// The site path where the runtime is hosted, e.g. "/" or "/Neutron/" on a
// GitHub Pages project site. Its service worker, guest bundles (runtime/),
// vendor modules (vendor/) and virtual routes (__scramjet__/, __neutron__/…)
// all live under it. Every context records the base before using a path:
// the page from Neutron.create, workers from their own script URL, and proxied
// documents from the bootstrap configuration the service worker injects.
declare global {
	var __neutronBase: string | undefined;
}

function normalize(base: string): string {
	const path = new URL(base, "https://base.invalid/").pathname;
	return path.endsWith("/") ? path : `${path}/`;
}

/** Records the base for this realm. `scriptURL` is relative to the base when given. */
export function setRuntimeBase(base: string): string {
	globalThis.__neutronBase = normalize(base);
	return globalThis.__neutronBase;
}

/** Derives the base from a runtime script's own URL (`<base>runtime/x.js`, `<base>sw.js`). */
export function baseFromScript(scriptURL: string, depth: number): string {
	return setRuntimeBase(new URL(depth ? "../".repeat(depth) : "./", scriptURL).pathname);
}

export function runtimeBase(): string {
	return (
		globalThis.__neutronBase ??
		(globalThis.__neutronProxyBootstrap?.hostBase
			? setRuntimeBase(globalThis.__neutronProxyBootstrap.hostBase)
			: "/")
	);
}

/** A runtime path such as `runtimePath("vendor/libcurl/libcurl.wasm")`. */
export function runtimePath(path: string): string {
	return `${runtimeBase()}${path.replace(/^\/+/, "")}`;
}

export const scramjetPrefix = (session: string) => runtimePath(`__scramjet__/${session}/`);
export const filePrefix = () => runtimePath("__neutron__/");
export const protocolPrefix = () => runtimePath("__neutron_protocol__/");
export const syncPrefix = () => runtimePath("__neutron_sync__/");
export const barrierPrefix = () => runtimePath("__neutron_barrier__/");
/** `<app id>/<stream>/<seq>`: holds reads of an app's files until that write announcement arrives. */
export const fileGatePrefix = () => runtimePath("__neutron_file_gate__/");
