import { proxyTransport } from "../runtime/proxy-transport";
import { runtimePath, scramjetPrefix } from "../shared/base";
import { isLoopbackHTTP } from "../shared/loopback";
import {
	type FetchHandler,
	proxyContext,
	type ScramjetAPI,
	updateCookies,
} from "../shared/proxy-context";
import { applyHeaderFilter, BlockedByClient } from "./header-filter";
import type { BrowserCallback } from "./loopback-fetch";
import type { ProxySession } from "./proxy";
import { applyCookieMode } from "./proxy-cookie-mode";

declare const self: ServiceWorkerGlobalScope;
const configurations = "neutron-scramjet-v2";
const running = new Map<string, Promise<{ handler: FetchHandler; browser: boolean }>>();
const jars = new Map<string, ReturnType<typeof proxyContext>["cookieJar"]>();
const configURL = (id: string) =>
	new URL(runtimePath(`__neutron_proxy_config__/${id}`), self.location.origin).href;
const cookieURL = (session: ProxySession) =>
	new URL(
		runtimePath(
			`__neutron_proxy_cookies__/${session.appId}${session.browser ? "/external-browser" : !session.partition || session.partition === "default" ? "" : `/${encodeURIComponent(session.partition.startsWith("persist:") ? session.partition : session.id)}`}`,
		),
		self.location.origin,
	).href;
