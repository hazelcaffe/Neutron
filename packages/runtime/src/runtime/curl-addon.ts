import { Buffer } from "buffer";
import { libcurl } from "libcurl.js";
import type { Network } from "./network";

// Stable public libcurl ids, not indexes into a particular wrapper's enums.
const option = Object.freeze({
	URL: 10002,
	USERAGENT: 10018,
	HTTPHEADER: 10023,
	CUSTOMREQUEST: 10036,
	POSTFIELDS: 10015,
	POST: 47,
	HTTPGET: 80,
	FOLLOWLOCATION: 52,
	WRITEFUNCTION: 20011,
	HEADERFUNCTION: 20079,
	TIMEOUT_MS: 155,
	TIMEOUT: 13,
	ACCEPT_ENCODING: 10102,
	VERBOSE: 41,
	NOPROGRESS: 43,
	HTTP_VERSION: 84,
	SSL_VERIFYPEER: 64,
	SSL_VERIFYHOST: 81,
	SSL_OPTIONS: 216,
	CAINFO_BLOB: 40309,
	DEBUGFUNCTION: 20094,
	PROXY: 10004,
	MAXREDIRS: 68,
	COOKIEFILE: 10031,
});
const info = Object.freeze({
	RESPONSE_CODE: 0x200002,
	EFFECTIVE_URL: 0x100001,
	SIZE_DOWNLOAD: 0x300008,
	TOTAL_TIME: 0x300003,
	REDIRECT_COUNT: 0x200014,
});
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const validText = (v: unknown): v is string => typeof v === "string" && !/[\r\n\0]/.test(v);
const flag = (v: unknown) => v === true || v === false || v === 1 || v === 0;
const id = (values: Record<string, number>, key: string | number) =>
	typeof key === "number" ? key : Object.hasOwn(values, key) ? values[key] : undefined;

class CurlFailure extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

type ChunkCallback = (buf: Buffer, size: number, nmemb: number) => number;
interface Options {
	url?: string;
	agent?: string;
	headers?: Record<string, string>;
	method?: string;
	post?: boolean;
	body?: Uint8Array;
	header?: ChunkCallback;
	write?: ChunkCallback;
	decode?: boolean;
	verbose?: boolean;
	timeout?: number;
	httpVersion?: number;
	follow?: boolean;
	maxRedirects?: number;
	nativeCA?: boolean;
	cookies?: boolean;
	debug?: (type: number, bytes: Buffer) => unknown;
}
interface Result {
	status: number;
	url: string;
}

// The Fetch facade resolves at the first body byte, normalizes headers and
// can mask a subsequent CURLE_PARTIAL_FILE. Use the callbacks on the pinned
// libcurl.js 0.7.5 HTTPSession instead. request_async still owns the request,
// POST buffer and http_set_options; Network.init owns WASM, TLS and Wisp.
interface RawSession {
	request_async(url: string, params: object, body?: Uint8Array): Promise<Result>;
	create_request(
		url: string,
		data: (b: Uint8Array) => void,
		end: (code: number) => void,
		headers: (b: Uint8Array) => void,
	): number;
	event_loop: ReturnType<typeof setInterval> | null;
	close_now(): void;
	close(): void;
	export_cookies(): string;
	requests_list: number[];
	remove_request_now(request: number): void;
}
const Session = libcurl.HTTPSession as unknown as new (options?: object) => RawSession;
class Transfer extends Session {
	failure?: Error;
	constructor(
		readonly onHeader: (b: Uint8Array) => void,
		readonly onBody: (b: Uint8Array) => void,
		readonly signal: AbortSignal,
		readonly jar?: string,
	) {
		super(jar === undefined ? {} : { enable_cookies: true, cookie_jar: jar });
	}
	static create_response(_stream: unknown, result: Result) {
		return result;
	}
	stream_response(url: string, report: () => void, finish: (code: number) => void) {
		let done = false;
		const end = (code: number) => {
			if (done) return;
			done = true;
			this.signal.removeEventListener("abort", abort);
			// http_get_info must be read before request_cleanup, including on a
			// successful zero-byte response. Do not resolve on a partial transfer.
			if (code > 0) this.failure = new CurlFailure(code, libcurl.get_error_string(code));
			try {
				if (code === 0 && !this.signal.aborted) report();
			} catch (error) {
				// Never unwind JS through curl_multi_perform or leave the caller
				// pending if the bridge could not read the native result.
				this.failure = new CurlFailure(2, String(error));
				code = -1;
			}
			finish(this.signal.aborted ? -1 : code);
		};
		// Never free the POST buffer from inside a C callback.
		const abort = () => queueMicrotask(() => end(-1));
		this.signal.addEventListener("abort", abort, { once: true });
		return this.create_request(url, this.onBody, end, this.onHeader);
	}
	// One session per in-flight transfer. Its finally block cleans up outside
	// curl_multi_perform. Do not also schedule upstream's deferred removal.
	remove_request() {}
	dispose() {
		if (this.event_loop !== null) clearInterval(this.event_loop);
		// Removing completed requests flushes libcurl's cookie jar. Export it
		// before HTTPSession.close unlinks this handle's private temporary file.
		for (const request of [...this.requests_list]) this.remove_request_now(request);
		if (this.jar !== undefined) {
			try {
				return this.export_cookies();
			} finally {
				this.close();
			}
		}
		this.close_now();
		return "";
	}
}

