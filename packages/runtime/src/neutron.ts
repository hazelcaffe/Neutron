import { type AppWindow, type ContextMenuData, type MenuData, RuntimeHost } from "./core/host";
import type { PreparedBundle } from "./core/importer";
import { PageProxy } from "./core/proxy";
import { initializeRuntimeWorker } from "./core/runtime-worker";
import { AppStorage } from "./core/storage";
import {
	applicationEntry,
	errorText,
	type InstalledApp,
	type LogEntry,
	type RuntimeSettings,
	type Snapshot,
} from "./shared/types";

export type RuntimeState = "initializing" | "stopped" | "starting" | "running" | "failed";
export type Platform = "linux" | "win32" | "darwin";

export interface NeutronEvents {
	/** Lifecycle of the running app. */
	state: RuntimeState;
	/** Runtime, main-process, renderer and import output. */
	log: LogEntry;
	/** Top-level windows of the running app, including hidden ones and Browser tabs. */
	windows: readonly AppWindow[];
	/** The application menu for the active window (empty when it has none). */
	menu: readonly MenuData[];
	/** A popup menu the app opened with Menu.popup() (null once it closes).
	 * Answer it with clickContextMenu(). */
	contextMenu: ContextMenuData | null;
	/** Notifications, tray changes and progress the app would show natively. */
	notification: string;
	/** The app opened (true) or closed (false) its developer tools. */
	devtools: boolean;
	/** `shell.showItemInFolder()`: a path in the app's virtual filesystem. */
	reveal: string;
}

export interface StartOptions {
	/** Wisp relay (`ws:` or `wss:` URL). Omit or leave empty to run offline. */
	relay?: string;
	/** Throw ERR_UNSUPPORTED_API instead of using fallbacks for missing APIs. */
	strict?: boolean;
	/** Platform reported to the app. Match the package you imported. */
	platform?: Platform;
}

export interface ImportFile {
	file: File;
	/** Path inside the imported folder, e.g. `resources/app.asar`. */
	path: string;
}
export type ImportSource =
	/** A ZIP of an installed app's `resources` folder. */
	| { zip: File; name?: string }
	/** The files of an installed app's `resources` folder, e.g. an `<input webkitdirectory>` FileList. */
	| { files: Iterable<File | ImportFile>; name?: string; kind?: "folder" | "example" };

export interface ImportCandidate {
	name: string;
	version: string;
	appPath: string;
	/** The detected main-process entry, when there is one. */
	entryPoint?: string;
	/** Scripts that could be the main-process entry. */
	choices: string[];
	/** Why the entry needs a decision. */
	issue?: string;
}
export interface ImportReview {
	name: string;
	importedFiles: number;
	archives: string[];
	missing: string[];
	candidates: ImportCandidate[];
	suggested?: number;
}
export interface ImportChoice {
	candidate: number;
	entry: string;
}
export interface ImportOptions {
	onProgress?(message: string): void;
	/**
	 * Called when the package or its startup file is ambiguous. Return the choice,
	 * or null to cancel. Without this callback such imports are rejected.
	 */
	chooseEntry?(review: ImportReview): Promise<ImportChoice | null> | ImportChoice | null;
	signal?: AbortSignal;
}

export interface NeutronOptions {
	/** Element that app windows fill. Give it a size; Neutron positions windows inside it. */
	viewport: HTMLElement;
}

type Listener<T> = (value: T) => void;
type ImportMessage =
	| { type: "progress"; message: string }
	| { type: "error"; message: string }
	| { type: "prepared"; review: Omit<PreparedBundle, "snapshot"> }
	| { type: "complete"; app: InstalledApp; snapshot: Snapshot };

const MAX_LOGS = 2000;
let instance: Neutron | undefined;

/**
 * The Neutron runtime: imports Electron apps into browser storage and runs one
 * at a time inside a viewport element. Create it with {@link Neutron.create}.
 *
 * The page must be served with the runtime's assets at the site root and with
 * cross-origin isolation headers; `@neutron/runtime/vite` does both.
 */
export class Neutron {
	private readonly storage = new AppStorage();
	private readonly host: RuntimeHost;
	private readonly listeners = new Map<keyof NeutronEvents, Set<Listener<never>>>();
	private readonly history: LogEntry[] = [];
	private current: RuntimeState = "initializing";
	private active?: InstalledApp;
	private pending?: InstalledApp;
	private windowList: readonly AppWindow[] = [];
	private menuItems: readonly MenuData[] = [];

