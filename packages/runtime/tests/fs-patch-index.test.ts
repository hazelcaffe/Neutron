import { expect, it, vi } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import type { FilePatch, Snapshot } from "../src/shared/types";

const file = (text: string) => ({ kind: "file" as const, data: new TextEncoder().encode(text) });

it("mirrors incremental changes without traversing unrelated package files or echoing remote changes", () => {
	const mounted: Snapshot = { "/pkg": { kind: "directory" }, "/state": { kind: "directory" } };
	for (let i = 0; i < 256; ++i) mounted[`/pkg/asset-${i}`] = file(`${i}`);
	const changes: FilePatch[] = [];
	const fs = new VirtualFileSystem(mounted, (patches) => changes.push(...patches));
	const walk = vi.spyOn(fs, "snapshot");
	fs.apply([{ path: "/state/cache", entry: { kind: "directory" } }]);
	for (let i = 0; i < 64; i++) {
		const path = `/state/cache/${i}`;
		fs.apply([{ path, entry: file("first") }]);
		fs.apply([{ path, entry: file("second") }]);
		if (i % 2 === 0) fs.apply([{ path, entry: null }]);
	}
	expect(walk).not.toHaveBeenCalled();
	expect(fs.fs.readFileSync("/state/cache/63", "utf8")).toBe("second");
	expect(fs.fs.existsSync("/state/cache/62")).toBe(false);
	fs.flush();
	expect(changes).toEqual([]);
});

it("reconciles implicit directories, links and subtree replacements before diffing local edits", () => {
	const changes: FilePatch[] = [];
	const fs = new VirtualFileSystem({}, (patches) => changes.push(...patches));
	fs.apply([{ path: "/state/implicit/nested", entry: file("initial") }]);
	fs.apply([{ path: "/alias", entry: { kind: "symlink", target: "/state" } }]);
	fs.apply([{ path: "/alias/implicit/nested", entry: file("via symlink") }]);
	fs.fs.linkSync("/state/implicit/nested", "/linked");
	changes.length = 0;
	fs.apply([{ path: "/linked", entry: file("via hardlink") }]);
	expect(fs.fs.readFileSync("/state/implicit/nested", "utf8")).toBe("via hardlink");
	fs.apply([{ path: "/state/implicit", entry: file("replaced directory") }]);
	fs.flush();
	expect(changes).toEqual([]);
	fs.fs.writeFileSync("/state/implicit", "local");
	expect(changes.map(({ path }) => path)).toEqual(["/state/implicit"]);
});
