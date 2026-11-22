import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { Duplex, Readable, Writable } from "readable-stream";
import type { LoopbackRegistry, RequestListener } from "./loopback";
import { abortError } from "./timers";

export const STATUS_CODES: Record<number, string> = {
	100: "Continue",
	101: "Switching Protocols",
	102: "Processing",
	103: "Early Hints",
	200: "OK",
	201: "Created",
	202: "Accepted",
	203: "Non-Authoritative Information",
	204: "No Content",
	205: "Reset Content",
	206: "Partial Content",
	207: "Multi-Status",
	208: "Already Reported",
	226: "IM Used",
	300: "Multiple Choices",
	301: "Moved Permanently",
	302: "Found",
	303: "See Other",
	304: "Not Modified",
	305: "Use Proxy",
	307: "Temporary Redirect",
	308: "Permanent Redirect",
	400: "Bad Request",
	401: "Unauthorized",
	402: "Payment Required",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	406: "Not Acceptable",
	407: "Proxy Authentication Required",
	408: "Request Timeout",
	409: "Conflict",
	410: "Gone",
	411: "Length Required",
	412: "Precondition Failed",
	413: "Payload Too Large",
	414: "URI Too Long",
	415: "Unsupported Media Type",
	416: "Range Not Satisfiable",
	417: "Expectation Failed",
	418: "I'm a Teapot",
	421: "Misdirected Request",
	422: "Unprocessable Entity",
	423: "Locked",
	424: "Failed Dependency",
	425: "Too Early",
	426: "Upgrade Required",
	428: "Precondition Required",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	451: "Unavailable For Legal Reasons",
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
	505: "HTTP Version Not Supported",
	506: "Variant Also Negotiates",
	507: "Insufficient Storage",
	508: "Loop Detected",
	509: "Bandwidth Limit Exceeded",
	510: "Not Extended",
	511: "Network Authentication Required",
};
type HeaderValue = string | number | readonly string[];
export interface RequestOptions {
	url?: string;
	protocol?: string;
	hostname?: string;
	host?: string;
	port?: number | string;
	path?: string;
	auth?: string;
	method?: string;
	headers?: Record<string, HeaderValue>;
	signal?: AbortSignal;
	timeout?: number;
	redirect?: RequestRedirect;
	agent?: Agent | false;
	/** Trusted roots for this request instead of the default bundle (https). */
	ca?: unknown;
}
/** Node's `ca` option (PEM strings or Buffers, or an array of them) as one PEM bundle. */
export function caBundle(ca: unknown): string | undefined {
	if (ca === undefined || ca === null) return;
	const pem = (Array.isArray(ca) ? ca : [ca])
		.map((item) =>
			typeof item === "string"
				? item
				: item instanceof Uint8Array
					? new TextDecoder().decode(item)
					: "",
		)
		.filter(Boolean)
		.join("\n");
	return pem || undefined;
}
export function validateHeaderName(name: string): void {
	if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name))
		throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), {
			code: "ERR_INVALID_HTTP_TOKEN",
		});
}
export function validateHeaderValue(name: string, value: HeaderValue): void {
	if (value === undefined)
		throw Object.assign(new TypeError(`Invalid value "undefined" for header "${name}"`), {
			code: "ERR_HTTP_INVALID_HEADER_VALUE",
		});
	for (const item of Array.isArray(value) ? value : [value])
		if (/[^\t\x20-\x7e\x80-\xff]/.test(String(item)))
			throw Object.assign(new TypeError(`Invalid character in header content ["${name}"]`), {
				code: "ERR_INVALID_CHAR",
			});
}

/** Pooling belongs to libcurl's HTTPSession. Agent preserves configuration and
 * lifecycle expected by Node clients; it cannot expose Chromium's raw socket. */
class Agent extends EventEmitter {
	defaultPort = 80;
	protocol = "http:";
	keepAlive: boolean;
	maxSockets: number;
	maxFreeSockets: number;
	sockets = Object.create(null);
	freeSockets = Object.create(null);
	requests = Object.create(null);
	constructor(
		readonly options: {
			keepAlive?: boolean;
			maxSockets?: number;
			maxFreeSockets?: number;
			ca?: unknown;
		} = {},
	) {
		super();
		this.keepAlive = options.keepAlive ?? false;
		this.maxSockets = options.maxSockets ?? Infinity;
		this.maxFreeSockets = options.maxFreeSockets ?? 256;
	}
	getName(options: RequestOptions): string {
		return `${options.hostname || options.host || "localhost"}:${options.port || this.defaultPort}:`;
	}
	destroy(): void {
		this.emit("close");
	}
}

