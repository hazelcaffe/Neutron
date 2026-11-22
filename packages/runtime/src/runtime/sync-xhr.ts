// The URL supplied by Scramjet's XHR.open hook is already rewritten. The
// helper only transports that request and delivers results to the caller.
type OpenArgs = [string, string, boolean, string?, string?];
export function installSyncXHR(
	scope: typeof globalThis,
	origin: string,
	prefix: URL,
	unmap: (url: string) => string,
): void {
	const NativeWorker = scope.Worker;
	const post = scope.Worker?.prototype.postMessage;
	const host = embeddingHost()?.__neutron;
	let worker: Worker | undefined;
	const overrides = new WeakMap<XMLHttpRequest, string[]>();
	Reflect.set(scope, "__neutronResetXHR", (xhr: XMLHttpRequest) => {
		for (const key of overrides.get(xhr) ?? []) Reflect.deleteProperty(xhr, key);
		overrides.delete(xhr);
	});
	Reflect.set(
		scope,
		"__neutronSyncXHR",
		(
			xhr: XMLHttpRequest,
			args: OpenArgs,
			headers: Record<string, string> = {},
			body: XMLHttpRequestBodyInit | null = null,
		) => {
			if (typeof SharedArrayBuffer === "undefined" || !NativeWorker)
				throw new DOMException(
					"Synchronous proxied XHR requires cross-origin isolation",
					"NetworkError",
				);
			const url = new URL(args[1], origin);
			if (url.origin !== origin || !url.pathname.startsWith(prefix.pathname))
				throw new DOMException("Invalid sync XHR session", "NetworkError");
			const memory = new SharedArrayBuffer(4096, { maxByteLength: 64 * 1024 * 1024 });
			const data = new Int32Array(memory, 0, 3);
			const request = {
				memory,
				method: args[0],
				url: url.href,
				user: args[3],
				password: args[4],
				headers,
				body: body instanceof URLSearchParams ? body.toString() : body,
			};
			if (host) host.syncXHR(request);
			else {
				worker ??= new NativeWorker(`${origin}/runtime/xhr-worker.js`, {
					name: "neutron-sync-xhr",
				});
				Reflect.apply(post, worker, [request]);
			}
			const deadline = performance.now() + 16000;
			while (Atomics.load(data, 0) === 0) {
				if (performance.now() > deadline) {
					worker?.terminate();
					worker = undefined;
					throw new DOMException("Synchronous XHR timed out", "NetworkError");
				}
				if (typeof window === "undefined") Atomics.wait(data, 0, 0, 100);
			}
			if (Atomics.load(data, 0) < 0)
				throw new DOMException("Synchronous XHR failed or exceeded 64 MiB", "NetworkError");
			const metaLength = data[1] ?? 0;
			const meta = JSON.parse(
				new TextDecoder().decode(new Uint8Array(memory, 12, metaLength).slice()),
			) as { status: number; statusText: string; url: string; headers: string };
			const bytes = new Uint8Array(memory, 12 + metaLength, data[2]).slice();
			const responseHeaders = new Headers();
			for (const line of meta.headers.split("\r\n")) {
				const colon = line.indexOf(":");
				if (colon > 0)
					responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim());
			}
			const mime = responseHeaders.get("content-type") || "";
			let text: string | undefined;
			const readText = () => {
				if (text === undefined) {
					let decoder: TextDecoder;
					try {
						decoder = new TextDecoder(/charset=["']?([^;\s"']+)/i.exec(mime)?.[1]);
					} catch {
						decoder = new TextDecoder();
					}
					text = decoder.decode(bytes);
				}
				return text;
			};
			const values: Record<string, unknown> = {
				readyState: 4,
				status: meta.status,
				statusText: meta.statusText,
				responseURL: unmap(meta.url),
				getAllResponseHeaders: () => meta.headers,
				getResponseHeader: (name: string) => responseHeaders.get(name),
			};
			const type = xhr.responseType;
			const response =
				type === "arraybuffer"
					? bytes.buffer
					: type === "blob"
						? new Blob([bytes], { type: mime })
						: type === "json"
							? (() => {
									try {
										return JSON.parse(readText());
									} catch {
										return null;
									}
								})()
							: readText();
			const xml =
				/(?:\/|\+)xml(?:;|$)/i.test(mime) && typeof DOMParser !== "undefined"
					? new DOMParser().parseFromString(readText(), "application/xml")
					: null;
			Object.assign(values, {
				response: type === "document" ? xml : response,
				responseXML: xml,
			});
			for (const [key, value] of Object.entries(values))
				Object.defineProperty(xhr, key, { configurable: true, value });
			Object.defineProperty(xhr, "responseText", {
				configurable: true,
				get: () => {
					if (type && type !== "text")
						throw new DOMException("Response is not text", "InvalidStateError");
					return readText();
				},
			});
			overrides.set(xhr, [...Object.keys(values), "responseText"]);
			xhr.dispatchEvent(new Event("readystatechange"));
			for (const name of ["load", "loadend"])
				xhr.dispatchEvent(
					new ProgressEvent(name, {
						lengthComputable: true,
						loaded: bytes.length,
						total: bytes.length,
					}),
				);
		},
	);
	if (typeof window !== "undefined")
		scope.addEventListener(
			"pagehide",
			() => {
				worker?.terminate();
				worker = undefined;
			},
			{ once: true },
		);
}

import { embeddingHost } from "./transport";