	/** Mounts the runtime and verifies its service worker. One instance per page. */
	static async create(options: NeutronOptions): Promise<Neutron> {
		if (instance) throw new Error("Neutron is already running in this page.");
		const neutron = new Neutron(options);
		instance = neutron;
		try {
			await neutron.storage.init();
			await initializeRuntimeWorker();
		} catch (error) {
			instance = undefined;
			throw error;
		}
		neutron.setState("stopped");
		neutron.log(
			"info",
			"runtime",
			"OPFS mounted · Service worker active · Scramjet initialized",
		);
		return neutron;
	}

	private constructor(options: NeutronOptions) {
		installStyles();
		options.viewport.classList.add("neutron-viewport");
		this.host = new RuntimeHost(options.viewport, this.storage, new PageProxy(), {
			log: (entry) => this.record(entry),
			state: (state) => this.setState(state),
			menu: (items) => {
				this.menuItems = items;
				this.emit("menu", items);
			},
			contextMenu: (menu) => this.emit("contextMenu", menu),
			windows: (items) => {
				this.windowList = items;
				this.emit("windows", items);
			},
			console: (open) => this.emit("devtools", open),
			toast: (message) => this.emit("notification", message),
			files: (filename) => this.emit("reveal", filename),
		});
	}

	/** Subscribes to an event. Returns a function that unsubscribes. */
	on<K extends keyof NeutronEvents>(type: K, listener: Listener<NeutronEvents[K]>): () => void {
		const set = this.listeners.get(type) ?? new Set();
		this.listeners.set(type, set);
		set.add(listener as Listener<never>);
		return () => set.delete(listener as Listener<never>);
	}

	get state(): RuntimeState {
		return this.current;
	}
	/** The app that is starting, running or failed; undefined when stopped. */
	get app(): InstalledApp | undefined {
		return this.active;
	}
	get windows(): readonly AppWindow[] {
		return this.windowList;
	}
	get menu(): readonly MenuData[] {
		return this.menuItems;
	}
	/** The most recent log entries (up to 2,000), oldest first. */
	get logs(): readonly LogEntry[] {
		return this.history.slice();
	}
	clearLogs(): void {
		this.history.length = 0;
	}

	/** Imported apps, newest first as stored. */
	listApps(): Promise<InstalledApp[]> {
		return this.storage.list();
	}

	/**
	 * Imports an app from its `resources` folder or a ZIP of it, including
	 * `app.asar.unpacked` and every companion file, into browser storage.
	 */
	async importApp(source: ImportSource, options: ImportOptions = {}): Promise<InstalledApp> {
		const input = importInput(source);
		const worker = new Worker(new URL("./core/import-worker.ts", import.meta.url), {
			type: "module",
		});
		const { signal } = options;
		let installing = false;
		try {
			const result = await new Promise<{ app: InstalledApp; snapshot: Snapshot }>(
				(resolve, reject) => {
					const abort = () => {
						if (!installing) reject(signal?.reason ?? abortError());
					};
					signal?.throwIfAborted();
					signal?.addEventListener("abort", abort, { once: true });
					const finalize = (candidate: number, entry?: string) =>
						worker.postMessage({ type: "finalize", candidate, entry });
					worker.onerror = (event) =>
						reject(new Error(`Import failed: ${event.message}`));
					worker.onmessage = (event: MessageEvent<ImportMessage>) => {
						const message = event.data;
						if (message.type === "progress") options.onProgress?.(message.message);
						else if (message.type === "error") reject(new Error(message.message));
						else if (message.type === "complete") {
							installing = true;
							resolve(message);
						} else if (message.type === "prepared") {
							const review = message.review;
							const index = review.suggested;
							if (index !== undefined && review.candidates[index]?.entryPoint) {
								finalize(index);
								return;
							}
							if (!options.chooseEntry) {
								reject(
									new Error(
										review.candidates[review.suggested ?? 0]?.issue ||
											"Choose the app’s main-process entry.",
									),
								);
								return;
							}
							void Promise.resolve(options.chooseEntry(toReview(review))).then(
								(choice) => {
									if (!choice) reject(abortError());
									else finalize(choice.candidate, choice.entry);
								},
								reject,
							);
						}
					};
					worker.postMessage({ type: "prepare", ...input });
				},
			);
			options.onProgress?.("Saving resources to this browser…");
			await this.storage.install(result.app, result.snapshot);
			this.describeImport(result.app);
			return result.app;
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError"))
				this.log("error", "import", errorText(error));
			throw error;
		} finally {
			worker.terminate();
		}
	}

