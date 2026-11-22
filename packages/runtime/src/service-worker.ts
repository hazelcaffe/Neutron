/// <reference lib="webworker" />
import { browserLoopback } from "./core/loopback-fetch";
import { configureProxy, proxyCookies, proxyFetch, setVirtualResponses } from "./core/proxy-worker";
import { AppStorage } from "./core/storage";
import {
	barrierPrefix,
	baseFromScript,
	fileGatePrefix,
	filePrefix,
	protocolPrefix,
	runtimeBase,
	runtimePath,
	syncPrefix,
} from "./shared/base";
import { PROXY_COOKIES } from "./shared/proxy-context";
import { installScramjetFixes } from "./shared/scramjet-debugger";
import { parse, type SyncRequest, type SyncResult, stringify } from "./shared/sync";
import { type FilePatch, HOST_WORKER_PROTOCOL } from "./shared/types";
import { parseProtocolURL } from "./shared/urls";

declare const self: ServiceWorkerGlobalScope;
// This worker is served at <base>sw.js with scope <base>.
baseFromScript(self.location.href, 0);
// Scramjet v2 snapshots the Blob URL APIs in every realm. Service workers do
// not expose them, so keep worker-created rewriter blobs in this worker.
const workerBlobs = new Map<string, Blob>();
Reflect.set(globalThis, "__neutronSWBlobs", workerBlobs);
if (!URL.createObjectURL) {
	URL.createObjectURL = (blob: Blob) => {
		const url = `blob:${self.location.origin}/${crypto.randomUUID()}`;
		workerBlobs.set(url, blob);
		return url;
	};
	URL.revokeObjectURL = (url) => {
		workerBlobs.delete(url);
	};
}
installScramjetFixes(globalThis);
importScripts(runtimePath("vendor/scramjet/scramjet_bundled.js"));
const MIME: Record<string, string> = {
	html: "text/html",
	htm: "text/html",
	js: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	css: "text/css",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	wasm: "application/wasm",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	webm: "video/webm",
	txt: "text/plain",
	map: "application/json",
};
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Disk writes and browser file reads meet in this worker, never on a blocked
// renderer thread. A read waits only for already-announced writes to its app.
const fileWrites = new Map<string, Promise<void>>();
let storageReady: Promise<AppStorage> | undefined;
function persistFiles(id: string, patches: FilePatch[]): Promise<void> {
	const previous = fileWrites.get(id) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			if (!storageReady) {
				const storage = new AppStorage();
				storageReady = storage
					.init()
					.then(() => storage)
					.catch((error) => {
						storageReady = undefined;
						throw error;
					});
			}
			await (await storageReady).persist(id, patches);
		});
	fileWrites.set(id, next);
	return next.finally(() => {
		if (fileWrites.get(id) === next) fileWrites.delete(id);
	});
}

