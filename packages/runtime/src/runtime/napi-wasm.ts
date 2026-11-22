import { instantiateNapiModule, instantiateNapiModuleSync } from "@emnapi/core";
import { getDefaultContext } from "@emnapi/runtime";
import { WASI } from "@tybys/wasm-util";
import { runtimePath } from "../shared/base";
import { isWasmAddonCandidate, type WasmAddon, wasmAddonFor } from "../shared/wasm-addons";
import type { VirtualFileSystem } from "./filesystem";
import type { Network } from "./network";
import { hostFetch, hostScope } from "./transport";

// Native addons rebuilt for wasm32-wasip1-threads and loaded through emnapi
// (a Node-API implementation for WebAssembly); see shared/wasm-addons.ts.
//
// Besides Node-API, these modules import `neutron`:
//   wait32/wait64   memory.atomic.wait, rewritten at build time: browsers trap
//                   on it in a page's main thread, so the main thread spins.
//   tcp_*           outgoing TCP for Rust networking (see TcpHost below).
//
// Proxied pages hook Worker, BroadcastChannel and fetch, so this module uses
// the embedding page's own (hostScope).

// A page's main thread may not block, nor compile or instantiate a module
// over 8 MB synchronously. Workers may do both.
const canBlock = typeof document === "undefined";
const NativeXHR = globalThis.XMLHttpRequest;

// emnapi documents @tybys/wasm-util's WASI; its declared types differ only in
// start()'s return type, which emnapi doesn't use.
export const asWASI = (wasi: WASI) =>
	wasi as unknown as NonNullable<Parameters<typeof instantiateNapiModuleSync>[1]>["wasi"];

function waitImports(memory: () => WebAssembly.Memory) {
	const view = () => new Int32Array(memory().buffer);
	return {
		wait32(address: number, expected: number, timeout: bigint): number {
			const index = address >>> 2;
			const milliseconds = timeout < 0n ? Number.POSITIVE_INFINITY : Number(timeout) / 1e6;
			if (canBlock) {
				const result = Atomics.wait(view(), index, expected, milliseconds);
				return result === "ok" ? 0 : result === "not-equal" ? 1 : 2;
			}
			if (Atomics.load(view(), index) !== expected) return 1;
			const deadline = performance.now() + milliseconds;
			// Another thread holds the lock briefly; poll until it changes.
			while (Atomics.load(view(), index) === expected)
				if (performance.now() > deadline) return 2;
			return 0;
		},
		wait64(): number {
			throw new Error("memory.atomic.wait64 is not used by bundled builds");
		},
	};
}

type TcpMessage = { shared: number; seq: number } & (
	| { op: "connect"; host: string; port: number }
	| { op: "write"; data: Uint8Array }
	| { op: "consumed" }
	| { op: "close" }
);
type Socket = ReturnType<ReturnType<Network["sockets"]>["connect"]>;

// Connection block shared with Rust (libsignal rust/net/infra/src/wasi_tcp.rs):
// state +0, head +4, tail +8, operation sequence +12, receive ring +16.
const STATE = 0;
const HEAD = 4;
const TAIL = 8;
const SEQUENCE = 12;
const RING = 16;
const OPEN = 1;
const FAILED = 2;
const EOF = 3;

/**
 * The embedder side of a module's TCP: one Wisp TCP stream per connection,
 * owned by the thread that instantiated the module (which never blocks). Wasm
 * threads forward their calls over a BroadcastChannel. Calls carry a
 * per-connection sequence number taken when Rust made them, because channel
 * messages from different threads can arrive out of order. Received bytes go
 * into the connection's ring in shared memory; `neutron_tcp_wake` wakes Rust.
 */
