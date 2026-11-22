import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { processModules } from "../src/runtime/processes";
import type { RuntimeConfig } from "../src/shared/types";
import { type GitServer, startGitServer } from "./git-server-fixture";

// GitHub Desktop-style workflows against the virtual Git CLI: argv, stdin and
// machine-readable output shapes that Desktop parses, plus smart-HTTP push,
// fetch, pull and Git LFS transfers against a local fixture origin.

const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const ZERO = "0".repeat(40);

function guest(env: Record<string, string> = {}) {
	const vfs = new VirtualFileSystem({}, () => {});
	vfs.fs.mkdirSync("/home/user", { recursive: true });
	vfs.fs.mkdirSync("/work", { recursive: true });
	const { child_process: cp } = processModules(
		{} as RuntimeConfig,
		vfs,
		{ fetch, clearPartition: () => {} },
		() => {},
	);
	const git = (args: string[], cwd = "/work/repo", stdin?: string) =>
		new Promise<{ code: number; out: string; err: string }>((resolve) => {
			const child = cp.execFile(
				GIT,
				args,
				{ cwd, env: { HOME: "/home/user", ...env } },
				(error, out, err) =>
					resolve({
						code: error ? Reflect.get(error, "code") : 0,
						out: String(out),
						err: String(err),
					}),
			);
			if (stdin !== undefined) child.stdin.end(stdin);
		});
	const write = (file: string, data: string | Uint8Array) => {
		vfs.fs.mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
		vfs.fs.writeFileSync(file, data);
	};
	return { vfs, git, write };
}

async function identity(git: ReturnType<typeof guest>["git"]) {
	await git(["config", "--global", "user.name", "Test User"], "/work");
	await git(["config", "--global", "user.email", "test@example.org"], "/work");
}