// Write announcements arrive by message; a read can overtake one. The shell
// registers a gate synchronously after each announcement (gateFiles in
// core/runtime-worker.ts), and reads of that app wait until it arrives.
const UUID = /^[\da-f-]{36}$/i;
/** Highest announcement received, by stream (one per shell page). */
const announced = new Map<string, number>();
const awaitingAnnouncement = new Map<string, { seq: number; arrived(): void }[]>();
/** By app id: reads wait for these announcements. */
const fileGates = new Map<string, Promise<void>>();
function announce(gate: unknown): void {
	const { stream, seq } = (gate ?? {}) as { stream?: unknown; seq?: unknown };
	if (typeof stream !== "string" || typeof seq !== "number") return;
	announced.set(stream, Math.max(seq, announced.get(stream) ?? 0));
	const waiting = awaitingAnnouncement.get(stream) ?? [];
	for (const waiter of waiting.filter((item) => item.seq <= seq)) waiter.arrived();
}
function gateFiles(id: string, stream: string, seq: number): void {
	if ((announced.get(stream) ?? 0) >= seq) return;
	const arrived = new Promise<void>((resolve) => {
		const waiter = {
			seq,
			arrived: () => {
				clearTimeout(timer);
				const waiting = awaitingAnnouncement.get(stream)?.filter((item) => item !== waiter);
				if (waiting?.length) awaitingAnnouncement.set(stream, waiting);
				else awaitingAnnouncement.delete(stream);
				resolve();
			},
		};
		// The announcement was posted before its gate; this only bounds a lost one
		// (the shell's page closing mid-post), after which reads proceed as before.
		const timer = setTimeout(() => {
			console.warn(`File write announcement ${stream}/${seq} did not arrive`);
			waiter.arrived();
		}, 10_000);
		awaitingAnnouncement.set(stream, [...(awaitingAnnouncement.get(stream) ?? []), waiter]);
	});
	const gate = Promise.all([fileGates.get(id), arrived]).then(() => {});
	fileGates.set(id, gate);
	void gate.then(() => {
		if (fileGates.get(id) === gate) fileGates.delete(id);
	});
}
self.addEventListener("message", (event) => {
	const type = event.data?.type;
	if (type === "runtime-handshake" || type === "persist-files" || type === "proxy-configure") {
		const port = event.ports[0];
		// These host RPCs are sent by the shell, not by an application frame.
		if (
			!port ||
			!event.source ||
			!("frameType" in event.source) ||
			event.source.frameType !== "top-level"
		) {
			port?.postMessage({ error: "Invalid runtime host request" });
			port?.close();
			return;
		}
		if (type === "runtime-handshake") {
			port.postMessage({ ok: true, protocol: HOST_WORKER_PROTOCOL });
			port.close();
			return;
		}
		const { id, patches } = event.data;
		if (
			type === "persist-files" &&
			(typeof id !== "string" || !UUID.test(id) || !Array.isArray(patches))
		) {
			announce(event.data.gate);
			port.postMessage({ error: "Invalid storage request" });
			port.close();
			return;
		}
		const work =
			type === "persist-files"
				? persistFiles(id, patches)
				: configureProxy(event.data.session, event.source.id);
		// After persistFiles registered the write, which reads then wait for.
		if (type === "persist-files") announce(event.data.gate);
		event.waitUntil(
			work
				.then(
					() => port.postMessage({ ok: true }),
					(error) => port.postMessage({ error: String(error) }),
				)
				.finally(() => port.close()),
		);
	}
	if (type === PROXY_COOKIES)
		event.waitUntil(
			proxyCookies(
				event.data.id,
				event.data.cookies,
				event.source instanceof Client ? event.source : null,
				event.ports[0],
			),
		);
});

