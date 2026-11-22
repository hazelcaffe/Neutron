import { parse } from "acorn";
import { ancestor, simple } from "acorn-walk";
import path from "path-browserify";
import { transform } from "sucrase";
import { createStub, isStrictCompatibility, noteStub } from "./fallback";
import type { VirtualFileSystem } from "./filesystem";
import { keytarAddon } from "./keytar";
import { nodeProxy } from "./proxies";
import { signalSQLCipherAddon } from "./sqlcipher";
import { sqliteNativeAddon } from "./sqlite";

interface ModuleRecord {
	id: string;
	filename: string;
	exports: unknown;
	loaded: boolean;
	children: ModuleRecord[];
	paths: string[];
	require?: RequireFunction;
}
interface ResolveContext {
	parentURL: string;
	conditions: string[];
	importAttributes?: Record<string, string>;
}
interface ResolveResult {
	url: string;
	format?: string;
	shortCircuit?: boolean;
}
type ResolveHook = (
	specifier: string,
	context: ResolveContext,
	next: (specifier: string, context: ResolveContext) => ResolveResult,
) => ResolveResult;
export interface RequireFunction {
	(specifier: string): unknown;
	resolve(specifier: string): string;
	cache: Record<string, ModuleRecord>;
	main?: ModuleRecord;
}
export class ModuleLoader {
	readonly cache: Record<string, ModuleRecord> = Object.create(null);
	private main?: ModuleRecord;
	private pending = new Map<string, Promise<unknown>>();
	private substitutes = new Map<string, object>();
	private resolveHooks: ResolveHook[] = [];
	private globalPaths = ["/resources/node_modules", "/app/node_modules", "/usr/lib/node_modules"];
	private resolveDependency(
		specifier: string,
		parent: string,
		mode: "require" | "import" = "require",
	): string {
		try {
			return this.resolve(specifier, parent, mode);
		} catch (error) {
			if (
				isStrictCompatibility() ||
				!(error instanceof Error) ||
				!error.message.startsWith("MODULE_NOT_FOUND")
			)
				throw error;
			const id = `stub:${parent}:${specifier}`;
			noteStub(`require(${JSON.stringify(specifier)}) from ${parent}`);
			if (!this.substitutes.has(id)) this.substitutes.set(id, createStub(specifier));
			return id;
		}
	}
	constructor(
		private vfs: VirtualFileSystem,
		private builtins: Record<string, unknown>,
		private globals: Record<string, unknown>,
		private nativeAddon?: (filename: string) => object | undefined,
	) {
		this.globals = { Proxy: nodeProxy, ...globals };
		const process = globals.process;
		if (process && typeof process === "object") {
			Object.defineProperty(process, "mainModule", {
				configurable: true,
				get: () => this.main,
			});
			Object.defineProperty(process, "dlopen", {
				configurable: true,
				writable: true,
				value: (module: { exports: unknown }, filename: string) => {
					module.exports = this.nativeModule(String(filename));
				},
			});
		}
	}
	private file(filename: string): boolean {
		try {
			return this.vfs.fs.statSync(filename).isFile();
		} catch {
			return false;
		}
	}
	private source(filename: string): string {
		if (!filename.startsWith("data:"))
			return String(this.vfs.fs.readFileSync(filename, "utf8"));
		const comma = filename.indexOf(",");
		if (comma < 0) throw new TypeError("Invalid data module URL");
		const meta = filename.slice(5, comma),
			body = filename.slice(comma + 1);
		if (!/^(text|application)\/javascript(?:;|$)/i.test(meta))
			throw new TypeError("Unsupported data module MIME type");
		return /;base64$/i.test(meta)
			? new TextDecoder().decode(Uint8Array.from(atob(body), (value) => value.charCodeAt(0)))
			: decodeURIComponent(body);
	}
	private package(filename: string): Record<string, unknown> {
		return JSON.parse(String(this.vfs.fs.readFileSync(filename, "utf8")));
	}
	private candidate(filename: string, visited = new Set<string>()): string | undefined {
		if (visited.has(filename)) return;
		visited.add(filename);
		for (const extension of ["", ".js", ".cjs", ".json", ".mjs", ".node"])
			if (this.file(filename + extension)) return filename + extension;
		if (this.file(`${filename}/package.json`)) {
			const pkg = this.package(`${filename}/package.json`);
			if (typeof pkg.main === "string") {
				const result = this.candidate(path.resolve(filename, pkg.main), visited);
				if (result) return result;
			}
		}
		for (const extension of [".js", ".json", ".cjs", ".mjs"])
			if (this.file(`${filename}/index${extension}`)) return `${filename}/index${extension}`;
	}
	private exportTarget(
		value: unknown,
		mode: "require" | "import" = "require",
	): string | undefined {
		if (typeof value === "string") return value;
		if (Array.isArray(value))
			return value.map((item) => this.exportTarget(item, mode)).find(Boolean);
		if (value && typeof value === "object")
			for (const condition of Object.keys(value)) {
				if (![mode, "node", "default"].includes(condition)) continue;
				const result = this.exportTarget(Reflect.get(value, condition), mode);
				if (result) return result;
			}
	}
	resolve(
		specifier: string,
		parent = "/app/package.json",
		mode: "require" | "import" = "require",
	): string {
		if (!this.resolveHooks.length) return this.resolveDefault(specifier, parent, mode);
		const url = new URL("file:///");
		url.pathname = parent;
		const context: ResolveContext = {
			parentURL: parent.startsWith("data:") ? parent : url.href,
			conditions: ["node", mode, "node-addons"],
			...(mode === "import" ? { importAttributes: {} } : {}),
		};
		const hooks = [...this.resolveHooks];
		const dispatch = (index: number, request: string, ctx: ResolveContext): ResolveResult => {
			const hook = hooks[index];
			if (hook)
				return hook(request, ctx, (next, nextContext = ctx) =>
					dispatch(index - 1, next, nextContext),
				);
			const filename = this.resolveDefault(
				request,
				ctx.parentURL.startsWith("file:")
					? decodeURIComponent(new URL(ctx.parentURL).pathname)
					: parent,
				ctx.conditions.includes("import") ? "import" : "require",
			);
			if (filename.startsWith("node:")) return { url: filename, format: "builtin" };
			if (filename.startsWith("data:")) return { url: filename, format: "module" };
			const resolved = new URL("file:///");
			resolved.pathname = filename;
			return { url: resolved.href, format: this.isESM(filename) ? "module" : "commonjs" };
		};
		const result = dispatch(hooks.length - 1, specifier, context);
		if (typeof result?.url !== "string")
			throw new TypeError("Module resolve hook must return a URL string");
		return result.url.startsWith("file:")
			? decodeURIComponent(new URL(result.url).pathname)
			: result.url;
	}
	private resolveDefault(specifier: string, parent: string, mode: "require" | "import"): string {
		if (specifier.startsWith("data:")) return specifier;
		specifier = specifier.replaceAll("\\", "/");
		parent = parent.replaceAll("\\", "/");
		const builtin = specifier.replace(/^node:/, "");
		if (Object.hasOwn(this.builtins, builtin)) return `node:${builtin}`;
		// A data module has no directory to search for relative or bare imports.
		// Hooks may resolve them explicitly; the default lookup must not walk
		// the opaque URL as a filesystem path.
		if (parent.startsWith("data:") && !specifier.startsWith("file:"))
			throw new Error(`ERR_UNSUPPORTED_RESOLVE_REQUEST: ${specifier} from a data URL`);
		if (specifier.startsWith("file:"))
			specifier = decodeURIComponent(new URL(specifier).pathname);
		let resolved: string | undefined;
		if (specifier.startsWith("#")) {
			let current = path.dirname(parent);
			while (true) {
				if (this.file(`${current}/package.json`)) {
					const pkg = this.package(`${current}/package.json`);
					const target = this.mappedExport(pkg.imports, specifier, mode);
					if (!target) throw new Error(`ERR_PACKAGE_IMPORT_NOT_DEFINED: ${specifier}`);
					return this.resolve(
						target.startsWith(".") ? path.resolve(current, target) : target,
						parent,
						mode,
					);
				}
				if (current === "/") break;
				current = path.dirname(current);
			}
		}
		if (specifier.startsWith(".") || specifier.startsWith("/"))
			resolved = this.candidate(path.resolve(path.dirname(parent), specifier));
		else {
			let current = path.dirname(parent);
			while (true) {
				for (const root of [
					path.join(current, "node_modules"),
					path.join(current, "node_modules.asar"),
				]) {
					const segments = specifier.split("/");
					const packageName = segments
						.splice(0, specifier.startsWith("@") ? 2 : 1)
						.join("/");
					const base = path.join(root, packageName);
					const packagePath = `${base}/package.json`;
					if (this.file(packagePath)) {
						const pkg = this.package(packagePath);
						if (pkg.exports !== undefined) {
							const key = segments.length ? `./${segments.join("/")}` : ".";
							const exports = pkg.exports;
							const target =
								exports &&
								typeof exports === "object" &&
								!Array.isArray(exports) &&
								Object.keys(exports).some((name) => name.startsWith("."))
									? this.mappedExport(exports, key, mode)
									: key === "."
										? this.exportTarget(exports, mode)
										: undefined;
							if (!target)
								throw new Error(`ERR_PACKAGE_PATH_NOT_EXPORTED: ${specifier}`);
							resolved = this.candidate(path.resolve(base, target));
						} else resolved = this.candidate(path.join(root, specifier));
					} else resolved = this.candidate(path.join(root, specifier));
					if (resolved) break;
				}
				if (resolved || current === "/") break;
				current = path.dirname(current);
			}
		}
		if (!resolved && !specifier.startsWith(".") && !path.isAbsolute(specifier))
			for (const root of this.globalPaths) {
				resolved = this.candidate(path.join(root, specifier));
				if (resolved) break;
			}
		if (!resolved)
			throw new Error(
				`MODULE_NOT_FOUND: Cannot find '${specifier}' from '${parent}'. Check the imported resources, companion archives, and app.asar.unpacked files.`,
			);
		const real = String(this.vfs.fs.realpathSync(resolved));
		const logical = path.join(
			String(this.vfs.fs.realpathSync(path.dirname(resolved))),
			path.basename(resolved),
		);
		const archive = /^(.+\.asar)\/(.+)$/.exec(logical);
		return archive && real === `${archive[1]}.unpacked/${archive[2]}` ? logical : real;
	}
	private mappedExport(
		exports: unknown,
		key: string,
		mode: "require" | "import",
	): string | undefined {
		if (!exports || typeof exports !== "object") return;
		const direct = this.exportTarget(Reflect.get(exports, key), mode);
		if (direct) return direct;
		for (const pattern of Object.keys(exports).sort((a, b) => b.length - a.length)) {
			if (!pattern.includes("*")) continue;
			const [prefix = "", suffix = ""] = pattern.split("*");
			if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
			const target = this.exportTarget(Reflect.get(exports, pattern), mode);
			if (target)
				return target.replaceAll(
					"*",
					key.slice(prefix.length, suffix.length ? -suffix.length : undefined),
				);
		}
	}
	isESM(filename: string): boolean {
		if (filename.startsWith("data:")) return true;
		if (
			filename.startsWith("node:") ||
			filename.startsWith("stub:") ||
			/\.(cjs|json|node)$/.test(filename)
		)
			return false;
		if (filename.endsWith(".mjs")) return true;
		let current = path.dirname(filename);
		while (true) {
			if (this.file(`${current}/package.json`))
				return this.package(`${current}/package.json`).type === "module";
			if (current === "/") return false;
			current = path.dirname(current);
		}
	}
	private compile(code: string, filename: string): string {
		const changes: { start: number; end: number; value: string }[] = [];
		let staticModules = false;
		const imported = new Set<string>();
		if (/\b(?:import|export)\b/.test(code)) {
			const ast = parse(code, {
				ecmaVersion: "latest",
				sourceType: "script",
				allowImportExportEverywhere: true,
				allowAwaitOutsideFunction: true,
				allowReturnOutsideFunction: true,
			});
			staticModules = ast.body.some(
				(node) =>
					node.type === "ImportDeclaration" ||
					node.type === "ExportNamedDeclaration" ||
					node.type === "ExportDefaultDeclaration" ||
					node.type === "ExportAllDeclaration",
			);
			for (const node of ast.body)
				if (
					(node.type === "ImportDeclaration" ||
						node.type === "ExportNamedDeclaration" ||
						node.type === "ExportAllDeclaration") &&
					node.source
				)
					imported.add(String(node.source.value));
			simple(ast, {
				ImportExpression: (node) =>
					changes.push({
						start: node.start,
						end: node.start + 6,
						value: "__neutronImport",
					}),
				MetaProperty: (node) => {
					if (node.meta.name === "import")
						changes.push({ start: node.start, end: node.end, value: "__neutronMeta" });
				},
			});
		}
		if (changes.length) {
			const parts: string[] = [];
			let cursor = 0;
			for (const change of changes.sort((a, b) => a.start - b.start)) {
				parts.push(code.slice(cursor, change.start), change.value);
				cursor = change.end;
			}
			parts.push(code.slice(cursor));
			code = parts.join("");
		}
		if (staticModules) {
			code = transform(code, {
				transforms: ["imports"],
				filePath: filename,
				preserveDynamicImport: true,
				disableESTransforms: true,
			}).code;
			// The Node linker needs its own import binding: ESM packages commonly
			// declare `const require = createRequire(import.meta.url)` themselves.
			const aliases: { start: number; end: number }[] = [];
			ancestor(
				parse(code, {
					ecmaVersion: "latest",
					sourceType: "script",
					allowAwaitOutsideFunction: true,
					allowReturnOutsideFunction: true,
				}),
				{
					CallExpression(node, _state, parents) {
						if (
							node.callee.type !== "Identifier" ||
							node.callee.name !== "require" ||
							node.arguments[0]?.type !== "Literal" ||
							!imported.has(String(node.arguments[0].value))
						)
							return;
						const parent = parents.at(-2);
						if (
							(parent?.type === "VariableDeclarator" &&
								parent.id.type === "Identifier" &&
								parent.id.name.startsWith("_")) ||
							parent?.type === "ExpressionStatement"
						)
							aliases.push({ start: node.callee.start, end: node.callee.end });
					},
				},
			);
			const parts: string[] = [];
			let cursor = 0;
			for (const alias of aliases.sort((a, b) => a.start - b.start)) {
				parts.push(code.slice(cursor, alias.start), "__neutronRequire");
				cursor = alias.end;
			}
			parts.push(code.slice(cursor));
			code = parts.join("");
		}
		return code;
	}
	private moduleGlobals(filename: string): Record<string, unknown> {
		return {
			...this.globals,
			__neutronRequire: (specifier: string) => {
				const resolved = this.resolveDependency(specifier, filename, "import");
				const value = this.load(resolved);
				return this.isESM(resolved) ? value : this.namespace(value);
			},
			__neutronImport: async (specifier: string) => {
				const resolved = this.resolveDependency(specifier, filename, "import");
				const exports = await this.importFile(resolved);
				return this.isESM(resolved)
					? exports
					: {
							...(exports &&
							(typeof exports === "object" || typeof exports === "function")
								? exports
								: {}),
							default: exports,
						};
			},
			__neutronMeta: {
				url: filename.startsWith("data:") ? filename : `file://${filename}`,
				dirname: path.dirname(filename),
				filename,
				resolve: (specifier: string) => {
					const resolved = this.resolve(specifier, filename, "import");
					return /^(node|data):/.test(resolved) ? resolved : `file://${resolved}`;
				},
			},
		};
	}
	private namespace(value: unknown): Record<string, unknown> {
		const result: Record<string, unknown> = { default: value, __esModule: true };
		if (value && (typeof value === "object" || typeof value === "function"))
			for (const key of Object.getOwnPropertyNames(value)) {
				if (["default", "__esModule", "prototype", "caller", "arguments"].includes(key))
					continue;
				Object.defineProperty(result, key, {
					enumerable: true,
					get: () => Reflect.get(value, key),
				});
			}
		return result;
	}
	async runAsync(filename: string): Promise<unknown> {
		return this.importFile(
			this.resolve(filename, "/app/package.json", "import"),
			new Set(),
			true,
		);
	}
	private async importFile(
		filename: string,
		ancestors = new Set<string>(),
		main = false,
	): Promise<unknown> {
		if (!this.isESM(filename)) return this.load(filename, main);
		if (ancestors.has(filename)) return this.cache[filename]?.exports;
		if (this.pending.has(filename)) return this.pending.get(filename);
		if (this.cache[filename]?.loaded) return this.cache[filename]?.exports;
		const module: ModuleRecord = {
			id: main ? "." : filename,
			filename,
			exports: {},
			loaded: false,
			children: [],
			paths: [path.join(path.dirname(filename), "node_modules")],
		};
		this.cache[filename] = module;
		module.require = this.requireFor(filename);
		if (main) this.main = module;
		const run = async () => {
			const code = this.source(filename).replace(/^#![^\n]*\n/, "");
			const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
			const next = new Set(ancestors);
			next.add(filename);
			for (const statement of ast.body) {
				if (
					(statement.type === "ImportDeclaration" ||
						statement.type === "ExportNamedDeclaration" ||
						statement.type === "ExportAllDeclaration") &&
					statement.source
				)
					await this.importFile(
						this.resolveDependency(String(statement.source.value), filename, "import"),
						next,
					);
			}
			const globals = {
				...this.moduleGlobals(filename),
				__filename: filename,
				__dirname: path.dirname(filename),
				require: this.requireFor(filename),
			};
			const factory = new Function(
				...Object.keys(globals),
				`return async function(exports, module) {\n${this.compile(code, filename)}\n}\n//# sourceURL=neutron:${filename}`,
			);
			const execute = factory(...Object.values(globals));
			await execute.call(
				module.exports,
				module.exports,
				module,
				filename,
				path.dirname(filename),
			);
			module.loaded = true;
			return module.exports;
		};
		const pending = run()
			.catch((error: unknown) => {
				delete this.cache[filename];
				throw error;
			})
			.finally(() => this.pending.delete(filename));
		this.pending.set(filename, pending);
		return pending;
	}
	requireFor(parent: string): RequireFunction {
		const require = ((specifier: string) => {
			const value = this.load(this.resolveDependency(specifier, parent));
			if (specifier !== "bindings" || typeof value !== "function") return value;
			let root = path.dirname(parent);
			while (root !== "/" && !this.file(`${root}/package.json`)) root = path.dirname(root);
			// The bindings package inspects V8 CallSite filenames, which are absent for
			// evaluated browser modules. Supply its documented module_root explicitly.
			return Object.assign(
				(options?: string | Record<string, unknown>) =>
					Reflect.apply(value, undefined, [
						{
							module_root: root,
							...(typeof options === "string"
								? { bindings: options }
								: options || {}),
						},
					]),
				value,
			);
		}) as RequireFunction;
		require.resolve = (specifier) => this.resolve(specifier, parent);
		require.cache = this.cache;
		Object.defineProperty(require, "main", { get: () => this.main });
		return require;
	}
	run(filename: string): unknown {
		return this.load(this.resolve(filename), true);
	}
	/** Node's CommonJS string entry (-e / Worker({eval:true})) exposes its
	 * module bindings on the child global, including to vm.runInThisContext.
	 * Only call this in a dedicated child realm, never in an app renderer. */
	runEval(source: string, id: "[eval]" | "[worker eval]"): void {
		const filename = path.join(this.vfs.cwd, id);
		const require = this.requireFor(filename);
		const Module = this.builtins.module as {
			new (id: string): ModuleRecord;
			_nodeModulePaths(from: string): string[];
		};
		const module = Object.assign(new Module(id), {
			filename,
			path: this.vfs.cwd,
			paths: Module._nodeModulePaths(this.vfs.cwd),
			require,
			parent: null,
			loaded: false,
			children: [],
		});
		const { __neutronImport, __neutronMeta, __neutronRequire } = this.moduleGlobals(filename);
		Object.assign(globalThis, {
			require,
			module,
			exports: module.exports,
			__filename: id,
			__dirname: ".",
			__neutronImport,
			__neutronMeta,
			__neutronRequire,
		});
		// Run a script, not a CommonJS file wrapper: top-level this is the global
		// and this entry is neither in require.cache nor require.main.
		// biome-ignore lint/security/noGlobalEval: This is the entry script of an uploaded Node worker.
		globalThis.eval(`${this.compile(source, filename)}\n//# sourceURL=${id}`);
	}
	moduleBuiltin(defaultFilename: string): unknown {
		const loader = this;
		const filename = (value: string | URL): string =>
			value instanceof URL || String(value).startsWith("file:")
				? decodeURIComponent(new URL(value).pathname)
				: String(value);
		class Module {
			static Module = Module;
			static builtinModules = Object.keys(loader.builtins);
			static _cache = loader.cache;
			static globalPaths = loader.globalPaths;
			static _resolveLookupPaths(
				request: string,
				parent?: { filename?: string; paths?: string[] },
			): string[] | null {
				if (Module.isBuiltin(request)) return null;
				return [
					...(parent?.paths ||
						Module._nodeModulePaths(path.dirname(parent?.filename || defaultFilename))),
					...Module.globalPaths,
				];
			}
			static _initPaths(): void {}
			static isBuiltin(name: string): boolean {
				return Object.hasOwn(loader.builtins, name.replace(/^node:/, ""));
			}
			static registerHooks(hooks: { resolve?: ResolveHook }): { deregister(): void } {
				if (hooks.resolve) loader.resolveHooks.push(hooks.resolve);
				return {
					deregister: () => {
						loader.resolveHooks = loader.resolveHooks.filter(
							(hook) => hook !== hooks.resolve,
						);
					},
				};
			}
			static syncBuiltinESMExports(): void {}
			static createRequire(value: string | URL): RequireFunction {
				return loader.requireFor(filename(value));
			}
			static _resolveFilename(request: string, parent?: { filename?: string }): string {
				return loader.resolve(request, parent?.filename || defaultFilename);
			}
			static _load(request: string, parent?: { filename?: string }, isMain = false): unknown {
				return isMain
					? loader.run(Module._resolveFilename(request, parent))
					: loader.requireFor(parent?.filename || defaultFilename)(request);
			}
			static _nodeModulePaths(from: string): string[] {
				const paths: string[] = [];
				let current = path.resolve(from);
				while (true) {
					paths.push(path.join(current, "node_modules"));
					if (current === "/") return paths;
					current = path.dirname(current);
				}
			}
			exports: unknown = {};
			filename = defaultFilename;
			constructor(
				readonly id = "",
				readonly parent?: Module,
			) {}
			require(request: string): unknown {
				return loader.requireFor(this.filename)(request);
			}
		}
		return Module;
	}
	/** The browser implementation of a native addon, shared by require() and
	 * process.dlopen() (which webpack's node-loader uses). */
	nativeModule(file: string): unknown {
		const filename = this.vfs.normalizePath(file);
		if (this.substitutes.has(filename)) return this.substitutes.get(filename);
		const replacement =
			this.nativeAddon?.(filename) ??
			(/(?:^|\/)@signalapp\+sqlcipher\.node$/.test(filename)
				? signalSQLCipherAddon(this.vfs)
				: /(?:^|\/)keytar\.node$/.test(filename)
					? keytarAddon(this.vfs)
					: sqliteNativeAddon(filename, this.vfs));
		if (replacement) {
			this.substitutes.set(filename, replacement as object);
			return replacement;
		}
		noteStub(`native addon ${file}`);
		if (!this.substitutes.has(filename)) this.substitutes.set(filename, createStub(file));
		return this.substitutes.get(filename);
	}
	private load(filename: string, main = false): unknown {
		if (filename.startsWith("stub:")) return this.substitutes.get(filename);
		if (filename.startsWith("node:")) return this.builtins[filename.slice(5)];
		if (this.cache[filename]) return this.cache[filename].exports;
		if (!filename.startsWith("data:") && filename.endsWith(".node"))
			return this.nativeModule(filename);
		const module: ModuleRecord = {
			id: main ? "." : filename,
			filename,
			exports: {},
			loaded: false,
			children: [],
			paths: [path.join(path.dirname(filename), "node_modules")],
		};
		this.cache[filename] = module;
		module.require = this.requireFor(filename);
		if (main) this.main = module;
		try {
			// A synchronous resolve hook can return a JS data: module too. Use
			// the same source provider as importFile instead of opening its URL on disk.
			let code = this.source(filename).replace(/^#![^\n]*\n/, "");
			if (!filename.startsWith("data:") && filename.endsWith(".json"))
				module.exports = JSON.parse(code);
			else {
				code = this.compile(code, filename);
				const globals = this.moduleGlobals(filename);
				// Globals belong to an outer scope, so a module can declare its own
				// global/fetch/process/Buffer bindings as it can under Node.
				const factory = new Function(
					...Object.keys(globals),
					`return function(exports, require, module, __filename, __dirname) {\n${code}\n}\n//# sourceURL=neutron:${filename}`,
				);
				const execute = factory(...Object.values(globals));
				execute.call(
					module.exports,
					module.exports,
					this.requireFor(filename),
					module,
					filename,
					path.dirname(filename),
				);
			}
			module.loaded = true;
			return module.exports;
		} catch (error) {
			delete this.cache[filename];
			if (error instanceof SyntaxError && !error.message.startsWith("Cannot compile"))
				error.message = `Cannot compile ${filename}: ${error.message}`;
			throw error;
		}
	}
}
