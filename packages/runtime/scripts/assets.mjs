import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
			if (name === "@mercuryworkshop/scramjet" && file === "scramjet_bundled.js") {
				let source = contents.toString();
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
					source = source.replace(original, replacement);
				}
				contents = Buffer.from(source);
			}
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
									contents: `const __dirname = "/vendor/brotli";\n${await readFile(path, "utf8")}`,
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
