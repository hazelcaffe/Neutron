import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createAsar } from "../src/core/asar";
import { finalizeBundle, prepareResources, readZip } from "../src/core/importer";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { ModuleLoader } from "../src/runtime/loader";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe("complete resource bundles", () => {
	it("chooses the Electron bootstrap, mounts sibling archives, and keeps resource-relative paths", () => {
		const app = createAsar({
			"package.json": JSON.stringify({ name: "bootstrap", main: "main.cjs" }),
			"main.cjs": `module.exports = { sibling: require('../obsidian.asar/main.cjs'), loose: require('../settings.json'), root: __dirname };`,
		});
		const secondary = createAsar({
			"package.json": '{"name":"obsidian-dev"}',
			"main.cjs": "module.exports = 'secondary archive';",
		});
		const bundle = prepareResources(
			readZip(
				zipSync({
					"Obsidian/resources/app.asar": app,
					"Obsidian/resources/obsidian.asar": secondary,
					"Obsidian/resources/settings.json": encode({ configured: true }),
					"Obsidian/other.txt": encode("outside resources"),
				}),
			),
			"Obsidian.zip",
			"zip",
		);
		expect(bundle.root).toBe("Obsidian/resources");
		expect(bundle.candidates[bundle.suggested ?? -1]?.appPath).toBe(
			"/neutron/resources/app.asar",
		);
		expect(
			bundle.candidates.find((candidate) => candidate.manifest.name === "obsidian-dev")
				?.entryPoint,
		).toBeUndefined();
		const installed = finalizeBundle(bundle, bundle.suggested ?? 0);
		const vfs = new VirtualFileSystem(installed.snapshot, () => {});
		const result = new ModuleLoader(vfs, {}, {}).run(installed.app.entryPoint || "");
		expect(result).toEqual({
			sibling: "secondary archive",
			loose: { configured: true },
			root: "/neutron/resources/app.asar",
		});
		expect(
			new Uint8Array(vfs.fs.readFileSync("/resources/obsidian.asar") as Uint8Array),
		).toEqual(secondary);
		expect(vfs.fs.readFileSync("/app/package.json", "utf8")).toContain("bootstrap");
		expect(installed.snapshot["/neutron/resources/other.txt"]).toBeUndefined();
	});
	it("does not invent index.js for a package without a valid entry", () => {
		const bundle = prepareResources(
			[
				{
					path: "resources/obsidian.asar",
					data: createAsar({
						"package.json": '{"name":"obsidian-dev","version":"1.15.1"}',
						"main.js": "module.exports = 42;",
						"index.html": "<h1>renderer</h1>",
					}),
				},
			],
			"resources",
			"folder",
		);
		const candidate = bundle.candidates[0];
		expect(candidate?.entryPoint).toBeUndefined();
		expect(candidate?.issue).toContain("renderer/update archive");
		expect(() => finalizeBundle(bundle, 0)).toThrow("does not declare a main entry");
		const selected = finalizeBundle(bundle, 0, "/neutron/resources/obsidian.asar/main.js");
		expect(selected.app.entryPoint).toBe("/neutron/resources/obsidian.asar/main.js");
	});
	it("uses app.asar.unpacked companions at their original locations", async () => {
		const root = await mkdtemp(join(tmpdir(), "neutron-resources-"));
		const output = `${root}.asar`;
		try {
			await writeFile(join(root, "package.json"), '{"name":"unpacked","main":"main.js"}');
			await writeFile(join(root, "main.js"), "module.exports=require('./external.json');");
			await writeFile(join(root, "external.json"), '{"unpacked":true}');
			await createPackageWithOptions(root, output, { unpack: "external.json" });
			const files = [
				{ path: "resources/app.asar", data: new Uint8Array(await readFile(output)) },
				{
					path: "resources/app.asar.unpacked/external.json",
					data: new Uint8Array(await readFile(`${output}.unpacked/external.json`)),
				},
			];
			const bundle = prepareResources(files, "resources", "folder");
			expect(bundle.missing).toEqual([]);
			const { app, snapshot } = finalizeBundle(bundle, 0);
			const vfs = new VirtualFileSystem(snapshot, () => {});
			expect(new ModuleLoader(vfs, {}, {}).run(app.entryPoint || "")).toEqual({
				unpacked: true,
			});
			expect(snapshot["/neutron/resources/app.asar/external.json"]).toEqual({
				kind: "symlink",
				target: "/neutron/resources/app.asar.unpacked/external.json",
			});
			expect(prepareResources(files.slice(0, 1), "resources", "folder").missing).toContain(
				"/neutron/resources/app.asar.unpacked/external.json",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(output, { force: true });
			await rm(`${output}.unpacked`, { recursive: true, force: true });
		}
	});
	it("accepts unpacked app directories and rejects ambiguous or escaping ZIP layouts", () => {
		const bundle = prepareResources(
			readZip(
				zipSync({
					"app/package.json": encode({ name: "loose", main: "src/boot" }),
					"app/src/boot.js": new TextEncoder().encode("module.exports=1;"),
				}),
			),
			"resources.zip",
			"zip",
		);
		expect(finalizeBundle(bundle, 0).app.entryPoint).toBe("/neutron/resources/app/src/boot.js");
		expect(() => readZip(zipSync({ "../escape": new Uint8Array([1]) }))).toThrow(
			"Invalid resource path",
		);
		expect(() =>
			prepareResources(
				[
					{ path: "one/resources/app.asar", data: createAsar({ "package.json": "{}" }) },
					{ path: "two/resources/app.asar", data: createAsar({ "package.json": "{}" }) },
				],
				"two.zip",
				"zip",
			),
		).toThrow("more than one");
	});
	it("keeps unpacked JavaScript in its logical ASAR namespace for relative imports", () => {
		const archive = createAsar({
			"package.json": '{"name":"logical-main","main":"main.js"}',
			"helper.js": "module.exports=42;",
		});
		const bundle = prepareResources(
			[{ path: "MyApp/resources/app.asar", data: archive }],
			"MyApp",
			"folder",
		);
		expect(bundle.root).toBe("MyApp/resources");
		bundle.snapshot["/neutron/resources/app.asar.unpacked"] = { kind: "directory" };
		bundle.snapshot["/neutron/resources/app.asar.unpacked/main.js"] = {
			kind: "file",
			data: new TextEncoder().encode(
				"module.exports={value:require('./helper'),filename:__filename};",
			),
		};
		bundle.snapshot["/neutron/resources/app.asar/main.js"] = {
			kind: "symlink",
			target: "/neutron/resources/app.asar.unpacked/main.js",
		};
		const installed = finalizeBundle(bundle, 0, "/neutron/resources/app.asar/main.js");
		expect(installed.app.entryPoint).toBe("/neutron/resources/app.asar/main.js");
		const loader = new ModuleLoader(
			new VirtualFileSystem(installed.snapshot, () => {}),
			{},
			{},
		);
		expect(loader.run(installed.app.entryPoint || "")).toEqual({
			value: 42,
			filename: "/neutron/resources/app.asar/main.js",
		});
	});
});
