import { proxyTransport } from "../runtime/proxy-transport";
import { isLoopbackHTTP } from "../shared/loopback";
import {
	acknowledged,
	type FetchHandler,
	PROXY_COOKIES,
	type ProxyCookies,
	proxyContext,
	type ScramjetAPI,
	updateCookies,
} from "../shared/proxy-context";
import type { BrowserCallback } from "./loopback-fetch";
import type { ProxySession } from "./proxy";
import { applyCookieMode } from "./proxy-cookie-mode";

declare const self: ServiceWorkerGlobalScope;
type VirtualResponse = (
	session: ProxySession,
	url: URL,
	request: Request,
	callback?: BrowserCallback,
) => Promise<Response | undefined>;
interface LoadedSession {
	session: ProxySession;
	handler: FetchHandler;
	jar: ReturnType<typeof proxyContext>["cookieJar"];
	persist(): Promise<void>;
}
const configurations = "neutron-scramjet-v2";
const running = new Map<string, Promise<LoadedSession>>();
let virtual: VirtualResponse = async () => undefined;
/** Neutron's own responses (files, app protocols, loopback callbacks) take
 * precedence over the network for every proxy session. */
export function setVirtualResponses(respond: VirtualResponse): void {
	virtual = respond;
}
const configURL = (id: string) =>
	new URL(`/__neutron_proxy_config__/${id}`, self.location.origin).href;
const cookieURL = (session: ProxySession) =>
	new URL(
		`/__neutron_proxy_cookies__/${session.appId}${session.browser ? "/external-browser" : !session.partition || session.partition === "default" ? "" : `/${encodeURIComponent(session.partition.startsWith("persist:") ? session.partition : session.id)}`}`,
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
/**
 * Every document of a proxy session reads cookies from its own copy of the
 * session's jar (Scramjet's document.cookie). Give live documents the cookies
 * another document or a network response set, as a browser's shared cookie
 * store would. `wait` lists the clients whose acknowledgement must arrive
 * first; "all" waits for every recipient.
 */
async function shareCookies(
	session: ProxySession,
	cookies: ProxyCookies["cookies"],
	{ wait, skip }: { wait: string[] | "all"; skip?: string },
): Promise<void> {
	const prefix = new URL(`/__scramjet__/${session.id}/`, self.location.origin).href;
	const message: ProxyCookies = { type: PROXY_COOKIES, id: session.id, cookies };
	const deliveries: Promise<void>[] = [];
	for (const client of await self.clients.matchAll({ type: "window" })) {
		if (client.id === skip || !client.url.startsWith(prefix)) continue;
		const delivered = acknowledged((port) => client.postMessage(message, [port]));
		if (wait === "all" || wait.includes(client.id)) deliveries.push(delivered);
	}
	await Promise.all(deliveries);
}
/** document.cookie in one of the session's documents. */
export async function proxyCookies(
	id: string,
	cookies: ProxyCookies["cookies"],
	source: Client | null,
	reply?: MessagePort,
): Promise<void> {
	try {
		const prefix = new URL(`/__scramjet__/${id}/`, self.location.origin).href;
		if (!source?.url.startsWith(prefix) || !Array.isArray(cookies)) return;
		// After a worker restart the session may not have handled a request yet.
		const loaded = await loadSession(id);
		updateCookies(loaded.jar, cookies);
		await loaded.persist();
		await shareCookies(loaded.session, cookies, { wait: "all", skip: source.id });
	} catch {
		/* An expired session has no jar left to update. */
	} finally {
		reply?.postMessage(true);
		reply?.close();
	}
}
function loadSession(id: string): Promise<LoadedSession> {
	const api = Reflect.get(globalThis, "$scramjet") as ScramjetAPI;
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
			const persist = () =>
				cache.put(cookieURL(session), new Response(context.cookieJar.dump()));
			const handler = new api.ScramjetFetchHandler({
				context,
				transport: proxyTransport(session.wisp),
				crossOriginIsolated: true,
				sendSetCookie: persist,
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
			// After applyCookieMode has removed cookies this request may not set.
			// The requesting document must hold them before its fetch resolves.
			api.Tap.tap(
				handler.hooks.fetch.preresponse,
				async (input: unknown, output: unknown) => {
					const { parsed, request } = input as {
						parsed: { url: URL };
						request: { requester: string };
					};
					const cookies = (
						output as { response: { rawHeaders: [string, string][] } }
					).response.rawHeaders
						.filter(([key]) => key.toLowerCase() === "set-cookie")
						.map(([, cookie]) => ({ url: parsed.url.href, cookie }));
					if (cookies.length)
						await shareCookies(session, cookies, { wait: [request.requester] });
				},
			);
			return { session, handler, jar: context.cookieJar, persist };
		})();
		running.set(id, pending);
	}
	return pending;
}
export async function proxyFetch(event: FetchEvent): Promise<Response> {
	const api = Reflect.get(globalThis, "$scramjet") as ScramjetAPI;
	const id = new URL(event.request.url).pathname.split("/")[2];
	if (!id) return new Response("Missing app proxy session", { status: 400 });
	let browser = false;
	try {
		const loaded = await loadSession(id);
		const handler = loaded.handler;
		browser = !!loaded.session.browser;
		const clientId = event.resultingClientId || event.clientId || "untracked";
		if (!handler.trackedClients.has(clientId))
			handler.trackedClients.set(clientId, { clientId, history: [] });
		const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
		const request = event.request;
		const prefix = `${self.location.origin}/__scramjet__/${id}/`;
		const result = await handler.handleFetch({
			// Authorization is per fetch, never captured from the first event that
			// built this cached handler. First iframe commits have no source client.
			loopbackCaller: client
				? client.frameType !== "top-level" && client.url.startsWith(prefix)
				: !event.clientId && request.mode === "navigate" && request.destination === "iframe"
					? request.referrer
					: false,
			loopbackSignal: request.signal,
			requester: event.clientId,
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
