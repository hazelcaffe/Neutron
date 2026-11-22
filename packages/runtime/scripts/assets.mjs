import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { libsignalWasm } from "../../libsignal-wasm/fetch.mjs";

const require = createRequire(import.meta.url);
/** The runtime package root. Sources and dependencies resolve from here. */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const defaultAssetsDir = resolve(root, "assets");
async function atomicWrite(filename, contents) {
	const data = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents);
	try {
		if ((await readFile(filename)).equals(data)) return;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await mkdir(dirname(filename), { recursive: true });
	const temporary = `${filename}.${process.pid}.tmp`;
	await writeFile(temporary, data);
	await rename(temporary, filename);
}
/**
 * Checked, version-pinned string patches to the Scramjet v2 bundle. Each one
 * must match exactly once; the build fails if upstream changes underneath it.
 */
export function patchScramjet(source) {
	for (const [label, original, replacement] of [
		// Upstream v2 currently passes file:/custom schemes through for native
		// app handlers. Electron resources need them routed by the SAME Scramjet
		// rewriters. This enables that URL branch; HTML/CSS/JS parsing and
		// rewriting remain wholly upstream.
		[
			"virtual-scheme",
			'if(!D||"http:"!=D.protocol&&"https:"!=D.protocol)return A;',
			"if(!D)return A;",
		],
		// Upstream drops an empty fragment ("#" and "page#") and always makes a
		// fragment-only reference absolute. The proxied document URL carries
		// Scramjet's own query flags, so `<a href="#">` reloaded the page instead
		// of a same-document fragment navigation. Keep fragment-only references
		// relative (the browser resolves them against the real document or <base>
		// URL, as for any page) and preserve empty fragments in both directions.
		[
			"fragment-reference",
			'let o=I.interface.codecEncode(D.hash.slice(1));D.hash="";',
			'let o=I.interface.codecEncode(D.hash.slice(1)),neutronHash=o||D.href.endsWith("#")?"#"+o:"";if(A.startsWith("#"))return neutronHash;D.hash="";',
		],
		[
			"empty-fragment-rewrite",
			'I.prefix.href+I.interface.codecEncode(D.href)+h+(o?"#"+o:"")}',
			"I.prefix.href+I.interface.codecEncode(D.href)+h+neutronHash}",
		],
		[
			"empty-fragment-unrewrite",
			'let C=I.interface.codecDecode(g.hash.slice(1));return g.hash="",g.search="",I.interface.codecDecode(g.href.slice(I.prefix.href.length))+(C?"#"+C:"")',
			'let C=I.interface.codecDecode(g.hash.slice(1)),neutronHash=C||g.href.endsWith("#")?"#"+C:"";return g.hash="",g.search="",I.interface.codecDecode(g.href.slice(I.prefix.href.length))+neutronHash',
		],
		// For documents without a conventional <html><head> structure, upstream
		// injects its scripts at index 0 of the parse tree: before <!DOCTYPE html>.
		// Markup before the doctype switches the page to quirks mode (Google's
		// sign-in pages then lay out wrongly). Inject right after the doctype.
		[
			"quirky-doctype",
			"!`),K.root.children.unshift(...A)",
			'!`),K.root.children.splice(K.root.children.findIndex(A=>"directive"===A.type&&/^!doctype$/i.test(A.name))+1,0,...A)',
		],
		// The v2 JS rewriter emits `$scramjet$wrappostmessage(target).postMessage(..)`
		// instead of the older `$setrealm` marker, but this wrapper never records
		// the caller's realm. With a string payload the window.postMessage hook
		// then attributes the message to the receiving window, so a popup's
		// `opener.postMessage("…")` arrived with event.source === the opener.
		// Mark the target with an object from the caller's realm for the call.
		[
			"postmessage-caller-realm",
			'{value:function(A){return A&&"function"==typeof A.postMessage?{postMessage:A.postMessage.bind(A)}:A},configurable:!1,writable:!1,enumerable:!1}',
			'{value:function(A){return A&&"function"==typeof A.postMessage?{postMessage(...I){try{(0,B.pS)(A,E.POLLUTANT,{value:{},configurable:!0})}catch{}try{return A.postMessage(...I)}finally{try{delete A[E.POLLUTANT]}catch{}}}}:A},configurable:!1,writable:!1,enumerable:!1}',
		],
		[
			"css-url-escapes",
			'let D=Q??E??i,o="rewrite"===A?(0,C.Oy)(D.trim(),g,B)',
			'let D=Q??E??i,o="rewrite"===A?(0,C.Oy)(globalThis.__neutronCSSURL?.(D.trim())??D.trim(),g,B)',
		],
		// The blob branch returns before v2 serializes worker options. Carry
		// the same module/destination metadata as for a normal worker URL;
		// Scramjet then selects its own module bootstrap rather than importScripts.
		[
			"blob-worker-mode",
			'if(A.startsWith("blob:"))return I.prefix.href+A;',
			'if(A.startsWith("blob:")){if(!E?.destination&&!E?.isModule)return I.prefix.href+A;let u=new B.xP(I.prefix.href+A);if(E.destination)u.searchParams.set(Q.QP.destination,E.destination);if(E.isModule)u.searchParams.set(Q.QP.isModule,"module");return u.href}',
		],
		// The History API's third argument is an optional nullable URL.
		// Only real, nonempty URLs should pass through the URL rewriter.
		// Converting an omitted argument with String() navigates to /undefined.
		[
			"history-optional-url",
			'let g=A.box.histories.get(I.this),B=(0,Q.Qf)(I.args[2]);if(Q.xP.canParse(B)&&new Q.xP(B).origin!==g.url.origin)return I.return(void 0);(B||""===B)&&(I.args[2]=g.rewriteUrl(B))',
			"let g=A.box.histories.get(I.this),B=I.args[2]==null?null:(0,Q.Qf)(I.args[2]);if(B&&Q.xP.canParse(B)&&new Q.xP(B).origin!==g.url.origin)return I.return(void 0);B&&(I.args[2]=g.rewriteUrl(B))",
		],
		// The rewriter deletes `debugger`, which breaks `if(x)debugger`. This hook
		// lets src/shared/scramjet-debugger.ts turn it into a same-length no-op
		// before Scramjet rewrites the source.
		[
			"debugger-statement",
			'try{let Q,w=(0,B.wU)();Q="string"==typeof A?o.rewrite_js(',
			'try{A=globalThis.__neutronBeforeRewriteJs?.(A,D)??A;let Q,w=(0,B.wU)();Q="string"==typeof A?o.rewrite_js(',
		],
		// The pinned v2 XHR hook has no sync worker. Dispatch only sync
		// requests to the host transport after upstream rewrites the URL.
		[
			"native-sync-xhr",
			'if(!A.getFlag("syncxhr"))return console.warn("ignoring request - sync xhr disabled in flags"),I.return(void 0);',
			'if(!A.flagEnabled("syncxhr"))return I.return(globalThis.__neutronSyncXHR(I.this,B,I.this[Q],I.args[0]));',
		],
		// Storage's named properties are visible only for stored keys, like
		// Chromium: `localStorage.missing` is undefined, not getItem()'s null,
		// and prototype members such as getItem remain `in` the object.
		// Webpack-style `m[prop] !== undefined` export filters depend on this.
		[
			"storage-named-properties-get",
			'return(0,C.rF)(I,g);return I.getItem(A.url.host+"@"+g)}}',
			'return(0,C.rF)(I,g);return I.getItem(A.url.host+"@"+g)??void 0}}',
		],
		[
			"storage-named-properties-has",
			'has:(I,g)=>null!==I.getItem(A.url.host+"@"+g),',
			'has:(I,g)=>"symbol"==typeof g||g in Object.getPrototypeOf(I)?g in Object.getPrototypeOf(I):null!==I.getItem(A.url.host+"@"+g),',
		],
		// Scramjet removes WebHID from proxied windows: every proxied site shares
		// one origin, so a device granted to one would reach all. Neutron sets
		// that boundary with the frame's permissions policy instead (app windows
		// get "hid", Browser tabs "hid 'none'", which nested frames can't lift),
		// as it does for WebUSB and Web Serial, which Scramjet leaves in place.
		[
			"webhid-permissions-policy",
			'g("Navigator.prototype.hid"),g("HID"),g("HIDDevice"),g("HIDConnectionEvent"),g("HIDInputReportEvent"),',
			"",
		],
		[
			"xhr-reuse",
			'A.Proxy("XMLHttpRequest.prototype.open",{apply(I){I.args[1]&&',
			'A.Proxy("XMLHttpRequest.prototype.open",{apply(I){globalThis.__neutronResetXHR?.(I.this);I.this[Q]={};I.args[1]&&',
		],
	]) {
		if (source.split(original).length !== 2)
			throw new Error(
				`Scramjet v2 ${label} patch no longer matches; review the pinned upstream version.`,
			);
		source = source.replace(original, () => replacement);
	}
	return source;
}
/**
 * Builds everything the runtime serves from the site root: /sw.js, /runtime/*
 * (guest bundles) and /vendor/* (Scramjet, libcurl, Wisp and WASM modules).
 */
