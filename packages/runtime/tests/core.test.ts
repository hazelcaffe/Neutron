import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackage, extractFile } from "@electron/asar";
import graceful from "graceful-fs";
import { describe, expect, it, vi } from "vitest";
import { createAsar, parseAsar } from "../src/core/asar";
import { scanCompatibility } from "../src/core/compatibility";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { ModuleLoader } from "../src/runtime/loader";
import type { FilePatch } from "../src/shared/types";

interface FixtureHeader {
	files: Record<
		string,
		{ offset: string; size: number; integrity?: { algorithm: string; hash: string } }
	>;
}
function withHeader(archive: Uint8Array, change: (header: FixtureHeader) => void): Uint8Array {
	const old = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const header = JSON.parse(
		new TextDecoder().decode(archive.subarray(16, 16 + old.getUint32(12, true))),
	) as FixtureHeader;
	change(header);
	const json = new TextEncoder().encode(JSON.stringify(header));
	const payload = archive.subarray(8 + old.getUint32(4, true));
	const pickleSize = 4 + ((4 + json.length + 3) & ~3);
	const output = new Uint8Array(8 + pickleSize + payload.length);
	const view = new DataView(output.buffer);
	view.setUint32(0, 4, true);
	view.setUint32(4, pickleSize, true);
	view.setUint32(8, pickleSize - 4, true);
	view.setUint32(12, json.length, true);
	output.set(json, 16);
	output.set(payload, 8 + pickleSize);
	return output;
}

