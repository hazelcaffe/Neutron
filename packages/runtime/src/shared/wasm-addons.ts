import { runtimePath } from "./base";

// Native addons that Neutron ships rebuilt for WebAssembly (wasm32-wasip1-threads,
// loaded through emnapi; see runtime/napi-wasm.ts and packages/libsignal-wasm).
// Each build is the addon's own source at that exact version, so the package's
// JavaScript works unchanged. Other versions get the usual native-addon fallback.
interface Build {
	/** Package that ships the native addon. */
	packageName: string;
	/** Matches the addon file inside that package. */
	addon: RegExp;
	/** Package version → bundled asset under the runtime base. */
	versions: Record<string, string>;
}
const BUILDS: Build[] = [
	{
		packageName: "@signalapp/libsignal-client",
		addon: /(?:^|\/)@signalapp\+libsignal-client\.node$/,
		versions: { "0.106.2": "vendor/libsignal/libsignal-client-0.106.2.wasm" },
	},
];

export interface WasmAddon {
	packageName: string;
	version: string;
	/** URL of the bundled WebAssembly module. */
	url: string;
}

/** Whether a file is a native addon that has a WebAssembly build (any version). */
export function isWasmAddonCandidate(filename: string): boolean {
	return BUILDS.some((build) => build.addon.test(filename));
}

/**
 * Finds the bundled build for a native addon file. `read` returns a file's
 * text, or undefined; it is given the shipping package's package.json, which
 * apps usually keep in app.asar while the addon itself is in app.asar.unpacked.
 */
export function wasmAddonFor(
	filename: string,
	read: (path: string) => string | undefined,
): WasmAddon | undefined {
	const build = BUILDS.find((item) => item.addon.test(filename));
	if (!build) return;
	const marker = `/node_modules/${build.packageName}/`;
	const at = filename.lastIndexOf(marker);
	if (at < 0) return;
	const root = filename.slice(0, at + marker.length);
	const text =
		read(`${root}package.json`) ??
		read(`${root.replace("/app.asar.unpacked/", "/app.asar/")}package.json`);
	if (!text) return;
	let version = "";
	try {
		version = String((JSON.parse(text) as { version?: unknown }).version ?? "");
	} catch {
		return;
	}
	const asset = build.versions[version];
	return asset ? { packageName: build.packageName, version, url: runtimePath(asset) } : undefined;
}
