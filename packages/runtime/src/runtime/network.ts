import { client as wisp } from "@mercuryworkshop/wisp-js/client";
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { libcurl } from "libcurl.js";
import { Duplex } from "readable-stream";
import { runtimePath } from "../shared/base";
import { httpModule } from "./http";
import type { LoopbackRegistry } from "./loopback";
import { VirtualServer } from "./optional";
import { WebSocket as BrowserWebSocket, hostFetch as browserFetch } from "./transport";

// The renderer can already be inside Scramjet when this bundle loads. Host
// assets and the Wisp connection must use the embedding host's real transport.
let curlWasm: Promise<void> | undefined;
export function loadCurl(): Promise<void> {
	curlWasm ??= (async () => {
		const path = runtimePath("vendor/libcurl/libcurl.wasm");
		const response = await browserFetch(path, { cache: "no-store" });
		if (!response.ok)
			throw new Error(
				`ERR_RUNTIME_ASSET: ${path} returned HTTP ${response.status}. Rebuild runtime assets and restart the app.`,
			);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)
			throw new Error(
				`ERR_RUNTIME_ASSET: ${path} returned ${response.headers.get("content-type") || "invalid data"}, not WebAssembly. Restart the dev server and app.`,
			);
		const serviceWorker = typeof window === "undefined" && "clients" in globalThis;
		const binary = serviceWorker
			? new URL(path, location.href).href
			: URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
		try {
			await libcurl.load_wasm(binary);
		} finally {
			if (!serviceWorker) URL.revokeObjectURL(binary);
		}
	})().catch((error: unknown) => {
		curlWasm = undefined;
		throw error;
	});
	return curlWasm;
}