export class TcpHost {
	private readonly sockets = new Map<
		number,
		{ socket: Socket; queue: Uint8Array[]; open: boolean; ended: boolean }
	>();
	private readonly order = new Map<number, { next: number; early: Map<number, TcpMessage> }>();
	private capacity = 0;
	constructor(
		private readonly network: Network | undefined,
		private readonly memory: WebAssembly.Memory,
		private readonly exports: () => WebAssembly.Exports | undefined,
	) {}
	private call(name: string, ...args: number[]): number {
		const exports = this.exports();
		if (!exports) throw new Error("module is not instantiated");
		return (exports[name] as (...values: number[]) => number)(...args);
	}
	private setState(shared: number, state: number): void {
		Atomics.store(new Int32Array(this.memory.buffer), (shared + STATE) >>> 2, state);
		this.call("neutron_tcp_wake", shared);
	}
	receive(message: TcpMessage): void {
		let order = this.order.get(message.shared);
		if (!order) {
			order = { next: 0, early: new Map() };
			this.order.set(message.shared, order);
		}
		order.early.set(message.seq, message);
		for (let next = order.early.get(order.next); next; next = order.early.get(order.next)) {
			order.early.delete(order.next);
			order.next++;
			this.handle(next);
			// Rust may reuse a released block's address for a new connection.
			if (next.op === "close") {
				this.order.delete(message.shared);
				return;
			}
		}
	}
	private handle(message: TcpMessage): void {
		const shared = message.shared;
		if (message.op === "connect") {
			if (!this.network) {
				this.setState(shared, FAILED);
				return;
			}
			this.capacity ||= this.call("neutron_tcp_ring_capacity");
			const socket = this.network.sockets().connect(message.port, message.host);
			const entry = { socket, queue: [] as Uint8Array[], open: false, ended: false };
			this.sockets.set(shared, entry);
			socket.on("connect", () => {
				if (this.sockets.get(shared) !== entry) return;
				entry.open = true;
				this.setState(shared, OPEN);
			});
			socket.on("data", (data: Uint8Array) => {
				if (this.sockets.get(shared) !== entry) return;
				entry.queue.push(new Uint8Array(data));
				this.flush(shared);
			});
			const end = () => {
				if (this.sockets.get(shared) !== entry || entry.ended) return;
				entry.ended = true;
				if (entry.open) this.flush(shared);
				else this.setState(shared, FAILED);
			};
			socket.on("end", end);
			socket.on("close", end);
			socket.on("error", end);
			return;
		}
		const entry = this.sockets.get(shared);
		if (message.op === "close") {
			this.sockets.delete(shared);
			entry?.socket.destroy();
			// Rust keeps its own reference; this drops the embedder's.
			this.call("neutron_tcp_release", shared);
			return;
		}
		if (!entry) return;
		// Channel messages may come from another realm (hostScope); copy the
		// bytes into this one for the stream's type checks.
		if (message.op === "write") entry.socket.write(new Uint8Array(message.data));
		else this.flush(shared);
	}
	private flush(shared: number): void {
		const entry = this.sockets.get(shared);
		if (!entry) return;
		const words = new Int32Array(this.memory.buffer);
		const bytes = new Uint8Array(this.memory.buffer);
		let head = Atomics.load(words, (shared + HEAD) >>> 2) >>> 0;
		const tail = Atomics.load(words, (shared + TAIL) >>> 2) >>> 0;
		let free = this.capacity - ((head - tail) >>> 0);
		while (entry.queue.length && free > 0) {
			const chunk = entry.queue[0] as Uint8Array;
			const count = Math.min(chunk.length, free);
			for (let written = 0; written < count; ) {
				const at = (head + written) % this.capacity;
				const part = Math.min(count - written, this.capacity - at);
				bytes.set(chunk.subarray(written, written + part), shared + RING + at);
				written += part;
			}
			head = (head + count) >>> 0;
			free -= count;
			if (count === chunk.length) entry.queue.shift();
			else entry.queue[0] = chunk.subarray(count);
		}
		Atomics.store(words, (shared + HEAD) >>> 2, head | 0);
		// EOF once everything received has been handed over.
		if (entry.ended && !entry.queue.length) Atomics.store(words, (shared + STATE) >>> 2, EOF);
		this.call("neutron_tcp_wake", shared);
	}
	close(): void {
		for (const entry of this.sockets.values()) entry.socket.destroy();
		this.sockets.clear();
		this.order.clear();
	}
}

