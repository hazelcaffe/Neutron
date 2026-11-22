import path from "path-browserify";
import { answerRpc, RpcClient } from "../runtime/rpc";
import { appLinkScheme, browserTarget } from "../shared/browser-links";
import { LOOPBACK_PROBE, rejectProbe } from "../shared/loopback";
import type { SyncRequest, SyncResult } from "../shared/sync";
import {
	applicationEntry,
	errorText,
	type FilePatch,
	type InstalledApp,
	type LogEntry,
	type RendererConfig,
	type RpcMessage,
	type RpcResult,
	type RuntimeBridge,
	type Snapshot,
	type WindowOptions,
} from "../shared/types";
import { resolveEntry } from "./importer";
import { encodeProxyURL, type PageProxy, type ProxySession } from "./proxy";
import type { AppStorage } from "./storage";

interface HostedWindow {
	browser?: ProxySession;
	returnTo?: number;
	menuVisible: boolean;
	menu?: MenuData[];
	isView?: boolean;
	id: number;
	element: HTMLElement;
	frame: HTMLIFrameElement;
	options: WindowOptions;
	remote: boolean;
	visible: boolean;
	url?: string;
	awaitingCommit?: boolean;
	loading: "created" | "loading" | "dom-ready" | "loaded" | "failed";
	error?: string;
	parentId?: number;
	reportedSize?: { width: number; height: number };
	listeners: Set<(message: Record<string, unknown>) => void>;
}
export interface AppWindow {
	id: number;
	title: string;
	active: boolean;
	visible: boolean;
	url: string;
	loading: HostedWindow["loading"];
	error?: string;
	views: number;
	/** A web-only Neutron Browser tab opened by shell.openExternal(). */
	browser: boolean;
}
export interface HostEvents {
	log(entry: LogEntry): void;
	state(state: "starting" | "running" | "stopped" | "failed"): void;
	menu(items: MenuData[]): void;
	console(open: boolean): void;
	toast(message: string): void;
	files(filename: string): void;
	windows(items: AppWindow[]): void;
}
export interface MenuData {
	id: string;
	label: string;
	role?: string;
	type: string;
	enabled: boolean;
	visible: boolean;
	checked: boolean;
	submenu?: MenuData[];
}

