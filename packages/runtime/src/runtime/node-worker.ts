import "../shared/worker-base";
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { PassThrough } from "readable-stream";
import { applicationPath, errorText, type FilePatch, type RuntimeConfig } from "../shared/types";
import { makeBuiltins, makeProcess } from "./builtins";
import { curlAddonLoader, isCurlAddon } from "./curl-addon";
import { configureCompatibility, createStub } from "./fallback";
import { VirtualFileSystem } from "./filesystem";
import { ModuleLoader } from "./loader";
import { fileText, WasmAddons } from "./napi-wasm";
import { loadCurl, Network } from "./network";
import {
	MainMessagePort,
	type NodeMessagePort,
	nativeTransfers,
	processModules,
	receiveTransportValue,
	transferValue,
} from "./processes";
import { initializeSQLCipher } from "./sqlcipher";
import { initializeSQLite } from "./sqlite";
import { nodeTimers } from "./timers";

// The Node IPC channel belongs to the worker host. Guest libraries may
// replace or remove ordinary JS globals without closing that channel.
const send = globalThis.postMessage.bind(globalThis);
const closeWorker = globalThis.close.bind(globalThis);
const parentPort = Object.assign(new EventEmitter(), {
	postMessage: (
		value: unknown,
		transfer: (Transferable | NodeMessagePort | MainMessagePort)[] = [],
	) => send({ type: "child-message", value: transferValue(value) }, nativeTransfers(transfer)),
	start: () => {},
	close: closeWorker,
	ref: () => parentPort,
	unref: () => parentPort,
});
let vfs: VirtualFileSystem;
let process: ReturnType<typeof makeProcess>;
const stdin = new PassThrough();
for (const level of ["log", "info", "warn", "error", "debug"] as const)
	console[level] = (...args: unknown[]) =>
		send({
			type: "log",
			level: level === "log" ? "info" : level,
			message: args.map(String).join(" "),
		});
let initialized = false;
let mode: "worker" | "fork" | "utility" = "worker";
const earlyMessages: MessageEvent<Record<string, unknown>>[] = [];
const receive = async (event: MessageEvent<Record<string, unknown>>) => {
	const message = receiveTransportValue(event.data) as Record<string, unknown>;
	if (message.type !== "start" && !initialized) {
		earlyMessages.push(event);
		return;
	}
	if (message.type === "fs") {
		vfs?.apply(message.patches as FilePatch[]);
		return;
	}
	if (message.type === "child-message") {
		if (mode === "worker") parentPort.emit("message", transferValue(message.value, true));
		else if (mode === "fork") process.emit("message", message.value);
		else
			(Reflect.get(process, "parentPort") as EventEmitter).emit("message", {
				data: message.value,
				ports: ((message.ports || []) as MessagePort[]).map(
					(port) => new MainMessagePort(port),
				),
			});
		return;
	}
	if (message.type === "stdin") {
		stdin.write(Buffer.from(message.data as Uint8Array));
		return;
	}
	if (message.type === "disconnect") {
		process?.emit("disconnect");
		return;
	}
	if (message.type !== "start") return;
	try {
		const config = message.config as RuntimeConfig;
		mode = message.mode === "fork" || message.mode === "utility" ? message.mode : "worker";
		await initializeSQLite();
		if (Object.keys(config.snapshot).some(isCurlAddon)) await loadCurl();
		// Signal's encrypted database addon; loaded only for apps that ship it.
		if (Object.keys(config.snapshot).some((name) => name.endsWith("@signalapp+sqlcipher.node")))
			await initializeSQLCipher();
		configureCompatibility(config.strict);
		const options = message.options as {
			eval?: boolean;
			workerData?: unknown;
			argv?: string[];
			cwd?: string;
			env?: Record<string, string>;
		};
		vfs = new VirtualFileSystem(config.snapshot, (patches) => send({ type: "fs", patches }));
		vfs.cwd = applicationPath(config.app);
		process = makeProcess(
			config,
			mode === "utility" ? "utility" : mode === "fork" ? undefined : "browser",
			(code) => {
				send({ type: "exit", code });
				closeWorker();
			},
		);
		process.pid = Number(message.pid);
		const evalId = mode === "worker" ? "[worker eval]" : "[eval]";
		process.argv = [
			"/neutron/electron",
			...(options.eval ? (mode === "worker" ? [evalId] : []) : [String(message.filename)]),
			...(options.argv || []),
		];
		if (options.cwd) {
			process.chdir(options.cwd);
			vfs.cwd = options.cwd;
		}
		Object.assign(process.env, options.env);
		Object.assign(process, {
			send: mode === "fork" ? parentPort.postMessage : undefined,
			disconnect: mode === "fork" ? () => process.emit("disconnect") : undefined,
			connected: mode === "fork" ? true : undefined,
			stdin,
			parentPort:
				mode === "utility"
					? Object.assign(new EventEmitter(), { postMessage: parentPort.postMessage })
					: undefined,
		});
		const network = new Network(config.wisp, (message) => console.debug(message));
		const globals = {
			process,
			Buffer,
			global: globalThis,
			...nodeTimers,
			fetch: network.fetch.bind(network),
		};
		// Keep native worker timers for host machinery; Node modules receive ref/unref timers lexically.
		Object.assign(globalThis, {
			process,
			Buffer,
			global: globalThis,
			fetch: network.browserFetch.bind(network),
			WebSocket: network.browserWebSocketClass(),
		});
		const builtins = makeBuiltins(vfs, network, createStub("electron (child worker)"), process);
		const processes = processModules(config, vfs, network, (level, source, message) =>
			send({ type: "log", level, source, message }),
		);
		Object.assign(builtins, {
			worker_threads: {
				...processes.worker_threads,
				isMainThread: mode !== "worker",
				workerData: transferValue(options.workerData, true),
				parentPort: mode === "worker" ? parentPort : null,
				threadId: mode === "worker" ? message.pid : 0,
			},
			child_process: processes.child_process,
		});
		const addons = new WasmAddons(
			fileText(vfs),
			{
				network,
				log: (level, message) => send({ type: "log", level, source: "worker", message }),
			},
			curlAddonLoader(network),
		);
		const loader = new ModuleLoader(vfs, builtins, globals, addons.load);
		const filename = String(message.filename);
		builtins.module = loader.moduleBuiltin(options.eval ? `${vfs.cwd}/${evalId}` : filename);
		send({ type: "online" });
		const executed = options.eval
			? Promise.resolve(loader.runEval(filename, evalId))
			: loader.runAsync(filename);
		void executed
			.then(() => {
				initialized = true;
				for (const event of earlyMessages.splice(0)) void receive(event);
			})
			.catch((error: unknown) => send({ type: "child-error", error: errorText(error) }));
	} catch (error) {
		send({ type: "child-error", error: errorText(error) });
	}
};
globalThis.addEventListener("message", (event) => {
	void receive(event);
});
globalThis.addEventListener("error", (event) =>
	send({ type: "child-error", error: errorText(event.error || event.message) }),
);
globalThis.addEventListener("unhandledrejection", (event) =>
	send({ type: "child-error", error: errorText(event.reason) }),
);