function tcpImports(memory: () => WebAssembly.Memory, post: (message: TcpMessage) => void) {
	const copy = (pointer: number, length: number) =>
		new Uint8Array(memory().buffer, pointer, length).slice();
	const seq = (shared: number) =>
		Atomics.add(new Int32Array(memory().buffer), (shared + SEQUENCE) >>> 2, 1);
	return {
		tcp_connect(shared: number, host: number, length: number, port: number) {
			post({
				op: "connect",
				shared,
				seq: seq(shared),
				host: new TextDecoder().decode(copy(host, length)),
				port,
			});
		},
		tcp_write(shared: number, data: number, length: number) {
			post({ op: "write", shared, seq: seq(shared), data: copy(data, length) });
		},
		tcp_consumed(shared: number) {
			post({ op: "consumed", shared, seq: seq(shared) });
		},
		tcp_close(shared: number) {
			post({ op: "close", shared, seq: seq(shared) });
		},
	};
}

const cxxExceptions = {
	__cxa_allocate_exception() {
		throw new Error("C++ exceptions are disabled in this build");
	},
	__cxa_throw() {
		throw new Error("C++ exceptions are disabled in this build");
	},
};

/** Imports for a wasm thread (napi-thread.ts) of a module loaded here. */
export function threadImports(memory: WebAssembly.Memory, channel: string) {
	const owner = new BroadcastChannel(channel);
	return {
		env: cxxExceptions,
		neutron: {
			...waitImports(() => memory),
			...tcpImports(
				() => memory,
				(message) => owner.postMessage(message),
			),
		},
	};
}

export interface WasmAddonHost {
	network?: Network;
	log(level: "warn" | "error", message: string): void;
}

interface Instance {
	exports: object;
	close(): void;
}

function instantiate(
	module: WebAssembly.Module,
	addon: WasmAddon,
	host: WasmAddonHost,
	sync: true,
): Instance;
function instantiate(
	module: WebAssembly.Module,
	addon: WasmAddon,
	host: WasmAddonHost,
	sync: false,
): Promise<Instance>;
function instantiate(
	module: WebAssembly.Module,
	addon: WasmAddon,
	host: WasmAddonHost,
	sync: boolean,
): Instance | Promise<Instance> {
	const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true });
	const name = `neutron-napi:${crypto.randomUUID()}`;
	let exports: WebAssembly.Exports | undefined;
	const tcp = new TcpHost(host.network, memory, () => exports);
	const channel = new hostScope.BroadcastChannel(name);
	channel.onmessage = (event: MessageEvent<TcpMessage>) => tcp.receive(event.data);
	const print = (level: "warn" | "error") => (text: string) =>
		host.log(level, `${addon.packageName}: ${text}`);
	const options = {
		context: getDefaultContext(),
		wasi: asWASI(
			new WASI({
				version: "preview1",
				returnOnExit: true,
				print: print("warn"),
				printErr: print("error"),
			}),
		),
		asyncWorkPoolSize: 4,
		reuseWorker: true,
		onCreateWorker: () => new hostScope.Worker(runtimePath("runtime/napi-thread.js"), { name }),
		overwriteImports(imports: WebAssembly.Imports) {
			imports.env = { ...imports.env, ...cxxExceptions, memory };
			imports.neutron = {
				...waitImports(() => memory),
				...tcpImports(
					() => memory,
					(message) => tcp.receive(message),
				),
			};
			// emnapi only accepts identifier function names; Node accepts any.
			const napi = imports.napi as Record<string, (...args: number[]) => number>;
			const create = napi.napi_create_function as (...args: number[]) => number;
			napi.napi_create_function = (env, name, length, cb, data, result) => {
				const status = create(env, name, length, cb, data, result);
				return status === 1 && name && cb && result
					? create(env, 0, 0, cb, data, result)
					: status;
			};
			return imports;
		},
	};
	const finish = (loaded: ReturnType<typeof instantiateNapiModuleSync>): Instance => {
		exports = loaded.instance.exports;
		const threads = (loaded.napiModule as { PThread?: { terminateAllThreads(): void } })
			.PThread;
		return {
			exports: loaded.napiModule.exports as object,
			close() {
				channel.close();
				tcp.close();
				threads?.terminateAllThreads();
			},
		};
	};
	const fail = (error: unknown): never => {
		channel.close();
		throw error;
	};
	if (sync) {
		try {
			return finish(instantiateNapiModuleSync(module, options));
		} catch (error) {
			return fail(error);
		}
	}
	return instantiateNapiModule(module, options).then(finish, fail);
}

