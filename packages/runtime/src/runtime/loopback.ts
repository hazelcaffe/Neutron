import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Readable, Writable } from "readable-stream";
import {
	type CallbackReply,
	type CallbackRequest,
	isLoopbackHTTP,
	LOOPBACK_BYTES,
	LOOPBACK_TIMEOUT,
	rejectProbe,
} from "../shared/loopback";
import { STATUS_CODES, validateHeaderName, validateHeaderValue } from "./http";

type Header = string | number | readonly string[];
type Address = { address: string; family: string; port: number };
type Binding = { server: LoopbackServer; origin: string; address: Address };
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const unsupported = () =>
	failure(
		"ERR_NOT_SUPPORTED",
		"Only HTTP callback listeners with an explicit loopback host and port are supported",
	);

class CallbackIncoming extends Readable {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly rawHeaders: string[];
	readonly httpVersion = "1.1";
	readonly complete = true; // the virtual transport has received the entire request
	readonly aborted = false;
	constructor(origin: URL, data: CallbackRequest) {
		super();
		this.url = data.path;
		this.method = data.method;
		const headers = new Headers(data.headers);
		headers.set("host", origin.host);
		this.headers = Object.assign(Object.create(null), Object.fromEntries(headers));
		this.rawHeaders = [...headers].flat();
		if (data.body?.byteLength) this.push(Buffer.from(data.body));
		this.push(null);
	}
	_read(): void {}
}

class CallbackResponse extends Writable {
	statusCode = 200;
	statusMessage?: string;
	headersSent = false;
	private headers = new Map<string, Header>();
	private chunks: Buffer[] = [];
	private bytes = 0;
	get finished(): boolean {
		return this.writableEnded;
	}
	private mutable(): void {
		if (this.headersSent) throw failure("ERR_HTTP_HEADERS_SENT", "Headers already sent");
	}
	setHeader(name: string, value: Header): this {
		this.mutable();
		validateHeaderName(name);
		validateHeaderValue(name, value);
		this.headers.set(name.toLowerCase(), value);
		return this;
	}
	getHeader(name: string) {
		return this.headers.get(name.toLowerCase());
	}
	getHeaderNames() {
		return [...this.headers.keys()];
	}
	getHeaders(): Record<string, Header> {
		return Object.assign(Object.create(null), Object.fromEntries(this.headers));
	}
	hasHeader(name: string) {
		return this.headers.has(name.toLowerCase());
	}
	removeHeader(name: string): void {
		this.mutable();
		this.headers.delete(name.toLowerCase());
	}
	writeHead(
		status: number,
		reasonOrHeaders?: string | Record<string, Header>,
		headers?: Record<string, Header>,
	): this {
		this.mutable();
		this.statusCode = status;
		if (typeof reasonOrHeaders === "string") this.statusMessage = reasonOrHeaders;
		else headers = reasonOrHeaders;
		if (Array.isArray(headers)) throw unsupported();
		for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
		this.commitHeaders();
		return this;
	}
	private commitHeaders(): void {
		if (!Number.isInteger(this.statusCode) || this.statusCode < 200 || this.statusCode > 599)
			throw failure("ERR_HTTP_INVALID_STATUS_CODE", "Invalid callback response status");
		if (this.statusMessage !== undefined)
			validateHeaderValue("statusMessage", this.statusMessage);
		this.headersSent = true;
	}
	_write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void): void {
		try {
			if (!this.headersSent) this.commitHeaders();
			this.bytes += chunk.byteLength;
			if (this.bytes > LOOPBACK_BYTES)
				throw failure("ERR_BUFFER_TOO_LARGE", "Callback response exceeds 1 MiB");
			if (chunk.length) this.chunks.push(Buffer.from(chunk));
			done();
		} catch (error) {
			done(error as Error);
		}
	}
	_final(done: (error?: Error | null) => void): void {
		try {
			if (!this.headersSent) this.commitHeaders();
			done();
		} catch (error) {
			done(error as Error);
		}
	}
	result(): Extract<CallbackReply, { type: "response" }> {
		const headers: [string, string][] = [];
		for (const [name, value] of this.headers)
			for (const item of Array.isArray(value) ? value : [value])
				headers.push([name, String(item)]);
		return {
			type: "response",
			status: this.statusCode,
			statusText: this.statusMessage ?? STATUS_CODES[this.statusCode] ?? "",
			headers,
			body: new Uint8Array(Buffer.concat(this.chunks)).buffer,
		};
	}
}

export type RequestListener = (req: CallbackIncoming, res: CallbackResponse) => void;