/** A transport lifecycle facade. Data goes through libcurl, never this stream. */
class RequestSocket extends Duplex {
	private timer?: ReturnType<typeof setTimeout>;
	connecting = true;
	encrypted: boolean;
	authorized = false;
	bytesWritten = 0;
	bytesRead = 0;
	constructor(
		readonly remoteAddress: string,
		readonly remotePort: number,
		protocol: string,
	) {
		super();
		this.encrypted = protocol === "https:";
	}
	_read(): void {}
	_write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
		callback(new Error("Raw HTTP socket writes are unavailable through the fetch transport"));
	}
	setNoDelay(): this {
		return this;
	}
	setKeepAlive(): this {
		return this;
	}
	setTimeout(milliseconds: number, callback?: () => void): this {
		clearTimeout(this.timer);
		if (callback) this.once("timeout", callback);
		if (milliseconds > 0) this.timer = setTimeout(() => this.emit("timeout"), milliseconds);
		return this;
	}
	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		clearTimeout(this.timer);
		callback(error);
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
	address() {
		return { address: "0.0.0.0", family: "IPv4", port: 0 };
	}
}

/** Content codings that fetch (libcurl and browsers) decodes. */
const DECODED = new Set(["gzip", "x-gzip", "deflate", "br"]);

export function httpModule(
	fetch: (url: string, options: RequestInit & { ca?: string }) => Promise<Response>,
	protocol = "http:",
	electron = false,
	loopback?: LoopbackRegistry,
) {
	class ProtocolAgent extends Agent {
		override defaultPort = protocol === "https:" ? 443 : 80;
		override protocol = protocol;
	}
	const globalAgent = new ProtocolAgent({ keepAlive: true });
	class IncomingMessage extends Readable {
		statusCode: number;
		statusMessage: string;
		headers: Record<string, string | string[]>;
		rawHeaders: string[];
		trailers = {};
		rawTrailers: string[] = [];
		httpVersion = "1.1";
		httpVersionMajor = 1;
		httpVersionMinor = 1;
		complete = false;
		aborted = false;
		url: string;
		connection: RequestSocket;
		private reader?: ReadableStreamDefaultReader<Uint8Array>;
		private reading = false;
		constructor(
			readonly req: ClientRequest,
			response: Response,
			readonly socket: RequestSocket,
		) {
			super();
			this.connection = socket;
			this.statusCode = response.status;
			this.statusMessage = response.statusText || STATUS_CODES[response.status] || "";
			// Fetch bodies (libcurl's and the browser's) arrive already decoded.
			// Node's http hands over the encoded bytes with their encoding, so a
			// client would decode them again; present the body as identity.
			// Electron's net module, like Chromium, keeps the header.
			const decoded =
				!electron &&
				response.headers
					.get("content-encoding")
					?.split(",")
					.every((value) => DECODED.has(value.trim().toLowerCase()));
			const kept = [...response.headers].filter(
				([name]) =>
					name !== "set-cookie" &&
					!(decoded && (name === "content-encoding" || name === "content-length")),
			);
			this.headers = Object.fromEntries(kept);
			const cookies = response.headers.getSetCookie();
			if (cookies.length) this.headers["set-cookie"] = cookies;
			this.rawHeaders = kept.flat();
			for (const cookie of cookies) this.rawHeaders.push("set-cookie", cookie);
			this.url = response.url || req.url.href;
			this.reader = response.body?.getReader();
		}
		_read(): void {
			if (this.reading || this.complete) return;
			this.reading = true;
			void (async () => {
				try {
					while (!this.destroyed) {
						const result = await this.reader?.read();
						if (!result || result.done) {
							this.complete = true;
							this.push(null);
							this.req.responseComplete();
							break;
						}
						this.socket.bytesRead += result.value.byteLength;
						this.req.activity();
						if (!this.push(Buffer.from(result.value))) break;
					}
				} catch (error) {
					this.destroy(error as Error);
				} finally {
					this.reading = false;
				}
			})();
		}
		_destroy(error: Error | null, callback: (error: Error | null) => void): void {
			if (!this.complete) {
				this.aborted = true;
				this.emit("aborted");
				this.req.destroy();
			}
			void this.reader?.cancel().catch(() => {});
			callback(error);
		}
		setTimeout(milliseconds: number, callback?: () => void): this {
			this.req.setTimeout(milliseconds, callback);
			return this;
		}
	}
	class ClientRequest extends Writable {
		readonly method: string;
		readonly path: string;
		readonly host: string;
		readonly protocol: string;
		readonly agent: Agent | false;
		readonly socket: RequestSocket;
		readonly connection: RequestSocket;
		res?: IncomingMessage;
		aborted = false;
		reusedSocket = false;
		maxHeadersCount = 2000;
		private sent = false;
		private chunks: Buffer[] = [];
		private headers = new Map<string, { name: string; value: HeaderValue }>();
		private controller = new AbortController();
		private timeout = 0;
		private timer?: ReturnType<typeof setTimeout>;
		private onAbort = () => this.destroy(abortError(this.options.signal));
		constructor(
			readonly url: URL,
			private options: RequestOptions,
		) {
			super({ autoDestroy: false } as ConstructorParameters<typeof Writable>[0] & {
				autoDestroy: boolean;
			});
			this.method = (options.method || "GET").toUpperCase();
			if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(this.method))
				throw new TypeError("Invalid HTTP method");
			this.path = url.pathname + url.search;
			this.host = url.hostname;
			this.protocol = url.protocol;
			this.agent = options.agent ?? globalAgent;
			this.socket = new RequestSocket(
				url.hostname,
				Number(url.port || (url.protocol === "https:" ? 443 : 80)),
				url.protocol,
			);
			this.connection = this.socket;
			for (const [name, value] of Object.entries(options.headers || {}))
				this.setHeader(name, value);
			if (!this.hasHeader("host")) this.setHeader("Host", url.host);
			const auth =
				options.auth ??
				(url.username
					? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
					: undefined);
			if (auth !== undefined && !this.hasHeader("authorization"))
				this.setHeader("Authorization", `Basic ${Buffer.from(auth).toString("base64")}`);
			url.username = url.password = "";
			if (options.timeout) this.setTimeout(options.timeout);
			options.signal?.addEventListener("abort", this.onAbort, { once: true });
			queueMicrotask(() => {
				if (options.signal?.aborted) this.onAbort();
				if (this.destroyed) return;
				this.emit("socket", this.socket);
				this.socket.connecting = false;
				this.socket.emit("connect");
				if (this.socket.encrypted) this.socket.emit("secureConnect");
			});
		}
		get headersSent(): boolean {
			return this.sent;
		}
		get finished(): boolean {
			return this.writableEnded;
		}
		setHeader(name: string, value: HeaderValue): this {
			if (this.sent)
				throw Object.assign(new Error("Cannot set headers after they are sent"), {
					code: "ERR_HTTP_HEADERS_SENT",
				});
			validateHeaderName(name);
			validateHeaderValue(name, value);
			this.headers.set(name.toLowerCase(), { name, value });
			return this;
		}
		getHeader(name: string): HeaderValue | undefined {
			return this.headers.get(name.toLowerCase())?.value;
		}
		getHeaders(): Record<string, HeaderValue> {
			return Object.assign(
				Object.create(null),
				Object.fromEntries([...this.headers].map(([name, entry]) => [name, entry.value])),
			);
		}
		getHeaderNames(): string[] {
			return [...this.headers.keys()];
		}
		getRawHeaderNames(): string[] {
			return [...this.headers.values()].map((entry) => entry.name);
		}
		hasHeader(name: string): boolean {
			return this.headers.has(name.toLowerCase());
		}
		removeHeader(name: string): void {
			if (this.sent)
				throw Object.assign(new Error("Cannot remove headers after they are sent"), {
					code: "ERR_HTTP_HEADERS_SENT",
				});
			this.headers.delete(name.toLowerCase());
		}
		appendHeader(name: string, value: HeaderValue): this {
			const previous = this.getHeader(name);
			return this.setHeader(
				name,
				previous === undefined ? value : [previous, value].flat().map(String),
			);
		}
		_write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void): void {
			this.chunks.push(Buffer.from(chunk));
			this.socket.bytesWritten += chunk.byteLength;
			this.activity();
			done();
		}
		_final(done: (error?: Error | null) => void): void {
			this.sent = true;
			this.activity();
			const headers: [string, string][] = [];
			for (const { name, value } of this.headers.values())
				for (const item of Array.isArray(value) ? value : [value])
					headers.push([name, String(item)]);
			const body = this.chunks.length
				? new Uint8Array(Buffer.concat(this.chunks))
				: undefined;
			this.chunks = [];
			// Browser fetch cannot send GET/HEAD bodies; libcurl has the same API.
			// Request options take precedence over the agent's, as in Node.
			const ca =
				this.url.protocol === "https:"
					? caBundle(this.options.ca ?? (this.agent ? this.agent.options.ca : undefined))
					: undefined;
			void fetch(this.url.href, {
				method: this.method,
				headers,
				body,
				signal: this.controller.signal,
				redirect: this.options.redirect ?? (electron ? "follow" : "manual"),
				...(ca && { ca }),
			}).then(
				(response) => {
					if (this.destroyed) {
						void response.body?.cancel();
						return;
					}
					this.activity();
					this.res = new IncomingMessage(this, response, this.socket);
					if (!this.emit("response", this.res)) this.res.resume();
				},
				(error: Error) => {
					if (!this.destroyed) this.destroy(error);
				},
			);
			done();
		}
		responseComplete(): void {
			clearTimeout(this.timer);
			this.destroy();
		}
		_destroy(error: Error | null, done: (error: Error | null) => void): void {
			clearTimeout(this.timer);
			this.options.signal?.removeEventListener("abort", this.onAbort);
			this.controller.abort();
			if (this.res && !this.res.complete) this.res.destroy();
			this.socket.destroy();
			this.chunks = [];
			done(error);
		}
		abort(): void {
			if (this.aborted) return;
			this.aborted = true;
			queueMicrotask(() => this.emit("abort"));
			this.destroy();
		}
		activity(): void {
			clearTimeout(this.timer);
			if (this.timeout && !this.destroyed)
				this.timer = setTimeout(() => this.emit("timeout"), this.timeout);
		}
		setTimeout(milliseconds: number, callback?: () => void): this {
			if (callback) this.once("timeout", callback);
			this.timeout = milliseconds;
			this.activity();
			return this;
		}
		setNoDelay(): this {
			this.socket.setNoDelay();
			return this;
		}
		setSocketKeepAlive(): this {
			this.socket.setKeepAlive();
			return this;
		}
		flushHeaders(): void {
			this.sent = true;
		}
	}
	const request = (
		input: string | URL | RequestOptions,
		options?: RequestOptions | ((response: IncomingMessage) => void),
		callback?: (response: IncomingMessage) => void,
	): ClientRequest => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		const fromURL = typeof input === "string" || input instanceof URL;
		const settings: RequestOptions = { ...(fromURL ? {} : input), ...options };
		const url = new URL(
			fromURL ? String(input) : settings.url || `${settings.protocol || protocol}//localhost`,
		);
		if (settings.protocol) url.protocol = settings.protocol;
		if (settings.hostname) url.hostname = settings.hostname;
		else if (settings.host) url.host = settings.host;
		if (settings.port !== undefined) url.port = String(settings.port);
		if (settings.path !== undefined) {
			const query = settings.path.indexOf("?");
			url.pathname = query < 0 ? settings.path : settings.path.slice(0, query);
			url.search = query < 0 ? "" : settings.path.slice(query);
		}
		if (!["http:", "https:"].includes(url.protocol))
			throw Object.assign(new TypeError(`Protocol ${url.protocol} not supported`), {
				code: "ERR_INVALID_PROTOCOL",
			});
		const req = new ClientRequest(url, settings);
		if (callback) req.on("response", callback);
		return req;
	};
	return {
		request,
		get: (...args: Parameters<typeof request>) => {
			const req = request(...args);
			req.end();
			return req;
		},
		ClientRequest,
		IncomingMessage,
		Agent: ProtocolAgent,
		globalAgent,
		STATUS_CODES,
		METHODS: [
			"ACL",
			"BIND",
			"CHECKOUT",
			"CONNECT",
			"COPY",
			"DELETE",
			"GET",
			"HEAD",
			"LINK",
			"LOCK",
			"M-SEARCH",
			"MERGE",
			"MKACTIVITY",
			"MKCALENDAR",
			"MKCOL",
			"MOVE",
			"NOTIFY",
			"OPTIONS",
			"PATCH",
			"POST",
			"PROPFIND",
			"PROPPATCH",
			"PURGE",
			"PUT",
			"REBIND",
			"REPORT",
			"SEARCH",
			"SOURCE",
			"SUBSCRIBE",
			"TRACE",
			"UNBIND",
			"UNLINK",
			"UNLOCK",
			"UNSUBSCRIBE",
		],
		validateHeaderName,
		validateHeaderValue,
		createServer: (
			optionsOrListener?: object | RequestListener,
			listener?: RequestListener,
		) => {
			if (!loopback || protocol !== "http:" || electron)
				throw Object.assign(
					new Error(
						"Virtual HTTP callback servers require the application's main process and plain HTTP",
					),
					{ code: "ERR_NOT_SUPPORTED" },
				);
			return loopback.createServer(optionsOrListener, listener);
		},
	};
}