function parseHeaders(lines: unknown): Record<string, string> | undefined {
	if (!Array.isArray(lines)) return;
	const headers: Record<string, string> = Object.create(null);
	const seen = new Set<string>();
	for (const line of lines) {
		if (!validText(line)) return;
		const colon = line.indexOf(":"),
			key = line.slice(0, colon),
			lower = key.toLowerCase();
		// libcurl.js accepts an object; it cannot represent duplicate fields or
		// libcurl's semicolon syntax for transmitting an empty field.
		if (colon <= 0 || !token.test(key) || seen.has(lower)) return;
		seen.add(lower);
		headers[key] = line.slice(colon + 1).trimStart();
	}
	return headers;
}

export const isCurlAddon = (filename: string) => /(?:^|[/\\])node_libcurl\.node$/.test(filename);
export function curlAddonLoader(network: Network) {
	let binding: object | undefined;
	return (filename: string) => {
		if (!isCurlAddon(filename)) return;
		binding ??= createBinding(network);
		return binding;
	};
}

function createBinding(network: Network) {
	const open = (isOpen: boolean) => {
		if (!isOpen) throw new Error("Curl handle is closed");
	};
	function unsupported(name: string) {
		console.warn(`node_libcurl: ${name} is not supported by the browser libcurl backend`);
		return 4; // CURLE_NOT_BUILT_IN
	}
	class Easy {
		isOpen = true;
		get isInsideMultiHandle() {
			return !!this.owner;
		}
		readonly isMonitoringSockets = false;
		owner?: Multi;
		opts: Options = {};
		result: Result = { status: 0, url: "" };
		elapsed = 0;
		received: number | undefined = 0;
		redirects = 0;
		private jar = "";
		private active?: AbortController;
		static strError(code: number) {
			return libcurl.ready ? libcurl.get_error_string(code) : `libcurl error ${code}`;
		}
		setOpt(key: number | string, v: unknown): number {
			open(this.isOpen);
			if (this.owner) throw new Error("Remove the easy handle before changing its options");
			const o = this.opts;
			const k = id(option, key);
			switch (k) {
				case option.URL:
				case option.USERAGENT:
				case option.CUSTOMREQUEST: {
					if (v !== null && !validText(v)) return 43;
					if (k === option.CUSTOMREQUEST && v !== null && !token.test(v)) return 43;
					o[k === option.URL ? "url" : k === option.USERAGENT ? "agent" : "method"] =
						v ?? undefined;
					break;
				}
				case option.HTTPHEADER: {
					const headers = v === null ? undefined : parseHeaders(v);
					if (!headers && v !== null) return 43;
					o.headers = headers;
					break;
				}
				case option.POSTFIELDS:
					if (typeof v !== "string" && !Buffer.isBuffer(v)) return 43;
					o.body = Buffer.from(v);
					o.post = true;
					break;
				case option.POST:
				case option.HTTPGET:
					if (!flag(v)) return 43;
					if (k === option.POST) o.post = !!v;
					else if (v) o.post = false;
					break;
				case option.WRITEFUNCTION:
				case option.HEADERFUNCTION:
					if (v !== null && typeof v !== "function") return 43;
					o[k === option.WRITEFUNCTION ? "write" : "header"] = (v ?? undefined) as
						| ChunkCallback
						| undefined;
					break;
				case option.FOLLOWLOCATION:
				case option.VERBOSE:
					if (!flag(v)) return 43;
					o[k === option.FOLLOWLOCATION ? "follow" : "verbose"] = !!v;
					break;
				case option.NOPROGRESS:
					if (v !== 1 && v !== true) return unsupported("progress reporting");
					break;
				case option.ACCEPT_ENCODING:
					if (v !== "" && v !== null) return unsupported("ACCEPT_ENCODING list");
					o.decode = v === "";
					break;
				case option.TIMEOUT:
				case option.TIMEOUT_MS: {
					if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return 43;
					const ms = v * (k === option.TIMEOUT ? 1000 : 1);
					if (ms > 0x7fffffff) return 43;
					o.timeout = ms;
					break;
				}
				case option.HTTP_VERSION:
					if (v !== 1 && v !== 2 && v !== 3) return unsupported("HTTP_VERSION");
					o.httpVersion = [1, 1.1, 2][v - 1];
					break;
				case option.SSL_VERIFYPEER:
					return v === 1 || v === true ? 0 : unsupported("disabling SSL_VERIFYPEER");
				case option.SSL_VERIFYHOST:
					return v === 2 ? 0 : unsupported("changing SSL_VERIFYHOST");
				case option.SSL_OPTIONS:
					if (v !== 0 && v !== 16) return unsupported("SSL_OPTIONS flags");
					// NATIVE_CA affects TLS handshakes only. Check it at perform
					// time and on every redirect before opening a TLS connection.
					o.nativeCA = v === 16;
					break;
				case option.CAINFO_BLOB:
					return unsupported("CAINFO_BLOB (custom trust store)");
				case option.DEBUGFUNCTION:
					if (v !== null && typeof v !== "function") return 43;
					o.debug = (v ?? undefined) as Options["debug"];
					break;
				case option.PROXY:
					if (v !== "" && v !== null) return unsupported("explicit proxy");
					break; // No HTTP/SOCKS proxy is configured on this handle.
				case option.MAXREDIRS:
					if (typeof v !== "number" || !Number.isSafeInteger(v) || v < -1) return 43;
					o.maxRedirects = v;
					break;
				case option.COOKIEFILE:
					if (v !== "" && v !== null) return unsupported("cookie input file");
					o.cookies = v === "";
					if (!o.cookies) this.jar = "";
					break;
				default:
					return 48; // CURLE_UNKNOWN_OPTION
			}
			return 0;
		}
		getInfo(key: string | number) {
			open(this.isOpen);
			switch (id(info, key)) {
				case info.RESPONSE_CODE:
					return { code: 0, data: this.result.status };
				case info.EFFECTIVE_URL:
					return { code: 0, data: this.result.url };
				case info.SIZE_DOWNLOAD:
					return this.received === undefined
						? { code: 4, data: null }
						: { code: 0, data: this.received };
				case info.TOTAL_TIME:
					return { code: 0, data: this.elapsed };
				case info.REDIRECT_COUNT:
					return { code: 0, data: this.redirects };
				default:
					return { code: 48, data: null };
			}
		}
		perform() {
			open(this.isOpen);
			return unsupported("blocking Easy.perform");
		}
		reset() {
			open(this.isOpen);
			if (this.owner) throw new Error("Easy handle is inside a multi handle");
			this.opts = {};
			this.active = undefined;
			this.result = { status: 0, url: "" };
			this.elapsed = 0;
			this.received = 0;
			this.redirects = 0;
		}
		close() {
			this.reset();
			this.isOpen = false;
		}
		async run(controller: AbortController) {
			const { signal } = controller,
				o = this.opts;
			this.active = controller;
			this.elapsed = 0;
			this.redirects = 0;
			this.received = 0;
			let url = o.url && URL.parse(o.url);
			if (!url) throw new CurlFailure(3, "URL missing or malformed");
			if (!/^https?:$/.test(url.protocol)) throw new CurlFailure(1, "Unsupported protocol");
			this.result.url = url.href;
			const started = performance.now();
			try {
				await network.init();
				signal.throwIfAborted();
				const headers = Object.assign(Object.create(null), o.headers);
				const names = Object.keys(headers).map((k) => k.toLowerCase());
				if (o.agent !== undefined && !names.includes("user-agent"))
					headers["User-Agent"] = o.agent;
				if (!o.decode && !names.includes("accept-encoding"))
					headers["Accept-Encoding"] = "";
				const deliver = (fn: ChunkCallback | undefined, b: Buffer) => {
					if (fn && fn.call(this, b, 1, b.length) !== b.length)
						throw new CurlFailure(23, "Short write from libcurl callback");
				};
				const guarded = (fn: (b: Buffer) => void) => (bytes: Uint8Array) => {
					if (signal.aborted) return;
					try {
						// libcurl.js already copied this chunk out of WASM memory.
						fn(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
					} catch (e) {
						controller.abort(
							e instanceof CurlFailure ? e : new CurlFailure(42, String(e)),
						);
					}
				};
				let sendBody = !!o.post;
				while (true) {
					signal.throwIfAborted();
					if (o.nativeCA && url.protocol === "https:")
						throw new CurlFailure(4, "Native CA store unavailable for TLS");
					if (url.protocol !== "http:" && url.protocol !== "https:")
						throw new CurlFailure(1, "Unsupported redirect protocol");
					this.result = { url: url.href, status: 0 };
					let location: string | undefined,
						encoded = false,
						complete = false,
						contentLength: number | undefined,
						count = 0;
					const redirects = () =>
						!!o.follow &&
						!!location &&
						[301, 302, 303, 307, 308].includes(this.result.status);
					const debug = (type: number, b: Buffer) => {
						if (o.verbose && o.debug) o.debug.call(this, type, Buffer.from(b));
					};
					const session = new Transfer(
						guarded((b) => {
							const line = b.toString("latin1"),
								status = /^HTTP\/\S+ (\d{3})\b/.exec(line);
							if (status) {
								this.result.status = Number(status[1]);
								location = undefined;
								encoded = false;
								contentLength = undefined;
							} else if (/^location:/i.test(line)) location = line.slice(9).trim();
							else if (/^content-length:\s*\d+\s*$/i.test(line))
								contentLength = Number(line.slice(15).trim());
							else if (/^content-encoding:/i.test(line))
								encoded = line.slice(17).trim().toLowerCase() !== "identity";
							// http_set_options always enables decoding. Never deliver decoded
							// bytes as if they were an unmodified encoded representation.
							if (!o.decode && encoded && !redirects())
								throw new CurlFailure(
									4,
									"Raw encoded response bodies are not available",
								);
							debug(1, b);
							deliver(o.header, b);
						}),
						guarded((b) => {
							if (redirects()) return;
							count += b.length;
							if (!encoded) debug(3, b);
							deliver(o.write, b);
						}),
						signal,
						o.cookies ? this.jar : undefined,
					);
					try {
						const result = await session.request_async(
							url.href,
							{
								headers,
								redirect: "manual",
								...(o.method ? { method: o.method } : {}),
								...(o.verbose && !o.debug ? { _libcurl_verbose: 1 } : {}),
								_libcurl_http_version:
									o.httpVersion ?? (url.protocol === "http:" ? 1.1 : 2),
							},
							sendBody ? (o.body ?? new Uint8Array()) : undefined,
						);
						signal.throwIfAborted();
						this.result = result;
						complete = true;
					} catch (error) {
						throw session.failure ?? error;
					} finally {
						const jar = session.dispose();
						// A caller can remove and immediately reuse this Easy handle
						// from a header callback before the old request unwinds.
						if (this.active === controller) {
							this.received = !encoded ? count : complete ? contentLength : undefined;
							if (o.cookies && !signal.aborted) this.jar = jar;
						}
					}
					if (!redirects() || !location) return;
					const limit = o.maxRedirects ?? 30;
					if (limit >= 0 && this.redirects >= limit)
						throw new CurlFailure(47, "Maximum redirects exceeded");
					const next: URL | null = URL.parse(location, url.href);
					if (!next) throw new CurlFailure(3, "Malformed redirect URL");
					// Never forward guest credentials or a custom Host to a new origin.
					if (url.origin !== next.origin) {
						if (
							next.username ||
							next.password ||
							sendBody ||
							names.some(
								(k) =>
									![
										"user-agent",
										"accept",
										"accept-encoding",
										"accept-language",
									].includes(k),
							)
						)
							throw new CurlFailure(
								4,
								"Cross-origin redirects with credentials, a body or custom headers are not supported",
							);
					}
					if ([301, 302, 303].includes(this.result.status)) sendBody = false;
					this.redirects++;
					url = next;
				}
			} finally {
				if (this.active === controller) this.elapsed = (performance.now() - started) / 1000;
			}
		}
	}
	class Multi {
		private handles = new Map<Easy, AbortController>();
		private callback?: (err: Error | null, easy: Easy, code: number) => void;
		isOpen = true;
		getCount = () => this.handles.size;
		onMessage(cb: Multi["callback"] | null) {
			open(this.isOpen);
			if (cb != null && typeof cb !== "function") throw new TypeError("Expected a callback");
			this.callback = cb ?? undefined;
			return this;
		}
		setOpt() {
			open(this.isOpen);
			return 6;
		} // CURLM_UNKNOWN_OPTION
		addHandle(easy: Easy) {
			open(this.isOpen);
			if (!(easy instanceof Easy) || !easy.isOpen) return 2;
			if (easy.owner) return 7;
			const ctl = new AbortController();
			easy.owner = this;
			this.handles.set(easy, ctl);
			easy.result = { status: 0, url: "" };
			const timer = easy.opts.timeout
				? setTimeout(
						() => ctl.abort(new CurlFailure(28, "Operation timed out")),
						easy.opts.timeout,
					)
				: undefined;
			void (async () => {
				let error: Error | null = null,
					code = 0;
				try {
					await easy.run(ctl);
					ctl.signal.throwIfAborted();
				} catch (e) {
					const reason = ctl.signal.aborted ? ctl.signal.reason : e;
					error = reason instanceof Error ? reason : new Error(String(reason));
					code = reason instanceof CurlFailure ? reason.code : 2;
				} finally {
					clearTimeout(timer);
				}
				// Removing a handle cancels without a DONE message. An old request
				// cannot complete a subsequently re-added handle.
				if (this.handles.get(easy) === ctl) this.callback?.(error, easy, code);
			})();
			return 0;
		}
		removeHandle(easy: Easy) {
			open(this.isOpen);
			const ctl = this.handles.get(easy);
			if (!ctl) return 2;
			this.handles.delete(easy);
			easy.owner = undefined;
			ctl.abort();
			return 0;
		}
		close() {
			open(this.isOpen);
			for (const easy of this.handles.keys()) this.removeHandle(easy);
			this.isOpen = false;
			this.callback = undefined;
		}
	}
	return {
		Easy,
		Multi,
		Share: class {
			constructor() {
				throw new Error("Shared curl handles are not supported");
			}
		},
		Curl: {
			option,
			info,
			multi: Object.freeze({}),
			// The worker preloads WASM before synchronous require; in a renderer
			// which hasn't initialized it, synchronous native init is unavailable.
			globalInit: (flags = 3) => (flags !== 3 ? 4 : libcurl.ready ? 0 : 2),
			// WASM global state belongs to Network and may have other users.
			globalCleanup: () => {
				throw new Error("Global cleanup of shared libcurl is not supported");
			},
			getVersion: () => {
				if (!libcurl.version) throw new Error("libcurl is not initialized");
				return `libcurl/${libcurl.version.curl} ${libcurl.version.ssl}`;
			},
			get VERSION_NUM() {
				return libcurl.version?.curl
					.split(".")
					.slice(0, 3)
					.reduce((n, s) => (n << 8) + Number.parseInt(s, 10), 0);
			},
		},
	};
}
