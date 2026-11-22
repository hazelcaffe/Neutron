import { Buffer } from "buffer";
import { EventEmitter } from "events";
import path from "path-browserify";
import { filePrefix } from "../shared/base";
import { parse, type SyncResult } from "../shared/sync";
import type { RpcResult } from "../shared/types";
import { applicationPath, errorText, type FilePatch, type RuntimeBridge } from "../shared/types";
import { protocolURL as encodeProtocolURL } from "../shared/urls";
import { bridgeValue, preloadWindow } from "./bridge-values";
import { makeBuiltins, makeProcess } from "./builtins";
import { curlAddonLoader } from "./curl-addon";
import { configureCompatibility, noteStub, withFallback } from "./fallback";
import { VirtualFileSystem } from "./filesystem";
import { ModuleLoader } from "./loader";
import { fileText, WasmAddons } from "./napi-wasm";
import { Network } from "./network";
import { vmModule } from "./optional";
import { executePageScript } from "./page-script";
import { processModules } from "./processes";
import { RpcClient } from "./rpc";
import { nodeTimers } from "./timers";
import { embeddingHost, hostScope } from "./transport";

declare global {
	interface Window {
		__neutron?: RuntimeBridge;
	}
}

/** Returns a promise when preloads wait for asynchronous setup. */
function boot(): Promise<void> | undefined {
	// Local app frames share this origin for synchronous require/preload. This is a
	// compatibility boundary, NOT a hostile-code security boundary (see README).
	const bridge = embeddingHost()?.__neutron;
	if (!bridge) return;
	const ownId =
		/^neutron:(\d+)$/.exec(window.name)?.[1] ||
		(window.frameElement as HTMLElement | null)?.dataset.neutronId;
	if (!ownId) return;
	const windowId = Number(ownId);
	const pageURL = () =>
		globalThis.__neutronProxyClient?.url.href ||
		globalThis.__neutronProxyBootstrap?.url ||
		location.href;
	const currentURL = pageURL();
	const filename = decodeURIComponent(new URL(currentURL).pathname);
	const config = bridge.config(windowId, filename);
	// The host owns these per-window preferences; setUserAgent updates them even
	// for a loaded document. Install before either preload or page scripts run.
	if (config.options.webPreferences?.userAgent !== undefined)
		Object.defineProperty(navigator, "userAgent", {
			configurable: true,
			get: () => config.options.webPreferences?.userAgent,
		});
	configureCompatibility(config.strict);
	const send = (message: object) => bridge.send(windowId, message);
	// At bootstrap this is the committed destination (possibly after a
	// redirect), rather than the original BrowserWindow.loadURL argument.
	const timing = performance.getEntriesByType("navigation")[0] as
		| PerformanceNavigationTiming
		| undefined;
	send({
		type: "navigation-commit",
		url: currentURL,
		status: /^https?:/.test(currentURL) ? timing?.responseStatus || -1 : -1,
	});
	let reportedURL = currentURL;
	const sameDocument = () => {
		const url = pageURL();
		if (url === reportedURL) return;
		reportedURL = url;
		send({ type: "navigation-commit", url, inPage: true });
	};
	window.addEventListener("hashchange", sameDocument);
	window.addEventListener("popstate", sameDocument);
	const navigation = Reflect.get(window, "navigation") as EventTarget | undefined;
	navigation?.addEventListener("currententrychange", sameDocument);
	let reportedTitle = "";
	const titleChanged = () => {
		const title = document.title;
		if (title === reportedTitle) return;
		reportedTitle = title;
		send({ type: "document-title", title });
	};
	const titleObserver = new MutationObserver(titleChanged);
	if (document.head)
		titleObserver.observe(document.head, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	window.addEventListener(
		"pagehide",
		() => {
			titleObserver.disconnect();
			navigation?.removeEventListener("currententrychange", sameDocument);
		},
		{ once: true },
	);
	const host = new RpcClient((message) => send({ ...message, type: "renderer-host-request" }));
	// A BrowserWindow is top-level from its app's point of view. Keep the host bridge
	// captured above, then hide the embedding parent from app traversal code.
	if (Object.getOwnPropertyDescriptor(window, "parent")?.configurable)
		Object.defineProperty(window, "parent", { configurable: true, get: () => window });
	const ipcRenderer = new EventEmitter();
	let nextInvoke = 0;
	const invokes = new Map<
		number,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const vfs = new VirtualFileSystem(config.snapshot, (patches) => send({ type: "fs", patches }));
	vfs.cwd = applicationPath(config.app);
	const unsubscribe = bridge.subscribe(windowId, (message) => {
		// IPC crosses a real Electron realm boundary. Host callbacks otherwise
		// hand us host-realm objects, which lack Scramjet v2's prototype aliases
		// (e.g. $scramjet__location). Clone data in the receiving renderer realm.
		if (message.type !== "renderer-port") message = structuredClone(message);
		if (message.type === "renderer-host-result") {
			host.receive({ ...message, type: "result" } as unknown as RpcResult);
			return;
		}
		if (message.type === "renderer-port") {
			ipcRenderer.emit(
				String(message.channel),
				{ sender: ipcRenderer, ports: message.ports },
				message.value,
			);
			return;
		}
		if (message.type === "renderer-event")
			ipcRenderer.emit(
				String(message.channel),
				{ sender: ipcRenderer },
				...(message.args as unknown[]),
			);
		else if (message.type === "ipc-result") {
			const pending = invokes.get(Number(message.id));
			if (!pending) return;
			clearTimeout(pending.timer);
			invokes.delete(Number(message.id));
			if (message.error) pending.reject(new Error(String(message.error)));
			else pending.resolve(message.value);
		} else if (message.type === "fs") vfs.apply(message.patches as FilePatch[]);
	});
	window.addEventListener("pagehide", () => {
		host.close();
		unsubscribe();
		for (const item of invokes.values()) {
			clearTimeout(item.timer);
			item.reject(new Error("Renderer navigated or closed"));
		}
		invokes.clear();
	});
	Object.assign(ipcRenderer, {
		send: (channel: string, ...args: unknown[]) =>
			send({ type: "ipc", channel, args: structuredClone(args) }),
		invoke: (channel: string, ...args: unknown[]) =>
			new Promise((resolve, reject) => {
				const id = ++nextInvoke;
				const timer = setTimeout(() => {
					invokes.delete(id);
					reject(new Error(`IPC invoke timed out: ${channel}`));
				}, 60_000);
				invokes.set(id, { resolve, reject, timer });
				try {
					send({ type: "ipc", invoke: true, id, channel, args: structuredClone(args) });
				} catch (error) {
					clearTimeout(timer);
					invokes.delete(id);
					reject(error);
				}
			}),
		sendSync: (channel: string, ...args: unknown[]) => {
			if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
				noteStub(
					"ipcRenderer.sendSync without cross-origin isolation (sent asynchronously)",
				);
				send({ type: "ipc", channel, args: structuredClone(args) });
				return undefined;
			}
			const memory = new SharedArrayBuffer(8 * 1024 * 1024);
			const control = new Int32Array(memory, 0, 2);
			send({ type: "sync-ipc", channel, args: structuredClone(args), memory });
			const deadline = performance.now() + 15_000;
			// Window agents cannot Atomics.wait. Electron's synchronous call also blocks its renderer.
			while (Atomics.load(control, 0) === 0)
				if (performance.now() > deadline)
					throw new Error(`Synchronous IPC timed out: ${channel}`);
			if (Atomics.load(control, 0) === -1)
				throw new Error("Synchronous IPC response exceeds 8 MiB");
			const result = parse(
				new TextDecoder().decode(
					new Uint8Array(new Uint8Array(memory, 8, Atomics.load(control, 1))),
				),
			) as SyncResult;
			if (result.error) throw new Error(result.error);
			return result.result;
		},
		postMessage: (channel: string, value: unknown, ports: MessagePort[] = []) =>
			send({ type: "ipc-port", channel, value: structuredClone(value), ports }),
	});
	const process = makeProcess(config, "renderer", () =>
		send({ type: "window-event", event: "close" }),
	);
	process.argv.push(...(config.options.webPreferences?.additionalArguments || []));
	// Report the mode actually used for preload globals. Apps use this property
	// to choose between contextBridge and assigning exports to a shared window.
	const isolated =
		config.options.webPreferences?.contextIsolation ??
		!config.options.webPreferences?.nodeIntegration;
	process.contextIsolated = isolated;
	const network = new Network(config.wisp, (message) =>
		send({ type: "log", source: `renderer:${windowId}/network`, level: "debug", message }),
	);
	network.localFetch = (value, init) => {
		const url = new URL(value);
		const route =
			url.protocol === "file:"
				? `${filePrefix()}${config.app.id}${url.pathname}${url.search}`
				: encodeProtocolURL(config.instanceId, url);
		return network.browserFetch(new URL(route, window.top?.location.href), init);
	};
	const styles = new Map<string, HTMLStyleElement>();
	const contextBridge = {
		exposeInMainWorld: (key: string, value: unknown) => {
			if (Object.hasOwn(window, key))
				throw new Error(`contextBridge cannot overwrite '${key}'`);
			Object.defineProperty(window, key, {
				value: bridgeValue(value),
				enumerable: true,
				writable: false,
				configurable: false,
			});
		},
	};
	const electron = {
		shell: withFallback(
			{ openExternal: (url: string) => host.call("shell.external", url) },
			"shell",
		),
		app: undefined,
		ipcMain: undefined,
		BrowserWindow: undefined,
		// Modern Electron removed remote. A truthy generic stub here prevents apps
		// from loading their packaged @electron/remote compatibility implementation.
		remote: undefined,
		ipcRenderer,
		contextBridge,
		webFrame: {
			setZoomFactor: (factor: number) => {
				document.documentElement.style.zoom = String(factor);
			},
			getZoomFactor: () => Number(document.documentElement.style.zoom) || 1,
			setZoomLevel: (level: number) => {
				document.documentElement.style.zoom = String(1.2 ** level);
			},
			executeJavaScript: executePageScript,
			insertCSS: (css: string) => {
				const key = crypto.randomUUID();
				const style = document.createElement("style");
				style.textContent = css;
				document.documentElement.append(style);
				styles.set(key, style);
				return key;
			},
			removeInsertedCSS: (key: string) => {
				styles.get(key)?.remove();
				styles.delete(key);
			},
		},
		webUtils: { getPathForFile: (file: File) => `/home/user/Downloads/${file.name}` },
	};
	const scope = isolated ? preloadWindow(window) : window;
	const globals = {
		process,
		Buffer,
		global: scope,
		...(isolated ? { window: scope, self: scope, globalThis: scope } : {}),
		...nodeTimers,
	};
	const builtins = makeBuiltins(vfs, network, withFallback(electron, "electron"), process);
	builtins.vm = withFallback(vmModule(globals), "vm");
	const processes = processModules(config, vfs, network, (level, source, message) =>
		send({ type: "log", level, source, message }),
	);
	builtins.worker_threads = processes.worker_threads;
	builtins.child_process = processes.child_process;
	const addons = new WasmAddons(
		fileText(vfs),
		{
			network,
			log: (level, message) =>
				send({ type: "log", source: `renderer:${windowId}`, level, message }),
		},
		curlAddonLoader(network),
	);
	window.addEventListener("pagehide", () => {
		processes.close();
		network.close();
		addons.close();
	});
	const loader = new ModuleLoader(vfs, builtins, globals, addons.load);
	builtins.module = loader.moduleBuiltin(config.filename);
	const options = (args: unknown[]) =>
		(args.findLast((value) => value && typeof value === "object") || {}) as {
			title?: string;
			message?: string;
			detail?: string;
			defaultPath?: string;
			buttons?: string[];
			properties?: string[];
			cancelId?: number;
		};
	const rendererDialog = {
		showOpenDialog: (...args: unknown[]) => host.call("dialog.open", options(args)),
		showSaveDialog: (...args: unknown[]) => host.call("dialog.save", options(args)),
		showMessageBox: (...args: unknown[]) => host.call("dialog.message", options(args)),
		showOpenDialogSync: (...args: unknown[]) => {
			const opts = options(args);
			const directory = opts.properties?.includes("openDirectory");
			const chosen = window.prompt(
				`${opts.title || (directory ? "Choose a folder" : "Choose a file")}\nPath in this app’s browser storage:`,
				opts.defaultPath || (directory ? "/home/user/Documents" : "/home/user/Downloads"),
			);
			if (!chosen) return undefined;
			const filename = path.resolve("/", chosen);
			if (
				directory &&
				opts.properties?.includes("createDirectory") &&
				!vfs.fs.existsSync(filename)
			)
				vfs.fs.mkdirSync(filename, { recursive: true });
			try {
				const stat = vfs.fs.statSync(filename);
				return (directory ? stat.isDirectory() : stat.isFile()) ? [filename] : undefined;
			} catch {
				return undefined;
			}
		},
		showSaveDialogSync: (...args: unknown[]) => {
			const opts = options(args);
			return (
				window.prompt(
					opts.title || "Save to virtual path",
					opts.defaultPath || "/home/user/Downloads/untitled",
				) || undefined
			);
		},
		showMessageBoxSync: (...args: unknown[]) => {
			const opts = options(args);
			const message = `${opts.message || ""}${opts.detail ? `\n\n${opts.detail}` : ""}`;
			if ((opts.buttons?.length || 1) < 2) {
				window.alert(message);
				return 0;
			}
			return window.confirm(message) ? 0 : (opts.cancelId ?? 1);
		},
		showErrorBox: (title: string, message: string) => window.alert(`${title}\n\n${message}`),
	};
	try {
		loader.resolve("@electron/remote", config.filename);
		const remote = loader.requireFor(config.filename)("@electron/remote");
		if (remote && typeof remote === "object")
			builtins["@electron/remote"] = new Proxy(remote, {
				get: (object, key) =>
					key === "dialog"
						? rendererDialog
						: key === "getBuiltin"
							? (name: string) =>
									name === "dialog"
										? rendererDialog
										: Reflect.apply(Reflect.get(object, key), object, [name])
							: Reflect.get(object, key),
			});
	} catch {
		/* Apps without a packaged remote module use the regular loader fallback. */
	}
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		const native = console[level].bind(console);
		// Scramjet guards console.log with a no-op setter. Defining our host
		// observer explicitly preserves logging and Electron's console event.
		Object.defineProperty(console, level, {
			configurable: true,
			writable: true,
			value: (...args: unknown[]) => {
				native(...args);
				const message = args
					.map((value) => {
						if (value instanceof Error) return errorText(value);
						if (typeof value === "string") return value;
						try {
							return JSON.stringify(value);
						} catch {
							return String(value);
						}
					})
					.join(" ");
				send({
					type: "log",
					source: `renderer:${windowId}`,
					level: level === "log" ? "info" : level,
					message,
				});
				send({
					type: "console-message",
					level:
						level === "warn"
							? "warning"
							: level === "debug"
								? "verbose"
								: level === "log"
									? "info"
									: level,
					message,
					sourceId: currentURL,
					lineNumber: 0,
				});
			},
		});
	}
	window.addEventListener("error", (event) => console.error(event.error || event.message));
	window.addEventListener("unhandledrejection", (event) => console.error(event.reason));

	const convertFrames = (root: ParentNode): void => {
		for (const element of root.querySelectorAll("webview")) {
			const frame = document.createElement("iframe");
			for (const attr of element.attributes) frame.setAttribute(attr.name, attr.value);
			frame.style.border = "0";
			frame.style.width ||= "100%";
			frame.style.height ||= "100%";
			element.replaceWith(frame);
		}
	};
	new MutationObserver(() => convertFrames(document)).observe(document, {
		childList: true,
		subtree: true,
	});
	window.open = ((url?: string | URL) => {
		if (url)
			send({
				type: "open-url",
				url: new URL(String(url), pageURL()).href,
				disposition: "new-window",
			});
		return null;
	}) as typeof window.open;
	window.close = () => send({ type: "window-event", event: "close" });
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0) return;
		const anchor = (event.target as Element)?.closest?.("a");
		const newWindow =
			anchor?.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey;
		if (
			anchor?.href &&
			/^https?:/.test(anchor.href) &&
			(newWindow || new URL(anchor.href).origin !== new URL(currentURL).origin)
		) {
			event.preventDefault();
			send({
				type: "open-url",
				url: anchor.href,
				disposition: newWindow ? "new-window" : "current-tab",
			});
		}
	});
	const nodeIntegration = Boolean(config.options.webPreferences?.nodeIntegration && !isolated);
	if (nodeIntegration)
		Object.assign(window, globals, {
			require: loader.requireFor(config.filename),
			__filename: config.filename,
			__dirname: path.dirname(config.filename),
			module: { exports: {} },
		});
	const preloads = new Set(
		[
			...(config.options.webPreferences?.sessionPreloads || []),
			config.options.webPreferences?.preload,
		].filter((value): value is string => Boolean(value)),
	);
	const start = () => {
		for (const preload of preloads) {
			try {
				loader.run(path.resolve(applicationPath(config.app), vfs.normalizePath(preload)));
			} catch (error) {
				console.error("Preload failed:", error);
				send({
					type: "window-event",
					event: "preload-error",
					args: [preload, errorText(error)],
				});
			}
		}
		const ready = () => {
			titleChanged();
			process.emit("loaded");
			send({ type: "window-event", event: "dom-ready" });
			convertFrames(document);
		};
		if (document.readyState === "loading")
			document.addEventListener("DOMContentLoaded", ready, { once: true });
		else queueMicrotask(ready);
	};
	// A page's main thread can only instantiate large WebAssembly modules
	// asynchronously. Do it for the app's addon builds before any code that can
	// require() them runs; the service worker's barrier script holds the page's
	// own scripts meanwhile (ProxySession.addonBarrier).
	if (preloads.size || nodeIntegration) {
		return addons.prepare(Object.keys(config.snapshot)).then(start);
	}
	start();
}

/** Lets the document's barrier script (see service-worker.ts) load once setup is done. */
function releaseBarrier(token: string, setup: Promise<void> | undefined): void {
	const channel = new hostScope.BroadcastChannel(`neutron-barrier:${token}`);
	let ready = false;
	channel.onmessage = (event) => {
		if (event.data === "waiting" && ready) channel.postMessage("ready");
	};
	// The barrier script has run by then, or the document is gone.
	const close = () => channel.close();
	document.addEventListener("DOMContentLoaded", close, { once: true });
	window.addEventListener("pagehide", close, { once: true });
	void Promise.resolve(setup)
		.catch((error: unknown) => console.error("Neutron renderer bootstrap failed", error))
		.finally(() => {
			ready = true;
			channel.postMessage("ready");
		});
}

let setup: Promise<void> | undefined;
try {
	setup = boot();
} catch (error) {
	console.error("Neutron renderer bootstrap failed", error);
}
const barrierToken = globalThis.__neutronProxyBootstrap?.barrier;
if (barrierToken) releaseBarrier(barrierToken, setup);