export class RuntimeHost {
	private worker?: Worker;
	private rpc?: RpcClient;
	private stopping?: Promise<void>;
	private app?: InstalledApp;
	private instanceId = "";
	private syncChannel?: BroadcastChannel;
	private snapshot: Snapshot = {};
	private windows = new Map<number, HostedWindow>();
	private activeWindow?: number;
	private nextBrowserId = -1;
	private selectionHistory: number[] = [];
	private wisp = "";
	private strict = false;
	private platform: "linux" | "win32" | "darwin" = "linux";
	private startupTimer?: ReturnType<typeof setTimeout>;
	private abort = new AbortController();
	private shortcuts: string[] = [];
	private appMenu: MenuData[] = [];
	private readonly emptyMenu: MenuData[] = [];
	private displayedMenu?: MenuData[];
	private wake?: WakeLockSentinel;
	/** Arguments for the instance `app.relaunch()` requested when this one exits. */
	private relaunch?: string[];
	constructor(
		private desktop: HTMLElement,
		private storage: AppStorage,
		private proxy: PageProxy,
		private events: HostEvents,
	) {
		const bridge: RuntimeBridge = {
			syncXHR: (request) => this.proxy.syncXHR(request),
			config: (windowId, filename) => {
				const window = this.windows.get(windowId);
				if (!this.app || !window || window.browser)
					throw new Error("Renderer no longer belongs to a running app");
				return {
					strict: this.strict,
					platform: this.platform,
					instanceId: this.instanceId,
					app: this.app,
					snapshot: structuredClone(this.snapshot),
					wisp: this.wisp,
					windowId,
					options: window.options,
					filename,
				} satisfies RendererConfig;
			},
			send: (windowId, message) =>
				this.rendererMessage(windowId, message as Record<string, unknown>),
			subscribe: (windowId, listener) => {
				const window = this.windows.get(windowId);
				window?.listeners.add(listener);
				return () => window?.listeners.delete(listener);
			},
			proxyURL: (url) => this.proxy.encode(url),
		};
		window.__neutron = bridge;
		navigator.serviceWorker?.addEventListener("message", (event) => {
			const probe = event.data,
				port = event.ports[0];
			if (probe?.type !== LOOPBACK_PROBE || !port) return;
			if (
				event.source !== navigator.serviceWorker.controller ||
				!this.worker ||
				this.stopping ||
				this.app?.id !== probe.appId ||
				this.instanceId !== probe.runId ||
				![...this.windows.values()].some(
					(tab) =>
						tab.browser?.id === probe.sessionId &&
						(!probe.bootstrap || tab.loading === "loading"),
				)
			) {
				rejectProbe(port, 410);
				return;
			}
			this.worker.postMessage(probe, [port]);
		});
		window.addEventListener("message", (event) => {
			if (event.origin !== location.origin || event.data?.type !== "neutron-browser-action")
				return;
			const tab = [...this.windows.values()].find(
				(item) =>
					item.browser?.id === event.data.session &&
					item.frame.contentWindow === event.source,
			);
			if (!tab?.browser) return;
			if (event.data.action === "close") this.closeBrowser(tab);
			if (event.data.action === "open" && typeof event.data.url === "string") {
				const target = URL.parse(event.data.url);
				if (!target) return;
				if (/^https?:$/.test(target.protocol))
					void this.openBrowser(target, tab.id).catch(() =>
						this.events.toast("Could not open browser link."),
					);
				else void this.returnLink(tab, target);
			}
		});
		new ResizeObserver(() => {
			for (const item of this.windows.values()) {
				if (!item.isView) this.sendBounds(item);
			}
			this.sendDisplay();
		}).observe(this.desktop);
		for (const query of ["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)"])
			matchMedia(query).addEventListener("change", () => this.sendTheme());
		let activity = 0;
		for (const event of ["pointermove", "keydown"])
			document.addEventListener(
				event,
				() => {
					if (Date.now() - activity > 1000) {
						activity = Date.now();
						this.send({ type: "activity" });
					}
				},
				{ passive: true },
			);
		document.addEventListener("keydown", (event) => {
			for (const key of this.shortcuts) {
				const parts = key.toLowerCase().split("+");
				if (
					parts.at(-1) === event.key.toLowerCase() &&
					(parts.includes("control") ||
						parts.includes("ctrl") ||
						parts.includes("commandorcontrol")) === (event.ctrlKey || event.metaKey) &&
					parts.includes("shift") === event.shiftKey &&
					parts.includes("alt") === event.altKey
				) {
					event.preventDefault();
					this.send({ type: "shortcut", key });
				}
			}
		});
	}
	async start(
		app: InstalledApp,
		wisp: string,
		strict = false,
		platform: "linux" | "win32" | "darwin" = "linux",
		argv: string[] = [],
	): Promise<void> {
		await this.stop();
		this.events.state("starting");
		this.app = app;
		this.instanceId = crypto.randomUUID();
		this.syncChannel = new BroadcastChannel(`neutron-host:${this.instanceId}`);
		this.syncChannel.onmessage = async (event: MessageEvent<SyncRequest>) => {
			const { nonce, method, args } = event.data;
			try {
				this.syncChannel?.postMessage({
					nonce,
					result: await this.request(method, args),
				} satisfies SyncResult);
			} catch (error) {
				this.syncChannel?.postMessage({
					nonce,
					error: errorText(error),
				} satisfies SyncResult);
			}
		};
		this.wisp = wisp;
		this.strict = strict;
		this.platform = platform;
		this.abort = new AbortController();
		try {
			const start = performance.now();
			this.snapshot = await this.storage.load(app.id, {
				signal: this.abort.signal,
				shared: crossOriginIsolated && typeof SharedArrayBuffer !== "undefined",
			});
			this.log(
				"info",
				"runtime",
				`Restored ${Object.keys(this.snapshot).length.toLocaleString()} filesystem entries in ${((performance.now() - start) / 1000).toFixed(1)}s`,
			);
			const entry = resolveEntry(this.snapshot, applicationEntry(app));
			if (!entry)
				throw new Error(
					`Entry point not found: ${applicationEntry(app)}. Import the entire installed resources folder or its ZIP; the selected package may be a renderer/update archive without the Electron bootstrap.`,
				);
			app.entryPoint = entry;
			await this.proxy.configure(wisp, this.instanceId, app);
			const worker = new Worker("/runtime/main-worker.js", {
				name: `neutron:${app.manifest.name}`,
			});
			this.worker = worker;
			this.rpc = new RpcClient((message) => this.send(message));
			worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
				if (this.worker !== worker) return;
				void this.onMessage(event.data, worker).catch((error: unknown) =>
					this.log("error", "host", errorText(error)),
				);
			});
			worker.addEventListener("error", (event) => {
				if (this.worker !== worker) return;
				this.log("error", "main", event.message);
				this.events.state("failed");
			});
			this.startupTimer = setTimeout(() => {
				this.log(
					"error",
					"runtime",
					"Main process has not started after 20 seconds. Stop the app if it is stuck in synchronous code.",
				);
				this.events.state("failed");
			}, 20_000);
			worker.postMessage({
				type: "start",
				config: {
					instanceId: this.instanceId,
					app,
					wisp,
					strict,
					platform,
					snapshot: this.snapshot,
					argv,
				},
			});
			this.log(
				"info",
				"runtime",
				`Starting ${app.manifest.name} ${app.manifest.version} → ${applicationEntry(app)}`,
			);
		} catch (error) {
			this.events.state("failed");
			throw error;
		}
	}
	stop(): Promise<void> {
		// Stopping from the host ends the app; a pending relaunch does not apply.
		this.relaunch = undefined;
		return this.stopOnce(false);
	}
	private stopOnce(appExited: boolean): Promise<void> {
		// The worker may report an app exit in the middle of a host-initiated Stop.
		this.stopping ??= this.teardown(appExited).finally(() => {
			this.stopping = undefined;
		});
		return this.stopping;
	}
	private async stopRequest(method: string, timeout: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.rpc?.call(method),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`no reply within ${timeout} ms`)),
						timeout,
					);
				}),
			]);
		} catch (error) {
			this.log("warn", "runtime", `Forcing stop after ${method}: ${String(error)}`);
		} finally {
			clearTimeout(timer);
		}
	}
	private async teardown(appExited: boolean): Promise<void> {
		clearTimeout(this.startupTimer);
		if (this.worker && this.rpc) {
			// Keep windows, IPC and host services live: a close handler may veto,
			// consult a renderer, save state, and then call quit again or exit.
			if (!appExited) await this.stopRequest("runtime.shutdown", 3_000);
			await this.stopRequest("runtime.finalize", 400);
		}
		this.abort.abort();
		this.syncChannel?.close();
		this.syncChannel = undefined;
		this.worker?.terminate();
		this.proxy.close();
		this.worker = undefined;
		this.rpc?.close();
		this.rpc = undefined;
		for (const item of this.windows.values()) item.element.remove();
		this.windows.clear();
		this.activeWindow = undefined;
		this.selectionHistory = [];
		this.shortcuts = [];
		this.events.menu([]);
		this.appMenu = [];
		this.displayedMenu = undefined;
		this.events.windows([]);
		await this.wake?.release();
		this.wake = undefined;
		await this.storage.flush();
		this.events.state("stopped");
	}
	send(message: unknown, transfer: Transferable[] = []): void {
		this.worker?.postMessage(message, transfer);
	}
	getSnapshot(): Snapshot {
		return this.snapshot;
	}
	menuClick(id: string): void {
		this.send({ type: "menu-click", id, windowId: this.activeWindow });
	}
	private syncMenu(): void {
		const current = this.windows.get(this.activeWindow ?? -1);
		const menu =
			current && !current.menuVisible ? this.emptyMenu : (current?.menu ?? this.appMenu);
		if (menu === this.displayedMenu) return;
		this.displayedMenu = menu;
		this.events.menu(menu);
	}
	private log(level: LogEntry["level"], source: string, message: string): void {
		this.events.log({ level, source, message, time: Date.now() });
	}
	private syncWindows(preferred?: number): void {
		const previous = this.activeWindow;
		if (preferred !== undefined) this.activeWindow = preferred;
		const active = this.windows.get(this.activeWindow ?? -1);
		if (!active?.visible || active.isView) {
			this.activeWindow = [...this.windows.keys(), ...this.selectionHistory]
				.reverse()
				.find((id) => {
					const item = this.windows.get(id);
					return item?.visible && !item.isView;
				});
		}
		for (const item of this.windows.values())
			if (!item.isView) {
				item.element.hidden = !item.visible || item.id !== this.activeWindow;
				item.element.inert = item.element.hidden;
			}
		if (previous !== this.activeWindow) {
			if (previous !== undefined && previous > 0)
				this.send({ type: "window-event", windowId: previous, event: "blur" });
			if (this.activeWindow !== undefined) {
				this.windows.get(this.activeWindow)?.frame.focus();
				if (this.activeWindow > 0)
					this.send({
						type: "window-event",
						windowId: this.activeWindow,
						event: "focus",
					});
			}
		}
		this.syncMenu();
		this.events.windows(
			[...this.windows.values()]
				.filter((item) => !item.isView)
				.map((item) => ({
					id: item.id,
					title: item.options.title || "Window",
					active: item.id === this.activeWindow,
					visible: item.visible,
					url: item.url || "about:blank",
					loading: item.loading,
					error: item.error,
					views: [...this.windows.values()].filter((view) => view.parentId === item.id)
						.length,
					browser: Boolean(item.browser),
				})),
		);
	}
	private activate(item: HostedWindow): void {
		let root = item;
		while (root.isView && root.parentId !== undefined) root = this.getWindow(root.parentId);
		if (root.isView || !root.visible) return;
		this.selectionHistory = this.selectionHistory.filter((id) => id !== root.id);
		this.selectionHistory.push(root.id);
		this.syncWindows(root.id);
	}
	private sendTheme(): void {
		this.send({
			type: "theme",
			dark: matchMedia("(prefers-color-scheme: dark)").matches,
			reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
		});
	}
	private sendDisplay(): void {
		const size = { width: this.desktop.clientWidth, height: this.desktop.clientHeight };
		const bounds = { x: 0, y: 0, ...size };
		this.send({
			type: "display",
			display: {
				bounds,
				workArea: bounds,
				size,
				workAreaSize: size,
				scaleFactor: devicePixelRatio,
			},
		});
	}
	private patches(patches: FilePatch[], source?: number): void {
		if (!this.app) return;
		for (const patch of patches) {
			if (patch.entry) this.snapshot[patch.path] = patch.entry;
			else delete this.snapshot[patch.path];
		}
		this.storage.enqueue(this.app.id, patches);
		if (source !== undefined) this.send({ type: "fs", patches });
		for (const item of this.windows.values())
			if (item.id !== source)
				for (const listener of item.listeners)
					listener({ type: "fs", patches: structuredClone(patches) });
	}
	private rendererMessage(windowId: number, message: Record<string, unknown>): void {
		if (!this.windows.has(windowId) || this.windows.get(windowId)?.browser) return;
		if (message.type === "navigation-commit") {
			const item = this.getWindow(windowId);
			item.url = String(message.url);
			item.awaitingCommit = false;
			if (!message.inPage && item.loading !== "loading") {
				item.loading = "loading";
				this.send({ type: "window-event", windowId, event: "did-start-loading" });
			}
			this.syncWindows();
		}
		if (message.type === "window-event" && message.event === "dom-ready") {
			const item = this.getWindow(windowId);
			item.loading = "dom-ready";
			this.syncWindows();
		}
		if (message.type === "renderer-host-request") {
			const method = String(message.method);
			void (async () => {
				try {
					if (
						![
							"dialog.open",
							"dialog.save",
							"dialog.message",
							"shell.external",
						].includes(method)
					)
						throw new Error(`Unsupported renderer host request: ${method}`);
					const value = await this.request(method, message.args as unknown[]);
					for (const listener of this.windows.get(windowId)?.listeners || [])
						listener({ type: "renderer-host-result", id: message.id, value });
				} catch (error) {
					for (const listener of this.windows.get(windowId)?.listeners || [])
						listener({
							type: "renderer-host-result",
							id: message.id,
							error: errorText(error),
						});
				}
			})();
			return;
		}
		if (message.type === "fs") this.patches(message.patches as FilePatch[], windowId);
		else if (message.type === "log")
			this.log(
				message.level as LogEntry["level"],
				String(message.source),
				String(message.message),
			);
		else if (message.type === "ipc-port")
			this.send({ ...message, windowId }, message.ports as MessagePort[]);
		else this.send({ ...message, windowId });
	}
	private async onMessage(message: Record<string, unknown>, worker: Worker): Promise<void> {
		switch (message.type) {
			case "rpc":
				await answerRpc(
					message as unknown as RpcMessage,
					(method, args) => this.request(method, args),
					(result) => worker.postMessage(result),
				);
				break;
			case "protocols":
				await this.proxy.setSchemes(String(message.partition), message.schemes as string[]);
				break;
			case "web-request":
				await this.proxy.setHeaderFilters(
					String(message.partition),
					message.headers as string[],
				);
				break;
			case "result":
				this.rpc?.receive(message as unknown as RpcResult);
				break;
			case "window-create":
				this.createWindow(Number(message.windowId), message.options as WindowOptions);
				break;
			case "view-create":
				this.createWindow(Number(message.windowId), message.options as WindowOptions, true);
				break;
			case "view-attach": {
				const view = this.getWindow(Number(message.windowId));
				const parent = this.getWindow(Number(message.parentId));
				parent.element.append(view.element);
				view.element.hidden = false;
				view.visible = true;
				view.parentId = parent.id;
				this.syncWindows();
				break;
			}
			case "view-detach": {
				const view = this.getWindow(Number(message.windowId));
				view.element.hidden = true;
				view.visible = false;
				view.parentId = undefined;
				this.desktop.append(view.element);
				this.syncWindows();
				break;
			}
			case "window-command":
				this.command(
					Number(message.windowId),
					String(message.method),
					message.args as unknown[],
				);
				break;
			case "fs":
				this.patches(message.patches as FilePatch[]);
				break;
			case "log":
				this.log(
					message.level as LogEntry["level"],
					String(message.source),
					String(message.message),
				);
				break;
			case "started":
				if (this.stopping) break;
				clearTimeout(this.startupTimer);
				this.events.state("running");
				this.sendTheme();
				this.sendDisplay();
				break;
			case "fatal":
				clearTimeout(this.startupTimer);
				this.log("error", "main", String(message.message));
				this.events.state("failed");
				break;
			case "relaunch":
				if (!this.stopping) this.relaunch = (message.args as unknown[]).map(String);
				break;
			case "quit": {
				const relaunch = this.relaunch;
				await this.stopOnce(true);
				if (relaunch && this.app && this.relaunch === relaunch)
					await this.start(this.app, this.wisp, this.strict, this.platform, relaunch);
				break;
			}
			case "renderer-event":
			case "ipc-result":
				for (const listener of this.windows.get(Number(message.windowId))?.listeners || [])
					listener(structuredClone(message));
				break;
			case "renderer-port":
				for (const listener of this.windows.get(Number(message.windowId))?.listeners || [])
					listener(message);
				break;
			case "menu":
				for (const item of this.windows.values()) item.menu = undefined;
				this.appMenu = message.items as MenuData[];
				this.syncMenu();
				break;
			case "menu-update":
				this.appMenu = message.items as MenuData[];
				this.syncMenu();
				break;
			case "shortcuts":
				this.shortcuts = message.keys as string[];
				break;
			case "console-open":
				this.events.console(true);
				break;
			case "console-close":
				this.events.console(false);
				break;
			case "notification":
				this.events.toast(
					`${message.title || this.app?.manifest.name}: ${message.body || ""}`,
				);
				break;
			case "tray":
				this.events.toast(`Tray: ${message.title || message.tooltip || "removed"}`);
				break;
			case "clipboard":
				await navigator.clipboard
					.writeText(String(message.text))
					.catch((error: unknown) => this.log("warn", "clipboard", String(error)));
				break;
			case "show-files":
				this.events.files(String(message.filename ?? ""));
				break;
			case "progress":
				this.events.toast(
					`Application progress: ${Math.round(Number(message.value) * 100)}%`,
				);
				break;
		}
	}
	private createWindow(
		id: number,
		options: WindowOptions,
		isView = false,
		browser?: ProxySession,
	): void {
		const element = document.createElement("section");
		element.className = isView ? "runtime-window runtime-view" : "runtime-window";
		element.setAttribute("aria-label", options.title || "Application window");
		if (isView)
			element.style.cssText = `left:${options.x ?? 0}px;top:${options.y ?? 0}px;width:${options.width ?? 300}px;height:${options.height ?? 200}px`;
		element.hidden = options.show === false;
		const frame = document.createElement("iframe");
		if (browser) {
			frame.name = `neutron-browser:${-id}`;
			frame.dataset.neutronBrowser = String(id);
			frame.setAttribute("sandbox", "allow-forms allow-scripts allow-same-origin");
		} else {
			frame.name = `neutron:${id}`;
			frame.dataset.neutronId = String(id);
		}
		frame.title = options.title || "Electron renderer";
		frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; autoplay");
		const hosted: HostedWindow = {
			browser,
			menuVisible: !options.autoHideMenuBar,
			isView,
			id,
			element,
			frame,
			options,
			remote: false,
			visible: options.show !== false,
			loading: "created",
			listeners: new Set(),
		};
		this.windows.set(id, hosted);
		element.append(frame);
		this.desktop.append(element);
		frame.addEventListener("load", () => {
			if (hosted.browser) {
				let href: string | undefined;
				try {
					href = frame.contentWindow?.location.href;
				} catch {
					/* opaque document */
				}
				const target = href && browserTarget(href, this.browserPrefix(hosted.browser));
				if (target) {
					if (!/^https?:$/.test(target.protocol)) {
						void this.returnLink(hosted, target);
						return;
					}
					hosted.url = target.origin;
					hosted.options.title = `Browser · ${target.host}`;
					frame.title = hosted.options.title;
					hosted.loading = "loaded";
					this.syncWindows();
				}
				return;
			}
			if (!hosted.url) return;
			if (hosted.awaitingCommit) {
				// about:blank/data documents need not contain a runtime bootstrap.
				hosted.awaitingCommit = false;
				this.send({ type: "navigation-commit", windowId: id, url: hosted.url, status: -1 });
			}
			// A preload can attach after DOMContentLoaded (or a page can suppress
			// its listener). The iframe's load still guarantees a ready document.
			if (hosted.loading === "loading")
				this.send({ type: "window-event", windowId: id, event: "dom-ready" });
			hosted.loading = "loaded";
			this.send({
				type: "window-event",
				windowId: id,
				event: "did-frame-finish-load",
				args: [true, id + 1, 0],
			});
			this.send({ type: "window-event", windowId: id, event: "did-finish-load" });
			this.send({ type: "window-event", windowId: id, event: "did-stop-loading" });
			this.syncWindows();
		});
		if (!isView) {
			this.sendBounds(hosted);
			if (hosted.visible) this.activate(hosted);
			else this.syncWindows();
		}
	}
	private sendBounds(item: HostedWindow, force = false): void {
		if (item.browser) return;
		const width = item.isView ? item.element.offsetWidth : this.desktop.clientWidth;
		const height = item.isView ? item.element.offsetHeight : this.desktop.clientHeight;
		if (!force && item.reportedSize?.width === width && item.reportedSize.height === height)
			return;
		item.reportedSize = { width, height };
		this.send({
			type: "window-event",
			windowId: item.id,
			event: "bounds",
			bounds: {
				x: item.isView ? item.element.offsetLeft : 0,
				y: item.isView ? item.element.offsetTop : 0,
				width,
				height,
			},
		});
	}
	private getWindow(id: number): HostedWindow {
		const item = this.windows.get(id);
		if (!item) throw new Error(`Window ${id} is closed`);
		return item;
	}
	/** Window-manager actions switch immediately in the host, then tell the main
	 * process so Electron state and events (show/hide/focus/close) stay in sync. */
	manageWindow(id: number, action: "restore" | "hide" | "reload" | "close"): void {
		const item = this.windows.get(id);
		if (!item || item.isView) return;
		if (action === "restore") {
			item.visible = true;
			this.activate(item);
			item.frame.focus();
		} else if (action === "hide") {
			item.visible = false;
			this.syncWindows();
		}
		if (item.browser) {
			if (action === "close") this.closeBrowser(item);
			else if (action === "reload") this.command(item.id, "reload", []);
		} else this.send({ type: "window-event", windowId: id, event: action });
	}
	private browserPrefix(session: ProxySession): URL {
		return new URL(`/__scramjet__/${session.id}/`, location.origin);
	}
	private async openBrowser(url: URL, returnTo = this.activeWindow): Promise<void> {
		if (!this.wisp)
			throw new Error(
				"External networking is off: start the app with a Wisp relay to open web pages.",
			);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password)
			throw new Error("Invalid browser destination");
		const browser = await this.proxy.browserSession();
		if (this.stopping) throw new Error("Application is stopping");
		const id = this.nextBrowserId--;
		this.createWindow(
			id,
			{ title: `Browser · ${url.host}`, autoHideMenuBar: true },
			false,
			browser,
		);
		const item = this.getWindow(id);
		item.returnTo = returnTo;
		item.url = url.origin;
		item.loading = "loading";
		item.frame.src = encodeProxyURL(browser, url.href);
		this.syncWindows();
	}
	private closeBrowser(tab: HostedWindow): void {
		const active = this.activeWindow === tab.id;
		this.command(tab.id, "destroy", []);
		const parent = tab.returnTo === undefined ? undefined : this.windows.get(tab.returnTo);
		if (active && parent?.visible) this.activate(parent);
	}
	private async returnLink(tab: HostedWindow, target: URL): Promise<void> {
		// Don't put authorization codes, state or fragments into tab labels or logs.
		if (
			appLinkScheme(target.protocol) &&
			(await this.rpc?.call<boolean>("app.open-link", target.href).catch(() => false))
		) {
			let current: HostedWindow | undefined = tab;
			while (current?.browser && this.windows.get(current.id) === current) {
				const parent: HostedWindow | undefined = this.windows.get(current.returnTo ?? 0);
				this.closeBrowser(current);
				current = parent;
			}
			return;
		}
		if (this.windows.get(tab.id) !== tab) return;
		tab.loading = "failed";
		tab.error = "No registered application handler for this address.";
		this.syncWindows();
	}
	private command(id: number, command: string, args: unknown[]): void {
		const item = this.windows.get(id);
		if (!item) return;
		const { element, frame } = item;
		switch (command) {
			case "userAgent":
				item.options.webPreferences ||= {};
				item.options.webPreferences.userAgent = String(args[0]);
				break;
			case "menuVisible":
				item.menuVisible = Boolean(args[0]);
				this.syncMenu();
				break;
			case "setMenu":
				item.menu = args[0] as MenuData[];
				this.syncMenu();
				break;
			case "destroy":
				element.remove();
				this.windows.delete(id);
				this.selectionHistory = this.selectionHistory.filter((windowId) => windowId !== id);
				this.syncWindows();
				break;
			case "show":
			case "restore":
				item.visible = true;
				if (item.isView) element.hidden = false;
				else this.activate(item);
				break;
			case "showInactive":
				item.visible = true;
				if (item.isView) element.hidden = false;
				else this.syncWindows();
				break;
			case "hide":
			case "minimize":
				item.visible = false;
				if (item.isView) element.hidden = true;
				else this.syncWindows();
				break;
			case "focus":
				this.activate(item);
				frame.focus();
				break;
			case "title": {
				frame.title = String(args[0]);
				item.options.title = String(args[0]);
				this.syncWindows();
				break;
			}
			case "maximize":
			case "unmaximize":
				if (!item.isView) this.sendBounds(item);
				break;
			case "bounds": {
				const bounds = args[0] as { x: number; y: number; width: number; height: number };
				if (item.isView)
					Object.assign(element.style, {
						left: `${bounds.x}px`,
						top: `${bounds.y}px`,
						width: `${bounds.width}px`,
						height: `${bounds.height}px`,
					});
				else if (
					bounds.x !== 0 ||
					bounds.y !== 0 ||
					bounds.width !== this.desktop.clientWidth ||
					bounds.height !== this.desktop.clientHeight
				)
					this.sendBounds(item, true);
				break;
			}
			case "center":
				this.sendBounds(item);
				break;
			case "resizable":
			case "alwaysOnTop":
				// Top-level renderers always occupy the viewport; they aren't OS windows.
				break;
			case "background":
				element.style.background = String(args[0]);
				break;
			case "borderRadius":
				if (item.isView) element.style.borderRadius = `${args[0]}px`;
				break;
			case "autoResize": {
				const options = args[0] as { width?: boolean; height?: boolean };
				if (options.width) element.style.width = "100%";
				if (options.height) element.style.height = "100%";
				break;
			}
			case "reload":
				item.loading = "loading";
				item.error = undefined;
				frame.contentWindow?.location.reload();
				this.syncWindows();
				break;
			case "back":
				frame.contentWindow?.history.back();
				break;
			case "forward":
				frame.contentWindow?.history.forward();
				break;
			case "stop":
				frame.contentWindow?.stop();
				break;
			case "print":
				frame.contentWindow?.print();
				break;
			case "zoom":
				if (frame.contentDocument)
					frame.contentDocument.documentElement.style.zoom = String(args[0]);
				break;
			case "attention":
				element.classList.toggle("attention", Boolean(args[0]));
				break;
		}
	}
	private async load(
		id: number,
		value: string,
		local: boolean,
		options: { query?: Record<string, string>; hash?: string; search?: string } = {},
	): Promise<void> {
		const item = this.getWindow(id);
		const partition = item.options.webPreferences?.partition || "default";
		const session = await this.proxy.ready(partition);
		await this.storage.flush();
		item.url = local ? `file://${value}` : value;
		item.loading = "loading";
		item.error = undefined;
		this.syncWindows();
		let url: string;
		if (value.startsWith("file:")) {
			const file = new URL(value);
			value = decodeURIComponent(file.pathname);
			options = {
				...options,
				search: options.search ?? file.search,
				hash: options.hash ?? file.hash,
			};
			local = true;
		}
		if (local) {
			const resolved = resolveEntry(this.snapshot, value);
			if (!resolved) throw new Error(`ENOENT: BrowserWindow.loadFile ${value}`);
			value = resolved;
			url = `file://${value.split("/").map(encodeURIComponent).join("/")}`;
			if (options.query) url += `?${new URLSearchParams(options.query)}`;
			else if (options.search)
				url += options.search.startsWith("?") ? options.search : `?${options.search}`;
			if (options.hash) url += `#${options.hash.replace(/^#/, "")}`;
			item.url = url;
			url = this.proxy.encode(url, partition);
			item.remote = false;
		} else if (/^https?:/.test(value)) {
			if (!this.wisp && !session.schemes?.includes(new URL(value).protocol.slice(0, -1)))
				throw new Error(
					"External networking is off: start the app with a Wisp relay to load remote pages.",
				);
			url = this.proxy.encode(value, partition);
			item.remote = true;
		} else if (value.startsWith("data:") || value === "about:blank") {
			url = value;
			item.remote = false;
		} else {
			url = this.proxy.encode(value, partition);
			item.remote = false;
		}
		this.send({ type: "window-event", windowId: id, event: "did-start-loading" });
		item.awaitingCommit = true;
		this.send({ type: "navigation-start", windowId: id, url: item.url });
		await new Promise<void>((resolve, reject) => {
			const frame = item.frame;
			const cleanup = () => {
				clearTimeout(timer);
				frame.removeEventListener("load", loaded);
				frame.removeEventListener("error", failed);
				this.abort.signal.removeEventListener("abort", aborted);
			};
			const loaded = () => {
				cleanup();
				resolve();
			};
			const failed = () => {
				cleanup();
				item.loading = "failed";
				item.error = `Navigation failed: ${value}`;
				this.send({
					type: "window-event",
					windowId: id,
					event: "did-fail-load",
					args: [-2, item.error, value, true],
				});
				this.syncWindows();
				reject(new Error(`Navigation failed: ${value}`));
			};
			const aborted = () => {
				cleanup();
				reject(new Error("Runtime stopped during navigation"));
			};
			const timer = setTimeout(failed, 45_000);
			frame.addEventListener("load", loaded, { once: true });
			frame.addEventListener("error", failed, { once: true });
			this.abort.signal.addEventListener("abort", aborted, { once: true });
			frame.name = `neutron:${id}`;
			frame.src = url;
		});
	}
	private async request(method: string, args: unknown[]): Promise<unknown> {
		switch (method) {
			case "platform.wake":
				if (args[0]) {
					this.wake ||= await navigator.wakeLock.request("screen");
				} else {
					await this.wake?.release();
					this.wake = undefined;
				}
				return;
			case "platform.media": {
				try {
					const stream = await navigator.mediaDevices.getUserMedia(
						args[0] === "camera" ? { video: true } : { audio: true },
					);
					for (const track of stream.getTracks()) track.stop();
					return true;
				} catch {
					return false;
				}
			}
			case "window.load":
				return this.load(
					Number(args[0]),
					String(args[1]),
					Boolean(args[2]),
					args[3] as Parameters<RuntimeHost["load"]>[3],
				);
			case "window.evaluate": {
				const item = this.getWindow(Number(args[0]));
				return (item.frame.contentWindow as (Window & typeof globalThis) | null)?.eval(
					String(args[1]),
				);
			}
			case "window.capture":
			case "window.pdf": {
				const doc = this.getWindow(Number(args[0])).frame.contentDocument;
				if (!doc?.body) throw new Error("Renderer is not ready to capture");
				const { toPng } = await import("html-to-image");
				const image = await toPng(doc.body, {
					backgroundColor: getComputedStyle(doc.body).backgroundColor || "#ffffff",
					skipFonts: true,
				});
				const data = Uint8Array.from(atob(image.split(",")[1] || ""), (value) =>
					value.charCodeAt(0),
				);
				if (method === "window.capture") return data;
				const { PDFDocument } = await import("pdf-lib");
				const pdf = await PDFDocument.create();
				const png = await pdf.embedPng(data);
				const page = pdf.addPage([595.28, 841.89]);
				const scale = Math.min(page.getWidth() / png.width, page.getHeight() / png.height);
				page.drawImage(png, {
					x: 0,
					y: page.getHeight() - png.height * scale,
					width: png.width * scale,
					height: png.height * scale,
				});
				return pdf.save();
			}
			case "window.css": {
				const doc = this.getWindow(Number(args[0])).frame.contentDocument;
				if (!doc) throw new Error("Renderer document is unavailable");
				const style = doc.createElement("style");
				style.id = crypto.randomUUID();
				style.textContent = String(args[1]);
				doc.head.append(style);
				return style.id;
			}
			case "window.removeCSS":
				this.getWindow(Number(args[0]))
					.frame.contentDocument?.getElementById(String(args[1]))
					?.remove();
				return;
			case "dialog.message": {
				const options = args[0] as {
					title?: string;
					message?: string;
					detail?: string;
					buttons?: string[];
				};
				return { response: await this.messageBox(options), checkboxChecked: false };
			}
			case "dialog.open":
				return this.openDialog(
					args[0] as { properties?: string[]; filters?: { extensions: string[] }[] },
				);
			case "dialog.save": {
				const options = args[0] as { defaultPath?: string; title?: string };
				const filePath = window.prompt(
					options.title || "Save as (a path in the app’s browser storage)",
					options.defaultPath || "/home/user/Downloads/untitled.txt",
				);
				return { canceled: !filePath, filePath: filePath || undefined };
			}
			case "shell.external": {
				const url = new URL(String(args[0]));
				if (/^https?:$/.test(url.protocol)) return this.openBrowser(url);
				if (url.protocol === "mailto:") {
					window.open(url.href, "_blank", "noopener,noreferrer");
					return;
				}
				if (
					appLinkScheme(url.protocol) &&
					(await this.rpc?.call<boolean>("app.open-link", url.href))
				)
					return;
				throw new Error("External protocol is not supported");
			}
			case "shell.download": {
				const entry = this.snapshot[String(args[0])];
				if (entry?.kind !== "file") throw new Error("File not found");
				download(entry.data, String(args[0]).split("/").pop() || "download");
				return;
			}
			default:
				throw new Error(`Unknown runtime host method: ${method}`);
		}
	}
	private messageBox(options: {
		title?: string;
		message?: string;
		detail?: string;
		buttons?: string[];
	}): Promise<number> {
		return new Promise((resolve) => {
			const modal = document.createElement("dialog");
			modal.className = "neutron-dialog";
			modal.dataset.kind = "message";
			const title = document.createElement("h2");
			title.textContent = options.title || this.app?.manifest.name || "Message";
			const message = document.createElement("p");
			message.textContent = options.message || "";
			const detail = document.createElement("p");
			detail.textContent = options.detail || "";
			detail.className = "neutron-dialog-detail";
			modal.append(title, message, detail);
			const actions = document.createElement("div");
			actions.className = "neutron-dialog-actions";
			(options.buttons || ["OK"]).forEach((label, index) => {
				const button = document.createElement("button");
				button.textContent = label;
				button.onclick = () => {
					modal.close();
					modal.remove();
					resolve(index);
				};
				actions.append(button);
			});
			modal.append(actions);
			modal.oncancel = () => {
				modal.remove();
				resolve(-1);
			};
			document.body.append(modal);
			modal.showModal();
		});
	}
	private openDialog(options: {
		properties?: string[];
		filters?: { extensions: string[] }[];
		title?: string;
		defaultPath?: string;
		buttonLabel?: string;
	}): Promise<object> {
		if (options.properties?.includes("openDirectory")) return this.directoryDialog(options);
		return new Promise((resolve, reject) => {
			const input = document.createElement("input");
			input.type = "file";
			input.multiple = options.properties?.includes("multiSelections") || false;
			input.accept =
				options.filters
					?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`))
					.join(",") || "";
			if (options.properties?.includes("openDirectory"))
				input.setAttribute("webkitdirectory", "");
			input.oncancel = () => resolve({ canceled: true, filePaths: [] });
			input.onchange = () => {
				void (async () => {
					const filePaths: string[] = [];
					const patches: FilePatch[] = [];
					for (const file of input.files || []) {
						const filename = `/home/user/Downloads/${file.webkitRelativePath || file.name}`;
						filePaths.push(filename);
						patches.push({
							path: filename,
							entry: { kind: "file", data: new Uint8Array(await file.arrayBuffer()) },
						});
					}
					this.patches(patches, -1);
					await this.storage.flush();
					resolve({ canceled: !filePaths.length, filePaths });
				})().catch(reject);
			};
			input.click();
		});
	}
	private directoryDialog(options: {
		title?: string;
		defaultPath?: string;
		buttonLabel?: string;
		properties?: string[];
	}): Promise<object> {
		return new Promise((resolve) => {
			const modal = document.createElement("dialog");
			modal.className = "neutron-dialog";
			modal.dataset.kind = "folder";
			modal.setAttribute("aria-label", options.title || "Choose a folder");
			const title = document.createElement("h2");
			title.textContent = options.title || "Choose a folder";
			const description = document.createElement("p");
			description.textContent =
				"Choose a folder in this app’s browser storage, or import a folder from your computer.";
			const label = document.createElement("label");
			label.textContent = "Folder path";
			const input = document.createElement("input");
			input.id = `folder-${crypto.randomUUID()}`;
			label.htmlFor = input.id;
			input.value =
				options.defaultPath && this.snapshot[options.defaultPath]?.kind === "directory"
					? options.defaultPath
					: "/home/user/Documents";
			const list = document.createElement("datalist");
			list.id = `${input.id}-choices`;
			input.setAttribute("list", list.id);
			for (const [filename, entry] of Object.entries(this.snapshot))
				if (entry.kind === "directory" && filename.startsWith("/home/user")) {
					const item = document.createElement("option");
					item.value = filename;
					list.append(item);
				}
			const message = document.createElement("p");
			message.setAttribute("role", "status");
			const actions = document.createElement("div");
			actions.className = "neutron-dialog-actions";
			const finish = (filePaths: string[]) => {
				modal.close();
				modal.remove();
				resolve({ canceled: !filePaths.length, filePaths });
			};
			const choose = document.createElement("button");
			choose.textContent = options.buttonLabel || "Select folder";
			choose.dataset.primary = "";
			choose.dataset.action = "choose-directory";
			choose.onclick = () => {
				const filename = path.resolve("/", input.value);
				if (this.snapshot[filename]?.kind !== "directory") {
					message.textContent = "That virtual folder does not exist.";
					return;
				}
				finish([filename]);
			};
			const cancel = document.createElement("button");
			cancel.textContent = "Cancel";
			cancel.onclick = () => finish([]);
			const mkdir = document.createElement("button");
			mkdir.textContent = "Create folder";
			mkdir.hidden = !options.properties?.includes("createDirectory");
			mkdir.onclick = () => {
				const filename = path.resolve("/", input.value);
				const patches: FilePatch[] = [];
				let current = "";
				for (const part of filename.split("/").filter(Boolean)) {
					current += `/${part}`;
					if (!this.snapshot[current])
						patches.push({ path: current, entry: { kind: "directory" } });
				}
				this.patches(patches, -1);
				input.value = filename;
				message.textContent = "Folder created.";
			};
			const upload = document.createElement("button");
			upload.textContent = "Import folder";
			upload.onclick = () => {
				const picker = document.createElement("input");
				picker.type = "file";
				picker.setAttribute("webkitdirectory", "");
				picker.multiple = true;
				picker.onchange = () => {
					void (async () => {
						const files = [...(picker.files || [])];
						if (!files.length) return;
						choose.disabled = true;
						upload.disabled = true;
						message.textContent = "Importing folder…";
						const base = "/home/user/Downloads";
						const root = files[0]?.webkitRelativePath.split("/")[0];
						if (!root) throw new Error("The browser did not provide directory paths.");
						const patches: FilePatch[] = [];
						const directories = new Set<string>();
						for (const file of files) {
							const filename = path.join(base, file.webkitRelativePath);
							let dir = path.dirname(filename);
							while (dir !== "/") {
								directories.add(dir);
								dir = path.dirname(dir);
							}
							patches.push({
								path: filename,
								entry: {
									kind: "file",
									data: new Uint8Array(await file.arrayBuffer()),
								},
							});
						}
						this.patches(
							[
								...Array.from(directories)
									.sort((a, b) => a.length - b.length)
									.map(
										(path): FilePatch => ({
											path,
											entry: { kind: "directory" },
										}),
									),
								...patches,
							],
							-1,
						);
						await this.storage.flush();
						input.value = path.join(base, root);
						message.textContent = "Folder imported.";
					})()
						.catch((error: unknown) => {
							message.textContent = String(error);
						})
						.finally(() => {
							choose.disabled = false;
							upload.disabled = false;
						});
				};
				picker.click();
			};
			actions.append(upload, mkdir, cancel, choose);
			modal.append(title, description, label, input, list, message, actions);
			modal.oncancel = (event) => {
				event.preventDefault();
				finish([]);
			};
			document.body.append(modal);
			modal.showModal();
		});
	}
}
export function download(bytes: Uint8Array | string, filename: string): void {
	const url = URL.createObjectURL(
		new Blob([typeof bytes === "string" ? bytes : new Uint8Array(bytes)]),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
