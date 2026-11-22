import { Buffer } from "buffer";
import { LOOPBACK_PROBE, rejectProbe } from "../shared/loopback";
import { type SyncResult, stringify } from "../shared/sync";
import {
	applicationEntry,
	applicationPath,
	errorText,
	type FilePatch,
	type RpcMessage,
	type RpcResult,
	type RuntimeConfig,
} from "../shared/types";
import { makeBuiltins, makeProcess } from "./builtins";
import { curlAddonLoader, isCurlAddon } from "./curl-addon";
import { createElectron } from "./electron";
import { configureCompatibility } from "./fallback";
import { VirtualFileSystem } from "./filesystem";
import { ModuleLoader } from "./loader";
import { LoopbackRegistry } from "./loopback";
import { loadCurl, Network } from "./network";
import { processModules } from "./processes";
import { answerRpc, RpcClient } from "./rpc";
import { initializeSQLCipher } from "./sqlcipher";
import { initializeSQLite } from "./sqlite";
import { nodeTimers } from "./timers";

const send = (message: unknown, transfer: Transferable[] = []) =>
	globalThis.postMessage(message, { transfer });
const rpc = new RpcClient(send);
let vfs: VirtualFileSystem;
let runtime: ReturnType<typeof createElectron>;
let exiting = false;
const loopback = new LoopbackRegistry();
let resolveExit: () => void;
const exited = new Promise<void>((resolve) => {
	resolveExit = resolve;
});
function notifyExit(code: number): void {
	loopback.dispose();
	resolveExit();
	send({ type: "quit", code });
}
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
	console[level] = (...args: unknown[]) =>
		send({
			type: "log",
			level: level === "log" ? "info" : level,
			source: "main",
			message: args
				.map((value) => {
					if (value instanceof Error) return errorText(value);
					if (typeof value === "string") return value;
					try {
						return JSON.stringify(value);
					} catch {
						return String(value);
					}
				})
				.join(" "),
		});
}
globalThis.addEventListener("error", (event) =>
	send({
		type: "log",
		level: "error",
		source: "main",
		message: errorText(event.error || event.message),
	}),
);
globalThis.addEventListener("unhandledrejection", (event) =>
	send({ type: "log", level: "error", source: "main", message: errorText(event.reason) }),
);
globalThis.addEventListener("message", async (event: MessageEvent<Record<string, unknown>>) => {
	const message = event.data;
	if (message.type === LOOPBACK_PROBE) {
		const port = event.ports[0];
		if (port) {
			if (exiting || !runtime) rejectProbe(port, 410);
			else loopback.probe(String(message.origin), port);
		}
		return;
	}
	if (message.type === "sync-ipc") {
		const memory = message.memory as SharedArrayBuffer;
		const control = new Int32Array(memory, 0, 2);
		const respond = (value: { result?: unknown; error?: string }) => {
			const result: SyncResult = { nonce: "", ...value };
			let encoded: Uint8Array;
			try {
				encoded = new TextEncoder().encode(stringify(result));
			} catch (error) {
				encoded = new TextEncoder().encode(
					stringify({ nonce: "", error: errorText(error) }),
				);
			}
			if (encoded.length > memory.byteLength - 8) Atomics.store(control, 0, -1);
			else {
				new Uint8Array(memory, 8).set(encoded);
				Atomics.store(control, 1, encoded.length);
				Atomics.store(control, 0, 1);
			}
		};
		try {
			runtime.syncIpc(
				Number(message.windowId),
				String(message.channel),
				message.args as unknown[],
				respond,
			);
		} catch (error) {
			respond({ error: errorText(error) });
		}
		return;
	}
	if (message.type === "result") {
		rpc.receive(message as unknown as RpcResult);
		return;
	}
	if (message.type === "fs") {
		vfs?.apply(message.patches as FilePatch[]);
		return;
	}
	if (message.type === "start") {
		try {
			const config = message.config as RuntimeConfig;
			await initializeSQLite();
			if (Object.keys(config.snapshot).some(isCurlAddon)) await loadCurl();
			// Signal's encrypted database addon; loaded only for apps that ship it.
			if (
				Object.keys(config.snapshot).some((name) =>
					name.endsWith("@signalapp+sqlcipher.node"),
				)
			)
				await initializeSQLCipher();
			if (exiting) return; // Stopped while a startup dependency was loading.
			configureCompatibility(config.strict);
			vfs = new VirtualFileSystem(config.snapshot, (patches) =>
				send({ type: "fs", patches }),
			);
			vfs.cwd = applicationPath(config.app);
			const network = new Network(
				config.wisp,
				(message) => send({ type: "log", source: "network", level: "debug", message }),
				loopback,
			);
			const process = makeProcess(config, "browser", notifyExit);
			const exit = process.exit;
			process.exit = (code = 0) => {
				if (exiting) return;
				exiting = true;
				try {
					exit(code);
				} catch (error) {
					// makeProcess runs synchronous 'exit' listeners before notifying
					// the host. A throwing listener must not strand the worker.
					notifyExit(code);
					throw error;
				}
			};
			runtime = createElectron({ send, rpc, config, vfs, network, exit: process.exit });
			const protocolChannel = new BroadcastChannel(`neutron-protocol:${config.instanceId}`);
			protocolChannel.onmessage = async (
				event: MessageEvent<{
					nonce: string;
					partition?: string;
					url: string;
					method: string;
					headers: [string, string][];
					body?: ArrayBuffer;
					/** A response's headers for `webRequest.onHeadersReceived`. */
					received?: Parameters<typeof runtime.headersReceived>[1];
				}>,
			) => {
				const { nonce, url, method, headers, body, received } = event.data;
				if (received) {
					try {
						protocolChannel.postMessage({
							nonce,
							change: await runtime.headersReceived(
								event.data.partition || "default",
								received,
							),
						});
					} catch (error) {
						protocolChannel.postMessage({ nonce, error: errorText(error) });
					}
					return;
				}
				try {
					const handler = runtime.protocolHandler(
						event.data.partition || "default",
						new URL(url).protocol.slice(0, -1),
					);
					if (!handler) throw new Error(`ERR_UNKNOWN_URL_SCHEME: ${url}`);
					const response = await handler(new Request(url, { method, headers, body }));
					protocolChannel.postMessage({
						nonce,
						body: new Uint8Array(await response.arrayBuffer()),
						status: response.status,
						headers: [...response.headers],
					});
				} catch (error) {
					protocolChannel.postMessage({ nonce, error: errorText(error) });
				}
			};
			const globals = {
				process,
				Buffer,
				global: globalThis,
				...nodeTimers,
				fetch: network.fetch.bind(network),
			};
			Object.assign(globalThis, {
				process,
				Buffer,
				global: globalThis,
				fetch: network.browserFetch.bind(network),
				WebSocket: network.browserWebSocketClass(),
			});
			const builtins = makeBuiltins(vfs, network, runtime.electron, process);
			const processes = processModules(config, vfs, network, (level, source, message) =>
				send({ type: "log", level, source, message }),
			);
			builtins.worker_threads = processes.worker_threads;
			builtins.child_process = processes.child_process;
			Object.assign(runtime.electron, { utilityProcess: processes.utilityProcess });
			const loader = new ModuleLoader(vfs, builtins, globals, curlAddonLoader(network));
			builtins.module = loader.moduleBuiltin(applicationEntry(config.app));
			const entry = applicationEntry(config.app);
			const started = () => {
				if (!exiting) runtime.markReady();
				if (!exiting) send({ type: "started" });
			};
			if (loader.isESM(loader.resolve(entry))) {
				void loader
					.runAsync(entry)
					.then(started)
					.catch((error: unknown) => send({ type: "fatal", message: errorText(error) }));
			} else {
				loader.run(entry);
				started();
			}
		} catch (error) {
			send({ type: "fatal", message: errorText(error) });
		}
	} else if (message.type === "rpc") {
		void answerRpc(
			message as unknown as RpcMessage,
			async (method, args) => {
				if (method === "app.open-link") return runtime?.openLink(String(args[0])) ?? false;
				if (method === "runtime.shutdown") {
					if (!runtime) exiting = true;
					if (exiting) return;
					runtime.quit();
					// A veto is not an exit. Continue servicing renderer IPC while
					// the app completes its work, subject to the host's deadline.
					await exited;
					return;
				}
				if (method === "runtime.finalize") {
					try {
						if (!exiting) runtime?.exit();
					} finally {
						await vfs?.settle();
					}
					return;
				}
				if (method !== "protocol") throw new Error(`Unknown worker request: ${method}`);
				const url = String(args[0]);
				const handler = runtime.protocolHandler(
					"default",
					new URL(url).protocol.slice(0, -1),
				);
				if (!handler) throw new Error(`No protocol handler for ${url}`);
				const response = await handler(new Request(url));
				return {
					body: new Uint8Array(await response.arrayBuffer()),
					status: response.status,
					headers: [...response.headers],
				};
			},
			send,
		);
	} else if (runtime && !exiting)
		void runtime.receive(message).catch((error: unknown) => console.error(error));
});
