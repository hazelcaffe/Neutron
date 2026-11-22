import type { ScramjetClient } from "@mercuryworkshop/scramjet";
import { browserTarget } from "../shared/browser-links";
import { proxyContext, type ScramjetAPI, updateCookies } from "../shared/proxy-context";
import { installScramjetFixes } from "../shared/scramjet-debugger";
import { proxyTransport } from "./proxy-transport";
import { installSyncXHR } from "./sync-xhr";

installScramjetFixes(globalThis);

const api = Reflect.get(globalThis, "$scramjet") as ScramjetAPI;
const config = globalThis.__neutronProxyBootstrap;
if (config && api) {
	// In srcdoc / data documents location.origin can be "null". The proxy
	// prefix belongs to the embedding runtime, not to that document's URL.
	const origin = config.hostOrigin || location.origin;
	const context = proxyContext(api, config, origin, config.cookies);
	// Capture the real embedding window before Scramjet installs app-facing
	// proxies. The shell validates the sending window and its active session.
	const browserParent =
		config.browser &&
		typeof window !== "undefined" &&
		window.parent === window.top &&
		window.frameElement?.hasAttribute("data-neutron-browser")
			? window.parent
			: undefined;
	const browserPost = browserParent?.postMessage.bind(browserParent);
	const transport = proxyTransport(config.wisp);
	const install = (scope: typeof globalThis): ScramjetClient => {
		const navigation = Reflect.get(scope, "navigation");
		const existing = Reflect.get(scope, api.SCRAMJETCLIENT) as ScramjetClient | undefined;
		if (existing) {
			existing.syncDocumentInit({
				initHeaders: config.headers,
				history: config.history,
				cookies: config.cookies,
			});
			return existing;
		}
		const client = new api.ScramjetClient(scope, {
			context,
			transport,
			initHeaders: config.headers,
			history: config.history,
			sendSetCookie: async (cookies) => {
				updateCookies(context.cookieJar, cookies);
				navigator.serviceWorker?.controller?.postMessage({
					type: "proxy-cookies",
					id: config.id,
					cookies: cookies.map((entry) => ({
						url: String(entry.url),
						cookie: entry.cookie,
					})),
				});
			},
			hookSubcontext: (child) => install(child as unknown as typeof globalThis),
		});
		installSyncXHR(scope, origin, context.prefix, (url) => String(client.unrewriteUrl(url)));
		client.hook();
		if (navigation && !Reflect.get(scope, "navigation"))
			Object.defineProperty(scope, "navigation", { value: navigation, configurable: true });
		return client;
	};
	const client = install(globalThis);
	globalThis.__neutronProxyClient = client;
	if (browserPost) {
		const targetURL = (value: string) =>
			browserTarget(value, context.prefix)?.href ?? new URL(value, client.url).href;
		const open = (url: string) =>
			browserPost(
				{
					type: "neutron-browser-action",
					action: "open",
					session: config.id,
					url: targetURL(url),
				},
				origin,
			);
		window.open = ((url?: string | URL) => {
			if (url) open(String(url));
			return null;
		}) as typeof window.open;
		window.close = () =>
			browserPost(
				{ type: "neutron-browser-action", action: "close", session: config.id },
				origin,
			);
		document.addEventListener("click", (event) => {
			if (event.defaultPrevented) return;
			const link = (event.target as Element)?.closest?.("a[href]");
			if (!(link instanceof HTMLAnchorElement)) return;
			if (
				link.target === "_blank" ||
				link.target === "_top" ||
				link.target === "_parent" ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey
			) {
				event.preventDefault();
				open(link.href);
			}
		});
	}
}
