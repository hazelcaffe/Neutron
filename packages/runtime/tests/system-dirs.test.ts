import { expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";

it("keeps root-owned system directories like the temp dir from being removed", async () => {
	const vfs = new VirtualFileSystem({}, () => {});
	vfs.fs.mkdirSync("/tmp", { recursive: true });
	vfs.fs.writeFileSync("/tmp/progress-1", "");
	// The pattern apps use to clean up "their" temp directory.
	vfs.fs.unlinkSync("\\tmp\\progress-1");
	expect(() => vfs.fs.rmdirSync("\\tmp")).toThrow(
		expect.objectContaining({ code: "EPERM", syscall: "rmdir" }),
	);
	await expect(vfs.fs.promises.rm("/tmp", { recursive: true })).rejects.toMatchObject({
		code: "EPERM",
	});
	const callback = await new Promise<{ code?: string } | null | undefined>((resolve) =>
		vfs.fs.rmdir("/tmp", (error) => resolve(error)),
	);
	expect(callback?.code).toBe("EPERM");
	expect(vfs.fs.existsSync("/tmp")).toBe(true);
	// Ordinary directories are unaffected.
	vfs.fs.mkdirSync("/tmp/mine");
	vfs.fs.rmdirSync("/tmp/mine");
	expect(vfs.fs.readdirSync("/tmp")).toEqual([]);
});
