import { Buffer } from "buffer";
import { EventEmitter } from "events";
import path from "path-browserify";
import { PassThrough, Readable } from "readable-stream";
import type { FilePatch, RuntimeConfig } from "../shared/types";
import type { VirtualFileSystem } from "./filesystem";
import { gitVersion, isGit, runGit } from "./git-command";
import type { Network } from "./network";

const MAX_STDIN = 64 * 1024 * 1024;
const uncloneable = new WeakSet<object>();
const untransferable = new WeakSet<object>();
const PlatformMessagePort = globalThis.MessagePort;
const isObject = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");
function markAsUncloneable(value: unknown): void {
	if (isObject(value)) uncloneable.add(value);
}
function markAsUntransferable(value: unknown): void {
	if (isObject(value)) untransferable.add(value);
}

export function receiveTransportValue(value: unknown): unknown {
	if (
		value &&
		typeof value === "object" &&
		["worker", "window"].includes(String(Reflect.get(value, "$scramjet$messagetype"))) &&
		Object.hasOwn(value, "$scramjet$data")
	)
		return Reflect.get(value, "$scramjet$data");
	return value;
}

export function nativeTransfers(
	values: (Transferable | NodeMessagePort | MainMessagePort)[],
): Transferable[] {
	return values.map((value) => {
		const native =
			value instanceof NodeMessagePort || value instanceof MainMessagePort
				? value.port
				: value;
		if (untransferable.has(value) || untransferable.has(native))
			throw new DOMException("Cannot transfer object of unsupported type.", "DataCloneError");
		return native;
	});
}
export function transferValue(
	value: unknown,
	receive = false,
	seen = new Map<object, unknown>(),
): unknown {
	if (value instanceof NodeMessagePort || value instanceof MainMessagePort) return value.port;
	if (receive && value instanceof PlatformMessagePort) return new NodeMessagePort(value);
	if (
		!value ||
		typeof value !== "object" ||
		ArrayBuffer.isView(value) ||
		value instanceof ArrayBuffer ||
		value instanceof PlatformMessagePort
	)
		return value;
	if (seen.has(value)) return seen.get(value);
	if (!receive && uncloneable.has(value))
		throw new DOMException("Cannot clone object of unsupported type.", "DataCloneError");
	if (value instanceof Map) {
		const result = new Map();
		seen.set(value, result);
		for (const [k, v] of value)
			result.set(transferValue(k, receive, seen), transferValue(v, receive, seen));
		return result;
	}
	if (value instanceof Set) {
		const result = new Set();
		seen.set(value, result);
		for (const item of value) result.add(transferValue(item, receive, seen));
		return result;
	}
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		seen.set(value, result);
		for (const item of value) result.push(transferValue(item, receive, seen));
		return result;
	}
	// Structured clone traverses enumerable own fields on class instances too.
	if (Object.prototype.toString.call(value) !== "[object Object]") return value;
	const result: Record<string, unknown> = {};
	seen.set(value, result);
	for (const [key, item] of Object.entries(value))
		Object.defineProperty(result, key, {
			value: transferValue(item, receive, seen),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	return result;
}

export class NodeMessagePort extends EventEmitter {
	constructor(readonly port: MessagePort) {
		super();
		port.onmessage = (event) =>
			this.emit("message", transferValue(receiveTransportValue(event.data), true));
		port.onmessageerror = (event) => this.emit("messageerror", event);
		port.start();
	}
	postMessage(
		value: unknown,
		transfer: (Transferable | NodeMessagePort | MainMessagePort)[] = [],
	): void {
		this.port.postMessage(transferValue(value), nativeTransfers(transfer));
	}
	start(): void {
		this.port.start();
	}
	close(): void {
		this.port.close();
		this.emit("close");
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
}
export class NodeMessageChannel {
	port1: NodeMessagePort;
	port2: NodeMessagePort;
	constructor() {
		const channel = new MessageChannel();
		this.port1 = new NodeMessagePort(channel.port1);
		this.port2 = new NodeMessagePort(channel.port2);
	}
}
export class MainMessagePort extends EventEmitter {
	constructor(readonly port: MessagePort) {
		super();
		port.onmessage = (event) =>
			this.emit("message", {
				data: receiveTransportValue(event.data),
				ports: event.ports.map((port) => new MainMessagePort(port)),
			});
		port.onmessageerror = (event) => this.emit("messageerror", event);
	}
	postMessage(value: unknown, ports: MainMessagePort[] = []): void {
		this.port.postMessage(
			value,
			ports.map((port) => port.port),
		);
	}
	start(): void {
		this.port.start();
	}
	close(): void {
		this.port.close();
		this.emit("close");
	}
}
export class MainMessageChannel {
	port1: MainMessagePort;
	port2: MainMessagePort;
	constructor() {
		const channel = new MessageChannel();
		this.port1 = new MainMessagePort(channel.port1);
		this.port2 = new MainMessagePort(channel.port2);
	}
}
export function processModules(
	config: RuntimeConfig,
	vfs: VirtualFileSystem,
	network: Pick<Network, "fetch" | "clearPartition">,
	report: (level: string, source: string, message: string) => void,
) {
	let nextId = 100;
	const children = new Set<JavaScriptProcess>();
	const unsubscribe = vfs.subscribe((patches, origin) => {
		for (const child of children)
			if (child !== origin) child.worker.postMessage({ type: "fs", patches });
	});
	interface Options {
		eval?: boolean;
		workerData?: unknown;
		transferList?: (Transferable | NodeMessagePort | MainMessagePort)[];
		argv?: string[];
		env?: Record<string, string>;
		cwd?: string;
		shell?: boolean | string;
		signal?: AbortSignal;
		encoding?: BufferEncoding | "buffer" | null;
		maxBuffer?: number;
		name?: string;
		type?: string;
	}
	class JavaScriptProcess extends EventEmitter {
		readonly worker: Worker;
		readonly pid = ++nextId;
		readonly threadId = this.pid;
		readonly stdout = new PassThrough();
		readonly stderr = new PassThrough();
		readonly stdin = new PassThrough();
		exitCode: number | null = null;
		connected = true;
		killed = false;
		constructor(filename: string | URL, options: Options = {}, mode = "worker") {
			super();
			const { transferList = [], ...bootOptions } = options;
			const transfers = nativeTransfers(transferList);
			const workerData = transferValue(options.workerData);
			this.worker = new Worker("/runtime/node-worker.js", {
				name: options.name || `neutron-child:${this.pid}`,
			});
			const crashed = (reason: string) => {
				// A worker thread reports its uncaught JS exception to the owning
				// thread. Forks and Electron utility processes have an independent
				// process lifetime: report stderr and a non-zero exit to the parent.
				try {
					if (mode === "worker") this.emit("error", new Error(reason));
					else {
						this.stderr.write(`${reason}\n`);
						report("error", `child:${this.pid}`, reason);
					}
				} finally {
					this.finish(1);
				}
			};
			this.worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
				const message = event.data;
				if (message.type === "child-message")
					this.emit("message", transferValue(message.value, true));
				else if (message.type === "fs")
					vfs.apply(message.patches as FilePatch[], true, this);
				else if (message.type === "online") {
					this.emit("online");
					this.emit("spawn");
				} else if (message.type === "exit") this.finish(Number(message.code));
				else if (message.type === "log") {
					const output = String(message.message);
					(message.level === "error" ? this.stderr : this.stdout).write(`${output}\n`);
					report(String(message.level), `child:${this.pid}`, output);
				} else if (message.type === "child-error") crashed(String(message.error));
			};
			this.worker.onerror = (event) => {
				event.preventDefault();
				crashed(event.message);
			};
			this.stdin.on("data", (chunk) =>
				this.worker.postMessage({ type: "stdin", data: new Uint8Array(chunk) }),
			);
			const source =
				filename instanceof URL ? decodeURIComponent(filename.pathname) : filename;
			try {
				this.worker.postMessage(
					{
						type: "start",
						config: { ...config, snapshot: vfs.snapshot() },
						filename: options.eval
							? source
							: path.resolve(options.cwd || vfs.cwd, vfs.normalizePath(source)),
						options: { ...bootOptions, cwd: options.cwd || vfs.cwd, workerData },
						pid: this.pid,
						mode,
					},
					transfers,
				);
			} catch (error) {
				this.worker.terminate();
				throw error;
			}
			children.add(this);
		}
		postMessage(
			value: unknown,
			transfer: (Transferable | NodeMessagePort | MainMessagePort)[] = [],
		): void {
			const transfers = nativeTransfers(transfer);
			this.worker.postMessage(
				{
					type: "child-message",
					value: transferValue(value),
					ports: transfers.filter((item) => item instanceof MessagePort),
				},
				transfers,
			);
		}
		send(value: unknown, callback?: (error: Error | null) => void): boolean {
			this.postMessage(value);
			callback?.(null);
			return true;
		}
		disconnect(): void {
			this.connected = false;
			this.worker.postMessage({ type: "disconnect" });
			this.emit("disconnect");
		}
		kill(): boolean {
			this.killed = true;
			this.finish(0);
			return true;
		}
		terminate(): Promise<number> {
			this.finish(1);
			return Promise.resolve(1);
		}
		ref(): this {
			return this;
		}
		unref(): this {
			return this;
		}
		private finish(code: number): void {
			if (this.exitCode !== null) return;
			this.exitCode = code;
			this.connected = false;
			this.worker.terminate();
			children.delete(this);
			this.stdout.end();
			this.stderr.end();
			this.stdin.end();
			this.emit("exit", code, null);
			this.emit("close", code, null);
		}
	}
	const fork = (filename: string, args: string[] = [], options: Options = {}) =>
		new JavaScriptProcess(filename, { ...options, argv: args }, "fork");
	const commands = new Set<CommandProcess>();
	class CommandProcess extends EventEmitter {
		readonly pid = ++nextId;
		readonly stdout = new Readable({ read() {} });
		readonly stderr = new Readable({ read() {} });
		readonly stdin = new PassThrough();
		readonly stdio = [this.stdin, this.stdout, this.stderr];
		readonly controller = new AbortController();
		exitCode: number | null = null;
		signalCode: string | null = null;
		killed = false;
		connected = false;
		constructor(command: string, args: string[], options: Options) {
			super();
			commands.add(this);
			const abort = () => this.kill();
			options.signal?.addEventListener("abort", abort, { once: true });
			queueMicrotask(async () => {
				if (options.signal?.aborted) this.kill();
				this.emit("spawn");
				let code = 127;
				let input: Promise<Uint8Array> | undefined;
				try {
					if (isGit(command) && !options.shell)
						code = await runGit(vfs, args, options, {
							fetch: (url, init) => network.fetch(url, init, `git:${this.pid}`),
							signal: this.controller.signal,
							// A pipe is an I/O boundary. Exceptions thrown by the parent's
							// data listeners belong to its event loop, not the Git command.
							stdout: (text) =>
								queueMicrotask(() => this.stdout.push(Buffer.from(text))),
							stderr: (text) =>
								queueMicrotask(() => this.stderr.push(Buffer.from(text))),
							stdin: () => {
								input ??= new Promise<Uint8Array>((resolve, reject) => {
									const chunks: Buffer[] = [];
									let size = 0;
									this.stdin.on("data", (chunk) => {
										size += chunk.length;
										if (size > MAX_STDIN)
											reject(new Error("standard input exceeds limit"));
										else chunks.push(Buffer.from(chunk));
									});
									this.stdin.once("end", () =>
										resolve(new Uint8Array(Buffer.concat(chunks))),
									);
									this.controller.signal.addEventListener("abort", () =>
										reject(this.controller.signal.reason),
									);
								});
								return input;
							},
						});
					else
						this.stderr.push(
							options.shell
								? "Shell execution is not supported\n"
								: "Unsupported child process executable\n",
						);
				} catch (e) {
					this.stderr.push(`${e}\n`);
					code = 1;
				} finally {
					options.signal?.removeEventListener("abort", abort);
					network.clearPartition(`git:${this.pid}`);
					commands.delete(this);
					this.stdin.end();
					const drained = [this.stdout, this.stderr].map(
						(stream) =>
							new Promise<void>((resolve) => {
								stream.once("end", resolve);
								stream.once("close", resolve);
								if (stream.destroyed) resolve();
								else {
									stream.push(null);
									if (stream.readableFlowing === null) stream.resume();
								}
							}),
					);
					this.exitCode = this.killed ? null : code;
					this.emit("exit", this.exitCode, this.signalCode);
					await Promise.all(drained);
					this.emit("close", this.exitCode, this.signalCode);
				}
			});
		}
		kill(signal = "SIGTERM") {
			if (this.killed || this.exitCode !== null) return false;
			this.killed = true;
			this.signalCode = signal;
			this.controller.abort();
			return true;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
	}
	const spawn = (command: string, args: string[] = [], options: Options = {}) => {
		if (options.shell || !/^(?:node|nodejs|electron|\/neutron\/electron)$/.test(command))
			return new CommandProcess(command, args, options);
		if (args[0] === "-e" || args[0] === "--eval")
			return new JavaScriptProcess(
				args[1] || "",
				{ ...options, eval: true, argv: args.slice(2) },
				"fork",
			);
		if (!args[0]) return new CommandProcess(command, args, options);
		return fork(args[0], args.slice(1), options);
	};
	const spawnSync = (command: string, args: string[] = [], options: Options = {}) => {
		const ok =
			!options.shell &&
			isGit(command) &&
			args.length === 1 &&
			["version", "--version"].includes(args[0] || "");
		const encode = (s: string) =>
			options.encoding && options.encoding !== "buffer"
				? Buffer.from(s).toString(options.encoding)
				: Buffer.from(s);
		const stdout = encode(ok ? gitVersion() : ""),
			stderr = encode(ok ? "" : "Synchronous command not supported; use spawn or execFile\n");
		return {
			pid: ++nextId,
			status: ok ? 0 : 128,
			signal: null,
			stdout,
			stderr,
			output: [null, stdout, stderr],
		};
	};
	type ExecCallback = (
		error: Error | null,
		stdout: string | Buffer,
		stderr: string | Buffer,
	) => void;
	const execFile = (
		command: string,
		argsOrOptions: string[] | Options | ExecCallback = [],
		opts: Options | ExecCallback = {},
		cb?: ExecCallback,
	) => {
		const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
		const options =
			!Array.isArray(argsOrOptions) && typeof argsOrOptions === "object"
				? argsOrOptions
				: typeof opts === "object"
					? opts
					: {};
		const callback =
			typeof argsOrOptions === "function"
				? argsOrOptions
				: typeof opts === "function"
					? opts
					: cb;
		const child = spawn(command, args, options);
		// Node's execFile exposes the requested encoding on the live streams
		// too. Consumers piping stderr into a line parser otherwise get Buffers
		// even though their final execFile callback receives a string.
		const encoding = options.encoding === undefined ? "utf8" : options.encoding;
		const out: Buffer[] = [],
			err: Buffer[] = [];
		const limit = options.maxBuffer ?? 1024 * 1024;
		let overflow: Error | undefined;
		for (const [stream, chunks] of [
			[child.stdout, out],
			[child.stderr, err],
		] as const) {
			if (encoding && encoding !== "buffer") stream.setEncoding(encoding);
			let size = 0;
			stream.on("data", (data) => {
				const chunk =
					typeof data === "string" && encoding && encoding !== "buffer"
						? Buffer.from(data, encoding)
						: Buffer.from(data);
				size += chunk.length;
				if (size <= limit) chunks.push(chunk);
				else if (!overflow) {
					overflow = Object.assign(new Error("maxBuffer length exceeded"), {
						code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					});
					child.kill();
				}
			});
		}
		child.once("close", (code, signal) => {
			const encode = (chunks: Buffer[]) =>
				options.encoding === null || options.encoding === "buffer"
					? Buffer.concat(chunks)
					: Buffer.concat(chunks).toString(options.encoding || "utf8");
			const stdout = encode(out),
				stderr = encode(err);
			callback?.(
				overflow ||
					(code === 0
						? null
						: Object.assign(
								new Error(String(stderr) || `Child exited with ${code ?? signal}`),
								{ code, signal, killed: child.killed },
							)),
				stdout,
				stderr,
			);
		});
		return child;
	};
	return {
		worker_threads: {
			markAsUncloneable,
			markAsUntransferable,
			isMarkedAsUntransferable: (value: unknown) =>
				isObject(value) && untransferable.has(value),
			Worker: JavaScriptProcess,
			isMainThread: true,
			parentPort: null,
			workerData: undefined,
			threadId: 0,
			MessageChannel: NodeMessageChannel,
			MessagePort: NodeMessagePort,
			SHARE_ENV: Symbol.for("neutron.SHARE_ENV"),
		},
		child_process: {
			fork,
			spawn,
			execFile,
			exec: (
				command: string,
				options: Options | ExecCallback = {},
				callback?: ExecCallback,
			) =>
				execFile(
					command,
					[],
					{ ...(typeof options === "object" ? options : {}), shell: true },
					typeof options === "function" ? options : callback,
				),
			execSync: () => {
				throw new Error("Shell execution is not supported");
			},
			spawnSync,
			execFileSync: (command: string, args: string[] = [], options: Options = {}) => {
				const result = spawnSync(command, args, options);
				if (result.status) throw Object.assign(new Error(String(result.stderr)), result);
				return result.stdout;
			},
		},
		utilityProcess: {
			fork: (filename: string, args: string[] = [], options: Options = {}) =>
				new JavaScriptProcess(filename, { ...options, argv: args }, "utility"),
		},
		close: () => {
			unsubscribe();
			for (const child of children) child.kill();
			for (const child of commands) child.kill();
		},
	};
}