	/** Deletes an app and everything it stored. Stops it first if it is running. */
	async removeApp(id: string): Promise<void> {
		if (this.active?.id === id || this.pending?.id === id) await this.stop();
		await this.storage.remove(id);
	}

	/** The app's virtual filesystem: live while it runs, otherwise as last saved. */
	async files(id: string): Promise<Snapshot> {
		await this.storage.flush();
		if (this.active?.id === id && this.current !== "stopped") return this.host.getSnapshot();
		return this.storage.load(id);
	}

	/** Starts an app, stopping any app that is already running. */
	async start(app: InstalledApp | string, options: StartOptions = {}): Promise<void> {
		if (this.current === "initializing") throw new Error("Neutron is still initializing.");
		const target =
			typeof app === "string" ? (await this.listApps()).find((item) => item.id === app) : app;
		if (!target) throw new Error(`No imported app has the ID ${String(app)}.`);
		this.pending = target;
		try {
			await this.host.start(
				target,
				options.relay || "",
				options.strict === true,
				options.platform || "linux",
			);
		} catch (error) {
			this.log("error", "runtime", errorText(error));
			throw error;
		}
	}

	/** Asks the app to quit (it can save state), then stops it. */
	async stop(): Promise<void> {
		this.pending = undefined;
		await this.host.stop();
	}

	/** Shows and focuses a window, including one the app never showed. */
	showWindow(id: number): void {
		this.host.manageWindow(id, "restore");
	}
	hideWindow(id: number): void {
		this.host.manageWindow(id, "hide");
	}
	reloadWindow(id: number): void {
		this.host.manageWindow(id, "reload");
	}
	/** Closes a window through the app's own `close` handling, so it can cancel. */
	closeWindow(id: number): void {
		this.host.manageWindow(id, "close");
	}
	/** Activates an application menu item for the active window. */
	clickMenu(id: string): void {
		this.host.menuClick(id);
	}
	/** Activates an item of the open popup menu, or dismisses it (no id). */
	clickContextMenu(id?: string): void {
		this.host.contextMenuClick(id);
	}

	/** Settings saved in browser storage; Neutron itself only reads them when asked. */
	loadSettings(): Promise<RuntimeSettings> {
		return this.storage.settings();
	}
	saveSettings(settings: RuntimeSettings): Promise<void> {
		return this.storage.saveSettings(settings);
	}

	/** The development relay served by `@neutron/runtime/vite`, or "" on static hosts. */
	static async localRelay(): Promise<string> {
		try {
			const response = await fetch("/__neutron_dev__", { cache: "no-store" });
			if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
				return "";
			const config = (await response.json()) as { wisp?: string };
			if (config.wisp !== "/wisp/") return "";
			const url = new URL(config.wisp, location.href);
			url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
			return url.href;
		} catch {
			return "";
		}
	}

	private emit<K extends keyof NeutronEvents>(type: K, value: NeutronEvents[K]): void {
		for (const listener of this.listeners.get(type) || [])
			try {
				(listener as Listener<NeutronEvents[K]>)(value);
			} catch (error) {
				console.error(error);
			}
	}
	private setState(state: RuntimeState): void {
		if (state === "starting") this.active = this.pending;
		if (state === "stopped") this.active = undefined;
		this.current = state;
		this.emit("state", state);
	}
	private record(entry: LogEntry): void {
		this.history.push(entry);
		if (this.history.length > MAX_LOGS) this.history.shift();
		this.emit("log", entry);
	}
	private log(level: LogEntry["level"], source: string, message: string): void {
		this.record({ time: Date.now(), level, source, message });
	}
	private describeImport(app: InstalledApp): void {
		this.log(
			"info",
			"import",
			`${app.manifest.name} ${app.manifest.version} · ${app.bundle?.importedFiles ?? app.fileCount} resource files · ${app.bundle?.archives.length ?? 1} ASAR mounts\nEntry: ${applicationEntry(app)}`,
		);
		if (app.bundle?.missing.length)
			this.log(
				"warn",
				"import",
				`Missing companion files:\n${app.bundle.missing.slice(0, 30).join("\n")}`,
			);
		const fallbacks = [
			...new Set(
				app.findings
					.filter((finding) => finding.status === "unsupported" && finding.api !== "scan")
					.map((finding) => finding.api),
			),
		];
		if (fallbacks.length)
			this.log(
				"warn",
				"import",
				`Uses APIs without a browser implementation (fallbacks are logged when called): ${fallbacks.join(", ")}`,
			);
	}
}

