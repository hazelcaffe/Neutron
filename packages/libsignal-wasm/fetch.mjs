// Provides dist/<file> from release.json: a local build (build.sh) if present,
// else the published build, downloaded and checked against its SHA-256.
// Usage: node fetch.mjs, or import { libsignalWasm } from "./fetch.mjs".
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Returns the module's path, or undefined (with a warning) if it's unavailable. */
export async function libsignalWasm({ log = console.warn } = {}) {
	const release = JSON.parse(await readFile(resolve(here, "release.json"), "utf8"));
	const target = resolve(here, "dist", release.file);
	try {
		await access(target);
		return target;
	} catch {
		/* Not built locally; download the published build. */
	}
	if (process.env.NEUTRON_SKIP_LIBSIGNAL_WASM) return;
	try {
		const response = await fetch(release.url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = Buffer.from(await response.arrayBuffer());
		const digest = createHash("sha256").update(data).digest("hex");
		if (digest !== release.sha256)
			throw new Error(`SHA-256 ${digest} does not match release.json (${release.sha256})`);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(`${target}.partial`, data);
		await rename(`${target}.partial`, target);
		return target;
	} catch (error) {
		log(
			`libsignal WebAssembly build unavailable (${error.message}); apps using @signalapp/libsignal-client get the native-addon fallback. Build it with packages/libsignal-wasm/build.sh.`,
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const path = await libsignalWasm();
	if (!path) process.exit(1);
	console.log(path);
}
