import type { ScramjetClient } from "@mercuryworkshop/scramjet";
import { browserTarget } from "../shared/browser-links";
import {
	acknowledged,
	PROXY_COOKIES,
	type ProxyCookies,
	proxyContext,
	type ScramjetAPI,
	updateCookies,
} from "../shared/proxy-context";
import { installScramjetFixes } from "../shared/scramjet-debugger";
import type { BrowserTabs } from "../shared/types";
import { proxyTransport } from "./proxy-transport";
import { installSyncXHR } from "./sync-xhr";

installScramjetFixes(globalThis);

/** The shell's tab operations, when this document is (inside) a Neutron Browser tab. */
function browserTab(): { tabs: BrowserTabs; top: boolean } | undefined {
	if (typeof window === "undefined") return;
	try {
		for (let current: Window = window; current.parent !== current; current = current.parent)
			if (current.parent === current.top) {
				const tabs = current.top.__neutron?.browser;
				return tabs && current.frameElement?.hasAttribute("data-neutron-browser")
					? { tabs, top: current === window }
					: undefined;
			}
	} catch {
		/* A cross-origin ancestor is not part of a Neutron tab. */
	}
}
// HTML "parse a boolean feature" for window.open's features string.
function featureEnabled(features: string, name: string): boolean {
	for (const part of features.split(/[\s,]+/)) {
		const [key, value = ""] = part.split("=");
		if (key?.toLowerCase() !== name) continue;
		if (value === "" || /^(?:yes|true)$/i.test(value)) return true;
		return (Number.parseInt(value, 10) || 0) !== 0;
	}
	return false;
}

const api = Reflect.get(globalThis, "$scramjet") as ScramjetAPI;
const config = globalThis.__neutronProxyBootstrap;
if (config && api) {
	// In srcdoc / data documents location.origin can be "null". The proxy
	// prefix belongs to the embedding runtime, not to that document's URL.
	const origin = config.hostOrigin || location.origin;
	const context = proxyContext(api, config, origin, config.cookies);
	// Capture the real embedding shell and service worker before Scramjet
	// installs app-facing proxies (it removes navigator.serviceWorker).
	const browser = config.browser ? browserTab() : undefined;
	const serviceWorker = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
	// A cookie written here must reach the session's network jar and its other
	// live documents. Closing a tab waits for that, as a browser's shared
	// cookie store would already have it.
	let cookieWrites: Promise<unknown> = Promise.resolve();
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
				const controller = serviceWorker?.controller;
				if (!controller) return;
				const message: ProxyCookies = {
					type: PROXY_COOKIES,
					id: config.id,
					cookies: cookies.map((entry) => ({
						url: String(entry.url),
						cookie: entry.cookie,
					})),
				};
				const written = acknowledged((port) => controller.postMessage(message, [port]));
				cookieWrites = Promise.all([cookieWrites, written]);
				await written;
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
	// Cookies set by another document of this session, or by a response to one
	// of its requests, before that request resolves in this document.
	serviceWorker?.addEventListener("message", (event: MessageEvent) => {
		const data = event.data as ProxyCookies | undefined;
		if (data?.type !== PROXY_COOKIES || data.id !== config.id || !Array.isArray(data.cookies))
			return;
		updateCookies(context.cookieJar, data.cookies);
		event.ports[0]?.postMessage(true);
	});
	serviceWorker?.startMessages();
	if (browser) {
		const { tabs } = browser;
		const targetURL = (value: string) =>
			browserTarget(value, context.prefix)?.href ?? new URL(value, client.url).href;
		const ownOpen = window.open;
		// A sandboxed tab cannot create real popups. Open the popup as another
		// tab and return its live window: `closed`, `opener`, `postMessage` and
		// location changes then behave as between a page and its popup.
		window.open = ((url?: string | URL, target?: string, features?: string) => {
			const name = target === undefined || target === null ? "" : String(target);
			if (/^_(?:self|parent|top)$/i.test(name))
				return ownOpen.call(window, url, name, features);
			const href = url === undefined || String(url) === "" ? "" : targetURL(String(url));
			const feature = String(features ?? "");
			const opener =
				!featureEnabled(feature, "noopener") && !featureEnabled(feature, "noreferrer");
			const popup = tabs.open(window, href, name, opener);
			if (!popup) return null;
			if (!Reflect.has(popup, api.SCRAMJETCLIENT)) {
				// Still its initial about:blank document: the opener may write to it,
				// navigate it or close it before a proxied page loads there.
				install(popup as unknown as typeof globalThis);
				Object.defineProperty(popup, "close", {
					configurable: true,
					writable: true,
					value: () => tabs.close(popup),
				});
			}
			return popup;
		}) as typeof window.open;
	}
	if (browser?.top) {
		const { tabs } = browser;
		const tab = window;
		Object.defineProperty(window, "opener", {
			configurable: true,
			enumerable: true,
			get: () => tabs.opener(tab),
			set: (value: unknown) => {
				if (value === null) tabs.disown(tab);
				else
					Object.defineProperty(tab, "opener", {
						value,
						writable: true,
						configurable: true,
						enumerable: true,
					});
			},
		});
		window.close = () => {
			void cookieWrites.then(() => tabs.close(tab));
		};
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
				// Like a browser, a link opens its new tab without an opener.
				tabs.open(
					window,
					browserTarget(link.href, context.prefix)?.href ?? link.href,
					"",
					false,
				);
			}
		});
	}
}