/**
 * Turns a drop into an import source. Call it synchronously from the `drop`
 * handler: the browser only exposes dropped folders during the event.
 */
export function importSourceFromDrop(data: DataTransfer): Promise<ImportSource> {
	const file = data.files[0];
	if (file && /\.zip$/i.test(file.name)) return Promise.resolve({ zip: file });
	const entry = data.items[0]?.webkitGetAsEntry();
	if (!entry?.isDirectory)
		return Promise.reject(
			new Error(
				"Drop the entire resources folder or a ZIP of it. A single ASAR omits companion files.",
			),
		);
	return directoryFiles(entry).then((files) => ({ files, name: entry.name, kind: "folder" }));
}

function importInput(source: ImportSource) {
	if ("zip" in source) {
		if (!/\.zip$/i.test(source.zip.name))
			throw new Error("Choose a ZIP of the app’s resources folder.");
		return { zip: source.zip, name: source.name || source.zip.name, kind: "zip" as const };
	}
	const files = [...source.files].map((item) =>
		item instanceof File ? { file: item, path: item.webkitRelativePath || item.name } : item,
	);
	if (!files.length) throw new Error("The selected folder is empty.");
	return {
		files,
		name: source.name || files[0]?.path.split("/")[0] || "resources",
		kind: source.kind || "folder",
	};
}

function toReview(review: Omit<PreparedBundle, "snapshot">): ImportReview {
	return {
		name: review.name,
		importedFiles: review.importedFiles,
		archives: review.archives,
		missing: review.missing,
		suggested: review.suggested,
		candidates: review.candidates.map((candidate) => ({
			name: candidate.manifest.name,
			version: candidate.manifest.version,
			appPath: candidate.appPath,
			entryPoint: candidate.entryPoint,
			choices: [
				...new Set(
					[candidate.entryPoint, ...candidate.choices].filter((value): value is string =>
						Boolean(value),
					),
				),
			],
			issue: candidate.issue,
		})),
	};
}

function abortError(): DOMException {
	return new DOMException("Import canceled", "AbortError");
}

async function directoryFiles(entry: FileSystemEntry): Promise<ImportFile[]> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) =>
			(entry as FileSystemFileEntry).file(resolve, reject),
		);
		return [{ file, path: entry.fullPath.replace(/^\//, "") }];
	}
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	const result: ImportFile[] = [];
	while (true) {
		const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
		if (!entries.length) break;
		for (const child of entries) result.push(...(await directoryFiles(child)));
	}
	return result;
}

// Layout the host relies on, at zero specificity so embedders can restyle it.
const STYLES = `
:where(.neutron-viewport){position:relative;overflow:hidden;isolation:isolate}
:where(.runtime-window){position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:#fff}
:where(.runtime-window[hidden]){display:none}
:where(.runtime-window>iframe){display:block;flex:1;width:100%;height:100%;min-height:0;border:0;background:#fff;color-scheme:normal}
:where(.runtime-view){inset:auto}
:where(.runtime-window.attention){outline:2px solid #e2b04a;outline-offset:-2px}
:where(.neutron-dialog){width:min(440px,calc(100vw - 32px));font:inherit}
:where(.neutron-dialog input){box-sizing:border-box;width:100%}
:where(.neutron-dialog-actions){display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px}
`;
function installStyles(): void {
	if (document.querySelector("style[data-neutron]")) return;
	const style = document.createElement("style");
	style.dataset.neutron = "";
	style.textContent = STYLES;
	document.head.prepend(style);
}