export async function buildAssets(out = defaultAssetsDir) {
	const packages = {
		"@mercuryworkshop/scramjet": ["dist", "scramjet", ["scramjet_bundled.js", "scramjet.wasm"]],
		"libcurl.js": [".", "libcurl", ["libcurl.wasm"]],
		"@mercuryworkshop/wisp-js": ["dist", "wisp-js", []],
		"sql.js": ["dist", "sqlite", ["sql-wasm.js", "sql-wasm.wasm"]],
		"brotli-wasm": ["pkg.node", "brotli", ["brotli_wasm_bg.wasm"]],
		// SQLite3 Multiple Ciphers (SQLCipher 4-compatible) for Signal's database addon.
		"@journeyapps/wa-sqlite": ["dist", "wa-sqlite", ["mc-wa-sqlite.mjs", "mc-wa-sqlite.wasm"]],
	};
	for (const [name, [subdir, target, files]] of Object.entries(packages)) {
		const pkg = await realpath(resolve(root, "node_modules", name));
		await mkdir(`${out}/vendor/${target}`, { recursive: true });
		for (const file of files) {
			let contents = await readFile(resolve(pkg, subdir, file));
			if (name === "@mercuryworkshop/scramjet" && file === "scramjet_bundled.js")
				contents = Buffer.from(patchScramjet(contents.toString()));
			await atomicWrite(`${out}/vendor/${target}/${file}`, contents);
		}
		for (const license of ["LICENSE", "LICENSE.txt", "COPYING", "NOTICES.txt"]) {
			try {
				await atomicWrite(
					`${out}/vendor/${target}/${license}`,
					await readFile(resolve(pkg, license)),
				);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	// Native addons rebuilt for WebAssembly (packages/libsignal-wasm). Optional:
	// without them, apps get Neutron's usual fallback for the native addon.
	const libsignal = await libsignalWasm();
	if (libsignal)
		await atomicWrite(
			`${out}/vendor/libsignal/${basename(libsignal)}`,
			await readFile(libsignal),
		);
	await mkdir(`${out}/runtime`, { recursive: true });
	// Build runtime contexts as classic bundles: the renderer must execute before app scripts.
	const aliases = {
		buffer: "buffer/",
		process: require.resolve("process/browser"),
		"process/browser": require.resolve("process/browser"),
		path: "path-browserify",
		stream: "stream-browserify",
		events: "events/",
		util: "util/",
		assert: "assert/",
		url: "url/",
		"node:path": "path-browserify",
		"node:buffer": "buffer/",
		"node:stream": "stream-browserify",
		"node:events": "events/",
		"node:url": resolve(root, "src/runtime/node-url.ts"),
	};
	await atomicWrite(
		`${out}/runtime/polyfills.js`,
		'import { Buffer } from "buffer/"; import process from "process/browser"; Object.assign(process, { getuid: () => 1000, getgid: () => 1000 }); export { Buffer, process };',
	);
	await Promise.all(
		[
			"renderer",
			"main-worker",
			"node-worker",
			"proxy-client",
			"sqlite-bootstrap",
			"xhr-worker",
			"napi-thread",
		].map(async (name) => {
			const result = await build({
				entryPoints: [resolve(root, `src/runtime/${name}.ts`)],
				outfile: `${out}/runtime/${name}.js`,
				bundle: true,
				absWorkingDir: root,
				format: "iife",
				platform: "browser",
				target: "esnext",
				sourcemap: true,
				minify: true,
				alias: aliases,
				plugins: [
					{
						// Use upstream's synchronous wasm-bindgen entry. Only its built-in
						// imports and module directory differ in the browser distribution.
						name: "brotli-wasm-binding",
						setup(build) {
							build.onResolve({ filter: /^brotli-wasm$/ }, () => ({
								path: resolve(
									root,
									"node_modules/brotli-wasm/pkg.node/brotli_wasm.js",
								),
								namespace: "wasm-binding",
							}));
							build.onLoad(
								{ filter: /.*/, namespace: "wasm-binding" },
								async ({ path }) => ({
									// The binding reads its .wasm from __dirname (see wasm-host.ts),
									// which follows the runtime base, e.g. /Neutron/ on Pages.
									contents: `const __dirname = require(${JSON.stringify(resolve(root, "src/shared/base.ts"))}).runtimePath("vendor/brotli");\n${await readFile(path, "utf8")}`,
									resolveDir: dirname(path),
								}),
							);
							build.onResolve(
								{ filter: /^(fs|util|util\/)$/, namespace: "wasm-binding" },
								() => ({ path: resolve(root, "src/runtime/wasm-host.ts") }),
							);
						},
					},
					{
						name: "wisp-native-transport",
						setup(build) {
							build.onResolve({ filter: /compat(?:_browser)?\.mjs$/ }, (args) =>
								args.importer.includes("@mercuryworkshop/wisp-js/")
									? { path: resolve(root, "src/runtime/transport.ts") }
									: undefined,
							);
						},
					},
				],
				define: { global: "globalThis" },
				inject: [`${out}/runtime/polyfills.js`],
				write: false,
			});
			for (const file of result.outputFiles) await atomicWrite(file.path, file.contents);
		}),
	);
	const worker = await build({
		entryPoints: [resolve(root, "src/service-worker.ts")],
		outfile: `${out}/sw.js`,
		bundle: true,
		absWorkingDir: root,
		format: "iife",
		platform: "browser",
		target: "esnext",
		minify: true,
		alias: aliases,
		inject: [`${out}/runtime/polyfills.js`],
		write: false,
	});
	for (const file of worker.outputFiles) await atomicWrite(file.path, file.contents);
	return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = await buildAssets(process.argv[2] ? resolve(process.argv[2]) : undefined);
	console.log(`Built Neutron runtime assets in ${out}`);
}