function fetchSync(url: string): ArrayBuffer {
	const request = new NativeXHR();
	request.open("GET", url, false);
	request.responseType = "arraybuffer";
	request.send();
	if (request.status !== 200) throw new Error(`${url}: HTTP ${request.status}`);
	return request.response as ArrayBuffer;
}

async function compile(url: string): Promise<WebAssembly.Module> {
	const response = await hostFetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	try {
		return await WebAssembly.compileStreaming(response.clone());
	} catch {
		// compileStreaming needs an application/wasm response.
		return WebAssembly.compile(await response.arrayBuffer());
	}
}

/** Reads a text file from an app's filesystem (including inside ASAR archives). */
export const fileText = (vfs: VirtualFileSystem) => (path: string) => {
	try {
		return String(vfs.fs.readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
};

/**
 * The native-addon hook for ModuleLoader: an addon with a bundled
 * WebAssembly build loads that build; anything else goes to `fallback`.
 * Workers instantiate on first require(). A page's main thread can't, so
 * renderers call prepare() and wait for it before running preload scripts.
 */
export class WasmAddons {
	private readonly instances = new Map<string, Instance>();
	private readonly failed = new Set<string>();
	constructor(
		private readonly read: (path: string) => string | undefined,
		private readonly host: WasmAddonHost,
		private readonly fallback: (filename: string) => object | undefined,
	) {}
	load = (filename: string): object | undefined => {
		const addon = wasmAddonFor(filename, this.read);
		if (!addon || this.failed.has(addon.url)) return this.fallback(filename);
		const existing = this.instances.get(addon.url);
		if (existing) return existing.exports;
		if (!canBlock) {
			this.failed.add(addon.url);
			this.host.log(
				"error",
				`${addon.packageName} ${addon.version}: the WebAssembly build was not prepared before require()`,
			);
			return this.fallback(filename);
		}
		try {
			const instance = instantiate(
				new WebAssembly.Module(fetchSync(addon.url)),
				addon,
				this.host,
				true,
			);
			this.instances.set(addon.url, instance);
			return instance.exports;
		} catch (error) {
			this.failed.add(addon.url);
			this.host.log("error", `${addon.packageName} ${addon.version}: ${String(error)}`);
			return this.fallback(filename);
		}
	};
	/** Instantiates, ahead of require(), the builds for these addon files. */
	async prepare(files: Iterable<string>): Promise<void> {
		const addons = new Map<string, WasmAddon>();
		for (const filename of files) {
			if (!isWasmAddonCandidate(filename)) continue;
			const addon = wasmAddonFor(filename, this.read);
			if (addon) addons.set(addon.url, addon);
		}
		await Promise.all(
			[...addons.values()].map(async (addon) => {
				if (this.instances.has(addon.url) || this.failed.has(addon.url)) return;
				try {
					this.instances.set(
						addon.url,
						await instantiate(await compile(addon.url), addon, this.host, false),
					);
				} catch (error) {
					this.failed.add(addon.url);
					this.host.log(
						"error",
						`${addon.packageName} ${addon.version}: ${String(error)}`,
					);
				}
			}),
		);
	}
	close(): void {
		for (const instance of this.instances.values()) instance.close();
		this.instances.clear();
	}
}
