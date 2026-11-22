import { describe, expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";

describe("fs.WriteStream.close", () => {
	it.each(["factory", "constructor", "handle"] as const)(
		"drains queued writes before the %s stream's close callback can publish the file",
		async (source) => {
			const vfs = new VirtualFileSystem({}, () => {});
			const { fs } = vfs;
			const stream =
				source === "factory"
					? fs.createWriteStream("/pending")
					: source === "constructor"
						? new fs.WriteStream("/pending", { autoClose: false })
						: (await fs.promises.open("/pending", "w")).createWriteStream();
			const events: string[] = [];
			stream.on("finish", () => events.push("finish"));
			stream.on("close", () => events.push("close"));
			stream.write('{"v":1}');
			stream.write("\n");
			await new Promise<void>((resolve, reject) => {
				stream.once("error", reject);
				stream.close(() => {
					fs.renameSync("/pending", "/records");
					resolve();
				});
			});
			fs.appendFileSync("/records", '{"v":2}\n');
			expect(fs.readFileSync("/records", "utf8")).toBe('{"v":1}\n{"v":2}\n');
			await new Promise<void>((resolve) => stream.close(() => setImmediate(resolve)));
			expect(events).toEqual(["finish", "close"]);
		},
	);
});
