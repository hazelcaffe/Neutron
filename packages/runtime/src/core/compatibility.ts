import { type Expression, parse, type Super } from "acorn";
import { simple } from "acorn-walk";
import type { Capability, Finding, Snapshot } from "../shared/types";

export const capabilities: Capability[] = [
	{
		api: "app",
		status: "partial",
		notes: "Readiness, lifecycle, paths, identity, command-line state; no OS integration.",
	},
	{
		api: "BrowserWindow",
		status: "partial",
		notes: "Full-viewport panes and a Windows manager for hidden/loading windows, focus, hide, reload and close. Embedded views retain their geometry.",
	},
	{
		api: "webContents",
		status: "partial",
		notes: "IPC, script/CSS injection, reload, zoom, navigation, DOM-based PNG capture and single-page raster PDF export.",
	},
	{
		api: "ipcMain",
		status: "implemented",
		notes: "on/once and handle/handleOnce over worker messaging.",
	},
	{
		api: "ipcRenderer",
		status: "partial",
		notes: "send/invoke/replies and events. sendSync uses shared memory when cross-origin isolated.",
	},
	{
		api: "contextBridge",
		status: "partial",
		notes: "Preload exports without leaking require; not Chromium isolated worlds.",
	},
	{
		api: "@electron/remote",
		status: "partial",
		notes: "Packaged @electron/remote uses synchronous IPC, stable object identities, V8 hidden metadata, and renderer callbacks. Synchronous renderer dialogs use browser prompts over virtual paths.",
	},
	{
		api: "Menu",
		status: "partial",
		notes: "Application menus, submenus, click callbacks, checkbox items and basic roles.",
	},
	{
		api: "MenuItem",
		status: "partial",
		notes: "Virtual menu model; OS accelerators are not global.",
	},
	{
		api: "dialog",
		status: "partial",
		notes: "Async and synchronous main-process dialogs via worker/SW bridge; imported files and virtual save paths.",
	},
	{
		api: "net",
		status: "partial",
		notes: "libcurl fetch/request over Wisp; no incoming TCP listener.",
	},
	{
		api: "session",
		status: "partial",
		notes: "Partitioned HTTP cookie jars (persistent for persist:), request hooks, user agents and virtual settings. Scramjet pages share its own cookie store.",
	},
	{
		api: "protocol",
		status: "partial",
		notes: "protocol.handle and legacy handlers; Scramjet v2 routes and rewrites browser HTML/CSS/JS for local and custom schemes, including computed imports and POST bodies.",
	},
	{
		api: "nativeTheme",
		status: "partial",
		notes: "Browser color-scheme tracking and themeSource override.",
	},
	{
		api: "screen",
		status: "partial",
		notes: "Virtual desktop dimensions and scale; one display.",
	},
	{
		api: "shell",
		status: "partial",
		notes: "External HTTP links, virtual downloads and virtual trash.",
	},
	{
		api: "clipboard",
		status: "partial",
		notes: "Synchronous app-local clipboard, writes forwarded to browser clipboard.",
	},
	{
		api: "Notification",
		status: "partial",
		notes: "Runtime notification UI, no native background notifications.",
	},
	{
		api: "globalShortcut",
		status: "partial",
		notes: "Shortcuts while the Neutron desktop has focus.",
	},
	{
		api: "nativeImage",
		status: "partial",
		notes: "PNG/JPEG encode/decode, BGRA bitmaps, crop, resize, data URLs and thumbnails. No native multi-resolution image handles.",
	},
	{
		api: "webFrame",
		status: "partial",
		notes: "Local renderer zoom, CSS insertion and JavaScript evaluation.",
	},
	{ api: "webUtils", status: "partial", notes: "Imported File objects receive virtual paths." },
	{
		api: "process",
		status: "partial",
		notes: "Synthetic Node/Electron metadata, env, argv, cwd, timing and events.",
	},
	{
		api: "fs",
		status: "partial",
		notes: "memfs synchronous/callback/promises API with OPFS persistence; process caches converge asynchronously.",
	},
	...["url", "assert", "string_decoder", "querystring"].map(
		(api): Capability => ({
			api,
			status: "implemented",
			notes: "Browser-compatible Node module.",
		}),
	),
	...[
		[
			"path",
			"POSIX and Win32 operations, selected by compatibility platform; resolve uses the virtual cwd.",
		],
		[
			"buffer",
			"Browser Buffer with base64url encoding, constants, Blob/File, UTF-8 and ASCII validation.",
		],
		[
			"events",
			"EventEmitter, promise once/on, abort listeners and scoped EventEmitterAsyncResource. EventTarget listener enumeration is unavailable.",
		],
		[
			"util",
			"Formatting, inspection, promisify, types and parseArgs. Not every modern Node utility is implemented.",
		],
		[
			"stream",
			"readable-stream constructors, pipeline/finished promises, consumers and browser Web Streams exports.",
		],
		["stream/promises", "Promise pipeline and finished, including error propagation."],
		[
			"stream/consumers",
			"Buffer, ArrayBuffer, text, JSON and Blob consumers for Node/Web streams.",
		],
		[
			"stream/web",
			"Browser-native Web Streams and encoding/compression streams where available.",
		],
		["timers", "Ref/unref-compatible handles; unref does not control a native event loop."],
		[
			"timers/promises",
			"Abortable timeout/immediate, async interval iteration, scheduler.wait/yield.",
		],
		[
			"dns",
			"Callbacks/promises for lookup and common records via Cloudflare DNS-over-HTTPS over libcurl/Wisp. No OS resolver or custom DNS servers.",
		],
		[
			"dns/promises",
			"Promise lookup and common record queries; localhost and literal addresses resolve locally.",
		],
		[
			"readline",
			"Streamed lines, async iteration, prompts/questions, abortable promise questions and ANSI cursor controls. No full interactive terminal editor.",
		],
		["readline/promises", "Promise-based questions with AbortSignal support."],
		[
			"async_hooks",
			"Explicit AsyncLocalStorage run/bind/snapshot and AsyncResource scopes. No automatic propagation across arbitrary native Promise chains or native async hooks.",
		],
		[
			"diagnostics_channel",
			"Named channels, subscriptions, store bindings and sync/promise tracing.",
		],
		[
			"domain",
			"Bound calls, interception and EventEmitter error forwarding; no automatic async error capture.",
		],
		[
			"module",
			"createRequire, builtin detection, mutable global paths and synchronous resolve hooks. Load hooks and Node's full linker are incomplete.",
		],
		[
			"os",
			"Synthetic platform metadata, virtual user paths, CPU/memory estimates and Linux os-release.",
		],
		["console", "Browser logging plus basic Console stream output."],
		[
			"SQLite WASM",
			"sql.js-backed standard SQLite in workers and renderers with OPFS persistence, queries, BLOBs and transactions. Native extensions are unavailable.",
		],
		[
			"better-sqlite3",
			"SQLite WASM package adapter with prepared queries, transactions and serialization. Partial addon API parity.",
		],
		[
			"sqlite3",
			"Callback-style SQLite WASM Database/Statement adapter with ordered operations.",
		],
		["@vscode/sqlite3", "VS Code SQLite bindings backed by browser-side WebAssembly."],
		[
			"node-libcurl",
			"Async Easy/Multi HTTP(S) transfers, raw response callbacks, per-handle cookies, redirect limits, cancellation and selected transfer info over libcurl.js/Wisp. TLS options requiring native trust stores are unsupported for TLS transfers.",
		],
	].map(([api = "", notes = ""]): Capability => ({ api, notes, status: "partial" })),
	{
		api: "crypto",
		status: "partial",
		notes: "crypto-browserify algorithms; not every modern Node crypto API.",
	},
	{
		api: "zlib",
		status: "partial",
		notes: "Gzip/deflate, WASM Brotli and bounded Zstandard codecs with sync, callback and stream APIs. Partial compression parameter support.",
	},
	{
		api: "http",
		status: "partial",
		notes: "Outgoing requests through libcurl. Main-process loopback HTTP listeners accept callbacks from the app’s hosted browser session; no inbound OS listener.",
	},
	{
		api: "https",
		status: "partial",
		notes: "Outgoing requests with browser-side TLS through libcurl.",
	},
	{ api: "net.Socket", status: "partial", notes: "Outgoing TCP streams through wisp-js." },
	{
		api: "MessageChannelMain",
		status: "partial",
		notes: "Transferable browser MessageChannels with Electron-style main/renderer events.",
	},
	{
		api: "MessagePortMain",
		status: "partial",
		notes: "start/close/postMessage and transferable ports over IPC.",
	},
	...[
		["tls", "Outgoing TLS sockets using browser-side libcurl. No listening TLS server."],
		[
			"dgram",
			"Outgoing UDP datagrams over Wisp v2; relay must permit UDP. No inbound OS bind.",
		],
		["ws", "Browser WebSocket and common Node ws events over libcurl/Wisp."],
		[
			"child_process",
			"JavaScript fork/spawn in workers. Native commands use a no-op child with empty output in permissive mode; no OS process is launched.",
		],
		[
			"worker_threads",
			"Worker, workerData, parentPort, MessageChannel, messaging, termination and shared virtual files.",
		],
		[
			"utilityProcess",
			"JavaScript-only fork with process.parentPort and virtual stdout/stderr.",
		],
		[
			"safeStorage",
			"Synchronous authenticated AES-256-GCM; key stored in app OPFS. Not an OS keychain.",
		],
		["View", "Virtual child view tree, attachment, bounds, backgrounds and visibility."],
		["WebContentsView", "Embedded local/Scramjet renderers with preload and IPC."],
		["BrowserView", "Legacy embedded view API backed by virtual WebContentsView."],
		[
			"BaseWindow",
			"Virtual BrowserWindow-compatible surface and contentView; no native handles.",
		],
		["Tray", "Virtual status messages and menu model; no operating-system tray."],
		["powerMonitor", "Activity-based idle state. Browser/system power information is limited."],
		["powerSaveBlocker", "Screen Wake Lock; subject to browser permission and visibility."],
		[
			"systemPreferences",
			"Virtual defaults, theme and media access requests. No host preference database.",
		],
		[
			"contentTracing",
			"Export browser Performance entries in trace-event format; not Chromium internals.",
		],
		[
			"crashReporter",
			"Parameter registry and runtime error console. No native dumps or automatic uploads.",
		],
		[
			"ipcRenderer.sendSync",
			"Synchronous shared-memory IPC; needs COOP/COEP headers, blocks UI, 8 MiB response limit.",
		],
		[
			"dialog.showOpenDialogSync",
			"Worker-to-host service-worker bridge; browser user-activation rules still apply.",
		],
		[
			"dialog.showSaveDialogSync",
			"Returns a virtual path through the synchronous worker bridge.",
		],
		[
			"dialog.showMessageBoxSync",
			"Blocking worker dialog, with interactive browser-hosted buttons.",
		],
		[
			"ES modules",
			"Static imports, dynamic import, import.meta, package imports/conditional exports and top-level await in main/child modules. Not a complete Node ESM linker.",
		],
		[
			"vm",
			"Basic Script/context evaluation in JavaScript. No separate isolate or execution timeout.",
		],
		[
			"v8",
			"Structured-value serialize/deserialize compatibility; not native V8 wire format. Heap metrics are placeholders.",
		],
	].map(([api = "", notes = ""]): Capability => ({ api, notes, status: "partial" })),
	...[
		"autoUpdater",
		"desktopCapturer",
		"TouchBar",
		"inAppPurchase",
		"pushNotifications",
		"debugger",
		"extensions",
		"native-addon",
		"http2",
		"inspector",
		"inspector/promises",
		"cluster",
		"repl",
		"sqlite",
		"wasi",
		"trace_events",
	].map(
		(api): Capability => ({
			api,
			status: "unsupported",
			notes: "No native implementation. Permissive mode uses no-op/default-value fallbacks and logs their use; strict mode throws.",
		}),
	),
];
export function capability(api: string): Capability {
	return (
		capabilities.find((item) => item.api === api) || {
			api,
			status: "unsupported",
			notes: "No compatibility implementation is registered.",
		}
	);
}