describe("ASAR interoperability", () => {
	it("recognizes zero-byte metadata by digest, independent of filename", () => {
		const archive = withHeader(createAsar({ metadata: "", "main.js": "ok" }), (header) => {
			header.files.metadata = {
				offset: "0",
				size: -1000,
				integrity: {
					algorithm: "SHA256",
					hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				},
			};
		});
		expect(parseAsar(archive).snapshot["/app/metadata"]).toEqual({
			kind: "file",
			data: new Uint8Array(),
		});
		expect(() =>
			parseAsar(
				withHeader(archive, (header) => {
					const entry = header.files.metadata;
					if (entry) entry.offset = "1";
				}),
			),
		).toThrow("Invalid ASAR file extent");
	});
	it("matches Electron when entries share or partially overlap stored data", async () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 254, 255]);
		const archive = withHeader(
			createAsar({
				"first.bin": bytes,
				"duplicate.bin": bytes,
				"slice.bin": bytes.subarray(1, 4),
				"empty.bin": new Uint8Array(),
			}),
			(header) => {
				const duplicate = header.files["duplicate.bin"];
				const slice = header.files["slice.bin"];
				if (duplicate) duplicate.offset = "0";
				if (slice) slice.offset = "1";
			},
		);
		const root = await mkdtemp(join(tmpdir(), "neutron-shared-asar-"));
		try {
			const filename = join(root, "shared.asar");
			await writeFile(filename, archive);
			const parsed = parseAsar(archive);
			for (const name of ["first.bin", "duplicate.bin", "slice.bin", "empty.bin"]) {
				expect(parsed.snapshot[`/app/${name}`]).toEqual({
					kind: "file",
					data: new Uint8Array(extractFile(filename, name)),
				});
			}
			const first = parsed.snapshot["/app/first.bin"];
			const duplicate = parsed.snapshot["/app/duplicate.bin"];
			if (first?.kind === "file") first.data[0] = 99;
			expect(duplicate?.kind === "file" && duplicate.data[0]).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("still rejects negative, fractional, unsafe, and out-of-bounds extents", () => {
		for (const [offset, size] of [
			["-1", 1],
			["0.5", 1],
			[String(Number.MAX_SAFE_INTEGER + 1), 1],
			["2", 1],
			["0", -1],
			["0", 0.5],
			["0", Number.MAX_SAFE_INTEGER],
		]) {
			const archive = withHeader(
				createAsar({ "file.bin": new Uint8Array([1, 2]) }),
				(header) => {
					header.files["file.bin"] = { offset: String(offset), size: Number(size) };
				},
			);
			expect(() => parseAsar(archive)).toThrow("Invalid ASAR file extent");
		}
	});
	it("reads an archive produced by Electron's official packager", async () => {
		const root = await mkdtemp(join(tmpdir(), "neutron-asar-"));
		const archive = `${root}.asar`;
		try {
			await writeFile(join(root, "package.json"), '{"name":"official","main":"main.js"}');
			await writeFile(join(root, "main.js"), "module.exports = 42;");
			await writeFile(join(root, "binary"), new Uint8Array([0, 255, 3, 7]));
			await createPackage(root, archive);
			const parsed = parseAsar(await readFile(archive));
			expect(parsed.snapshot["/app/binary"]).toEqual({
				kind: "file",
				data: new Uint8Array([0, 255, 3, 7]),
			});
			expect(parsed.unpacked).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(archive, { force: true });
		}
	});
	it("writes archives readable by Electron", async () => {
		const root = await mkdtemp(join(tmpdir(), "neutron-write-"));
		try {
			const file = join(root, "demo.asar");
			await writeFile(file, createAsar({ "nested/main.js": "module.exports = 42;" }));
			expect(extractFile(file, "nested/main.js").toString()).toBe("module.exports = 42;");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("rejects malformed lengths and unsafe directory names", () => {
		const valid = createAsar({ "main.js": "ok" });
		expect(() => parseAsar(valid.subarray(0, 16))).toThrow();
		const malformed = valid.slice();
		new DataView(malformed.buffer).setUint32(12, 0xffffffff, true);
		expect(() => parseAsar(malformed)).toThrow("header lengths");
		expect(() => parseAsar(createAsar({ "../escape.js": "no" }))).toThrow("filename");
	});
});

describe("virtual Node runtime", () => {
	it("loads JavaScript data modules returned by native-style import hooks", async () => {
		const { snapshot } = parseAsar(
			createAsar({
				"main.mjs": `const value = await import('data:text/javascript;base64,ZXhwb3J0IGNvbnN0IGFuc3dlcj00Mjs='); export default value.answer;`,
			}),
		);
		const loader = new ModuleLoader(new VirtualFileSystem(snapshot, () => {}), {}, {});
		expect(await loader.runAsync("/app/main.mjs")).toMatchObject({ default: 42 });
	});
	it("links native-style CommonJS namespaces and permits ESM dirname bindings", async () => {
		const { snapshot } = parseAsar(
			createAsar({
				"main.mjs": `import data from './marked.cjs'; import {createRequire} from 'module'; const require = createRequire(import.meta.url); const __dirname = 'local'; export default [require('./marked.cjs').answer,typeof createRequire,__dirname];`,
				"marked.cjs": `Object.defineProperty(exports,'__esModule',{value:true});exports.answer=42;`,
			}),
		);
		const builtins: Record<string, unknown> = {};
		const loader = new ModuleLoader(new VirtualFileSystem(snapshot, () => {}), builtins, {});
		builtins.module = loader.moduleBuiltin("/app/main.mjs");
		expect(await loader.runAsync("/app/main.mjs")).toMatchObject({
			default: [42, "function", "local"],
		});
	});
	it("allows modules to shadow injected globals and registers chained resolver hooks", async () => {
		const { snapshot } = parseAsar(
			createAsar({
				"shadow.cjs":
					'const global = "local", fetch = 42; module.exports = [global, fetch, process.marker];',
				"shadow.mjs":
					'const global = "esm", fetch = 20; export default [global, fetch, process.marker];',
				"value.cjs": "module.exports = 42;",
				"main.cjs": `const Module = require('module'); const hook = Module.registerHooks({resolve(specifier, context, next) { return next(specifier === 'alias' ? './value.cjs' : specifier, context); }}); const value = require('alias'); hook.deregister(); module.exports = {value, builtin: Module.isBuiltin('node:fs'), paths: Module._resolveLookupPaths('global-package')};`,
			}),
		);
		const builtins: Record<string, unknown> = { fs: {} };
		const loader = new ModuleLoader(new VirtualFileSystem(snapshot, () => {}), builtins, {
			global: {},
			fetch: () => {},
			process: { marker: "injected" },
		});
		builtins.module = loader.moduleBuiltin("/app/main.cjs");
		expect(loader.run("/app/shadow.cjs")).toEqual(["local", 42, "injected"]);
		expect(await loader.runAsync("/app/shadow.mjs")).toMatchObject({
			default: ["esm", 20, "injected"],
		});
		expect(loader.run("/app/main.cjs")).toMatchObject({
			value: 42,
			builtin: true,
			paths: expect.arrayContaining(["/resources/node_modules"]),
		});
		expect(() => loader.resolve("alias", "/app/main.cjs")).toThrow("MODULE_NOT_FOUND");
	});
	it("snapshots unreadable directories and normalizes Windows file/stream paths", async () => {
		const vfs = new VirtualFileSystem({ "/tmp": { kind: "directory" } }, () => {});
		vfs.fs.mkdirSync("\\tmp\\private");
		vfs.fs.writeFileSync("\\tmp\\private\\value", "persisted");
		vfs.fs.chmodSync("/tmp/private", 0);
		expect(vfs.snapshot()["/tmp/private/value"]).toEqual({
			kind: "file",
			mtimeMs: expect.any(Number),
			data: new TextEncoder().encode("persisted"),
		});
		vfs.fs.chmodSync("/tmp/private", 0o700);
		const chunks: Buffer[] = [];
		for await (const chunk of vfs.fs.createReadStream("\\tmp\\private\\value"))
			chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks).toString()).toBe("persisted");
	});
	it("settles queued callback writes before a runtime is stopped", async () => {
		const vfs = new VirtualFileSystem({ "/tmp": { kind: "directory" } }, () => {});
		let completed = false;
		vfs.fs.writeFile("/tmp/records", '{"id":1}\n', (error) => {
			if (error) throw error;
			vfs.fs.appendFile("/tmp/records", '{"id":2}\n', (error) => {
				if (error) throw error;
				completed = true;
			});
		});
		await vfs.settle();
		expect(completed).toBe(true);
		expect(vfs.fs.readFileSync("/tmp/records", "utf8")).toBe('{"id":1}\n{"id":2}\n');
	});
	it("does not transform CommonJS because a string mentions export, and preserves modern class syntax in ESM", async () => {
		const { snapshot } = parseAsar(
			createAsar({
				"plain.cjs": `const label = "export value"; class Example extends Error { static code = 'OK'; code = 'OK'; constructor() { super(label), this.name = 'Example'; } } module.exports = new Example().code;`,
				"modern.mjs": `export class Example extends Error { static code = 'OK'; code = 'OK'; constructor() { super('message'), this.name = 'Example'; } }`,
			}),
		);
		const loader = new ModuleLoader(new VirtualFileSystem(snapshot, () => {}), {}, {});
		expect(loader.run("/app/plain.cjs")).toBe("OK");
		const module = (await loader.runAsync("/app/modern.mjs")) as {
			Example: new () => { code: string };
		};
		expect(new module.Example().code).toBe("OK");
	});
	it("supports graceful-fs descriptor cloning and callable stream subclasses", async () => {
		const patches: FilePatch[] = [];
		const vfs = new VirtualFileSystem({ "/tmp": { kind: "directory" } }, (changes) =>
			patches.push(...changes),
		);
		const cloned = Object.create(Object.getPrototypeOf(vfs.fs));
		for (const name of Object.getOwnPropertyNames(vfs.fs)) {
			const descriptor = Object.getOwnPropertyDescriptor(vfs.fs, name);
			if (descriptor) Object.defineProperty(cloned, name, descriptor);
		}
		const fs = graceful.gracefulify(cloned);
		await new Promise<void>((resolve, reject) => {
			const output = fs.createWriteStream("/tmp/stream.txt");
			output.on("error", reject);
			output.on("finish", resolve);
			output.end("stream contents");
		});
		const chunks: Buffer[] = [];
		for await (const chunk of fs.createReadStream("/tmp/stream.txt"))
			chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks).toString()).toBe("stream contents");
		expect(patches.findLast((patch) => patch.path === "/tmp/stream.txt")?.entry).toEqual({
			kind: "file",
			mtimeMs: expect.any(Number),
			data: new TextEncoder().encode("stream contents"),
		});
		await new Promise<void>((resolve, reject) =>
			fs.writeFile("/tmp/callback.txt", "callback contents", (error: Error | null) =>
				error ? reject(error) : resolve(),
			),
		);
		expect(patches.some((patch) => patch.path === "/tmp/callback.txt")).toBe(true);
		expect(vfs.fs.realpathSync.native("/tmp/callback.txt")).toBe("/tmp/callback.txt");
	});
	it("detects same-size writes within one clock tick and keeps previous snapshots immutable", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const changes: FilePatch[][] = [];
			const vfs = new VirtualFileSystem(
				{
					"/app": { kind: "directory" },
					"/app/static.bin": { kind: "file", data: new Uint8Array([1, 2, 3]) },
				},
				(patches) => changes.push(patches),
			);
			vfs.fs.writeFileSync("/app/state", "first");
			const before = vfs.snapshot();
			const timestamp = vfs.fs.statSync("/app/state").mtimeMs;
			vfs.fs.writeFileSync("/app/state", "other");
			expect(vfs.fs.statSync("/app/state").mtimeMs).toBe(timestamp);
			expect(before["/app/state"]).toEqual({
				kind: "file",
				mtimeMs: timestamp,
				data: new TextEncoder().encode("first"),
			});
			expect(vfs.snapshot()["/app/state"]).toEqual({
				kind: "file",
				mtimeMs: timestamp,
				data: new TextEncoder().encode("other"),
			});
			expect(changes.map((patches) => patches.map((patch) => patch.path))).toEqual([
				["/app/state"],
				["/app/state"],
			]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("links async ESM, top-level await, dynamic imports, import.meta, and package import mappings", async () => {
		const { snapshot } = parseAsar(
			createAsar({
				"package.json": '{"type":"module","imports":{"#value":"./value.mjs"}}',
				"main.mjs": `import {value} from '#value'; import condition from 'conditional'; const dynamic = await import('./dynamic.mjs'); export const answer = await Promise.resolve(value + dynamic.default + condition); export const filename = import.meta.filename;`,
				"value.mjs": `export const value = await Promise.resolve(20);`,
				"dynamic.mjs": `export default 2;`,
				"node_modules/conditional/package.json":
					'{"type":"module","exports":{".":{"import":"./import.mjs","require":"./require.cjs"}}}',
				"node_modules/conditional/import.mjs": `export default 20;`,
				"node_modules/conditional/require.cjs": `module.exports = 99;`,
			}),
		);
		const loader = new ModuleLoader(new VirtualFileSystem(snapshot, () => {}), {}, {});
		expect(await loader.runAsync("/app/main.mjs")).toMatchObject({
			answer: 42,
			filename: "/app/main.mjs",
		});
		expect(loader.requireFor("/app/main.mjs")("conditional")).toBe(99);
	});
	it("persists binary descriptor writes, renames, promises and symlinks through patches", async () => {
		const patches: FilePatch[] = [];
		const vfs = new VirtualFileSystem({}, (items) => patches.push(...items));
		vfs.fs.mkdirSync("/tmp");
		const fd = vfs.fs.openSync("/tmp/file", "w+");
		vfs.fs.writeSync(fd, Buffer.from([0, 255, 7]));
		vfs.fs.closeSync(fd);
		await vfs.fs.promises.rename("/tmp/file", "/tmp/renamed");
		vfs.fs.symlinkSync("/tmp/renamed", "/tmp/link");
		const mirror = new VirtualFileSystem({}, () => {});
		mirror.apply(patches);
		expect([...(mirror.fs.readFileSync("/tmp/link") as Uint8Array)]).toEqual([0, 255, 7]);
		expect(mirror.fs.existsSync("/tmp/file")).toBe(false);
	});
	it("supports circular modules, JSON, packages with exports and lowered static ESM", () => {
		const { snapshot } = parseAsar(
			createAsar({
				"main.js": `exports.a = require('./a'); exports.pkg = require('pkg'); exports.esm = require('./esm.mjs');`,
				"a.js": `exports.name = 'a'; exports.other = require('./b').name;`,
				"b.js": `exports.name = 'b'; exports.other = require('./a').name;`,
				"node_modules/pkg/package.json": '{"exports":{".":{"require":"./data.json"}}}',
				"node_modules/pkg/data.json": '{"value":7}',
				"esm.mjs": `import value from './node_modules/pkg/data.json'; export const number = value.value + 1;`,
			}),
		);
		const vfs = new VirtualFileSystem(snapshot, () => {});
		const loader = new ModuleLoader(vfs, {}, {});
		expect(loader.run("/app/main.js")).toMatchObject({
			a: { name: "a", other: "b" },
			pkg: { value: 7 },
			esm: { number: 8 },
		});
		expect(() => loader.resolve("pkg/private")).toThrow("ERR_PACKAGE_PATH_NOT_EXPORTED");
	});
	it("scans imports with aliases and native binaries without counting comments", () => {
		const { snapshot } = parseAsar(
			createAsar({
				"main.js": `// require('child_process')\nconst { ipcRenderer: ipc } = require('electron'); ipc.sendSync('x'); import fs from 'node:fs';`,
				"native.node": "abc",
			}),
		);
		const found = scanCompatibility(snapshot).map((item) => item.api);
		expect(found).toContain("ipcRenderer.sendSync");
		expect(found).toContain("fs");
		expect(found).toContain("native-addon");
		expect(found).not.toContain("child_process");
	});
});
