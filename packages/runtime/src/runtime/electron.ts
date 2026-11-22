import { Buffer } from "buffer";
import { EventEmitter } from "events";
import path from "path-browserify";
import { appLinkScheme } from "../shared/browser-links";
import { syncCall } from "../shared/sync";
import { applicationPath, type RuntimeConfig, type WindowOptions } from "../shared/types";
import { unsupported, unsupportedModule } from "./builtins";
import { createStub, serializeFallbacks, withFallback } from "./fallback";
import type { VirtualFileSystem } from "./filesystem";
import { imageModule } from "./native-image";
import type { Network } from "./network";
import { optionalElectron } from "./optional";
import { platformModules } from "./platform";
import { MainMessageChannel, MainMessagePort } from "./processes";
import type { RpcClient } from "./rpc";
import { type HeadersReceived, sessionModule } from "./sessions";
import { defaultUserAgent } from "./user-agent";

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;
class IpcMain extends EventEmitter {
	readonly handlers = new Map<string, Handler>();
	handle(channel: string, handler: Handler): void {
		if (this.handlers.has(channel)) throw new Error(`A handler already exists for ${channel}`);
		if (typeof handler !== "function") throw new TypeError("IPC handler must be a function");
		this.handlers.set(channel, handler);
	}
	handleOnce(channel: string, handler: Handler): void {
		this.handle(channel, (event, ...args) => {
			this.removeHandler(channel);
			return handler(event, ...args);
		});
	}
	removeHandler(channel: string): void {
		this.handlers.delete(channel);
	}
}
interface IpcEvent {
	frameId?: number;
	ports?: MainMessagePort[];
	sender: WebContents;
	senderFrame: { url: string };
	reply(channel: string, ...args: unknown[]): void;
	returnValue?: unknown;
}
interface Hooks {
	send(message: unknown, transfer?: Transferable[]): void;
	exit(code: number): void;
	rpc: RpcClient;
	config: RuntimeConfig;
	vfs: VirtualFileSystem;
	network: Network;
}
interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface MenuTemplate {
	id?: string;
	label?: string;
	sublabel?: string;
	toolTip?: string;
	role?: string;
	type?: string;
	enabled?: boolean;
	visible?: boolean;
	checked?: boolean;
	accelerator?: string;
	registerAccelerator?: boolean;
	submenu?: MenuTemplate[] | MenuModel;
	click?: (item: MenuItem, window: unknown, event: unknown) => void;
}
/** Electron's Menu instance shape; the runtime's Menu class extends it. */
class MenuModel extends EventEmitter {
	items: MenuItem[] = [];
	append(item: MenuItem): void {
		this.items.push(item);
		item.menu = this;
	}
	insert(position: number, item: MenuItem): void {
		this.items.splice(position, 0, item);
		item.menu = this;
	}
	getMenuItemById(id: string): MenuItem | null {
		const find = (items: MenuItem[]): MenuItem | undefined => {
			for (const item of items) {
				if (item.id === id) return item;
				const nested = find(item.submenu?.items || []);
				if (nested) return nested;
			}
		};
		return find(this.items) || null;
	}
}
let nextMenuCommand = 0;
class MenuItem {
	/** Set by the runtime: builds its Menu class and performs built-in roles. */
	static createMenu = (template: MenuTemplate[]): MenuModel => {
		const menu = new MenuModel();
		for (const item of template) menu.append(new MenuItem(item));
		return menu;
	};
	static executeRole?: (role: string, window: unknown, contents: unknown) => boolean;
	id: string;
	label: string;
	sublabel: string;
	toolTip: string;
	role?: string;
	type: string;
	enabled: boolean;
	visible: boolean;
	checked: boolean;
	accelerator?: string;
	registerAccelerator: boolean;
	readonly commandId = ++nextMenuCommand;
	submenu?: MenuModel;
	menu?: MenuModel;
	/** Electron calls the template's handler as click(menuItem, window, event). */
	click: (event?: unknown, window?: unknown, contents?: unknown) => void;
	constructor(options: MenuTemplate = {}) {
		this.id = options.id || crypto.randomUUID();
		this.label = options.label || options.role || "";
		this.sublabel = options.sublabel || "";
		this.toolTip = options.toolTip || "";
		this.role = options.role;
		this.submenu = Array.isArray(options.submenu)
			? MenuItem.createMenu(options.submenu)
			: options.submenu;
		this.type = options.type || (this.submenu ? "submenu" : "normal");
		this.enabled = options.enabled !== false;
		this.visible = options.visible !== false;
		this.checked = options.checked || false;
		this.accelerator = options.accelerator;
		this.registerAccelerator = options.registerAccelerator !== false;
		const handler = options.click;
		this.click = (event = {}, window, contents) => {
			if (this.type === "checkbox") this.checked = !this.checked;
			else if (this.type === "radio") {
				for (const sibling of this.menu?.items || [])
					if (sibling.type === "radio") sibling.checked = sibling === this;
			}
			if (this.role && MenuItem.executeRole?.(this.role, window, contents)) return;
			handler?.(this, window, event);
		};
	}
	serialize(): object {
		return {
			id: this.id,
			label: this.label,
			role: this.role,
			type: this.type,
			enabled: this.enabled,
			visible: this.visible,
			checked: this.checked,
			accelerator: this.accelerator,
			submenu: this.submenu?.items.map((item) => item.serialize()),
		};
	}
}
class WebContents extends EventEmitter {
	readonly ipc = new IpcMain();
	readonly mainFrame: {
		ipc: IpcMain;
		url: string;
		routingId: number;
		processId: number;
		parent: null;
		frameToken: string;
		top?: unknown;
		frames: unknown[];
		framesInSubtree: unknown[];
		send(channel: string, ...args: unknown[]): void;
		executeJavaScript(code: string): Promise<unknown>;
	};
	isSecured = false;
	hostWebContents = null;
	private openHandler?: (details: { url: string }) => {
		action: string;
		overrideBrowserWindowOptions?: WindowOptions;
	};
	url = "";
	title = "";
	destroyed = false;
	loading = false;
	private async load(target: string, local: boolean, options?: object): Promise<void> {
		this.loading = true;
		try {
			await this.hooks.rpc.call("window.load", this.id, target, local, options);
		} catch (error) {
			this.loading = false;
			throw error;
		}
	}
	zoom = 1;
	private effectiveUserAgent: string;
	constructor(
		readonly id: number,
		private hooks: Hooks,
		readonly session: ReturnType<ReturnType<typeof sessionModule>["fromPartition"]>,
	) {
		super();
		// A session UA change only affects subsequently created WebContents.
		this.effectiveUserAgent = session.getUserAgent();
		const contents = this;
		this.mainFrame = {
			ipc: new IpcMain(),
			get url() {
				return contents.url;
			},
			routingId: 0,
			processId: this.id + 1,
			parent: null,
			frameToken: `neutron-frame-${this.id}`,
			frames: [],
			framesInSubtree: [],
			send: (channel, ...args) => contents.send(channel, ...args),
			executeJavaScript: (code) => contents.executeJavaScript(code),
		};
		this.mainFrame.top = this.mainFrame;
		this.mainFrame.framesInSubtree.push(this.mainFrame);
	}
	send(channel: string, ...args: unknown[]): void {
		this.hooks.send({
			type: "renderer-event",
			windowId: this.id,
			channel,
			args: serializeFallbacks(args, channel),
		});
	}
	sendToFrame(_frame: unknown, channel: string, ...args: unknown[]): boolean {
		this.send(channel, ...args);
		return true;
	}
	postMessage(channel: string, message: unknown, ports: MainMessagePort[] = []): void {
		const nativePorts = ports.map((port) => port.port);
		this.hooks.send(
			{
				type: "renderer-port",
				windowId: this.id,
				channel,
				value: message,
				ports: nativePorts,
			},
			nativePorts,
		);
	}
	get userAgent(): string {
		return this.getUserAgent();
	}
	set userAgent(value: string) {
		this.setUserAgent(value);
	}
	getUserAgent(): string {
		return this.effectiveUserAgent;
	}
	setUserAgent(value: string): void {
		this.effectiveUserAgent = value;
		this.command("userAgent", value);
	}
	loadURL(url: string, options?: { userAgent?: string }): Promise<void> {
		if (options?.userAgent !== undefined) this.setUserAgent(options.userAgent);
		return this.load(url, false);
	}
	loadFile(
		filename: string,
		options?: { query?: Record<string, string>; hash?: string; search?: string },
	): Promise<void> {
		filename = this.hooks.vfs.normalizePath(filename);
		return this.load(
			path.resolve(applicationPath(this.hooks.config.app), filename),
			true,
			options,
		);
	}
	getURL(): string {
		return this.url;
	}
	isLoading(): boolean {
		return this.loading;
	}
	isLoadingMainFrame(): boolean {
		return this.loading;
	}
	getTitle(): string {
		return this.title;
	}
	getType(): string {
		return "window";
	}
	getProcessId(): number {
		return this.id + 1;
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	executeJavaScript(code: string): Promise<unknown> {
		return this.hooks.rpc.call("window.evaluate", this.id, code);
	}
	insertCSS(css: string): Promise<string> {
		return this.hooks.rpc.call("window.css", this.id, css);
	}
	removeInsertedCSS(key: string): Promise<void> {
		return this.hooks.rpc.call("window.removeCSS", this.id, key);
	}
	reload(): void {
		this.command("reload");
	}
	reloadIgnoringCache(): void {
		this.reload();
	}
	stop(): void {
		this.command("stop");
	}
	goBack(): void {
		this.command("back");
	}
	goForward(): void {
		this.command("forward");
	}
	openDevTools(): void {
		this.hooks.send({ type: "console-open" });
		this.emit("devtools-opened");
	}
	closeDevTools(): void {
		this.hooks.send({ type: "console-close" });
	}
	toggleDevTools(): void {
		this.openDevTools();
	}
	setZoomFactor(value: number): void {
		this.zoom = value;
		this.command("zoom", value);
	}
	getZoomFactor(): number {
		return this.zoom;
	}
	setZoomLevel(value: number): void {
		this.setZoomFactor(1.2 ** value);
	}
	getZoomLevel(): number {
		return Math.log(this.zoom) / Math.log(1.2);
	}
	get zoomFactor(): number {
		return this.getZoomFactor();
	}
	set zoomFactor(value: number) {
		this.setZoomFactor(value);
	}
	get zoomLevel(): number {
		return this.getZoomLevel();
	}
	set zoomLevel(value: number) {
		this.setZoomLevel(value);
	}
	focus(): void {
		this.command("focus");
	}
	print(): void {
		this.command("print");
	}
	async capturePage(): Promise<ReturnType<ReturnType<typeof imageModule>["createFromBuffer"]>> {
		return imageModule(this.hooks.vfs).createFromBuffer(
			await this.hooks.rpc.call<Uint8Array>("window.capture", this.id),
		);
	}
	async printToPDF(): Promise<Buffer> {
		return Buffer.from(await this.hooks.rpc.call<Uint8Array>("window.pdf", this.id));
	}
	async downloadURL(url: string): Promise<void> {
		const response = await this.hooks.network.fetch(url);
		const filename = `/home/user/Downloads/${decodeURIComponent(new URL(url).pathname.split("/").pop() || "download")}`;
		this.hooks.vfs.fs.writeFileSync(filename, new Uint8Array(await response.arrayBuffer()));
		await this.hooks.rpc.call("shell.download", filename);
	}
	setWindowOpenHandler(
		handler: (details: { url: string }) => {
			action: string;
			overrideBrowserWindowOptions?: WindowOptions;
		},
	): void {
		this.openHandler = handler;
	}
	openWindow(url: string): { action: string; overrideBrowserWindowOptions?: WindowOptions } {
		return this.openHandler?.({ url }) || { action: "allow" };
	}
	command(method: string, ...args: unknown[]): void {
		this.hooks.send({ type: "window-command", windowId: this.id, method, args });
	}
}

export function createElectron(hooks: Hooks) {
	const { config, vfs, rpc, network } = hooks;
	const sessionFor = (options: WindowOptions) =>
		(options.webPreferences &&
			(Reflect.get(options.webPreferences, "session") as
				| ReturnType<typeof session.fromPartition>
				| undefined)) ||
		session.fromPartition(options.webPreferences?.partition || "default");
	const hostOptions = (options: WindowOptions): WindowOptions => {
		const preferences = options.webPreferences || {};
		const target = sessionFor(options);
		return {
			title: options.title,
			width: options.width,
			height: options.height,
			x: options.x,
			y: options.y,
			show: options.show,
			frame: options.frame,
			resizable: options.resizable,
			backgroundColor: options.backgroundColor,
			autoHideMenuBar: options.autoHideMenuBar,
			webPreferences: {
				userAgent: target.getUserAgent(),
				preload: preferences.preload,
				nodeIntegration: preferences.nodeIntegration,
				contextIsolation: preferences.contextIsolation,
				partition: target.partition,
				webviewTag: preferences.webviewTag,
				additionalArguments: preferences.additionalArguments,
				sessionPreloads: target.getPreloads(),
			},
		};
	};
	const platform = platformModules(vfs, rpc, config.app.manifest.name, hooks.send);
	const windows = new Map<number, BrowserWindow>();
	const contents = new Map<number, WebContents>();
	let nextWindow = 0;
	let focused: number | undefined;
	let ready = false;
	// Registered link schemes and, on Windows, the extra launcher arguments
	// the OS passes before the URL (setAsDefaultProtocolClient's `args`).
	const linkSchemes = new Map<string, string[]>();
	let singleInstance = false;
	let quitting = false;
	let exiting = false;
	let allClosedTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveReady: () => void = () => {};
	const readyPromise = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	function markReady(): void {
		if (ready || exiting) return;
		ready = true;
		app.emit("will-finish-launching");
		resolveReady();
		app.emit("ready", {});
	}
	const paths: Record<string, string> = {
		home: "/home/user",
		appData: "/home/user/.config",
		userData: `/home/user/.config/${config.app.manifest.name}`,
		sessionData: "/home/user/.session",
		temp: "/tmp",
		exe: "/neutron/electron",
		module: "/app",
		desktop: "/home/user/Desktop",
		documents: "/home/user/Documents",
		downloads: "/home/user/Downloads",
		logs: "/home/user/logs",
		cache: "/home/user/.cache",
		crashDumps: `/home/user/.config/${config.app.manifest.name}/Crashpad`,
		music: "/home/user/Music",
		pictures: "/home/user/Pictures",
		videos: "/home/user/Videos",
		recent: "/home/user/Recent",
	};
	for (const folder of Object.values(paths))
		if (!folder.startsWith("/neutron")) vfs.fs.mkdirSync(folder, { recursive: true });
	const cancelable = () => ({
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
	});
	const switches = new Map<string, string>();
	let appName = config.app.manifest.name;
	function exit(code = 0): void {
		if (exiting) return;
		exiting = true;
		quitting = true;
		try {
			for (const window of [...windows.values()]) window.destroy();
			app.emit("quit", {}, code);
		} finally {
			hooks.exit(code);
		}
	}
	const app = Object.assign(new EventEmitter(), {
		isPackaged: true,
		accessibilitySupportEnabled: false,
		runningUnderARM64Translation: false,
		userAgentFallback: defaultUserAgent(config),
		whenReady: () => {
			if (!ready) queueMicrotask(markReady);
			return readyPromise;
		},
		isReady: () => ready,
		getName: () => appName,
		setName: (name: string) => {
			appName = name;
		},
		getVersion: () => config.app.manifest.version,
		getGPUInfo: async () => ({ gpuDevice: [], auxAttributes: { browserManaged: true } }),
		getAppMetrics: () => [],
		getGPUFeatureStatus: () =>
			Object.fromEntries(
				[
					"2d_canvas",
					"gpu_compositing",
					"rasterization",
					"opengl",
					"video_decode",
					"video_encode",
					"webgl",
					"webgl2",
					"webgpu",
				].map((name) => [name, "unavailable_off"]),
			),
		getAppPath: () => applicationPath(config.app),
		setAppPath: (value: string) => {
			const next = path.resolve(applicationPath(config.app), value);
			if (!vfs.fs.statSync(next).isDirectory())
				throw new Error(`Application path is not a directory or ASAR mount: ${next}`);
			config.app.appPath = next;
		},
		getPath: (name: string) => {
			if (!paths[name]) throw new Error(`Unknown app path: ${name}`);
			return paths[name];
		},
		setPath: (name: string, value: string) => {
			paths[name] = value;
			vfs.fs.mkdirSync(value, { recursive: true });
		},
		getLocale: () => navigator.language,
		getPreferredSystemLanguages: () => [...navigator.languages],
		getSystemLocale: () => navigator.language,
		getLocaleCountryCode: () => navigator.language.split("-")[1] || "US",
		quit: () => {
			if (quitting) return;
			quitting = true;
			try {
				const event = cancelable();
				app.emit("before-quit", event);
				if (event.defaultPrevented || exiting) return;
				for (const window of [...windows.values()]) {
					window.close();
					if (!window.isDestroyed() || exiting) return;
				}
				if (windows.size) return;
				const willQuit = cancelable();
				app.emit("will-quit", willQuit);
				if (!willQuit.defaultPrevented) exit();
			} finally {
				if (!exiting) quitting = false;
			}
		},
		exit,
		// Like Electron, this only schedules a new instance for when this one
		// exits. There is no other executable to launch: an `execPath` option
		// starts the same app again.
		relaunch: (options: { args?: unknown[]; execPath?: string } = {}) => {
			hooks.send({
				type: "relaunch",
				args: (options.args ?? config.argv ?? []).map(String),
			});
		},
		requestSingleInstanceLock: () => {
			singleInstance = true;
			return true;
		},
		releaseSingleInstanceLock: () => {
			singleInstance = false;
		},
		hasSingleInstanceLock: () => singleInstance,
		setAsDefaultProtocolClient: (value: string, _path?: string, args?: string[]) => {
			const scheme = appLinkScheme(value);
			if (!scheme) return false;
			linkSchemes.set(scheme, Array.isArray(args) ? args.map(String) : []);
			return true;
		},
		removeAsDefaultProtocolClient: (value: string) =>
			linkSchemes.delete(appLinkScheme(value) ?? ""),
		isDefaultProtocolClient: (value: string) => linkSchemes.has(appLinkScheme(value) ?? ""),
		commandLine: {
			appendSwitch: (name: string, value = "") => switches.set(name, value),
			hasSwitch: (name: string) => switches.has(name),
			getSwitchValue: (name: string) => switches.get(name) || "",
			removeSwitch: (name: string) => switches.delete(name),
			appendArgument: (value: string) => switches.set(value, ""),
		},
		disableHardwareAcceleration: () => console.warn("Browser manages hardware acceleration."),
		setAppUserModelId: (value: string) => {
			console.debug(`Virtual AppUserModelId: ${value}`);
		},
		setAboutPanelOptions: (options: object) => {
			about = options;
		},
		showAboutPanel: () =>
			rpc.call("dialog.message", {
				title: appName,
				message: `${appName} ${config.app.manifest.version}`,
				detail: JSON.stringify(about),
			}),
		focus: () => BrowserWindow.getAllWindows()[0]?.focus(),
	});
	let about: object = {};
	Object.defineProperty(app, "name", {
		enumerable: true,
		configurable: true,
		get: () => appName,
		set: (value: string) => {
			appName = String(value);
		},
	});

	class View extends EventEmitter {
		readonly id: number;
		children: View[] = [];
		private bounds: Bounds = { x: 0, y: 0, width: 300, height: 200 };
		constructor(options: WindowOptions = {}, rootId?: number) {
			super();
			this.id = rootId ?? ++nextWindow;
			if (rootId === undefined)
				hooks.send({
					type: "view-create",
					windowId: this.id,
					options: hostOptions({ ...options, frame: false, show: false }),
				});
		}
		addChildView(view: View, index = this.children.length): void {
			this.children = this.children.filter((child) => child !== view);
			this.children.splice(index, 0, view);
			hooks.send({ type: "view-attach", parentId: this.id, windowId: view.id });
		}
		removeChildView(view: View): void {
			this.children = this.children.filter((child) => child !== view);
			hooks.send({ type: "view-detach", windowId: view.id });
		}
		getBounds(): Bounds {
			return { ...this.bounds };
		}
		setBounds(bounds: Bounds): void {
			this.bounds = { ...bounds };
			hooks.send({
				type: "window-command",
				windowId: this.id,
				method: "bounds",
				args: [bounds],
			});
		}
		setVisible(value: boolean): void {
			hooks.send({
				type: "window-command",
				windowId: this.id,
				method: value ? "show" : "hide",
				args: [],
			});
		}
		setBackgroundColor(color: string): void {
			hooks.send({
				type: "window-command",
				windowId: this.id,
				method: "background",
				args: [color],
			});
		}
		setBorderRadius(radius: number): void {
			hooks.send({
				type: "window-command",
				windowId: this.id,
				method: "borderRadius",
				args: [radius],
			});
		}
	}
	class WebContentsView extends View {
		readonly webContents: WebContents;
		constructor(options: WindowOptions = {}) {
			super(options);
			this.webContents = withFallback(
				new WebContents(this.id, hooks, sessionFor(options)),
				"webContents",
			);
			contents.set(this.id, this.webContents);
		}
		setAutoResize(options: object): void {
			hooks.send({
				type: "window-command",
				windowId: this.id,
				method: "autoResize",
				args: [options],
			});
		}
	}
	class BrowserWindow extends EventEmitter {
		closing = false;
		readonly id: number;
		readonly webContents: WebContents;
		readonly contentView: View;
		private browserViews: WebContentsView[] = [];
		private bounds: Bounds;
		private viewportBounds?: Bounds;
		private title: string;
		private destroyed = false;
		private visible: boolean;
		autoHideMenuBar: boolean;
		menuBarVisible: boolean;
		menu?: Menu | null;
		private maximized = false;
		private minimized = false;
		private fullscreen = false;
		private maximizable = true;
		private minimizable = true;
		private fullscreenable = true;
		private minimumSize = [0, 0];
		private maximumSize = [0, 0];
		constructor(readonly options: WindowOptions = {}) {
			super();
			clearTimeout(allClosedTimer);
			this.id = ++nextWindow;
			this.bounds = {
				x: options.x ?? 40 + (this.id - 1) * 24,
				y: options.y ?? 32 + (this.id - 1) * 24,
				width: options.width ?? 800,
				height: options.height ?? 600,
			};
			this.title = options.title || appName;
			this.visible = options.show !== false;
			this.autoHideMenuBar = !!options.autoHideMenuBar;
			this.menuBarVisible = !this.autoHideMenuBar;
			this.webContents = withFallback(
				new WebContents(this.id, hooks, sessionFor(options)),
				"webContents",
			);
			this.contentView = new View({}, this.id);
			contents.set(this.id, this.webContents);
			Object.assign(this.webContents, {
				getOwnerBrowserWindow: () => this,
				getLastWebPreferences: () => ({ ...this.options.webPreferences }),
			});
			windows.set(this.id, this);
			if (this.visible) focused = this.id;
			hooks.send({
				type: "window-create",
				windowId: this.id,
				options: hostOptions({ ...options, ...this.bounds, title: this.title }),
			});
			app.emit("web-contents-created", {}, this.webContents);
			app.emit("browser-window-created", {}, withFallback(this, "BrowserWindow"));
		}
		static getAllWindows(): BrowserWindow[] {
			return [...windows.values()].map((window) => withFallback(window, "BrowserWindow"));
		}
		static getFocusedWindow(): BrowserWindow | null {
			const window = windows.get(focused || 0);
			return window ? withFallback(window, "BrowserWindow") : null;
		}
		static fromId(id: number): BrowserWindow | null {
			const window = windows.get(id);
			return window ? withFallback(window, "BrowserWindow") : null;
		}
		static fromWebContents(contents: WebContents): BrowserWindow | null {
			return BrowserWindow.fromId(contents.id);
		}
		loadFile(...args: Parameters<WebContents["loadFile"]>): Promise<void> {
			return this.webContents.loadFile(...args);
		}
		loadURL(...args: Parameters<WebContents["loadURL"]>): Promise<void> {
			return this.webContents.loadURL(...args);
		}
		close(): void {
			if (this.closing || this.destroyed) return;
			this.closing = true;
			try {
				const event = cancelable();
				this.emit("close", event);
				if (!event.defaultPrevented) this.destroy();
			} finally {
				this.closing = false;
			}
		}
		destroy(): void {
			if (this.destroyed) return;
			this.destroyed = true;
			this.webContents.destroyed = true;
			windows.delete(this.id);
			contents.delete(this.id);
			for (const view of this.contentView.children) {
				const webContents = contents.get(view.id);
				if (webContents) {
					webContents.destroyed = true;
					webContents.emit("destroyed");
					contents.delete(view.id);
				}
				hooks.send({
					type: "window-command",
					windowId: view.id,
					method: "destroy",
					args: [],
				});
			}
			this.webContents.command("destroy");
			this.webContents.emit("destroyed");
			this.emit("closed");
			// Window teardown in Chromium crosses an event-loop boundary. Apps
			// can close a setup window and create its replacement in the same turn.
			if (!quitting && !windows.size) {
				clearTimeout(allClosedTimer);
				allClosedTimer = setTimeout(() => {
					if (!quitting && !windows.size) app.emit("window-all-closed");
				}, 0);
			}
		}
		isDestroyed(): boolean {
			return this.destroyed;
		}
		show(): void {
			this.visible = true;
			this.webContents.command("show");
			this.emit("show");
			this.focus();
		}
		showInactive(): void {
			this.visible = true;
			this.webContents.command("showInactive");
		}
		hide(): void {
			this.visible = false;
			this.webContents.command("hide");
			this.emit("hide");
		}
		isVisible(): boolean {
			return this.visible;
		}
		focus(): void {
			focused = this.id;
			this.webContents.focus();
			this.emit("focus");
		}
		blur(): void {
			focused = undefined;
			this.emit("blur");
		}
		isFocused(): boolean {
			return focused === this.id;
		}
		minimize(): void {
			this.minimized = true;
			this.webContents.command("minimize");
			this.emit("minimize");
		}
		restore(): void {
			this.minimized = false;
			this.webContents.command("restore");
			this.emit("restore");
		}
		isMinimized(): boolean {
			return this.minimized;
		}
		maximize(): void {
			this.maximized = true;
			this.webContents.command("maximize");
			this.emit("maximize");
		}
		unmaximize(): void {
			this.maximized = false;
			this.webContents.command("unmaximize");
			this.emit("unmaximize");
		}
		isMaximized(): boolean {
			return this.maximized;
		}
		setFullScreen(value: boolean): void {
			this.fullscreen = value;
			this.webContents.command(value ? "maximize" : "unmaximize");
			this.emit(value ? "enter-full-screen" : "leave-full-screen");
		}
		isFullScreen(): boolean {
			return this.fullscreen;
		}
		getBounds(): Bounds {
			return { ...this.bounds };
		}
		getContentBounds(): Bounds {
			return this.getBounds();
		}
		setBounds(value: Partial<Bounds>): void {
			if (this.viewportBounds) return;
			Object.assign(this.bounds, value);
			this.webContents.command("bounds", this.bounds);
			this.emit("resize");
		}
		syncViewportBounds(value: Bounds): void {
			const resized =
				value.width !== this.bounds.width || value.height !== this.bounds.height;
			this.viewportBounds = { ...value };
			this.bounds = { ...value };
			if (resized) this.emit("resize");
		}
		setContentBounds(value: Partial<Bounds>): void {
			this.setBounds(value);
		}
		getSize(): number[] {
			return [this.bounds.width, this.bounds.height];
		}
		getContentSize(): number[] {
			return this.getSize();
		}
		setSize(width: number, height: number): void {
			this.setBounds({ width, height });
		}
		setContentSize(width: number, height: number): void {
			this.setSize(width, height);
		}
		getPosition(): number[] {
			return [this.bounds.x, this.bounds.y];
		}
		setPosition(x: number, y: number): void {
			this.setBounds({ x, y });
		}
		center(): void {
			this.webContents.command("center");
		}
		setTitle(title: string): void {
			this.title = title;
			this.webContents.command("title", title);
		}
		getTitle(): string {
			return this.title;
		}
		setBackgroundColor(color: string): void {
			this.webContents.command("background", color);
		}
		setResizable(value: boolean): void {
			this.options.resizable = value;
			this.webContents.command("resizable", value);
		}
		setMaximizable(value: boolean): void {
			this.maximizable = value;
		}
		isMaximizable(): boolean {
			return this.maximizable;
		}
		setMinimizable(value: boolean): void {
			this.minimizable = value;
		}
		isMinimizable(): boolean {
			return this.minimizable;
		}
		setFullScreenable(value: boolean): void {
			this.fullscreenable = value;
		}
		isFullScreenable(): boolean {
			return this.fullscreenable;
		}
		setMinimumSize(width: number, height: number): void {
			this.minimumSize = [width, height];
		}
		getMinimumSize(): number[] {
			return [...this.minimumSize];
		}
		setMaximumSize(width: number, height: number): void {
			this.maximumSize = [width, height];
		}
		getMaximumSize(): number[] {
			return [...this.maximumSize];
		}
		isResizable(): boolean {
			return this.options.resizable !== false;
		}
		setAlwaysOnTop(value: boolean): void {
			this.webContents.command("alwaysOnTop", value);
		}
		setMenu(menu: Menu | null): void {
			this.menu = menu;
			this.webContents.command("setMenu", menu?.items.map((item) => item.serialize()) ?? []);
		}
		setBrowserView(view: WebContentsView | null): void {
			for (const previous of this.browserViews) this.contentView.removeChildView(previous);
			this.browserViews = [];
			if (view) this.addBrowserView(view);
		}
		addBrowserView(view: WebContentsView): void {
			this.browserViews.push(view);
			this.contentView.addChildView(view);
		}
		removeBrowserView(view: WebContentsView): void {
			this.browserViews = this.browserViews.filter((item) => item !== view);
			this.contentView.removeChildView(view);
		}
		getBrowserView(): WebContentsView | null {
			return this.browserViews[0] || null;
		}
		getBrowserViews(): WebContentsView[] {
			return [...this.browserViews];
		}
		setTopBrowserView(view: WebContentsView): void {
			this.contentView.addChildView(view);
		}
		setMenuBarVisibility(value: boolean): void {
			this.menuBarVisible = Boolean(value);
			this.webContents.command("menuVisible", this.menuBarVisible);
		}
		isMenuBarVisible(): boolean {
			return this.menuBarVisible;
		}
		setAutoHideMenuBar(value: boolean): void {
			this.autoHideMenuBar = Boolean(value);
		}
		isMenuBarAutoHide(): boolean {
			return this.autoHideMenuBar;
		}
		removeMenu(): void {
			this.setMenu(null);
		}
		setProgressBar(value: number): void {
			hooks.send({ type: "progress", value });
		}
		flashFrame(value: boolean): void {
			this.webContents.command("attention", value);
		}
		getNativeWindowHandle(): never {
			return unsupported("BrowserWindow.getNativeWindowHandle");
		}
		reload(): void {
			this.webContents.reload();
		}
	}

	const ipcMain = new IpcMain();
	const ipcTargets = (sender: WebContents) => [sender.mainFrame.ipc, sender.ipc, ipcMain];
	const emitIPC = (sender: WebContents, event: IpcEvent, channel: string, args: unknown[]) => {
		sender.emit("ipc-message", event, channel, ...args);
		for (const target of ipcTargets(sender)) target.emit(channel, event, ...args);
	};
	let applicationMenu: Menu | null = null;
	class Menu extends MenuModel {
		static buildFromTemplate(template: MenuTemplate[]): Menu {
			const menu = new Menu();
			for (const item of template)
				menu.append(item instanceof MenuItem ? item : new MenuItem(item));
			return menu;
		}
		static setApplicationMenu(menu: Menu | null): void {
			applicationMenu = menu;
			for (const window of windows.values()) window.menu = undefined;
			hooks.send({ type: "menu", items: menu?.items.map((item) => item.serialize()) || [] });
		}
		static getApplicationMenu(): Menu | null {
			return applicationMenu;
		}
		/** Shows a context menu at the pointer (or options.x/y in the window). */
		popup(
			options: { window?: BrowserWindow; x?: number; y?: number; callback?: () => void } = {},
		): void {
			finishPopup();
			const window = options.window ?? BrowserWindow.getFocusedWindow() ?? undefined;
			popup = { menu: this, window, callback: options.callback };
			this.emit("menu-will-show", { preventDefault() {} });
			hooks.send({
				type: "context-menu",
				windowId: window?.id,
				x: options.x,
				y: options.y,
				items: this.items.map((item) => item.serialize()),
			});
		}
		closePopup(): void {
			if (popup?.menu !== this) return;
			hooks.send({ type: "menu-close" });
			finishPopup();
		}
	}
	let popup: { menu: Menu; window?: BrowserWindow; callback?: () => void } | undefined;
	const finishPopup = () => {
		const done = popup;
		popup = undefined;
		if (!done) return;
		done.menu.emit("menu-will-close", { preventDefault() {} });
		done.callback?.();
	};
	MenuItem.createMenu = (template) => Menu.buildFromTemplate(template);
	MenuItem.executeRole = (role, target) => {
		const window = target instanceof BrowserWindow ? target : BrowserWindow.getFocusedWindow();
		if (role === "quit") app.quit();
		else if (role === "close") window?.close();
		else if (role === "reload") window?.reload();
		else if (role === "toggleDevTools" || role === "toggledevtools")
			window?.webContents.openDevTools();
		else return false;
		return true;
	};
	const dialogOptions = (args: unknown[]): unknown =>
		args.find((arg) => arg && typeof arg === "object" && !(arg instanceof BrowserWindow)) || {};
	const dialog = {
		showOpenDialog: (...args: unknown[]) => rpc.call("dialog.open", dialogOptions(args)),
		showSaveDialog: (...args: unknown[]) => rpc.call("dialog.save", dialogOptions(args)),
		showMessageBox: (...args: unknown[]) => rpc.call("dialog.message", dialogOptions(args)),
		showErrorBox: (title: string, content: string) => {
			void rpc.call("dialog.message", { title, message: content, type: "error" });
		},
		showOpenDialogSync: (...args: unknown[]) =>
			syncCall<{ canceled: boolean; filePaths?: string[] }>(
				config.instanceId,
				"host",
				"dialog.open",
				[dialogOptions(args)],
			).filePaths,
		showSaveDialogSync: (...args: unknown[]) =>
			syncCall<{ canceled: boolean; filePath?: string }>(
				config.instanceId,
				"host",
				"dialog.save",
				[dialogOptions(args)],
			).filePath,
		showMessageBoxSync: (...args: unknown[]) =>
			syncCall<{ response: number }>(config.instanceId, "host", "dialog.message", [
				dialogOptions(args),
			]).response,
	};
	let clipboardText = "";
	const clipboard = {
		readText: () => clipboardText,
		writeText: (value: string) => {
			clipboardText = value;
			hooks.send({ type: "clipboard", text: value });
		},
		clear: () => {
			clipboardText = "";
		},
		availableFormats: () => (clipboardText ? ["text/plain"] : []),
	};
	const shortcuts = new Map<string, () => void>();
	const globalShortcut = {
		register: (accelerator: string, callback: () => void) => {
			shortcuts.set(accelerator, callback);
			hooks.send({ type: "shortcuts", keys: [...shortcuts.keys()] });
			return true;
		},
		unregister: (accelerator: string) => {
			shortcuts.delete(accelerator);
		},
		unregisterAll: () => shortcuts.clear(),
		isRegistered: (accelerator: string) => shortcuts.has(accelerator),
	};
	type ProtocolHandler = (request: Request) => Response | Promise<Response>;
	const byPartition = new Map<string, Map<string, ProtocolHandler>>();
	const protocolHandler = (partition: string, scheme: string) =>
		byPartition.get(partition)?.get(scheme);
	const mime = (filename: string): string =>
		({
			html: "text/html",
			css: "text/css",
			js: "text/javascript",
			mjs: "text/javascript",
			wasm: "application/wasm",
			woff: "font/woff",
			ttf: "font/ttf",
			webp: "image/webp",
			gif: "image/gif",
			ico: "image/x-icon",
			json: "application/json",
			svg: "image/svg+xml",
			png: "image/png",
			jpg: "image/jpeg",
			woff2: "font/woff2",
		})[filename.split(".").pop() || ""] || "application/octet-stream";
	type LegacyResponse =
		| string
		| Uint8Array
		| {
				path?: string;
				data?: string | Uint8Array;
				mimeType?: string;
				statusCode?: number;
				headers?: HeadersInit;
		  };
	const createProtocol = (partition: string) => {
		const protocols = new Map<string, ProtocolHandler>();
		byPartition.set(partition, protocols);
		const updated = () =>
			hooks.send({ type: "protocols", partition, schemes: [...protocols.keys()] });
		const register = (scheme: string, handler: ProtocolHandler) => {
			scheme = scheme.toLowerCase();
			if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || typeof handler !== "function")
				throw new TypeError("Invalid protocol registration");
			if (protocols.has(scheme)) throw new Error(`Protocol already handled: ${scheme}`);
			protocols.set(scheme, handler);
			updated();
		};
		const remove = (scheme: string) => {
			const removed = protocols.delete(scheme.toLowerCase());
			if (removed) updated();
			return removed;
		};
		const registerLegacy = (
			scheme: string,
			type: "file" | "buffer" | "string",
			handler: (request: Request, callback: (response: LegacyResponse) => void) => void,
		) => {
			register(
				scheme,
				(request) =>
					new Promise<Response>((resolve, reject) => {
						try {
							handler(request, (value) => {
								try {
									const options =
										typeof value === "object" && !(value instanceof Uint8Array)
											? value
											: {};
									const filename =
										options.path ||
										(type === "file" && typeof value === "string" ? value : "");
									const data =
										type === "file"
											? new Uint8Array(
													vfs.fs.readFileSync(filename) as Uint8Array,
												)
											: (options.data ??
												(typeof value === "string" ||
												value instanceof Uint8Array
													? value
													: ""));
									const headers = new Headers(options.headers);
									headers.set(
										"Content-Type",
										options.mimeType ||
											(type === "file"
												? mime(filename)
												: type === "string"
													? "text/html"
													: "application/octet-stream"),
									);
									resolve(
										new Response(
											typeof data === "string" ? data : new Uint8Array(data),
											{ status: options.statusCode || 200, headers },
										),
									);
								} catch (error) {
									reject(error);
								}
							});
						} catch (error) {
							reject(error);
						}
					}),
			);
		};
		return {
			handle: register,
			unhandle: (scheme: string) => {
				if (!remove(scheme)) throw new Error(`Protocol is not handled: ${scheme}`);
			},
			isProtocolHandled: (scheme: string) => protocols.has(scheme.toLowerCase()),
			isProtocolRegistered: (scheme: string) => protocols.has(scheme.toLowerCase()),
			unregisterProtocol: remove,
			registerFileProtocol: (scheme: string, handler: Parameters<typeof registerLegacy>[2]) =>
				registerLegacy(scheme, "file", handler),
			registerBufferProtocol: (
				scheme: string,
				handler: Parameters<typeof registerLegacy>[2],
			) => registerLegacy(scheme, "buffer", handler),
			registerStringProtocol: (
				scheme: string,
				handler: Parameters<typeof registerLegacy>[2],
			) => registerLegacy(scheme, "string", handler),
			registerSchemesAsPrivileged: () =>
				console.warn("Custom protocol privileges are browser-managed."),
		};
	};
	// Renderer documents and subresources load through the Scramjet proxy, not
	// `network`. The proxy asks for these filters on a session's responses.
	const rendererHeaders = new Map<string, HeadersReceived>();
	const session = sessionModule(
		network,
		vfs,
		createProtocol,
		() => app.userAgentFallback,
		(partition, patterns, dispatch) => {
			if (patterns) rendererHeaders.set(partition, dispatch);
			else rendererHeaders.delete(partition);
			hooks.send({ type: "web-request", partition, headers: patterns ?? [] });
		},
	);
	const protocol = session.defaultSession.protocol;
	network.protocolHandler = protocolHandler;
	network.localFetch = async (url) => {
		if (url.startsWith("file:"))
			return new Response(
				new Uint8Array(
					vfs.fs.readFileSync(decodeURIComponent(new URL(url).pathname)) as Uint8Array,
				),
				{ headers: { "Content-Type": mime(new URL(url).pathname) } },
			);
	};
	class Notification extends EventEmitter {
		constructor(readonly options: { title?: string; body?: string }) {
			super();
		}
		static isSupported(): boolean {
			return true;
		}
		show(): void {
			hooks.send({ type: "notification", ...this.options });
			this.emit("show");
		}
		close(): void {
			this.emit("close");
		}
	}
	const display = {
		id: 1,
		bounds: { x: 0, y: 0, width: 1280, height: 800 },
		workArea: { x: 0, y: 0, width: 1280, height: 800 },
		size: { width: 1280, height: 800 },
		workAreaSize: { width: 1280, height: 800 },
		scaleFactor: 1,
		rotation: 0,
		internal: true,
	};
	const electron = {
		ipcRenderer: undefined,
		contextBridge: undefined,
		webFrame: undefined,
		app,
		BrowserWindow,
		ipcMain,
		MessageChannelMain: MainMessageChannel,
		MessagePortMain: MainMessagePort,
		Menu,
		MenuItem,
		dialog,
		clipboard,
		nativeImage: imageModule(vfs),
		globalShortcut,
		protocol,
		session,
		Notification,
		net: {
			fetch: (input: string | Request, init?: RequestInit) =>
				network.electronFetch(input, init),
			request: network.http("https:", true).request,
			isOnline: () => navigator.onLine,
			get online() {
				return navigator.onLine;
			},
		},
		shell: {
			openExternal: (url: string) => rpc.call("shell.external", url),
			// Resolves with an error message rather than rejecting, like Electron.
			// A folder opens in the Files view, Neutron's file manager.
			openPath: async (filename: string) => {
				try {
					const target = vfs.normalizePath(filename);
					if (vfs.fs.statSync(target).isDirectory())
						hooks.send({ type: "show-files", filename: target });
					else await rpc.call("shell.download", target);
					return "";
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
			trashItem: async (filename: string) => vfs.fs.rmSync(filename, { recursive: true }),
			showItemInFolder: (filename: string) => hooks.send({ type: "show-files", filename }),
		},
		screen: Object.assign(new EventEmitter(), {
			getPrimaryDisplay: () => display,
			getAllDisplays: () => [display],
			getDisplayMatching: () => display,
			getDisplayNearestPoint: () => display,
		}),
		webContents: {
			getAllWebContents: () => [...contents.values()],
			fromId: (id: number) => contents.get(id),
			getFocusedWebContents: () => windows.get(focused || 0)?.webContents,
		},
		...Object.fromEntries(
			["autoUpdater", "utilityProcess", "desktopCapturer", "netLog", "webFrameMain"].map(
				(name) => [name, unsupportedModule(name)],
			),
		),
		...Object.fromEntries(["TouchBar", "ImageView"].map((name) => [name, createStub(name)])),
	};
	Object.assign(electron, platform, {
		View,
		BaseWindow: BrowserWindow,
		BrowserView: WebContentsView,
		WebContentsView,
	});
	Object.assign(electron, optionalElectron());
	const receive = async (message: Record<string, unknown>): Promise<void> => {
		platform.receive(message);
		const windowId = Number(message.windowId);
		const window = windows.get(windowId);
		const webContents = contents.get(windowId);
		if (message.type === "window-event" && webContents) {
			if (message.event === "did-start-loading") webContents.loading = true;
			if (message.event === "did-stop-loading" || message.event === "did-fail-load")
				webContents.loading = false;
		}
		if (
			(message.type === "navigation-commit" || message.type === "navigation-start") &&
			webContents
		) {
			const url = String(message.url),
				isInPlace = message.inPage === true;
			const { processId, routingId } = webContents.mainFrame;
			const details = {
				url,
				isMainFrame: true,
				isInPlace,
				frame: webContents.mainFrame,
				frameProcessId: processId,
				frameRoutingId: routingId,
			};
			if (message.type === "navigation-start")
				webContents.emit(
					"did-start-navigation",
					details,
					url,
					false,
					true,
					processId,
					routingId,
				);
			else {
				webContents.url = url;
				if (isInPlace)
					webContents.emit(
						"did-navigate-in-page",
						details,
						url,
						true,
						processId,
						routingId,
					);
				else {
					const httpResponseCode = Number(message.status) || -1;
					const event = { ...details, httpResponseCode, httpStatusText: "" };
					webContents.emit(
						"did-frame-navigate",
						event,
						url,
						httpResponseCode,
						"",
						true,
						processId,
						routingId,
					);
					webContents.emit("did-navigate", event, url, httpResponseCode, "");
				}
			}
			return;
		}
		if (message.type === "document-title" && webContents) {
			const event = cancelable(),
				title = String(message.title);
			webContents.title = title;
			webContents.emit("page-title-updated", event, title, true);
			window?.emit("page-title-updated", event, title, true);
			if (!event.defaultPrevented && window) window.setTitle(title);
			return;
		}
		if (message.type === "open-url" && webContents) {
			const url = String(message.url);
			if (message.disposition === "current-tab") {
				const event = cancelable();
				webContents.emit("will-navigate", event, url);
				if (!event.defaultPrevented) await webContents.loadURL(url);
			} else {
				const result = webContents.openWindow(url);
				if (result.action === "allow") {
					const child = new BrowserWindow(result.overrideBrowserWindowOptions);
					await child.loadURL(url);
					webContents.emit("did-create-window", child, { url });
				}
			}
		} else if (message.type === "ipc-port" && webContents) {
			const event: IpcEvent = {
				sender: webContents,
				senderFrame: webContents.mainFrame,
				reply: (channel, ...args) => webContents.send(channel, ...args),
				ports: (message.ports as MessagePort[]).map((port) => new MainMessagePort(port)),
			};
			emitIPC(webContents, event, String(message.channel), [message.value]);
		} else if (message.type === "ipc") {
			if (!webContents) return;
			const channel = String(message.channel);
			const event: IpcEvent = {
				sender: webContents,
				senderFrame: webContents.mainFrame,
				reply: (channel, ...args) => webContents.send(channel, ...args),
			};
			if (message.invoke) {
				try {
					const handler = ipcTargets(webContents)
						.map((target) => target.handlers.get(channel))
						.find(Boolean);
					if (!handler) throw new Error(`No ipcMain handler registered for '${channel}'`);
					const value = await handler(event, ...(message.args as unknown[]));
					hooks.send({
						type: "ipc-result",
						windowId,
						id: message.id,
						value: serializeFallbacks(value, channel),
					});
				} catch (error) {
					hooks.send({
						type: "ipc-result",
						windowId,
						id: message.id,
						error: `IPC ${channel}: ${String(error)}`,
					});
				}
			} else emitIPC(webContents, event, channel, message.args as unknown[]);
		} else if (message.type === "console-message" && webContents) {
			const level = String(message.level);
			const text = String(message.message);
			const sourceId = String(message.sourceId);
			// The event details support current Electron; positional arguments retain
			// the legacy signature used by applications built against older versions.
			webContents.emit(
				"console-message",
				{
					...cancelable(),
					message: text,
					level,
					sourceId,
					lineNumber: Number(message.lineNumber) || 0,
					frame: webContents.mainFrame,
				},
				["verbose", "info", "warning", "error"].indexOf(level),
				text,
				Number(message.lineNumber) || 0,
				sourceId,
			);
		} else if (message.type === "window-event" && webContents && !window) {
			webContents.emit(String(message.event), {}, ...((message.args as unknown[]) || []));
		} else if (message.type === "window-event" && window) {
			const event = String(message.event);
			if (event === "close") window.close();
			else if (event === "hide") window.hide();
			else if (event === "reload") window.reload();
			else if (event === "minimize") window.minimize();
			else if (event === "maximize")
				window.isMaximized() ? window.unmaximize() : window.maximize();
			else if (event === "restore") {
				window.restore();
				if (!window.isVisible()) window.show();
				else window.focus();
			} else if (event === "focus") {
				focused = windowId;
				window.emit("focus");
			} else if (event === "blur") {
				if (focused === windowId) focused = undefined;
				window.emit("blur");
			} else if (event === "bounds") {
				window.syncViewportBounds(message.bounds as Bounds);
			} else {
				window.webContents.emit(event, {}, ...((message.args as unknown[]) || []));
				if (event === "did-finish-load") window.emit("ready-to-show");
			}
		} else if (message.type === "menu-dismiss") finishPopup();
		else if (message.type === "menu-click" && message.popup) {
			// Electron runs the item's click handler, then closes the menu and
			// calls popup()'s callback.
			const open = popup;
			const item = open?.menu.getMenuItemById(String(message.id));
			const target = open?.window ?? BrowserWindow.getFocusedWindow() ?? undefined;
			try {
				if (item?.enabled) item.click({ preventDefault() {} }, target, target?.webContents);
			} finally {
				finishPopup();
			}
		} else if (message.type === "menu-click") {
			const menu = window?.menu === undefined ? applicationMenu : window.menu;
			const item = menu?.getMenuItemById(String(message.id));
			if (!item?.enabled) return;
			const target = window ?? BrowserWindow.getFocusedWindow() ?? undefined;
			item.click({ preventDefault() {} }, target, target?.webContents);
			if (window?.menu !== undefined) window.setMenu(window.menu);
			else
				hooks.send({
					type: "menu-update",
					items: applicationMenu?.items.map((item) => item.serialize()) || [],
				});
		} else if (message.type === "shortcut") shortcuts.get(String(message.key))?.();
		else if (message.type === "display") Object.assign(display, message.display);
	};
	return {
		electron: withFallback(electron, "electron"),
		quit: app.quit,
		exit,
		receive,
		/** Electron replies to sendSync when `event.returnValue` is assigned, which
		 * async handlers do after awaiting. The renderer stays blocked until then. */
		syncIpc: (
			windowId: number,
			channel: string,
			args: unknown[],
			respond: (result: { result?: unknown; error?: string }) => void,
		) => {
			const sender = contents.get(windowId);
			if (!sender) throw new Error("IPC sender is closed");
			let done = false;
			let value: unknown;
			const finish = (result: { result?: unknown; error?: string }) => {
				if (done) return;
				done = true;
				respond(result);
			};
			const event = {
				sender,
				frameId: 0,
				senderFrame: sender.mainFrame,
				reply: (name: string, ...values: unknown[]) => sender.send(name, ...values),
			} as IpcEvent;
			Object.defineProperty(event, "returnValue", {
				enumerable: true,
				get: () => value,
				set: (next: unknown) => {
					value = next;
					finish({ result: serializeFallbacks(next, channel) });
				},
			});
			try {
				sender.emit("ipc-message-sync", event, channel, ...args);
				for (const target of ipcTargets(sender)) {
					for (const listener of target.rawListeners(channel)) {
						const result = (listener as (...values: unknown[]) => unknown).call(
							target,
							event,
							...args,
						);
						if (result && typeof (result as Promise<unknown>).then === "function")
							void Promise.resolve(result).catch((error) =>
								finish({ error: String(error) }),
							);
					}
				}
			} catch (error) {
				finish({ error: String(error) });
				return;
			}
			// Returning from the handler (or resolving its Promise) is not a reply.
			// A timer/callback may assign returnValue later, including undefined.
		},
		protocolHandler,
		/** `webRequest.onHeadersReceived` for a response the renderer proxy received. */
		headersReceived: async (partition: string, details: Parameters<HeadersReceived>[0]) =>
			(await rendererHeaders.get(partition)?.(details)) ?? {},
		openLink: (value: string) => {
			const url = URL.parse(value);
			const args = url && linkSchemes.get(url.protocol.slice(0, -1));
			if (exiting || !url || !args) return false;
			// macOS delivers links to the running app with open-url. Windows and
			// Linux launch the registered command line, which a single-instance
			// app receives as second-instance argv: `exe [args...] url` on Windows
			// (the args given to setAsDefaultProtocolClient) and `exe url` on Linux.
			const platform = config.platform ?? "linux";
			if (platform === "darwin" && app.listenerCount("open-url"))
				return app.emit("open-url", cancelable(), value);
			if (singleInstance)
				return app.emit(
					"second-instance",
					cancelable(),
					[paths.exe, ...(platform === "win32" ? args : []), value],
					vfs.cwd,
					{},
				);
			// Neutron cannot start a second process for an app without the lock;
			// a URL handler is the only remaining way to deliver the link.
			return app.listenerCount("open-url") > 0 && app.emit("open-url", cancelable(), value);
		},
		markReady,
	};
}
