import { expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { processModules } from "../src/runtime/processes";
import type { RuntimeConfig } from "../src/shared/types";
import { contents, first, type Hit, head, startFixture } from "./git-smart-fixture";

const url = "http://127.0.0.1:4262/two.git";
function harness(transport = fetch) {
	const vfs = new VirtualFileSystem({}, () => {});
	vfs.fs.mkdirSync("/home/user", { recursive: true });
	vfs.fs.mkdirSync("/app");
	const { child_process: cp, close } = processModules(
		{} as RuntimeConfig,
		vfs,
		{ fetch: transport, clearPartition: () => {} },
		() => {},
	);
	const exec = (args: string[], cwd = "/app", encoding: BufferEncoding | "buffer" = "utf8") =>
		new Promise<{ code: number; out: string | Buffer; err: string | Buffer }>((resolve) => {
			cp.execFile("C:\\portable tool\\bin\\git.exe", args, { cwd, encoding }, (e, out, err) =>
				resolve({ code: e ? Reflect.get(e, "code") : 0, out, err }),
			);
		});
	return { vfs, cp, close, exec };
}
it("clones a smart HTTP pack into guest fs and reads both revisions from disk", async () => {
	const hits: Hit[] = [];
	const server = await startFixture(hits, 4262);
	const { exec, vfs, close } = harness();
	try {
		const clone = await exec(["clone", "--progress", "--", url, "two"]);
		expect(clone.code, String(clone.err)).toBe(0);
		expect(hits.map((h) => h.method)).toEqual(["GET", "POST"]);
		expect(vfs.fs.readFileSync("/app/two/hello.txt", "utf8")).toBe(contents);
		expect(await exec(["log", "--format=%H"], "/app/two")).toEqual({
			code: 0,
			out: `${head}\n${first}\n`,
			err: "",
		});
		expect(await exec(["-C", "two", "rev-parse", "HEAD"])).toMatchObject({ out: `${head}\n` });
		expect(await exec(["ls-files", "-z"], "/app/two", "buffer")).toMatchObject({
			out: Buffer.from("hello.txt\0"),
		});
		const status = ["-C", "two", "status", "--porcelain=2", "--untracked-files=all", "-z"];
		expect(await exec(status)).toMatchObject({ code: 0, out: "" });
		vfs.fs.writeFileSync("/app/two/hello.txt", "changed content\n");
		vfs.fs.writeFileSync("/app/two/extra.txt", "not tracked\n");
		const changed = await exec(status);
		expect(changed.code, String(changed.err)).toBe(0);
		expect(changed.out).toMatch(
			/^1 \.M N\.\.\. 100644 100644 100644 [a-f0-9]{40} [a-f0-9]{40} hello\.txt\0\? extra\.txt\0$/,
		);
		expect(
			await exec([
				"-C",
				"two",
				"log",
				head,
				"-1",
				"--raw",
				"--format=format:",
				"--numstat",
				"-z",
				"--",
			]),
		).toMatchObject({
			code: 0,
			out: expect.stringMatching(
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Git -z output separates raw and numstat records with NUL.
				/^:100644 100644 [a-f\d]{7} [a-f\d]{7} M\0hello\.txt\x001\t1\thello\.txt\0$/,
			),
		});
		expect(await exec(["clone", url, "two"])).toMatchObject({
			code: 128,
			err: expect.stringMatching(/not an empty directory/),
		});
		expect(hits).toHaveLength(2);
	} finally {
		close();
		await new Promise<void>((ok) => server.close(() => ok()));
	}
});
it("persists user config and distinguishes absent keys from unsupported flags/commands", async () => {
	const { exec, vfs, cp } = harness();
	expect(
		await exec(["config", "--global", "--replace-all", "user.name", "Guest User"]),
	).toMatchObject({ code: 0 });
	expect(vfs.fs.readFileSync("/home/user/.gitconfig", "utf8")).toContain("Guest User");
	expect(await exec(["config", "-z", "--global", "user.name"])).toMatchObject({
		out: "Guest User\0",
	});
	expect(await exec(["config", "--get", "user.email"])).toEqual({ code: 1, out: "", err: "" });
	expect(await exec(["push"])).toMatchObject({
		code: 128,
		err: expect.stringContaining("not a git repository"),
	});
	expect(await exec(["rebase", "main"])).toMatchObject({
		code: 128,
		err: expect.stringContaining("unsupported git command"),
	});
	expect(await exec(["clone", "--mirror", url])).toMatchObject({ code: 128 });
	expect(cp.spawnSync("git", ["clone", url]).status).not.toBe(0);
});
it("rejects credentials, non-HTTP URLs, disallowed transports, and HTTP failures without publishing files", async () => {
	let calls = 0;
	const { exec, vfs } = harness(async () => {
		calls++;
		return new Response("private", { status: 401 });
	});
	for (const source of [
		"ssh://guest@localhost/r",
		"file:///app/repo",
		"https://a:b@example.com/x",
	]) {
		expect(await exec(["clone", source, "repo"])).toMatchObject({ code: 128 });
	}
	expect(await exec(["-c", "protocol.http.allow=never", "clone", url, "repo"])).toMatchObject({
		code: 128,
	});
	expect(calls).toBe(0);
	// No credential helper can run, so a 401 ends like git with prompts off.
	expect(await exec(["clone", url, "repo"])).toMatchObject({
		code: 128,
		err: expect.stringContaining("could not read Username for 'http://127.0.0.1:4262'"),
	});
	expect(calls).toBe(1);
	expect(vfs.fs.existsSync("/app/repo")).toBe(false);
});

it("aborts an in-flight request without publishing a partial clone or mutating an empty destination", async () => {
	const started = Promise.withResolvers<void>();
	const { cp, vfs } = harness(async (_url, init) => {
		started.resolve();
		return new Promise((_resolve, reject) =>
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
				once: true,
			}),
		);
	});
	vfs.fs.mkdirSync("/app/keep");
	const child = cp.spawn("git", ["clone", url, "keep"]);
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	await started.promise;
	expect(child.kill()).toBe(true);
	expect(await closed).toEqual({ code: null, signal: "SIGTERM" });
	expect(vfs.fs.readdirSync("/app/keep")).toEqual([]);
});