/** Raw virtual resources. All browser content rewriting is performed by Scramjet v2. */
async function appFile(request: Request): Promise<Response> {
	try {
		const url = new URL(request.url);
		const parts = url.pathname.slice(filePrefix().length).split("/").map(decodeURIComponent);
		const id = parts.shift();
		if (!id || parts.some((part) => part === ".." || part === "." || /[\\/\0]/.test(part)))
			return new Response("Invalid virtual path", { status: 400 });
		await fileGates.get(id);
		const pending = fileWrites.get(id);
		if (pending) {
			try {
				await pending;
			} catch (error) {
				return new Response(`Virtual file write failed: ${String(error)}`, { status: 500 });
			}
		}
		let root = await navigator.storage.getDirectory();
		for (const name of ["neutron", "apps", id]) root = await root.getDirectoryHandle(name);
		let links: Record<string, string> = {};
		try {
			links = JSON.parse(
				await (await (await root.getFileHandle("links.json")).getFile()).text(),
			);
		} catch {
			/* No symlinks. */
		}
		let virtual = `/${parts.join("/")}`;
		for (let depth = 0; depth < 40; depth++) {
			const prefix = Object.keys(links).find(
				(link) => virtual === link || virtual.startsWith(`${link}/`),
			);
			if (!prefix) break;
			virtual = new URL(
				`${links[prefix]}${virtual.slice(prefix.length)}`,
				`https://virtual.invalid${prefix}`,
			).pathname;
			if (depth === 39) throw new Error("Symlink loop");
		}
		const resolved = virtual.split("/").filter(Boolean);
		const name = resolved.pop();
		if (!name) return new Response("Not a file", { status: 404 });
		root = await root.getDirectoryHandle("fs");
		for (const part of resolved) root = await root.getDirectoryHandle(part);
		const file = await (await root.getFileHandle(name)).getFile();
		const type = MIME[name.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
		const headers = {
			"Cross-Origin-Embedder-Policy": "credentialless",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Content-Type": type,
			"Cache-Control": "no-store",
			"Accept-Ranges": "bytes",
		};
		const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
		if (range) {
			const start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
			const end =
				range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
			if (start > end || start >= file.size)
				return new Response(null, {
					status: 416,
					headers: { "Content-Range": `bytes */${file.size}` },
				});
			return new Response(request.method === "HEAD" ? null : file.slice(start, end + 1), {
				status: 206,
				headers: {
					...headers,
					"Content-Range": `bytes ${start}-${end}/${file.size}`,
					"Content-Length": String(end - start + 1),
				},
			});
		}
		return new Response(request.method === "HEAD" ? null : file, { headers });
	} catch (error) {
		return new Response(`Virtual file unavailable: ${String(error)}`, { status: 404 });
	}
}
async function protocolResponse(
	id: string,
	url: string,
	request: Request,
	partition = "default",
): Promise<Response> {
	const nonce = crypto.randomUUID();
	const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
	return new Promise((resolve, reject) => {
		const channel = new BroadcastChannel(`neutron-protocol:${id}`);
		const timer = setTimeout(() => {
			channel.close();
			reject(new Error("Protocol handler timed out"));
		}, 15_000);
		channel.onmessage = (
			event: MessageEvent<{
				nonce: string;
				error?: string;
				body: Uint8Array;
				status: number;
				headers: [string, string][];
			}>,
		) => {
			if (event.data.nonce !== nonce) return;
			clearTimeout(timer);
			channel.close();
			if (event.data.error) reject(new Error(event.data.error));
			else
				resolve(
					new Response(
						request.method === "HEAD" || [204, 205, 304].includes(event.data.status)
							? null
							: new Uint8Array(event.data.body),
						{ status: event.data.status, headers: event.data.headers },
					),
				);
		};
		channel.postMessage({
			partition,
			nonce,
			url,
			method: request.method,
			headers: [...request.headers],
			body,
		});
	});
}
// An app document's barrier script (ProxySession.addonBarrier). Parsing stops
// at it until its renderer.js finishes asynchronous preload setup, so the
// app's own scripts still run after its preloads. The renderer answers
// "waiting" with "ready" once done, and also sends "ready" unprompted.
function barrier(token: string): Promise<Response> {
	return new Promise((resolve) => {
		const channel = new BroadcastChannel(`neutron-barrier:${token}`);
		const release = (body = "") => {
			clearTimeout(timer);
			channel.close();
			resolve(
				new Response(body, {
					headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
				}),
			);
		};
		// A renderer that failed to load must not hang the document.
		const timer = setTimeout(
			() => release('console.warn("Neutron: renderer setup timed out");'),
			60_000,
		);
		channel.onmessage = (event) => {
			if (event.data === "ready") release();
		};
		channel.postMessage("waiting");
	});
}
setVirtualResponses(async (session, target, request, callback) => {
	if (session.browser) {
		if (callback)
			return browserLoopback(
				session,
				callback.owner ? await self.clients.get(callback.owner) : undefined,
				target,
				request.method,
				callback,
			);
		if (/^https?:$/.test(target.protocol)) return undefined;
		// A committed navigation to a desktop scheme is handled by the
		// owning tab's host. Asset/XHR requests never trigger app events.
		// External pages cannot fetch OPFS or an Electron protocol handler.
		return new Response("This address can only be opened by its registered application.", {
			status: 403,
			headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
		});
	}
	if (session.schemes?.includes(target.protocol.slice(0, -1)))
		return protocolResponse(
			session.runId ?? session.id,
			target.href,
			request,
			session.partition,
		);
	if (/^https?:$/.test(target.protocol)) return undefined;
	if (target.protocol === "file:")
		return appFile(
			new Request(
				`${self.location.origin}${filePrefix()}${session.appId}${target.pathname}${target.search}`,
				{ method: request.method, headers: request.headers },
			),
		);
	return protocolResponse(session.runId ?? session.id, target.href, request, session.partition);
});
self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith(fileGatePrefix())) {
		const [id = "", stream = "", seq = ""] = url.pathname
			.slice(fileGatePrefix().length)
			.split("/");
		const valid = UUID.test(id) && UUID.test(stream) && /^\d{1,15}$/.test(seq);
		// Registered before responding: the shell's request blocks until then.
		if (valid) gateFiles(id, stream, Number(seq));
		event.respondWith(new Response(null, { status: valid ? 204 : 400 }));
		return;
	}
	if (url.pathname.startsWith(barrierPrefix())) {
		const token = url.pathname.slice(barrierPrefix().length);
		event.respondWith(
			/^[\da-f-]{36}$/i.test(token)
				? barrier(token)
				: Promise.resolve(new Response("Invalid barrier", { status: 400 })),
		);
		return;
	}
	if (url.pathname.startsWith(runtimePath("__scramjet__/"))) {
		event.respondWith(proxyFetch(event));
		return;
	}
	if (url.pathname.startsWith(filePrefix())) {
		event.respondWith(appFile(event.request));
		return;
	}
	if (url.pathname.startsWith(protocolPrefix())) {
		const parsed = parseProtocolURL(url);
		event.respondWith(
			protocolResponse(parsed.instanceId, parsed.url, event.request).catch(
				(error) => new Response(String(error), { status: 502 }),
			),
		);
		return;
	}
	if (url.pathname.startsWith(syncPrefix()))
		event.respondWith(
			(async () => {
				const [instanceId, target] = url.pathname.slice(syncPrefix().length).split("/");
				if (!instanceId || !["main", "host"].includes(target || ""))
					return new Response(stringify({ error: "Invalid synchronous bridge target" }), {
						status: 400,
					});
				const request = parse(await event.request.text()) as SyncRequest;
				return new Promise<Response>((resolve) => {
					const channel = new BroadcastChannel(`neutron-${target}:${instanceId}`);
					const finish = (result: SyncResult) => {
						clearTimeout(timer);
						channel.close();
						resolve(
							new Response(stringify(result), {
								headers: {
									"Content-Type": "application/json",
									"Cache-Control": "no-store",
								},
							}),
						);
					};
					const timer = setTimeout(
						() =>
							finish({
								nonce: request.nonce,
								error: "Synchronous bridge timed out (handler may depend on the blocked renderer)",
							}),
						15_000,
					);
					channel.onmessage = (event: MessageEvent<SyncResult>) => {
						if (event.data.nonce === request.nonce) finish(event.data);
					};
					channel.postMessage(request);
				});
			})().catch(
				(error) => new Response(stringify({ error: String(error) }), { status: 500 }),
			),
		);
	else if (
		url.pathname.startsWith(runtimeBase()) &&
		// Only documents and worker scripts carry the isolation policy;
		// same-origin subresources pass through untouched.
		(event.request.mode === "navigate" ||
			["worker", "sharedworker"].includes(event.request.destination))
	)
		event.respondWith(isolated(event.request));
});

// Static hosts such as GitHub Pages cannot send cross-origin isolation
// headers. Add them to this site's own documents and worker scripts.
async function isolated(request: Request): Promise<Response> {
	const response = await fetch(request);
	if (
		response.type === "opaque" ||
		response.type === "opaqueredirect" ||
		response.status < 200 ||
		response.status > 599 ||
		(response.headers.has("Cross-Origin-Embedder-Policy") &&
			response.headers.has("Cross-Origin-Opener-Policy"))
	)
		return response;
	const headers = new Headers(response.headers);
	if (!headers.has("Cross-Origin-Embedder-Policy"))
		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
	if (!headers.has("Cross-Origin-Opener-Policy"))
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