describe("local repository workflows", () => {
	it("stages from stdin, commits a message from stdin and reports Desktop's status/diff formats", async () => {
		const { git, write } = guest();
		await identity(git);
		expect(await git(["-c", "init.defaultBranch=main", "init", "repo"], "/work")).toMatchObject(
			{ code: 0 },
		);
		write("/work/repo/a.txt", "one\ntwo\nthree\n");
		write("/work/repo/dir/b.txt", "bee\n");
		expect(
			await git(
				["update-index", "--add", "--remove", "--replace", "-z", "--stdin"],
				undefined,
				"a.txt\0dir/b.txt\0",
			),
		).toMatchObject({ code: 0 });
		const first = await git(["commit", "-F", "-"], undefined, "Initial commit\n\nBody line\n");
		expect(first.out).toMatch(/^\[main \(root-commit\) [0-9a-f]{7}\] Initial commit\n/);
		write("/work/repo/a.txt", "one\n2\nthree\n");
		write("/work/repo/new.txt", "fresh");
		const status = await git([
			"--no-optional-locks",
			"status",
			"--untracked-files=all",
			"--branch",
			"--porcelain=2",
			"-z",
		]);
		const head = (await git(["rev-parse", "HEAD"])).out.trim();
		expect(status.out.split("\0")).toEqual([
			`# branch.oid ${head}`,
			"# branch.head main",
			expect.stringMatching(
				/^1 \.M N\.\.\. 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} a\.txt$/,
			),
			"? new.txt",
			"",
		]);
		const diff = await git([
			"diff",
			"--no-ext-diff",
			"--patch-with-raw",
			"-z",
			"--no-color",
			"HEAD",
			"--",
			"a.txt",
		]);
		expect(diff.out).toContain(":100644 100644 ");
		const blob = (text: string) =>
			createHash("sha1").update(`blob ${text.length}\0${text}`).digest("hex").slice(0, 7);
		expect(diff.out.split("\0").at(-1)).toBe(
			`diff --git a/a.txt b/a.txt\nindex ${blob("one\ntwo\nthree\n")}..${blob("one\n2\nthree\n")} 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n`,
		);
		const untracked = await git([
			"diff",
			"--no-ext-diff",
			"--patch-with-raw",
			"-z",
			"--no-color",
			"--no-index",
			"--",
			"/dev/null",
			"new.txt",
		]);
		expect(untracked.code).toBe(1);
		expect(untracked.out.split("\0").at(-1)).toContain(
			"@@ -0,0 +1 @@\n+fresh\n\\ No newline at end of file\n",
		);
		// Desktop commits by unstaging everything and restaging the selection.
		expect(await git(["reset", "--", "."])).toMatchObject({ code: 0 });
		await git(
			["update-index", "--add", "--remove", "--replace", "-z", "--stdin"],
			undefined,
			"a.txt\0new.txt\0",
		);
		expect((await git(["commit", "-F", "-"], undefined, "Second\n")).code).toBe(0);
		const log = await git([
			"log",
			"--date=raw",
			"--max-count=10",
			"-z",
			"--format=%H%x00%s%x00%P",
			"--no-show-signature",
			"--no-color",
			"--end-of-options",
			"HEAD",
			"--",
		]);
		expect(log.out.split("\0").filter((_, i) => i % 3 === 1)).toEqual([
			"Second",
			"Initial commit",
		]);
		const raw = await git([
			"log",
			log.out.slice(0, 40),
			"-C",
			"-M",
			"-m",
			"-1",
			"--no-show-signature",
			"--first-parent",
			"--raw",
			"--format=format:",
			"--numstat",
			"-z",
			"--",
		]);
		expect(raw.out.split("\0")).toEqual([
			expect.stringMatching(/^:100644 100644 [0-9a-f]{7} [0-9a-f]{7} M$/),
			"a.txt",
			expect.stringMatching(/^:000000 100644 0000000 [0-9a-f]{7} A$/),
			"new.txt",
			"1\t1\ta.txt",
			"1\t0\tnew.txt",
			"",
		]);
		expect(
			await git(
				[
					"log",
					"--format=format:%an <%ae> %ad",
					"--no-walk=unsorted",
					"--date=raw",
					"-z",
					"--stdin",
				],
				undefined,
				`${head}\n`,
			),
		).toMatchObject({
			out: expect.stringMatching(/^Test User <test@example\.org> \d+ [+-]\d{4}$/),
		});
		// Unknown revisions after -- or --end-of-options are "bad revision".
		expect(
			await git([
				"rev-list",
				"--left-right",
				"--count",
				"--end-of-options",
				"main...origin/main",
				"--",
			]),
		).toMatchObject({
			code: 128,
			err: "fatal: bad revision 'main...origin/main'\n",
		});
	});

	it("creates, switches and renames branches and records checkout reflog entries", async () => {
		const { git, write, vfs } = guest();
		await identity(git);
		await git(["init", "-b", "main", "repo"], "/work");
		write("/work/repo/a.txt", "base\n");
		await git(["add", "-A"]);
		await git(["commit", "-m", "base"]);
		expect(await git(["branch", "--no-track", "--", "topic", "main"])).toMatchObject({
			code: 0,
		});
		expect(await git(["checkout", "--progress", "topic", "--"])).toMatchObject({ code: 0 });
		write("/work/repo/a.txt", "topic\n");
		await git(["commit", "-a", "-m", "topic work"]);
		write("/work/repo/a.txt", "local edit\n");
		// Local changes to a file that differs between branches block a switch.
		expect(await git(["checkout", "main", "--"])).toMatchObject({
			code: 1,
			err: expect.stringMatching(
				/^error: Your local changes to the following files would be overwritten by checkout:\n\ta\.txt\n/,
			),
		});
		await git(["checkout", "HEAD", "--", "a.txt"]);
		expect(await git(["checkout", "main", "--"])).toMatchObject({ code: 0 });
		expect(vfs.fs.readFileSync("/work/repo/a.txt", "utf8")).toBe("base\n");
		const reflog = await git([
			"log",
			"-g",
			"--no-abbrev-commit",
			"--pretty=oneline",
			"HEAD",
			"-n",
			"2500",
			"--",
		]);
		expect(reflog.out).toMatch(
			/^[0-9a-f]{40} HEAD@\{0\}: checkout: moving from topic to main\n[0-9a-f]{40} HEAD@\{1\}: commit: topic work\n[0-9a-f]{40} HEAD@\{2\}: checkout: moving from main to topic\n/,
		);
		expect(
			await git([
				"rev-list",
				"--left-right",
				"--count",
				"--end-of-options",
				"main...topic",
				"--",
			]),
		).toMatchObject({ out: "0\t1\n" });
		expect(await git(["branch", "-m", "topic", "feature"])).toMatchObject({ code: 0 });
		expect(await git(["merge", "--", "feature"])).toMatchObject({
			code: 0,
			out: expect.stringContaining("Fast-forward"),
		});
		expect(vfs.fs.readFileSync("/work/repo/a.txt", "utf8")).toBe("topic\n");
		// `git checkout HEAD --` with no paths keeps HEAD attached.
		await git(["checkout", "HEAD", "--"]);
		expect(await git(["symbolic-ref", "HEAD"])).toMatchObject({ out: "refs/heads/main\n" });
	});

	it("undoes the first commit without deleting HEAD and stashes/pops changes", async () => {
		const { git, write, vfs } = guest();
		await identity(git);
		await git(["init", "-b", "main", "repo"], "/work");
		write("/work/repo/a.txt", "a\n");
		await git(["add", "-A"]);
		await git(["commit", "-m", "first"]);
		expect(
			await git(["update-ref", "-d", "HEAD", "-m", "Reverting first commit"]),
		).toMatchObject({ code: 0 });
		expect(vfs.fs.readFileSync("/work/repo/.git/HEAD", "utf8")).toBe("ref: refs/heads/main\n");
		expect(await git(["rev-parse", "--verify", "--end-of-options", "HEAD"])).toMatchObject({
			code: 128,
		});
		expect(await git(["rm", "--cached", "-r", "-f", "."])).toMatchObject({ code: 0 });
		expect((await git(["status", "--porcelain=2", "-z", "--untracked-files=all"])).out).toBe(
			"? a.txt\0",
		);
		await git(["add", "-A"]);
		await git(["commit", "-m", "first again"]);
		write("/work/repo/a.txt", "stashed change\n");
		expect(await git(["stash", "push", "-m", "!!GitHub_Desktop<main>"])).toMatchObject({
			code: 0,
		});
		expect(vfs.fs.readFileSync("/work/repo/a.txt", "utf8")).toBe("a\n");
		const list = await git([
			"log",
			"-g",
			"-z",
			"--format=%gD%x00%H%x00%gs",
			"refs/stash",
			"--",
		]);
		expect(list.out).toMatch(
			/^refs\/stash@\{0\}\0[0-9a-f]{40}\0On main: !!GitHub_Desktop<main>\0$/,
		);
		expect(await git(["stash", "pop", "--quiet", "refs/stash@{0}"])).toMatchObject({ code: 0 });
		expect(vfs.fs.readFileSync("/work/repo/a.txt", "utf8")).toBe("stashed change\n");
		expect(await git(["log", "-g", "refs/stash", "--"])).toMatchObject({
			code: 128,
			err: "fatal: bad revision 'refs/stash'\n",
		});
	});

	it("stages and discards selected lines with git apply, and restages renames by blob", async () => {
		const { git, write, vfs } = guest();
		await identity(git);
		await git(["init", "-b", "main", "repo"], "/work");
		const lines = (n: number) =>
			Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
		write("/work/repo/a.txt", lines(20));
		await git(["add", "-A"]);
		await git(["commit", "-m", "first"]);
		const read = (file: string) => String(vfs.fs.readFileSync(`/work/repo/${file}`, "utf8"));
		write(
			"/work/repo/a.txt",
			lines(20).replace("line 3\n", "three\n").replace("line 15\n", "fifteen\nextra\n"),
		);
		// Desktop's partial commit: one line of the second hunk; its new-side
		// start is off by the unselected line, so the hunk is found by search.
		const apply = ["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"];
		expect(
			await git(
				apply,
				undefined,
				"--- a/a.txt\n+++ b/a.txt\n@@ -12,6 +12,7 @@\n line 12\n line 13\n line 14\n line 15\n+extra\n line 16\n line 17\n",
			),
		).toEqual({ code: 0, out: "", err: "" });
		expect((await git(["diff", "--cached"])).out).toMatch(
			/@@ -13,6 \+13,7 @@ line 12\n line 13\n line 14\n line 15\n\+extra\n line 16\n line 17\n line 18\n$/,
		);
		expect(read("a.txt")).toContain("three\n");
		// A patch whose preimage is gone fails without touching the index.
		const before = (await git(["ls-files", "-s"])).out;
		expect(
			await git(
				apply,
				undefined,
				"--- a/a.txt\n+++ b/a.txt\n@@ -2,3 +2,3 @@\n line 2\n-nope\n+yes\n line 4\n",
			),
		).toEqual({
			code: 1,
			out: "",
			err: "error: patch failed: a.txt:2\nerror: a.txt: patch does not apply\n",
		});
		expect((await git(["ls-files", "-s"])).out).toBe(before);
		// Part of an untracked file.
		write("/work/repo/new.txt", "n1\nn2\nn3\n");
		expect(
			await git(
				apply,
				undefined,
				"--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+n1\n+n3\n",
			),
		).toMatchObject({ code: 0 });
		expect((await git(["show", ":new.txt"])).out).toBe("n1\nn3\n");
		expect(
			await git(apply, undefined, "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+n1\n"),
		).toMatchObject({ code: 1, err: "error: new.txt: already exists in index\n" });
		// Discarding a selection rewrites the worktree only.
		expect(
			await git(
				["apply", "--unidiff-zero", "--whitespace=nowarn", "-"],
				undefined,
				"--- a/a.txt\n+++ b/a.txt\n@@ -14,5 +14,4 @@\n line 14\n fifteen\n-extra\n line 16\n line 17\n",
			),
		).toEqual({ code: 0, out: "", err: "" });
		expect(read("a.txt")).toBe(
			lines(20).replace("line 3\n", "three\n").replace("line 15\n", "fifteen\n"),
		);
		// diff --check uses git's whitespace rules: blank and CRLF lines too.
		await git(["reset", "-q", "--hard"]);
		write("/work/repo/ws.txt", "x\n");
		await git(["add", "ws.txt"]);
		write("/work/repo/ws.txt", "x\n   \n \t\ny\r\n\t \tz\n<<<<<<< ours \n");
		expect(await git(["diff", "--check"])).toEqual({
			code: 2,
			out: "ws.txt:2: trailing whitespace.\n+   \nws.txt:3: trailing whitespace.\n+ \t\nws.txt:4: trailing whitespace.\n+y\r\nws.txt:5: space before tab in indent.\n+\t \tz\nws.txt:6: leftover conflict marker\nws.txt:6: trailing whitespace.\n+<<<<<<< ours \n",
			err: "",
		});
		expect(await git(["rm", "-q", "--cached", "--", "ws.txt"])).toEqual({
			code: 0,
			out: "",
			err: "",
		});
		vfs.fs.rmSync("/work/repo/ws.txt");
		// Default whitespace warnings, -R and --check.
		const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n line 1\n+tail \n line 2\n";
		expect(await git(["apply", "-"], undefined, patch)).toEqual({
			code: 0,
			out: "",
			err: "<stdin>:5: trailing whitespace.\ntail \nwarning: 1 line adds whitespace errors.\n",
		});
		expect(await git(["apply", "--check", "-"], undefined, patch)).toMatchObject({ code: 1 });
		expect(await git(["apply", "-R", "-"], undefined, patch)).toMatchObject({ code: 0 });
		expect(read("a.txt")).toBe(lines(20));
		expect(await git(["apply", "-"], undefined, "not a patch\n")).toEqual({
			code: 128,
			out: "",
			err: 'error: No valid patches in input (allow with "--allow-empty")\n',
		});
		// Desktop restages a renamed file's old blob under the new name.
		vfs.fs.renameSync("/work/repo/a.txt", "/work/repo/moved.txt");
		await git(["add", "--update", "--", "a.txt"]);
		const tree = await git(["ls-tree", "HEAD", "--", "a.txt"]);
		const [mode, type, oid] = tree.out.split("\t")[0]?.split(" ") ?? [];
		expect([mode, type, tree.out.split("\t")[1]]).toEqual(["100644", "blob", "a.txt\n"]);
		expect(
			await git(["update-index", "--cacheinfo", mode as string, oid as string, "moved.txt"]),
		).toMatchObject({
			code: 128,
			err: "error: moved.txt: cannot add to the index - missing --add option?\nfatal: git update-index: --cacheinfo cannot add moved.txt\n",
		});
		expect(
			await git(["update-index", "--add", "--cacheinfo", `${mode},${oid},moved.txt`]),
		).toMatchObject({ code: 0 });
		expect((await git(["status", "--porcelain=2", "-z", "--untracked-files=all"])).out).toBe(
			`1 D. N... 100644 000000 000000 ${oid} ${ZERO} a.txt\x001 A. N... 000000 100644 100644 ${ZERO} ${oid} moved.txt\0`,
		);
	});

	it("records conflicted merges in the index and completes them with commit --no-edit", async () => {
		const { git, write, vfs } = guest();
		await identity(git);
		await git(["init", "-b", "main", "repo"], "/work");
		write("/work/repo/f.txt", "base\n");
		write("/work/repo/other.txt", "same\n");
		await git(["add", "-A"]);
		await git(["commit", "-m", "base"]);
		await git(["checkout", "-b", "side"]);
		write("/work/repo/f.txt", "side\n");
		await git(["commit", "-am", "side"]);
		await git(["checkout", "main"]);
		write("/work/repo/f.txt", "main\n");
		await git(["commit", "-am", "main"]);
		const [ours, theirs] = [
			(await git(["rev-parse", "main"])).out.trim(),
			(await git(["rev-parse", "side"])).out.trim(),
		];
		// Conflicted trees cannot be produced, so merge-tree refuses honestly.
		expect(
			await git([
				"merge-tree",
				"--write-tree",
				"--name-only",
				"--no-messages",
				"-z",
				ours,
				theirs,
			]),
		).toMatchObject({ code: 128 });
		const merge = await git(["merge", "--", "side"]);
		expect(merge).toMatchObject({
			code: 1,
			out: "Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n",
		});
		expect(vfs.fs.readFileSync("/work/repo/f.txt", "utf8")).toBe(
			"<<<<<<< HEAD\nmain\n=======\nside\n>>>>>>> side\n",
		);
		expect(vfs.fs.readFileSync("/work/repo/.git/MERGE_HEAD", "utf8")).toBe(`${theirs}\n`);
		expect((await git(["status", "--porcelain=2", "-z"])).out).toMatch(
			/^u UU N\.\.\. 100644 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} [0-9a-f]{40} f\.txt\0$/,
		);
		expect(await git(["commit", "--no-edit", "--cleanup=strip"])).toMatchObject({
			code: 128,
			err: expect.stringContaining("unmerged files"),
		});
		write("/work/repo/f.txt", "resolved\n");
		await git(["add", "--", "f.txt"]);
		expect(await git(["commit", "--no-edit", "--cleanup=strip"])).toMatchObject({ code: 0 });
		expect((await git(["log", "-1", "--format=%P%x00%B"])).out).toBe(
			`${ours} ${theirs}\0Merge branch 'side'\n\n`,
		);
		expect(vfs.fs.existsSync("/work/repo/.git/MERGE_HEAD")).toBe(false);
		// merge --abort restores the pre-merge state.
		await git(["checkout", "-b", "again"]);
		write("/work/repo/f.txt", "again\n");
		await git(["commit", "-am", "again"]);
		await git(["checkout", "main"]);
		write("/work/repo/f.txt", "main 2\n");
		await git(["commit", "-am", "main 2"]);
		expect((await git(["merge", "again"])).code).toBe(1);
		expect(await git(["merge", "--abort"])).toMatchObject({ code: 0 });
		expect(vfs.fs.readFileSync("/work/repo/f.txt", "utf8")).toBe("main 2\n");
		expect((await git(["status", "--porcelain=2", "-z"])).out).toBe("");
	});

	it("refuses unsupported commands and arguments with a nonzero status", async () => {
		const { git } = guest();
		await git(["init", "repo"], "/work");
		expect(await git(["rebase", "main"])).toMatchObject({
			code: 128,
			err: "fatal: unsupported git command: rebase\n",
		});
		expect(await git(["log", "--graph"])).toMatchObject({
			code: 128,
			err: "fatal: unsupported git log arguments\n",
		});
		expect(await git(["status", "--porcelain=2", "--find-renames=30"])).toMatchObject({
			code: 128,
		});
	});
});