class LoopbackServer extends EventEmitter {
	private binding?: Binding;
	private closing = false;
	private active = 0;
	constructor(
		private registry: LoopbackRegistry,
		listener?: RequestListener,
	) {
		super();
		if (listener) this.on("request", listener);
	}
	get listening() {
		return !!this.binding;
	}
	address() {
		return this.binding ? { ...this.binding.address } : null;
	}
	listen(...args: unknown[]): this {
		if (this.listening || this.closing)
			throw failure("ERR_SERVER_ALREADY_LISTEN", "Server already listening or closing");
		const cb = typeof args.at(-1) === "function" ? (args.pop() as () => void) : undefined;
		let [port, host] = args;
		if (port && typeof port === "object" && args.length === 1) {
			if (Object.keys(port).some((key) => key !== "port" && key !== "host"))
				throw unsupported();
			({ port, host } = port as { port: unknown; host: unknown });
		} else if (args.length !== 2) throw unsupported();
		if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw unsupported();
		if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
			throw failure("ERR_SOCKET_BAD_PORT", "Expected an integer port from 0 through 65535");
		let binding: Binding;
		try {
			binding = this.registry.bind(this, host, port);
		} catch (error) {
			queueMicrotask(() => this.emit("error", error));
			return this;
		}
		this.binding = binding;
		queueMicrotask(() => {
			if (this.binding !== binding) return;
			if (cb) this.once("listening", cb);
			this.emit("listening");
		});
		return this;
	}
	close(callback?: (error?: Error) => void): this {
		if (!this.binding) {
			if (callback)
				queueMicrotask(() =>
					callback(failure("ERR_SERVER_NOT_RUNNING", "Server is not running")),
				);
			return this;
		}
		this.registry.unbind(this.binding);
		this.binding = undefined;
		this.closing = true;
		if (callback) this.once("close", callback);
		this.drained();
		return this;
	}
	private drained(): void {
		if (this.closing && !this.active)
			queueMicrotask(() => {
				if (!this.closing) return;
				this.closing = false;
				this.emit("close");
			});
	}
	getConnections(cb: (error: null, count: number) => void) {
		queueMicrotask(() => cb(null, this.active));
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
	async handle(origin: URL, data: CallbackRequest, signal: AbortSignal): Promise<CallbackReply> {
		const req = new CallbackIncoming(origin, data);
		const res = new CallbackResponse();
		this.active++;
		const abort = () => {
			req.destroy();
			res.destroy();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			return await new Promise<CallbackReply>((resolve) => {
				res.once("finish", () => resolve(res.result()));
				res.once("close", () => resolve({ type: "failed", status: 502 }));
				res.once("error", () => resolve({ type: "failed", status: 502 }));
				try {
					this.emit("request", req, res);
				} catch {
					resolve({ type: "failed", status: 500 });
				}
			});
		} finally {
			signal.removeEventListener("abort", abort);
			// Let normal request 'end'/'close' events drain on successful responses.
			if (!req.destroyed) req.resume();
			if (!res.writableFinished) res.destroy();
			this.active--;
			this.drained();
		}
	}
}

/** One registry per main process. Closing/rebinding changes the binding identity;
 * an old probe can never deliver its payload to a replacement listener. */
export class LoopbackRegistry {
	private bindings = new Map<string, Binding>();
	// A closed callback address must not start sending late callbacks to Wisp.
	private retired = new Set<string>();
	private pending = new Set<() => void>();
	private stopped = false;
	createServer(options?: object | RequestListener, listener?: RequestListener) {
		if (options && typeof options !== "function" && Object.keys(options).length)
			throw unsupported();
		return new LoopbackServer(
			this,
			typeof options === "function" ? (options as RequestListener) : listener,
		);
	}
	bind(server: LoopbackServer, host: string, port: number): Binding {
		if (this.stopped) throw failure("ERR_SERVER_NOT_RUNNING", "Application stopped");
		if (this.bindings.size >= 64) throw failure("EMFILE", "Callback listener limit reached");
		const originFor = (p: number) =>
			`http://${host === "::1" ? "[::1]" : host}${p === 80 ? "" : `:${p}`}`;
		if (!port) {
			const [start = 0] = crypto.getRandomValues(new Uint16Array(1));
			for (let i = 0; i < 16384; i++) {
				const candidate = 49152 + ((start + i) % 16384);
				if (
					!this.bindings.has(originFor(candidate)) &&
					!this.retired.has(originFor(candidate))
				) {
					port = candidate;
					break;
				}
			}
		}
		const origin = originFor(port);
		if (!port || this.bindings.has(origin))
			throw failure("EADDRINUSE", "Loopback address in use");
		const binding = {
			server,
			origin,
			address: { address: host, family: host === "::1" ? "IPv6" : "IPv4", port },
		};
		this.bindings.set(origin, binding);
		this.retired.delete(origin);
		return binding;
	}
	unbind(binding: Binding): void {
		this.bindings.delete(binding.origin);
		this.retired.add(binding.origin);
	}
	probe(value: string, port: MessagePort): void {
		const origin = URL.parse(value);
		if (!origin || !isLoopbackHTTP(origin) || origin.origin !== value || this.stopped) {
			rejectProbe(port, 410);
			return;
		}
		const binding = this.bindings.get(value);
		if (!binding) {
			if (this.retired.has(value)) rejectProbe(port, 410);
			else {
				port.postMessage({ type: "miss" } satisfies CallbackReply);
				port.close();
			}
			return;
		}
		if (this.pending.size >= 32) {
			rejectProbe(port, 503);
			return;
		}
		const controller = new AbortController();
		const finish = (reply: CallbackReply) => {
			if (!this.pending.delete(stop)) return;
			clearTimeout(timer);
			port.postMessage(reply, reply.type === "response" ? [reply.body] : []);
			port.close();
			controller.abort();
		};
		const stop = () => finish({ type: "failed", status: 410 });
		const timer = setTimeout(() => finish({ type: "failed", status: 504 }), LOOPBACK_TIMEOUT);
		this.pending.add(stop);
		let consumed = false;
		port.onmessageerror = stop;
		port.onmessage = async ({ data }: MessageEvent<CallbackRequest | { cancel: true }>) => {
			if ("cancel" in data || this.bindings.get(value) !== binding || consumed) return stop();
			consumed = true;
			if ((data.body?.byteLength ?? 0) > LOOPBACK_BYTES)
				return finish({ type: "failed", status: 413 });
			try {
				finish(await binding.server.handle(origin, data, controller.signal));
			} catch {
				finish({ type: "failed", status: 502 });
			}
		};
		port.postMessage({ type: "bound" } satisfies CallbackReply);
	}
	dispose(): void {
		this.stopped = true;
		for (const { server } of this.bindings.values()) server.close();
		for (const stop of this.pending) stop();
		this.retired.clear();
	}
}
