import type { SqlJsStatic } from "sql.js";
import { runtimePath } from "../shared/base";

// This classic parser-blocking script runs before the renderer/preloads and
// before Scramjet hooks XHR. Synchronous instantiation leaves only microtasks,
// which the browser drains before executing the following injected script.
function initializeRenderer() {
	// Ordinary nested documents have no Electron preload or Node modules.
	// The host sets the frame marker when it creates a BrowserWindow or view.
	if (!window.frameElement?.hasAttribute("data-neutron-id") || window.parent !== window.top)
		return;
	const request = new XMLHttpRequest();
	request.open(
		"GET",
		new URL(
			runtimePath("vendor/sqlite/sql-wasm.wasm"),
			globalThis.__neutronProxyBootstrap?.hostOrigin ?? location.origin,
		).href,
		false,
	);
	request.overrideMimeType("text/plain; charset=x-user-defined");
	request.send();
	if (request.status !== 200) throw new Error(`SQLite WASM returned HTTP ${request.status}`);
	const bytes = Uint8Array.from(
		request.responseText,
		(character) => character.charCodeAt(0) & 255,
	);
	const compiled = new WebAssembly.Module(bytes);
	const initialize = Reflect.get(globalThis, "initSqlJs") as (
		options: object,
	) => Promise<SqlJsStatic>;
	void initialize({
		instantiateWasm(
			imports: WebAssembly.Imports,
			receive: (instance: WebAssembly.Instance) => void,
		) {
			const instance = new WebAssembly.Instance(compiled, imports);
			receive(instance);
			return instance.exports;
		},
	}).then((engine) => {
		globalThis.__neutronSQLite = engine;
	});
}
initializeRenderer();