describe("remote workflows over smart HTTP", () => {
	let origin: GitServer;
	let root: string;
	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "neutron-git-origin-"));
		origin = await startGitServer(root);
	});
	afterAll(async () => {
		await origin.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("publishes, clones, fetches, pulls, prunes and rejects non-fast-forward pushes", async () => {
		const url = origin.url("shared");
		const alice = guest();
		await identity(alice.git);
		await alice.git(["init", "-b", "main", "repo"], "/work");
		alice.write("/work/repo/readme.md", "hello\n");
		await alice.git(["add", "-A"]);
		await alice.git(["commit", "-m", "start"]);
		expect(await alice.git(["remote", "add", "--", "origin", url])).toMatchObject({ code: 0 });
		const published = await alice.git([
			"push",
			"--set-upstream",
			"--progress",
			"--",
			"origin",
			"main",
		]);
		expect(published).toMatchObject({
			code: 0,
			err: expect.stringContaining(" * [new branch]      main -> main"),
		});
		expect(await alice.git(["rev-parse", "--symbolic-full-name", "@{upstream}"])).toMatchObject(
			{ out: "refs/remotes/origin/main\n" },
		);

		const bob = guest();
		await identity(bob.git);
		expect(
			await bob.git(["clone", "--recursive", "--progress", "--", url, "/work/repo"], "/work"),
		).toMatchObject({ code: 0 });
		expect(bob.vfs.fs.readFileSync("/work/repo/readme.md", "utf8")).toBe("hello\n");
		bob.write("/work/repo/readme.md", "hello from bob\n");
		await bob.git(["commit", "-a", "-m", "bob"]);
		expect(await bob.git(["push", "--progress", "--", "origin", "main:main"])).toMatchObject({
			code: 0,
		});

		alice.write("/work/repo/other.txt", "alice\n");
		await alice.git(["add", "other.txt"]);
		await alice.git(["commit", "-m", "alice"]);
		// Desktop maps this exact shape to its "pull first" prompt.
		expect(await alice.git(["push", "--progress", "--", "origin", "main:main"])).toMatchObject({
			code: 1,
			err: expect.stringMatching(/\(fetch first\)\nerror: failed to push some refs to '/),
		});
		expect(
			await alice.git([
				"fetch",
				"--progress",
				"--prune",
				"--recurse-submodules=on-demand",
				"--",
				"origin",
			]),
		).toMatchObject({ code: 0 });
		expect(
			(await alice.git(["--no-optional-locks", "status", "--branch", "--porcelain=2", "-z"]))
				.out,
		).toContain("# branch.ab +1 -1\0");
		expect(
			await alice.git(["pull", "--ff", "--recurse-submodules", "--progress", "--", "origin"]),
		).toMatchObject({ code: 0 });
		expect(alice.vfs.fs.readFileSync("/work/repo/readme.md", "utf8")).toBe("hello from bob\n");
		const merge = await alice.git(["log", "-1", "--format=%P%x00%s"]);
		expect(merge.out.split("\0")[0]?.split(" ")).toHaveLength(2);
		expect(await alice.git(["push", "--", "origin", "main:main"])).toMatchObject({ code: 0 });

		// A new, empty remote: fetch --prune drops its tracking branches.
		expect(
			await alice.git(["remote", "set-url", "--", "origin", origin.url("empty")]),
		).toMatchObject({ code: 0 });
		expect(await alice.git(["fetch", "--prune", "--", "origin"])).toMatchObject({ code: 0 });
		expect((await alice.git(["for-each-ref", "--format=%(refname)", "refs/remotes"])).out).toBe(
			"",
		);
		expect(alice.vfs.fs.existsSync("/work/repo/.git/FETCH_HEAD")).toBe(true);
		expect(await alice.git(["remote", "remove", "--", "origin"])).toMatchObject({ code: 0 });
		expect(
			await alice.git(["config", "--null", "--get-regexp", "^remote\\..+\\.url$"]),
		).toMatchObject({ code: 1 });
	});

	it("reports missing credentials like git with prompts disabled", async () => {
		const { git } = guest({
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_PARAMETERS: "'credential.helper=' 'credential.helper=desktop'",
		});
		const server = await import("node:http").then(({ createServer }) =>
			createServer((_req, res) =>
				res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }).end(),
			),
		);
		await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
		const address = server.address() as { port: number };
		try {
			expect(
				await git(["clone", `http://127.0.0.1:${address.port}/private.git`, "p"], "/work"),
			).toEqual({
				code: 128,
				out: "",
				err: `error: credential helper 'desktop' was not run: this Git cannot execute credential helper programs\nfatal: could not read Username for 'http://127.0.0.1:${address.port}': terminal prompts disabled\n`,
			});
		} finally {
			await new Promise<void>((ok) => server.close(() => ok()));
		}
	});

	it("installs the LFS filter, smudges on clone, cleans on add and uploads on push", async () => {
		const url = origin.url("assets");
		const content = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 256));
		const oid = createHash("sha256").update(content).digest("hex");
		const author = guest();
		await identity(author.git);
		expect(await author.git(["lfs", "install", "--skip-repo"], "/work")).toEqual({
			code: 0,
			out: "Git LFS initialized.\n",
			err: "",
		});
		expect(author.vfs.fs.readFileSync("/home/user/.gitconfig", "utf8")).toMatch(
			/\[filter "lfs"\][^[]*clean = git-lfs clean -- %f/,
		);
		await author.git(["init", "-b", "main", "repo"], "/work");
		expect(await author.git(["lfs", "track", "*.bin"])).toMatchObject({
			out: 'Tracking "*.bin"\n',
		});
		expect(JSON.parse((await author.git(["lfs", "track", "--json"])).out)).toEqual({
			patterns: [
				{ pattern: "*.bin", source: ".gitattributes", lockable: false, tracked: true },
			],
		});
		expect(await author.git(["check-attr", "filter", "asset.bin"])).toMatchObject({
			out: "asset.bin: filter: lfs\n",
		});
		author.write("/work/repo/asset.bin", content);
		await author.git(["add", "-A"]);
		// The index holds a pointer; the worktree keeps the content and is clean.
		const blob = await author.git(["show", ":asset.bin"]);
		expect(blob.out).toBe(
			`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 4096\n`,
		);
		await author.git(["commit", "-m", "asset"]);
		expect((await author.git(["status", "--porcelain=2", "-z"])).out).toBe("");
		await author.git(["remote", "add", "origin", url]);
		const pushed = await author.git(["push", "--set-upstream", "--", "origin", "main"]);
		expect(pushed).toMatchObject({
			code: 0,
			err: expect.stringContaining("Uploading LFS objects: 100% (1/1)"),
		});
		expect(origin.lfsObjects.get(oid)?.equals(content)).toBe(true);

		const reader = guest();
		await identity(reader.git);
		await reader.git(["lfs", "install", "--skip-repo"], "/work");
		const before = origin.hits.length;
		expect(await reader.git(["clone", "--", url, "/work/repo"], "/work")).toMatchObject({
			code: 0,
		});
		expect(
			Buffer.from(reader.vfs.fs.readFileSync("/work/repo/asset.bin") as Uint8Array).equals(
				content,
			),
		).toBe(true);
		expect(
			origin.hits
				.slice(before)
				.map((h) => `${h.method} ${h.path.replace(/[0-9a-f]{64}/, "<oid>")}`),
		).toEqual([
			"GET /assets.git/info/refs?service=git-upload-pack",
			"POST /assets.git/git-upload-pack",
			"POST /assets.git/info/lfs/objects/batch",
			"GET /lfs/<oid>",
		]);
		expect((await reader.git(["status", "--porcelain=2", "-z"])).out).toBe("");

		// Without the filter configured, a checkout keeps the pointer file.
		const plain = guest();
		await identity(plain.git);
		await plain.git(["clone", "--", url, "/work/repo"], "/work");
		expect(String(plain.vfs.fs.readFileSync("/work/repo/asset.bin", "utf8"))).toContain(
			`oid sha256:${oid}`,
		);
		expect(await plain.git(["lfs", "uninstall"], "/work")).toMatchObject({ code: 0 });
	});

	it("deletes remote branches and pushes annotated tags with --follow-tags", async () => {
		const url = origin.url("tags");
		const { git, write } = guest();
		await identity(git);
		await git(["init", "-b", "main", "repo"], "/work");
		write("/work/repo/a", "a\n");
		await git(["add", "-A"]);
		await git(["commit", "-m", "a"]);
		await git(["remote", "add", "origin", url]);
		await git(["push", "-u", "origin", "main"]);
		await git(["branch", "gone"]);
		await git(["push", "origin", "gone"]);
		expect(await git(["tag", "-a", "-m", "", "v1", "HEAD"])).toMatchObject({ code: 0 });
		expect(
			await git([
				"push",
				"--follow-tags",
				"--dry-run",
				"--no-verify",
				"--porcelain",
				"--",
				"origin",
				"main",
			]),
		).toMatchObject({
			out: expect.stringContaining("refs/tags/v1:refs/tags/v1\t[new tag]"),
		});
		expect(await git(["push", "--follow-tags", "--", "origin", "main"])).toMatchObject({
			code: 0,
		});
		expect(await git(["push", "--", "origin", ":gone"])).toMatchObject({ code: 0 });
		const remote = await git(["ls-remote", "--refs", "origin"]);
		expect(
			remote.out
				.split("\n")
				.filter(Boolean)
				.map((l) => l.split("\t")[1]),
		).toEqual(["refs/heads/main", "refs/tags/v1"]);
		expect(remote.out).not.toContain(ZERO);
	});
});