export async function configureProxy(session: ProxySession, owner: string): Promise<void> {
	const cache = await caches.open(configurations);
	// SW-only routing metadata survives a worker restart, but no live listener,
	// payload or host Client identifier is copied into a page's proxy bootstrap.
	await cache.put(
		configURL(session.id),
		Response.json(session, {
			headers: session.browser ? { "X-Neutron-Owner": owner } : {},
		}),
	);
	running.delete(session.id);
}
export async function proxyCookies(
	id: string,
	cookies: { url: string; cookie: string }[],
): Promise<void> {
	const jar = jars.get(id);
	if (!jar) return;
	updateCookies(jar, cookies);
	const cache = await caches.open(configurations);
	const session = (await (await cache.match(configURL(id)))?.json()) as ProxySession | undefined;
	if (session) await cache.put(cookieURL(session), new Response(jar.dump()));
}
export async function proxyFetch(
	event: FetchEvent,
	virtual: (
		session: ProxySession,
		url: URL,
		request: Request,
		callback?: BrowserCallback,
	) => Promise<Response | undefined>,
): Promise<Response> {
	const api = Reflect.get(globalThis, "$scramjet") as ScramjetAPI;
	const id = new URL(event.request.url).pathname
		.slice(runtimePath("__scramjet__/").length)
		.split("/")[0];
	if (!id) return new Response("Missing app proxy session", { status: 400 });
	let pending = running.get(id);
	if (!pending) {
		pending = (async () => {
			const cache = await caches.open(configurations);
			const stored = await cache.match(configURL(id));
			if (!stored) throw new Error("App proxy session expired; restart the application");
			const session = (await stored.json()) as ProxySession;
			const owner = stored.headers.get("X-Neutron-Owner");
			const cookieData = await (await cache.match(cookieURL(session)))?.text();
			const context = proxyContext(api, session, self.location.origin, cookieData);
			jars.set(id, context.cookieJar);
			const handler = new api.ScramjetFetchHandler({
				context,
				transport: proxyTransport(session.wisp),
				crossOriginIsolated: true,
				sendSetCookie: async () => {
					await cache.put(cookieURL(session), new Response(context.cookieJar.dump()));
				},
				fetchDataUrl: async (url) => api.BareResponse.fromNativeResponse(await fetch(url)),
				fetchBlobUrl: async (url) => {
					const blob = (
						Reflect.get(globalThis, "__neutronSWBlobs") as Map<string, Blob> | undefined
					)?.get(url);
					return api.BareResponse.fromNativeResponse(
						blob ? new Response(blob) : await fetch(url),
					);
				},
			});
			// Virtual callbacks must see the same cookie policy as network requests.
			applyCookieMode(api, handler);
			api.Tap.tap(handler.hooks.fetch.request, async (input: unknown, output: unknown) => {
				const { parsed, request } = input as {
					parsed: { url: URL };
					request: {
						method: string;
						loopbackCaller: boolean | string;
						loopbackSignal: AbortSignal;
						initialHeaders: { toRawHeaders(): [string, string][] };
						body: ArrayBuffer | null;
					};
				};
				// Use Scramjet's outbound headers directly. Constructing a native
				// Request here would drop virtual Cookie/Origin/etc. as forbidden.
				const callback =
					session.browser && isLoopbackHTTP(parsed.url)
						? {
								owner,
								caller: request.loopbackCaller,
								signal: request.loopbackSignal,
								headers: (output as { init: { headers: [string, string][] } }).init
									.headers,
								body: request.body ?? undefined,
							}
						: undefined;
				const response = await virtual(
					session,
					parsed.url,
					new Request(parsed.url, {
						method: request.method,
						headers: callback ? undefined : request.initialHeaders.toRawHeaders(),
						body:
							callback || ["GET", "HEAD"].includes(request.method)
								? undefined
								: request.body,
					}),
					callback,
				);
				if (response)
					Reflect.set(
						output as object,
						"earlyResponse",
						api.BareResponse.fromNativeResponse(response),
					);
			});
			if (!session.browser && session.headerFilters?.length)
				api.Tap.tap(handler.hooks.fetch.preresponse, (input: unknown, output: unknown) =>
					applyHeaderFilter(api, session, input, output),
				);
			return { handler, browser: !!session.browser };
		})();
		running.set(id, pending);
	}
	let browser = false;
	try {
		const loaded = await pending;
		const handler = loaded.handler;
		browser = loaded.browser;
		const clientId = event.resultingClientId || event.clientId || "untracked";
		if (!handler.trackedClients.has(clientId))
			handler.trackedClients.set(clientId, { clientId, history: [] });
		const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
		const request = event.request;
		const prefix = `${self.location.origin}${scramjetPrefix(id)}`;
		const result = await handler.handleFetch({
			// Authorization is per fetch, never captured from the first event that
			// built this cached handler. First iframe commits have no source client.
			loopbackCaller: client
				? client.frameType !== "top-level" && client.url.startsWith(prefix)
				: !event.clientId && request.mode === "navigate" && request.destination === "iframe"
					? request.referrer
					: false,
			loopbackSignal: request.signal,
			rawUrl: new URL(request.url),
			rawReferrer: request.referrer || null,
			rawDestination: request.destination,
			mode: request.mode,
			credentials: request.credentials,
			referrer: request.referrer,
			method: request.method,
			cache: request.cache,
			clientId,
			rawClientUrl: client?.url ? new URL(client.url) : undefined,
			// Only the virtual cookie jar can supply a guest Cookie header.
			initialHeaders: api.ScramjetHeaders.fromRawHeaders(
				[...request.headers].filter(([key]) => key !== "cookie"),
			),
			body: ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer(),
		});
		const headers = new Headers(result.headers.toRawHeaders());
		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
		headers.delete("Content-Length");
		return new Response(
			request.method === "HEAD" || [204, 205, 304].includes(result.status)
				? null
				: (result.body as BodyInit),
			{ status: result.status, statusText: result.statusText, headers },
		);
	} catch (error) {
		// A webRequest listener cancelled the request: a network error, as in Electron.
		if (error instanceof BlockedByClient) return Response.error();
		// Transport/rewriter errors can contain the URL, including a callback query.
		const detail = browser
			? "External browser request failed"
			: error instanceof Error
				? error.stack
				: String(error);
		console.error("Scramjet v2 request failed", browser ? detail : error);
		return new Response(detail, {
			status: 502,
			headers: {
				"Cross-Origin-Embedder-Policy": "credentialless",
				"Content-Type": "text/plain",
			},
		});
	}
}
