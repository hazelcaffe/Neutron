/// <reference lib="webworker" />

interface SyncRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: XMLHttpRequestBodyInit | null;
	user?: string;
	password?: string;
	memory: SharedArrayBuffer;
}
// Native *asynchronous* XHR allows the service worker to serve the encoded
// URL. Chromium sometimes bypasses the service worker for synchronous sends.
self.onmessage = ({ data }: MessageEvent<SyncRequest>) => {
	const control = new Int32Array(data.memory, 0, 3);
	const xhr = new XMLHttpRequest();
	const fail = () => {
		Atomics.store(control, 0, -1);
		Atomics.notify(control, 0);
	};
	try {
		xhr.open(data.method, data.url, true, data.user, data.password);
		for (const [key, value] of Object.entries(data.headers)) xhr.setRequestHeader(key, value);
		xhr.responseType = "arraybuffer";
		xhr.timeout = 15000;
		xhr.onabort = xhr.onerror = xhr.ontimeout = fail;
		xhr.onload = () => {
			try {
				const body = new Uint8Array(xhr.response || 0);
				const meta = new TextEncoder().encode(
					JSON.stringify({
						status: xhr.status,
						statusText: xhr.statusText,
						url: xhr.responseURL,
						headers: xhr.getAllResponseHeaders(),
					}),
				);
				const size = 12 + meta.length + body.length;
				if (size > data.memory.byteLength) data.memory.grow(size);
				const output = new Uint8Array(data.memory);
				output.set(meta, 12);
				output.set(body, 12 + meta.length);
				control[1] = meta.length;
				control[2] = body.length;
				Atomics.store(control, 0, 1);
				Atomics.notify(control, 0);
			} catch {
				fail();
			}
		};
		xhr.send(data.body);
	} catch {
		fail();
	}
};
self.postMessage({ ready: true });
