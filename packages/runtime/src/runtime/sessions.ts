import { EventEmitter } from "events";
import { matchesURLPattern as matches } from "../shared/urls";
import { dnsModule } from "./dns";
import { noteStub } from "./fallback";
import type { VirtualFileSystem } from "./filesystem";
import type { Network } from "./network";

interface Cookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	session: boolean;
	expirationDate?: number;
	hostOnly: boolean;
	sameSite: string;
}
type CookieInput = Partial<Cookie> & { url: string; name: string; value: string };
type Details = Record<string, unknown> & { url: string };
type Listener = (details: Details, callback: (result: Record<string, unknown>) => void) => void;
interface Registration {
	patterns: string[];
	listener: Listener;
}

export type HeadersReceived = (details: Details) => Promise<Record<string, unknown>>;
export function sessionModule<P extends object>(
	network: Network,
	vfs: VirtualFileSystem,
	createProtocol: (partition: string) => P,
	fallbackUserAgent: () => string,
	/** The partition's onHeadersReceived filter changed; renderer responses use it too. */
	rendererHeaders?: (
		partition: string,
		patterns: string[] | undefined,
		dispatch: HeadersReceived,
	) => void,
) {
	const sessions = new Map<string, Session>();
	let nextRequest = 0;
	class Session extends EventEmitter {
		readonly serviceWorkers = Object.assign(new EventEmitter(), {
			getAllRunning: () => ({}),
			startWorkerForScope: async (_url: string) => {
				noteStub("session.serviceWorkers.startWorkerForScope (browser-managed)");
			},
			getFromVersionID: () => undefined,
		});
		readonly availableSpellCheckerLanguages = [...navigator.languages];
		readonly cookies: EventEmitter & {
			get(filter?: Partial<Cookie> & { url?: string }): Promise<Cookie[]>;
			set(details: CookieInput): Promise<void>;
			remove(url: string, name: string): Promise<void>;
			flushStore(): Promise<void>;
		};
		readonly webRequest: Record<
			string,
			(filter: { urls?: string[] } | Listener | null, listener?: Listener | null) => void
		>;
		readonly protocol: P;
		private jar: Cookie[] = [];
		private userAgent?: string;
		private requestListeners = new Map<string, Registration>();
		private permissionRequestHandler: unknown;
		private permissionCheckHandler: unknown;
		private deviceHandlers: { permission?: unknown; usbProtectedClasses?: unknown } = {};
		private preloads: string[] = [];
		private registeredPreloads = new Map<
			string,
			{ id: string; type: string; filePath: string }
		>();
		private cookieFile: string;
		private proxy = "DIRECT";
		private spellchecker = true;
		private words = new Set<string>();
		private languages: string[] = [];
		storagePath?: string;
		constructor(readonly partition: string) {
			super();
			this.protocol = createProtocol(partition);
			this.cookieFile = `/home/user/.session/${encodeURIComponent(partition)}.cookies.json`;
			if (partition.startsWith("persist:") && vfs.fs.existsSync(this.cookieFile))
				this.jar = JSON.parse(String(vfs.fs.readFileSync(this.cookieFile, "utf8")));
			const persist = async () => {
				if (partition.startsWith("persist:")) {
					vfs.fs.mkdirSync("/home/user/.session", { recursive: true });
					vfs.fs.writeFileSync(this.cookieFile, JSON.stringify(this.jar));
				}
			};
			this.cookies = Object.assign(new EventEmitter(), {
				get: async (filter: Partial<Cookie> & { url?: string } = {}) => {
					this.jar = this.jar.filter(
						(cookie) =>
							!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000,
					);
					return this.jar
						.filter((cookie) => {
							if (filter.url) {
								const url = new URL(filter.url);
								const domain = cookie.domain.replace(/^\./, "");
								if (
									url.hostname !== domain &&
									(cookie.hostOnly || !url.hostname.endsWith(`.${domain}`))
								)
									return false;
								if (cookie.secure && url.protocol !== "https:") return false;
								if (
									url.pathname !== cookie.path &&
									!url.pathname.startsWith(
										cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
									)
								)
									return false;
							}
							return Object.entries(filter).every(
								([key, value]) =>
									key === "url" || Reflect.get(cookie, key) === value,
							);
						})
						.map((cookie) => ({ ...cookie }));
				},
				set: async (details: CookieInput) => {
					const url = new URL(details.url);
					const domain = (details.domain || url.hostname).replace(/^\./, "");
					if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
						throw new Error("Cookie domain does not match URL");
					const cookie: Cookie = {
						name: details.name,
						value: details.value,
						domain: details.domain || url.hostname,
						path: details.path || "/",
						secure: details.secure ?? url.protocol === "https:",
						httpOnly: details.httpOnly || false,
						session: !details.expirationDate,
						expirationDate: details.expirationDate,
						hostOnly: !details.domain,
						sameSite: details.sameSite || "unspecified",
					};
					this.jar = this.jar.filter(
						(old) =>
							old.name !== cookie.name ||
							old.domain !== cookie.domain ||
							old.path !== cookie.path,
					);
					this.jar.push(cookie);
					this.cookies.emit("changed", {}, cookie, "explicit", false);
					await persist();
				},
				remove: async (url: string, name: string) => {
					const remove = await this.cookies.get({ url, name });
					for (const cookie of remove) {
						this.jar = this.jar.filter(
							(old) =>
								old.name !== cookie.name ||
								old.domain !== cookie.domain ||
								old.path !== cookie.path,
						);
						this.cookies.emit("changed", {}, cookie, "explicit", true);
					}
					await persist();
				},
				flushStore: persist,
			});
			this.webRequest = Object.fromEntries(
				[
					"onBeforeRequest",
					"onBeforeSendHeaders",
					"onSendHeaders",
					"onHeadersReceived",
					"onResponseStarted",
					"onCompleted",
					"onErrorOccurred",
					"onBeforeRedirect",
				].map((name) => [
					name,
					(filter: { urls?: string[] } | Listener | null, listener?: Listener | null) => {
						if (typeof filter === "function") {
							listener = filter;
							filter = {};
						}
						if (!listener) this.requestListeners.delete(name);
						else
							this.requestListeners.set(name, {
								patterns: filter?.urls || ["<all_urls>"],
								listener,
							});
						if (name === "onHeadersReceived")
							rendererHeaders?.(
								partition,
								this.requestListeners.get(name)?.patterns,
								(details) =>
									this.dispatch(
										"onHeadersReceived",
										{ ...details, id: ++nextRequest },
										true,
									),
							);
					},
				]),
			);
			network.interceptors.set(partition, {
				before: async (request) => {
					const details = {
						id: ++nextRequest,
						url: request.url,
						method: request.method,
						timestamp: Date.now(),
						resourceType: "xhr",
					};
					const result = await this.dispatch("onBeforeRequest", details, true);
					if (result.cancel) throw new Error("ERR_BLOCKED_BY_CLIENT");
					const headers = new Headers(request.headers);
					if (!headers.has("User-Agent")) headers.set("User-Agent", this.getUserAgent());
					if (!headers.has("Cookie")) {
						const cookies = await this.cookies.get({ url: request.url });
						if (cookies.length)
							headers.set(
								"Cookie",
								cookies
									.map((cookie) => `${cookie.name}=${cookie.value}`)
									.join("; "),
							);
					}
					const change = await this.dispatch(
						"onBeforeSendHeaders",
						{ ...details, requestHeaders: Object.fromEntries(headers) },
						true,
					);
					if (change.cancel) throw new Error("ERR_BLOCKED_BY_CLIENT");
					await this.dispatch("onSendHeaders", details, false);
					const init = {
						method: request.method,
						headers: (change.requestHeaders as HeadersInit | undefined) || headers,
						body: ["GET", "HEAD"].includes(request.method)
							? undefined
							: await request.arrayBuffer(),
						signal: request.signal,
					};
					const outgoing = new Request(String(result.redirectURL || request.url), {
						...init,
						headers: undefined,
					});
					// Request's browser guard strips Cookie/User-Agent; libcurl can send them.
					Object.defineProperty(outgoing, "headers", {
						value: new Headers(init.headers),
					});
					return outgoing;
				},
				after: async (response, request) => {
					const raw = Reflect.get(response, "raw_headers") as
						| [string, string][]
						| undefined;
					const cookies =
						raw
							?.filter(([name]) => name.toLowerCase() === "set-cookie")
							.map(([, value]) => value) || response.headers.getSetCookie();
					for (const value of cookies) {
						const parts = value.split(";").map((part) => part.trim());
						const pair = parts.shift() || "";
						const equal = pair.indexOf("=");
						if (equal < 0) continue;
						const attributes = Object.fromEntries(
							parts.map((part) => {
								const equal = part.indexOf("=");
								return equal < 0
									? [part.toLowerCase(), true]
									: [part.slice(0, equal).toLowerCase(), part.slice(equal + 1)];
							}),
						);
						await this.cookies.set({
							url: request.url,
							name: pair.slice(0, equal),
							value: pair.slice(equal + 1),
							domain:
								typeof attributes.domain === "string"
									? attributes.domain
									: undefined,
							path:
								typeof attributes.path === "string"
									? attributes.path
									: new URL(request.url).pathname.replace(/[^/]*$/, "") || "/",
							secure: Boolean(attributes.secure),
							httpOnly: Boolean(attributes.httponly),
							expirationDate:
								typeof attributes["max-age"] === "string"
									? Date.now() / 1000 + Number(attributes["max-age"])
									: typeof attributes.expires === "string"
										? Date.parse(attributes.expires) / 1000
										: undefined,
						});
					}
					const details = {
						id: nextRequest,
						url: request.url,
						statusCode: response.status,
						responseHeaders: Object.fromEntries(
							[...response.headers].map(([name, value]) => [name, [value]]),
						),
						timestamp: Date.now(),
					};
					const change = await this.dispatch("onHeadersReceived", details, true);
					if (change.cancel) throw new Error("ERR_BLOCKED_BY_CLIENT");
					await this.dispatch("onResponseStarted", details, false);
					await this.dispatch("onCompleted", details, false);
					if (change.responseHeaders) {
						const headers = new Headers();
						for (const [name, value] of Object.entries(
							change.responseHeaders as Record<string, string | string[]>,
						))
							for (const part of Array.isArray(value) ? value : [value])
								headers.append(name, part);
						return new Response(response.body, {
							status: response.status,
							statusText: response.statusText,
							headers,
						});
					}
					return response;
				},
			});
		}
		private async dispatch(
			name: string,
			details: Details,
			blocking: boolean,
		): Promise<Record<string, unknown>> {
			const registration = this.requestListeners.get(name);
			if (!registration?.patterns.some((pattern) => matches(pattern, details.url))) return {};
			if (!blocking) {
				registration.listener(details, () => {});
				return {};
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`webRequest ${name} callback timed out`)),
					15_000,
				);
				registration.listener(details, (value) => {
					clearTimeout(timer);
					resolve(value);
				});
			});
		}
		fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
			return network.electronFetch(input, init, this.partition);
		}
		async resolveHost(hostname: string): Promise<object> {
			return { endpoints: await dnsModule(network).promises.lookup(hostname, { all: true }) };
		}
		getUserAgent(): string {
			return this.userAgent ?? fallbackUserAgent();
		}
		setUserAgent(value: string): void {
			this.userAgent = value;
		}
		getStoragePath(): string | null {
			if (this.storagePath) return this.storagePath;
			return this.partition.startsWith("persist:")
				? `/home/user/.session/${encodeURIComponent(this.partition)}`
				: null;
		}
		async clearCache(): Promise<void> {
			network.clearPartition(this.partition);
		}
		async getCacheSize(): Promise<number> {
			return 0;
		}
		async clearStorageData(): Promise<void> {
			this.jar = [];
			network.clearPartition(this.partition);
			await this.cookies.flushStore();
		}
		flushStorageData(): void {
			void this.cookies.flushStore();
		}
		async closeAllConnections(): Promise<void> {
			network.clearPartition(this.partition);
		}
		async setProxy(config: { proxyRules?: string; mode?: string }): Promise<void> {
			this.proxy = config.proxyRules || "DIRECT";
			if (this.proxy !== "DIRECT")
				noteStub("session.setProxy (stored; requests still use the configured Wisp relay)");
		}
		async resolveProxy(): Promise<string> {
			return this.proxy;
		}
		setPermissionRequestHandler(handler: unknown): void {
			this.permissionRequestHandler = handler;
		}
		getPermissionRequestHandler(): unknown {
			return this.permissionRequestHandler;
		}
		setPermissionCheckHandler(handler: unknown): void {
			this.permissionCheckHandler = handler;
		}
		/** Stored for the app. A browser grants devices only through its chooser,
		 * and its protected USB classes (HID, mass storage, ...) can't be unlocked. */
		setDevicePermissionHandler(handler: unknown): void {
			this.deviceHandlers.permission = handler;
		}
		setUSBProtectedClassesHandler(handler: unknown): void {
			this.deviceHandlers.usbProtectedClasses = handler;
		}
		getPermissionCheckHandler(): unknown {
			return this.permissionCheckHandler;
		}
		setPreloads(values: string[]): void {
			this.preloads = values;
		}
		getPreloads(): string[] {
			return [
				...this.preloads,
				...[...this.registeredPreloads.values()]
					.filter((script) => script.type === "frame")
					.map((script) => script.filePath),
			];
		}
		registerPreloadScript(script: { type: string; filePath: string }): string {
			const id = crypto.randomUUID();
			this.registeredPreloads.set(id, { ...script, id });
			return id;
		}
		unregisterPreloadScript(id: string): void {
			this.registeredPreloads.delete(id);
		}
		getPreloadScripts(): object[] {
			return [...this.registeredPreloads.values()];
		}
		async getSharedDictionaryUsageInfo(): Promise<unknown[]> {
			return [];
		}
		async getSharedDictionaryInfo(): Promise<unknown[]> {
			return [];
		}
		async clearSharedDictionaryCache(): Promise<void> {}
		setSpellCheckerEnabled(value: boolean): void {
			this.spellchecker = value;
		}
		isSpellCheckerEnabled(): boolean {
			return this.spellchecker;
		}
		setSpellCheckerLanguages(values: string[]): void {
			this.languages = values;
		}
		getSpellCheckerLanguages(): string[] {
			return [...this.languages];
		}
		addWordToSpellCheckerDictionary(word: string): boolean {
			this.words.add(word);
			return true;
		}
		removeWordFromSpellCheckerDictionary(word: string): boolean {
			return this.words.delete(word);
		}
		async listWordsInSpellCheckerDictionary(): Promise<string[]> {
			return [...this.words];
		}
	}
	const fromPartition = (partition: string): Session => {
		partition ||= "default";
		let value = sessions.get(partition);
		if (!value) {
			value = new Session(partition);
			sessions.set(partition, value);
		}
		return value;
	};
	return {
		fromPartition,
		fromPath: (filename: string) => {
			const normalized = vfs.normalizePath(filename);
			const session = fromPartition(`persist:path:${normalized}`);
			session.storagePath = normalized;
			return session;
		},
		get defaultSession() {
			return fromPartition("default");
		},
		getAllSessions: () => [...sessions.values()],
	};
}