/** Static import inventory. Deliberately does not pretend to calculate app success percentages. */
export function scanCompatibility(snapshot: Snapshot): Finding[] {
	const isRequire = (node: Expression | Super): boolean =>
		(node.type === "Identifier" && node.name === "require") ||
		(node.type === "MemberExpression" &&
			node.object.type === "Identifier" &&
			["window", "global", "globalThis"].includes(node.object.name) &&
			((node.property.type === "Identifier" && node.property.name === "require") ||
				(node.property.type === "Literal" && node.property.value === "require")));
	const findings: Finding[] = [];
	const seen = new Set<string>();
	const add = (api: string, file: string, line?: number): void => {
		const key = `${file}:${api}`;
		if (!seen.has(key)) {
			seen.add(key);
			findings.push({ ...capability(api), file, line });
		}
	};
	for (const [file, entry] of Object.entries(snapshot)) {
		if (file.endsWith(".node")) {
			add(
				/\/(?:vscode-)?sqlite3\.node$|\/better_sqlite3\.node$/.test(file)
					? "SQLite WASM"
					: "native-addon",
				file,
			);
			continue;
		}
		if (entry.kind !== "file" || !/\.[cm]?js$/.test(file)) continue;
		const text = new TextDecoder().decode(entry.data);
		const electronNames = new Set<string>();
		const aliases = new Map<string, string>();
		try {
			const ast = parse(text, {
				ecmaVersion: "latest",
				sourceType: "module",
				locations: true,
				allowReturnOutsideFunction: true,
			});
			simple(ast, {
				ImportDeclaration(node) {
					const source = String(node.source.value).replace(/^node:/, "");
					if (source === "electron" || source.startsWith("electron/")) {
						for (const spec of node.specifiers) {
							if (spec.type === "ImportSpecifier") {
								const name =
									spec.imported.type === "Identifier"
										? spec.imported.name
										: String(spec.imported.value);
								aliases.set(spec.local.name, name);
								add(name, file, node.loc?.start.line);
							} else electronNames.add(spec.local.name);
						}
					} else if (capabilities.some((item) => item.api === source))
						add(source, file, node.loc?.start.line);
				},
				VariableDeclarator(node) {
					const init = node.init;
					if (
						init?.type !== "CallExpression" ||
						!isRequire(init.callee) ||
						init.arguments[0]?.type !== "Literal" ||
						!(
							init.arguments[0].value === "electron" ||
							String(init.arguments[0].value).startsWith("electron/")
						)
					)
						return;
					if (node.id.type === "Identifier") electronNames.add(node.id.name);
					else if (node.id.type === "ObjectPattern")
						for (const prop of node.id.properties) {
							if (
								prop.type === "Property" &&
								prop.key.type === "Identifier" &&
								prop.value.type === "Identifier"
							) {
								aliases.set(prop.value.name, prop.key.name);
								add(prop.key.name, file, node.loc?.start.line);
							}
						}
				},
				CallExpression(node) {
					if (isRequire(node.callee) && node.arguments[0]?.type === "Literal") {
						const name = String(node.arguments[0].value).replace(/^node:/, "");
						if (capabilities.some((item) => item.api === name))
							add(name, file, node.loc?.start.line);
					}
				},
			});
			simple(ast, {
				MemberExpression(node) {
					if (node.object.type !== "Identifier" || node.property.type !== "Identifier")
						return;
					if (electronNames.has(node.object.name))
						add(node.property.name, file, node.loc?.start.line);
					const alias = aliases.get(node.object.name);
					if (
						alias &&
						capabilities.some(
							(item) =>
								item.api ===
								`${alias}.${node.property.type === "Identifier" ? node.property.name : ""}`,
						)
					)
						add(`${alias}.${node.property.name}`, file, node.loc?.start.line);
				},
			});
		} catch {
			findings.push({
				api: "scan",
				status: "partial",
				notes: "Could not parse this source; its API use was not analyzed.",
				file,
			});
		}
	}
	return findings;
}