export function validateWisp(value: string): string {
	if (!value.trim()) return "";
	const url = new URL(value);
	if (!["ws:", "wss:"].includes(url.protocol))
		throw new Error("Wisp endpoint must use ws:// or wss://.");
	if (url.search || url.hash || url.username || url.password)
		throw new Error("Wisp endpoint must not contain credentials, a query or a fragment.");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.href;
}
export class Network {
	browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		if (url.protocol === "blob:" || url.protocol === "data:") return browserFetch(input, init);
		if (
			url.origin === location.origin &&
			(url.pathname.startsWith(runtimePath("vendor/")) ||
				url.pathname.startsWith(runtimePath("runtime/")) ||
				url.pathname.startsWith(runtimePath("__neutron")))
		)
			return browserFetch(input, init);
		return this.fetch(input, init);
	}
	browserWebSocketClass(): typeof WebSocket {
		const Proxied = this.webSocketClass();
		const endpoint = this.endpoint;
		return new Proxy(BrowserWebSocket, {
			construct(target, args: [string, (string | string[])?]) {
				// Wisp's own WebSocket is the native transport, not another proxied destination.
				return Reflect.construct(
					endpoint && String(args[0]).startsWith(endpoint) ? target : Proxied,
					args,
				);
			},
		});
	}
	localFetch?: (url: string, init?: RequestInit) => Promise<Response | undefined>;
	protocolHandler?: (
		partition: string,
		scheme: string,
	) => ((request: Request) => Response | Promise<Response>) | undefined;
	readonly interceptors = new Map<
		string,
		{
			before(input: Request): Promise<Request>;
			after(response: Response, request: Request): Promise<Response>;
		}
	>();
	private ready?: Promise<void>;
	private sessions = new Map<string, InstanceType<typeof libcurl.HTTPSession>>();
	constructor(
		readonly endpoint: string,
		private log: (message: string) => void,
		private loopback?: LoopbackRegistry,
	) {}
	async init(): Promise<void> {
		if (!this.endpoint)
			throw new Error(
				"ERR_WISP_NOT_CONFIGURED: Set a Wisp relay URL in Neutron settings to enable networking.",
			);
		this.ready ??= loadCurl()
			.then(() => {
				// libcurl handles TLS locally; the requested wisp-js implementation handles TCP transport.
				libcurl.transport = wisp.WispWebSocket;
				libcurl.set_websocket(this.endpoint);
			})
			.catch((error: unknown) => {
				this.ready = undefined;
				throw error;
			});
		await this.ready;
	}
	async electronFetch(
		input: string | URL | Request,
		init?: RequestInit & { bypassCustomProtocolHandlers?: boolean },
		partition = "default",
	): Promise<Response> {
		const url = input instanceof Request ? input.url : String(input);
		const handler =
			!init?.bypassCustomProtocolHandlers &&
			this.protocolHandler?.(partition, new URL(url).protocol.slice(0, -1));
		if (handler) return handler(new Request(input, init));
		return this.fetch(input, init, partition);
	}
	async fetch(
		input: string | URL | Request,
		init?: RequestInit,
		partition = "default",
	): Promise<Response> {
		const url = input instanceof Request ? input.url : String(input);
		if (!/^https?:/.test(url)) {
			const options =
				input instanceof Request
					? {
							method: input.method,
							headers: input.headers,
							signal: input.signal,
							...(!["GET", "HEAD"].includes(input.method)
								? { body: await input.clone().arrayBuffer() }
								: {}),
							...init,
						}
					: init;
			const local = await this.localFetch?.(url, options);
			if (local) return local;
		}
		await this.init();
		let session = this.sessions.get(partition);
		if (!session) {
			session = new libcurl.HTTPSession({
				enable_cookies: !this.interceptors.has(partition),
			});
			this.sessions.set(partition, session);
		}
		this.log(
			`${init?.method || "GET"} ${input instanceof Request ? input.url : String(input)}`,
		);
		const intercept = this.interceptors.get(partition);
		if (!intercept) return session.fetch(input, init);
		const request = await intercept.before(new Request(input, init));
		return intercept.after(await session.fetch(request), request);
	}
	clearPartition(partition: string): void {
		this.sessions.get(partition)?.close();
		this.sessions.delete(partition);
	}
	close(): void {
		for (const session of this.sessions.values()) session.close();
		this.sessions.clear();
	}
	webSocketClass() {
		const network = this;
		return class ProxiedWebSocket extends EventTarget {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			readonly CONNECTING = 0;
			readonly OPEN = 1;
			readonly CLOSING = 2;
			readonly CLOSED = 3;
			readyState = 0;
			bufferedAmount = 0;
			extensions = "";
			protocol = "";
			binaryType: BinaryType = "blob";
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			private socket?: WebSocket;
			private emitter = new EventEmitter();
			constructor(
				readonly url: string,
				protocols?: string | string[],
			) {
				super();
				void network
					.init()
					.then(() => {
						if (this.readyState === 3) return;
						const socket = new libcurl.WebSocket(url, protocols);
						this.socket = socket;
						socket.binaryType = "arraybuffer";
						socket.onopen = () => {
							this.readyState = 1;
							this.protocol = socket.protocol;
							const event = new Event("open");
							this.dispatchEvent(event);
							this.onopen?.(event);
							this.emitter.emit("open");
						};
						socket.onmessage = (incoming) => {
							const data =
								incoming.data instanceof ArrayBuffer && this.binaryType === "blob"
									? new Blob([incoming.data])
									: incoming.data;
							const event = new MessageEvent("message", { data });
							this.dispatchEvent(event);
							this.onmessage?.(event);
							this.emitter.emit(
								"message",
								typeof incoming.data === "string"
									? Buffer.from(incoming.data)
									: Buffer.from(incoming.data),
								typeof incoming.data !== "string",
							);
						};
						socket.onclose = (incoming) => {
							this.readyState = 3;
							const event = new CloseEvent("close", {
								code: incoming.code,
								reason: incoming.reason,
								wasClean: incoming.wasClean,
							});
							this.dispatchEvent(event);
							this.onclose?.(event);
							this.emitter.emit("close", incoming.code, Buffer.from(incoming.reason));
						};
						socket.onerror = (event) => this.fail(event);
					})
					.catch((error: unknown) =>
						this.fail(new ErrorEvent("error", { error, message: String(error) })),
					);
			}
			private fail(event: Event): void {
				this.dispatchEvent(event);
				this.onerror?.(event);
				if (this.emitter.listenerCount("error")) this.emitter.emit("error", event);
				this.readyState = 3;
			}
			send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
				if (this.readyState !== 1) throw new Error("WebSocket is not open");
				this.socket?.send(
					typeof data === "string" || data instanceof Blob
						? data
						: ArrayBuffer.isView(data)
							? new Uint8Array(
									new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
								)
							: new Uint8Array(new Uint8Array(data)),
				);
			}
			close(code = 1000, reason = ""): void {
				if (this.socket) {
					this.readyState = 2;
					this.socket.close(code, reason);
				} else this.readyState = 3;
			}
			terminate(): void {
				this.close();
			}
			on(name: string, listener: (...args: unknown[]) => void): this {
				this.emitter.on(name, listener);
				return this;
			}
			once(name: string, listener: (...args: unknown[]) => void): this {
				this.emitter.once(name, listener);
				return this;
			}
			off(name: string, listener: (...args: unknown[]) => void): this {
				this.emitter.off(name, listener);
				return this;
			}
			removeListener(name: string, listener: (...args: unknown[]) => void): this {
				return this.off(name, listener);
			}
		};
	}
	tls() {
		const network = this;
		class JSStreamSocket extends Duplex {
			constructor(private source?: Duplex) {
				super();
				source?.on("data", (data) => this.push(data));
				source?.on("end", () => this.push(null));
				source?.on("error", (error) => this.destroy(error));
			}
			_read(): void {
				this.source?.resume();
			}
			_write(
				data: Buffer,
				_encoding: string,
				callback: (error?: Error | null) => void,
			): void {
				if (this.source) this.source.write(data, callback);
				else callback(new Error("No underlying stream"));
			}
		}
		class TLSSocket extends Duplex {
			_handle: { _parentWrap: JSStreamSocket };
			constructor(source?: Duplex) {
				super();
				this._handle = { _parentWrap: new JSStreamSocket(source) };
			}
			encrypted = true;
			authorized = false;
			private socket?: InstanceType<typeof libcurl.TLSSocket>;
			private writes: { chunk: Buffer; callback(error?: Error | null): void }[] = [];
			connect(
				options: { host?: string; port: number; servername?: string },
				callback?: () => void,
			): this {
				if (callback) this.once("secureConnect", callback);
				void network
					.init()
					.then(() => {
						if (this.destroyed) return;
						const socket = new libcurl.TLSSocket(
							options.servername || options.host || "localhost",
							options.port,
						);
						this.socket = socket;
						socket.onopen = () => {
							this.authorized = true;
							for (const write of this.writes) {
								socket.send(write.chunk);
								write.callback();
							}
							this.writes = [];
							this.emit("connect");
							this.emit("secureConnect");
						};
						socket.onmessage = (data) => this.push(Buffer.from(data));
						socket.onclose = () => {
							this.push(null);
							this.destroy();
						};
						socket.onerror = (code) =>
							this.destroy(new Error(`TLS connection failed (libcurl ${code})`));
					})
					.catch((error: Error) => this.destroy(error));
				return this;
			}
			_read(): void {}
			_write(
				chunk: Buffer,
				_encoding: string,
				callback: (error?: Error | null) => void,
			): void {
				if (this.authorized) {
					this.socket?.send(chunk);
					callback();
				} else this.writes.push({ chunk, callback });
			}
			_destroy(error: Error | null, callback: (error: Error | null) => void): void {
				this.socket?.close();
				for (const item of this.writes)
					item.callback(error || new Error("TLS socket closed"));
				this.writes = [];
				callback(error);
			}
			setNoDelay(): this {
				return this;
			}
			setKeepAlive(): this {
				return this;
			}
		}
		const connect = (
			options: { host?: string; port: number; servername?: string } | number,
			host?: string | (() => void),
			callback?: () => void,
		) =>
			new TLSSocket().connect(
				typeof options === "number"
					? { port: options, host: typeof host === "string" ? host : undefined }
					: options,
				typeof host === "function" ? host : callback,
			);
		return { TLSSocket, connect, createSecureContext: () => ({}), rootCertificates: [] };
	}
	datagrams() {
		const endpoint = this.endpoint;
		class DatagramSocket extends EventEmitter {
			private connection?: InstanceType<typeof wisp.ClientConnection>;
			private ready?: Promise<void>;
			private streams = new Map<
				string,
				ReturnType<InstanceType<typeof wisp.ClientConnection>["create_stream"]>
			>();
			constructor(
				readonly type: string,
				listener?: (...args: unknown[]) => void,
			) {
				super();
				if (listener) this.on("message", listener);
			}
			private init(): Promise<void> {
				this.ready ??= new Promise((resolve, reject) => {
					if (!endpoint) {
						reject(new Error("ERR_WISP_NOT_CONFIGURED"));
						return;
					}
					const conn = new wisp.ClientConnection(endpoint);
					this.connection = conn;
					conn.onopen = resolve;
					conn.onerror = () => reject(new Error("Wisp UDP connection failed"));
				});
				return this.ready;
			}
			send(data: Uint8Array | string, ...args: unknown[]): void {
				const values = args.filter((value) => typeof value !== "function");
				const callback = args.find((value) => typeof value === "function") as
					| ((error: Error | null, bytes?: number) => void)
					| undefined;
				const full = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
				const offset = values.length >= 4 ? Number(values[0]) : 0;
				const length = values.length >= 4 ? Number(values[1]) : full.length;
				const port = Number(values[values.length >= 4 ? 2 : 0]);
				const host = String(values[values.length >= 4 ? 3 : 1] || "localhost");
				void this.init()
					.then(() => {
						const key = `${host}:${port}`;
						let stream = this.streams.get(key);
						if (!stream) {
							stream = this.connection?.create_stream(host, port, "udp");
							if (!stream) throw new Error("Wisp is closed");
							this.streams.set(key, stream);
							stream.onmessage = (data) =>
								this.emit("message", Buffer.from(data), {
									address: host,
									port,
									family: this.type === "udp6" ? "IPv6" : "IPv4",
									size: data.length,
								});
							stream.onclose = () => this.streams.delete(key);
						}
						stream.send(full.subarray(offset, offset + length));
						callback?.(null, length);
					})
					.catch((error: Error) => {
						if (callback) callback(error);
						else this.emit("error", error);
					});
			}
			bind(_port?: number, _address?: string, callback?: () => void): this {
				queueMicrotask(() => {
					this.emit("listening");
					callback?.();
				});
				return this;
			}
			setMulticastTTL(): this {
				return this;
			}
			setMulticastLoopback(): this {
				return this;
			}
			setBroadcast(): this {
				return this;
			}
			addMembership(): void {}
			dropMembership(): void {}
			address(): object {
				return {
					address: "0.0.0.0",
					family: this.type === "udp6" ? "IPv6" : "IPv4",
					port: 0,
				};
			}
			close(callback?: () => void): void {
				this.connection?.close();
				this.emit("close");
				callback?.();
			}
			ref(): this {
				return this;
			}
			unref(): this {
				return this;
			}
		}
		return {
			Socket: DatagramSocket,
			createSocket: (
				type: string | { type: string },
				listener?: (...args: unknown[]) => void,
			) => new DatagramSocket(typeof type === "string" ? type : type.type, listener),
		};
	}
	http(defaultProtocol = "http:", electron = false) {
		return httpModule(
			electron ? this.electronFetch.bind(this) : this.fetch.bind(this),
			defaultProtocol,
			electron,
			this.loopback,
		);
	}
	sockets() {
		const endpoint = this.endpoint;
		class Socket extends Duplex {
			private connection?: InstanceType<typeof wisp.ClientConnection>;
			private stream?: ReturnType<
				InstanceType<typeof wisp.ClientConnection>["create_stream"]
			>;
			private queued: { data: Buffer; callback(error?: Error | null): void }[] = [];
			connecting = false;
			remoteAddress = "";
			remotePort = 0;
			connect(
				portOrOptions: number | string | { port?: number; host?: string; path?: string },
				hostOrCallback?: string | (() => void),
				callback?: () => void,
			): this {
				const socketPath =
					typeof portOrOptions === "string"
						? portOrOptions
						: typeof portOrOptions === "object"
							? portOrOptions.path
							: undefined;
				if (socketPath) {
					queueMicrotask(() =>
						this.destroy(
							Object.assign(new Error(`connect ENOENT ${socketPath}`), {
								code: "ENOENT",
								syscall: "connect",
								address: socketPath,
							}),
						),
					);
					return this;
				}
				if (!endpoint) {
					queueMicrotask(() => this.destroy(new Error("ERR_WISP_NOT_CONFIGURED")));
					return this;
				}
				const port = Number(
					typeof portOrOptions === "number"
						? portOrOptions
						: typeof portOrOptions === "object"
							? portOrOptions.port
							: NaN,
				);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					queueMicrotask(() =>
						this.destroy(
							Object.assign(new Error(`Invalid TCP port: ${port}`), {
								code: "ERR_SOCKET_BAD_PORT",
							}),
						),
					);
					return this;
				}
				const host =
					typeof portOrOptions === "object"
						? portOrOptions.host || "localhost"
						: typeof hostOrCallback === "string"
							? hostOrCallback
							: "localhost";
				const listener = typeof hostOrCallback === "function" ? hostOrCallback : callback;
				if (listener) this.once("connect", listener);
				this.connecting = true;
				this.remoteAddress = host;
				this.remotePort = port;
				const conn = new wisp.ClientConnection(endpoint);
				this.connection = conn;
				conn.onopen = () => {
					let stream: ReturnType<typeof conn.create_stream>;
					try {
						stream = conn.create_stream(host, port);
					} catch (error) {
						this.destroy(error instanceof Error ? error : new Error(String(error)));
						return;
					}
					this.stream = stream;
					this.connecting = false;
					stream.onmessage = (data) => this.push(Buffer.from(data));
					stream.onclose = () => {
						this.push(null);
						this.destroy();
					};
					for (const item of this.queued) {
						stream.send(item.data);
						item.callback();
					}
					this.queued = [];
					this.emit("connect");
					this.emit("ready");
				};
				conn.onerror = () => this.destroy(new Error("Wisp connection failed"));
				conn.onclose = () => {
					this.push(null);
					this.destroy();
				};
				return this;
			}
			_read(): void {}
			_write(
				data: Buffer,
				_encoding: string,
				callback: (error?: Error | null) => void,
			): void {
				if (this.stream) {
					this.stream.send(data);
					callback();
				} else this.queued.push({ data, callback });
			}
			_final(callback: (error?: Error | null) => void): void {
				this.stream?.close();
				callback();
			}
			_destroy(error: Error | null, callback: (error: Error | null) => void): void {
				this.stream?.close();
				this.connection?.close();
				for (const item of this.queued) item.callback(error || new Error("Socket closed"));
				this.queued = [];
				callback(error);
			}
			setNoDelay(): this {
				return this;
			}
			setKeepAlive(): this {
				return this;
			}
			ref(): this {
				return this;
			}
			unref(): this {
				return this;
			}
		}
		const connect = (...args: Parameters<Socket["connect"]>) => new Socket().connect(...args);
		return {
			Socket,
			connect,
			createConnection: connect,
			isIP: (host: string) =>
				host.includes(":") ? 6 : /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 4 : 0,
			createServer: (
				optionsOrListener?: object | ((...args: unknown[]) => void),
				listener?: (...args: unknown[]) => void,
			) =>
				new VirtualServer(
					"net.createServer (no inbound listener)",
					optionsOrListener,
					listener,
				),
		};
	}
}
