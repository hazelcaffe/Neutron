import type { ProxyTransport, RawHeaders } from "@mercuryworkshop/proxy-transports";
import type { CookieJar, ScramjetClient, ScramjetContext } from "@mercuryworkshop/scramjet";
import type { ProxySession } from "../core/proxy";

export type ProxyBootstrap = ProxySession & {
	hostOrigin: string;
	url: string;
	cookies: string;
	headers: RawHeaders;
	history: { url: string }[];
};
export interface FetchResponse {
	body?: string | Uint8Array | ArrayBuffer | ReadableStream | Blob;
	status: number;
	statusText: string;
	headers: { toRawHeaders(): RawHeaders };
}
export interface FetchHandler {
	trackedClients: Map<string, { clientId: string; history: { url: string }[] }>;
	handleFetch(request: object): Promise<FetchResponse>;
	hooks: { fetch: { request: object; preresponse: object } };
}
export type ScramjetAPI = typeof import("@mercuryworkshop/scramjet") & {
	ScramjetFetchHandler: new (init: {
		transport: ProxyTransport;
		context: ScramjetContext;
		crossOriginIsolated: boolean;
		sendSetCookie: (cookies: { url: URL; cookie: string }[]) => Promise<void>;
		fetchDataUrl: (url: string) => Promise<unknown>;
		fetchBlobUrl: (url: string) => Promise<unknown>;
	}) => FetchHandler;
};
declare global {
	var __neutronProxyBootstrap: ProxyBootstrap | undefined;
	var __neutronProxyClient: ScramjetClient | undefined;
}
export function proxyContext(
	api: ScramjetAPI,
	session: ProxySession,
	origin: string,
	cookies = "",
): ScramjetContext {
	const cookieJar = new api.CookieJar();
	if (cookies) cookieJar.load(cookies);
	const context: ScramjetContext = {
		config: {
			...api.defaultConfig,
			maskedfiles: ["/runtime/", "/vendor/"],
			flags: {
				...api.defaultConfig.flags,
				captureErrors: false,
				cleanErrors: false,
				syncxhr: false,
				// A data: module has no hierarchical base URL. Keep rewritten
				// worker entry points on their session URL so the browser can link
				// Scramjet's root-relative module specifiers.
				encapsulateWorkers: false,
			},
		},
		prefix: new URL(`/__scramjet__/${session.id}/`, origin),
		cookieJar,
		interface: {
			codecEncode: encodeURIComponent,
			codecDecode: decodeURIComponent,
			getInjectScripts(meta, _handler, html, script) {
				const config: ProxyBootstrap = {
					...session,
					hostOrigin: origin,
					url: meta.origin.href,
					cookies: context.cookieJar.dump(),
					headers: html.headers || [],
					history: html.history || [],
				};
				const source = `globalThis.__neutronProxyBootstrap=${JSON.stringify(config)};`;
				return [
					script(`${origin}/vendor/scramjet/scramjet_bundled.js`),
					script(
						`data:application/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`,
					),
					...(session.browser
						? []
						: [
								script(`${origin}/vendor/sqlite/sql-wasm.js`),
								script(`${origin}/runtime/sqlite-bootstrap.js`),
							]),
					script(`${origin}/runtime/proxy-client.js`),
					...(session.browser ? [] : [script(`${origin}/runtime/renderer.js`)]),
				];
			},
			getWorkerInjectScripts(meta, isModule, script) {
				const config: ProxyBootstrap = {
					...session,
					hostOrigin: origin,
					url: meta.origin.href,
					cookies: context.cookieJar.dump(),
					headers: [],
					history: [],
				};
				const setup = `globalThis.__neutronProxyBootstrap=${JSON.stringify(config)};`;
				// Module imports are hoisted. Put config initialization in its own
				// imported module so it runs before the client module evaluates.
				return `${script(`${origin}/vendor/scramjet/scramjet_bundled.js`)}\n${isModule ? script(`data:application/javascript;base64,${btoa(unescape(encodeURIComponent(setup)))}`) : setup}\n${script(`${origin}/runtime/proxy-client.js`)}\n`;
			},
		},
	};
	return context;
}
export function updateCookies(
	jar: CookieJar,
	cookies: { url: URL | string; cookie: string }[],
): void {
	for (const entry of cookies) jar.setCookies(entry.cookie, new URL(entry.url));
}
