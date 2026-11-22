import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import path from "path-browserify";
import { compare } from "./git-diff";
import { download, LfsFilter, type Pointer, parsePointer, treeAttributes } from "./git-lfs";
import {
	commitTree,
	deleteLocalSection,
	EMPTY_TREE,
	editIndex,
	fail,
	findMergeBase,
	formatIdent,
	type GitContext,
	GitFailure,
	headRef,
	type IndexEntry,
	identity,
	inPathspec,
	isValidRefName,
	logRef,
	lstat,
	MAX_BLOB,
	modeOf,
	type Repo,
	read,
	readBlob,
	readCommit,
	readIndex,
	readObjectType,
	repoPath,
	resolveCommit,
	resolveRevision,
	setLocalConfig,
	type TreeEntry,
	tryResolve,
	unsupported,
	updateRef,
	upstreamOf,
	writeTreeFromEntries,
	ZERO_OID,
} from "./git-repo";
import { commitSnapshot, untrackedFiles, worktreeSnapshot } from "./git-snapshot";

const out = (repo: Repo, text: string) => repo.ctx.io.stdout(text);

/** Read NUL- or newline-separated paths from standard input. */
async function stdinPaths(repo: Repo, z: boolean): Promise<string[]> {
	const text = Buffer.from(await repo.ctx.io.stdin()).toString("utf8");
	return text.split(z ? "\0" : /\r?\n/).filter(Boolean);
}

// ---------------------------------------------------------------- ahead/behind

/** Count commits only reachable from `a` and only from `b` (git rev-list
 * --left-right --count a...b) with a date-ordered two-color walk. */
export async function aheadBehind(repo: Repo, a: string, b: string): Promise<[number, number]> {
	if (a === b) return [0, 0];
	const flags = new Map<string, number>();
	const commits = new Map<string, git.CommitObject>();
	const queue: string[] = [];
	const time = (oid: string) => commits.get(oid)?.committer.timestamp ?? 0;
	const add = async (oid: string, flag: number) => {
		const prior = flags.get(oid) || 0;
		if ((prior | flag) === prior) return;
		flags.set(oid, prior | flag);
		if (!commits.has(oid)) commits.set(oid, (await readCommit(repo, oid)).commit);
		if (!queue.includes(oid)) queue.push(oid);
	};
	await add(a, 1);
	await add(b, 2);
	let walked = 0;
	while (queue.some((oid) => flags.get(oid) !== 3)) {
		repo.ctx.io.signal.throwIfAborted();
		if (++walked > 200_000) fail("history exceeds the commit walk limit");
		queue.sort((p, q) => time(p) - time(q));
		const oid = queue.pop() as string;
		const flag = flags.get(oid) || 0;
		for (const parent of commits.get(oid)?.parent || []) await add(parent, flag);
	}
	let ahead = 0,
		behind = 0;
	for (const flag of flags.values()) {
		if (flag === 1) ahead++;
		else if (flag === 2) behind++;
	}
	return [ahead, behind];
}

// ---------------------------------------------------------------- status

export async function status(repo: Repo, args: string[]): Promise<number> {
	type Untracked = "all" | "normal" | "no";
	let porcelain: "v1" | "v2" | undefined,
		z = false,
		branch = false,
		untracked: Untracked = "normal" as Untracked,
		showIgnored = false;
	for (const arg of args) {
		if (arg === "--porcelain=2" || arg === "--porcelain=v2") porcelain = "v2";
		else if (
			arg === "--porcelain" ||
			arg === "--porcelain=v1" ||
			arg === "--short" ||
			arg === "-s"
		)
			porcelain = "v1";
		else if (arg === "-z") z = true;
		else if (arg === "--branch" || arg === "-b") branch = true;
		else if (/^(--untracked-files|-u)=?(all|normal|no)$/.test(arg))
			untracked = arg.replace(/^(--untracked-files|-u)=?/, "") as Untracked;
		else if (arg === "-u" || arg === "--untracked-files") untracked = "all";
		else if (arg === "--ignored") showIgnored = true;
		else if (
			arg === "--no-renames" ||
			arg === "--ignore-submodules" ||
			arg === "--no-ahead-behind"
		) {
			/* No rename detection in status; submodules are reported as gitlinks. */
		} else unsupported("status");
	}
	if (!porcelain) z = false;
	const eol = z ? "\0" : "\n";
	const lines: string[] = [];
	const head = await tryResolve(repo, "HEAD");
	const current = (await headRef(repo))?.replace(/^refs\/heads\//, "");
	if (branch && porcelain === "v2") {
		lines.push(
			`# branch.oid ${head ?? "(initial)"}`,
			`# branch.head ${current ?? "(detached)"}`,
		);
		const up = current ? await upstreamOf(repo, current) : undefined;
		if (up) {
			lines.push(`# branch.upstream ${up.ref.replace(/^refs\/(heads|remotes)\//, "")}`);
			const target = await tryResolve(repo, up.ref);
			if (target && head) {
				const [ahead, behind] = await aheadBehind(repo, head, target);
				lines.push(`# branch.ab +${ahead} -${behind}`);
			}
		}
	} else if (branch && porcelain === "v1") {
		lines.push(`## ${current ?? "HEAD (no branch)"}`);
	}
	const index = await readIndex(repo);
	const headTree = await commitTree(repo, head);
	const worktree = await worktreeSnapshot(repo, index);
	const staged = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
	const conflicts = new Map<string, IndexEntry[]>();
	for (const entry of index)
		if (entry.stage) conflicts.set(entry.path, [...(conflicts.get(entry.path) || []), entry]);
	const paths = [...new Set([...headTree.keys(), ...staged.keys(), ...conflicts.keys()])].sort();
	for (const file of paths) {
		repo.ctx.io.signal.throwIfAborted();
		const w = worktree.snapshot.get(file);
		const stages = conflicts.get(file);
		if (stages) {
			const at = (n: number) => stages.find((e) => e.stage === n);
			const [s1, s2, s3] = [at(1), at(2), at(3)];
			const xy = !s1
				? s2 && s3
					? "AA"
					: s2
						? "AU"
						: "UA"
				: !s2
					? s3
						? "DU"
						: "DD"
					: !s3
						? "UD"
						: "UU";
			if (porcelain === "v2")
				lines.push(
					`u ${xy} N... ${s1?.mode ?? "000000"} ${s2?.mode ?? "000000"} ${s3?.mode ?? "000000"} ${w?.mode ?? "000000"} ${s1?.oid ?? ZERO_OID} ${s2?.oid ?? ZERO_OID} ${s3?.oid ?? ZERO_OID} ${file}`,
				);
			else lines.push(`${xy} ${file}`);
			continue;
		}
		const h = headTree.get(file),
			i = staged.get(file);
		const x =
			!h && i
				? "A"
				: h && !i
					? "D"
					: h && i && (h.oid !== i.oid || h.mode !== i.mode)
						? (h.mode === "120000") !== (i.mode === "120000")
							? "T"
							: "M"
						: ".";
		const y = !i ? "." : !w ? "D" : w.mode !== i.mode || (await w.oid()) !== i.oid ? "M" : ".";
		if (x === "." && y === ".") continue;
		const sub =
			i?.mode === "160000" || h?.mode === "160000"
				? `S${x === "." ? "." : "C"}${y === "M" ? "M" : "."}.`
				: "N...";
		if (porcelain === "v2")
			lines.push(
				`1 ${x}${y} ${sub} ${h?.mode ?? "000000"} ${i?.mode ?? "000000"} ${w?.mode ?? "000000"} ${h?.oid ?? ZERO_OID} ${i?.oid ?? ZERO_OID} ${file}`,
			);
		else lines.push(`${x.replace(".", " ")}${y.replace(".", " ")} ${file}`);
	}
	if (untracked !== "no") {
		const ignored: string[] = [];
		const files = await untrackedFiles(repo, new Set(index.map((e) => e.path)), {
			collapse: untracked === "normal",
			ignored: showIgnored ? ignored : undefined,
		});
		for (const file of files) lines.push(porcelain === "v2" ? `? ${file}` : `?? ${file}`);
		for (const file of ignored) lines.push(porcelain === "v2" ? `! ${file}` : `!! ${file}`);
	}
	if (!porcelain) {
		// Human output is not parsed by tools; keep it minimal and truthful.
		out(repo, `On branch ${current ?? "HEAD (detached)"}\n`);
		const changes = lines.filter((l) => !l.startsWith("#"));
		out(
			repo,
			changes.length ? `${changes.join("\n")}\n` : "nothing to commit, working tree clean\n",
		);
		return 0;
	}
	out(repo, lines.map((l) => l + eol).join(""));
	return 0;
}

// ---------------------------------------------------------------- index updates

async function stageFile(
	repo: Repo,
	filter: LfsFilter,
	file: string,
): Promise<{ oid: string; mode: string; stats: { mtimeMs: number; size: number } } | undefined> {
	const absolute = path.join(repo.dir, file);
	const stat = lstat(repo, absolute);
	if (!stat) return;
	if (stat.isDirectory()) {
		if (repo.fs.existsSync(path.join(absolute, ".git"))) {
			const oid = await tryResolve({ ...repo, gitdir: path.join(absolute, ".git") }, "HEAD");
			if (!oid) fail(`'${file}' does not have a commit checked out`);
			return { oid: oid as string, mode: "160000", stats: { mtimeMs: 0, size: 0 } };
		}
		return;
	}
	if (Number(stat.size) > MAX_BLOB) fail(`${file} exceeds the blob size limit`);
	const data = stat.isSymbolicLink()
		? new Uint8Array(Buffer.from(String(repo.fs.readlinkSync(absolute))))
		: new Uint8Array(repo.fs.readFileSync(absolute) as Uint8Array);
	const blob = await filter.clean(file, data, true);
	const oid = await git.writeBlob({ fs: repo.fs, gitdir: repo.gitdir, blob });
	return {
		oid,
		mode: modeOf(stat),
		stats: { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) },
	};
}

/** git update-index [--add] [--remove] [--force-remove] [--replace] [-z] --stdin | <paths> */
export async function updateIndex(repo: Repo, cwd: string, args: string[]): Promise<number> {
	let add = false,
		remove = false,
		forceRemove = false,
		z = false,
		stdin = false,
		refresh = false;
	const files: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--add") add = true;
		else if (arg === "--remove") remove = true;
		else if (arg === "--force-remove") forceRemove = true;
		else if (arg === "--replace") {
			/* Paths never conflict with directories in this index writer. */
		} else if (arg === "-z") z = true;
		else if (arg === "--stdin") stdin = true;
		else if (arg === "--refresh" || arg === "-q" || arg === "--really-refresh") refresh = true;
		else if (arg === "--") files.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("update-index");
		else files.push(arg);
	}
	if (stdin) files.push(...(await stdinPaths(repo, z)));
	const filter = await LfsFilter.load(repo);
	const index = await readIndex(repo);
	const tracked = new Set(index.map((e) => e.path));
	const updates: [string, Awaited<ReturnType<typeof stageFile>>][] = [];
	for (const name of files) {
		const file = repoPath(repo, cwd, name);
		if (forceRemove) {
			updates.push([file, undefined]);
			continue;
		}
		const staged = await stageFile(repo, filter, file);
		if (!staged) {
			if (!remove && tracked.has(file))
				fail(
					`error: ${file}: does not exist and --remove not passed\nfatal: Unable to process path ${file}`,
				);
			if (tracked.has(file)) updates.push([file, undefined]);
			continue;
		}
		if (!tracked.has(file) && !add)
			fail(
				`error: ${file}: cannot add to the index - missing --add option?\nfatal: Unable to process path ${file}`,
			);
		updates.push([file, staged]);
	}
	if (refresh && !files.length) return 0;
	await editIndex(repo, async (writer) => {
		for (const [file, staged] of updates) {
			if (!staged) writer.remove(file);
			else writer.insert(file, staged.oid, staged.mode, staged.stats);
		}
	});
	return 0;
}

/** git add [-A|--all|-u] [--] <pathspec>... */
export async function add(repo: Repo, cwd: string, args: string[]): Promise<number> {
	let update = false,
		all = false;
	const specs: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--") specs.push(...args.splice(0));
		else if (arg === "-A" || arg === "--all") all = true;
		else if (arg === "-u" || arg === "--update") update = true;
		else if (arg === "-f" || arg === "--force") unsupported("add --force");
		else if (arg.startsWith("-")) unsupported("add");
		else specs.push(arg);
	}
	// Without a pathspec, -A and -u operate on the whole tree (git 2.x).
	if (!specs.length) specs.push(update || all ? repo.dir : "");
	if (specs.includes("")) {
		out(repo, "Nothing specified, nothing added.\n");
		return 0;
	}
	const paths = specs.map((s) => repoPath(repo, cwd, s));
	const index = await readIndex(repo);
	const tracked = new Set(index.map((e) => e.path));
	const candidates = new Set([...tracked].filter((f) => inPathspec(f, paths)));
	if (!update)
		for (const file of await untrackedFiles(repo, tracked))
			if (inPathspec(file, paths)) candidates.add(file);
	for (const spec of paths)
		if (
			spec !== "." &&
			![...candidates].some((f) => inPathspec(f, [spec])) &&
			!repo.fs.existsSync(path.join(repo.dir, spec))
		)
			fail(`pathspec '${spec}' did not match any files`);
	const filter = await LfsFilter.load(repo);
	const worktree = await worktreeSnapshot(repo, index);
	const staged = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
	const updates: [string, Awaited<ReturnType<typeof stageFile>>][] = [];
	for (const file of [...candidates].sort()) {
		const entry = staged.get(file);
		const w = worktree.snapshot.get(file);
		if (
			entry &&
			w &&
			w.known === entry.oid &&
			w.mode === entry.mode &&
			!index.some((e) => e.path === file && e.stage)
		)
			continue;
		updates.push([file, await stageFile(repo, filter, file)]);
	}
	await editIndex(repo, async (writer) => {
		for (const [file, entry] of updates) {
			if (!entry) writer.remove(file);
			else writer.insert(file, entry.oid, entry.mode, entry.stats);
		}
	});
	return 0;
}

/** git rm [--cached] [-r] [-f] [-q] [--] <paths> */
export async function rm(repo: Repo, cwd: string, args: string[]): Promise<number> {
	let cached = false,
		ignoreUnmatch = false;
	const specs: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--") specs.push(...args.splice(0));
		else if (arg === "--cached") cached = true;
		else if (arg === "--ignore-unmatch") ignoreUnmatch = true;
		else if (["-r", "-f", "--force", "-q", "--quiet"].includes(arg)) {
			/* Recursive removal of matched index paths. */
		} else if (arg.startsWith("-")) unsupported("rm");
		else specs.push(arg);
	}
	const paths = specs.map((s) => repoPath(repo, cwd, s));
	const index = await readIndex(repo);
	const matched = [...new Set(index.map((e) => e.path))].filter((f) => inPathspec(f, paths));
	if (!matched.length && !ignoreUnmatch)
		fail(`pathspec '${specs[0] ?? ""}' did not match any files`);
	await editIndex(repo, async (writer) => {
		for (const file of matched) writer.remove(file);
	});
	if (!cached)
		for (const file of matched) {
			try {
				repo.fs.rmSync(path.join(repo.dir, file), { force: true });
			} catch {
				/* Already gone. */
			}
			removeEmptyParents(repo, file);
		}
	for (const file of matched) out(repo, `rm '${file}'\n`);
	return 0;
}

function removeEmptyParents(repo: Repo, file: string) {
	for (let dir = path.dirname(file); dir !== "."; dir = path.dirname(dir)) {
		const absolute = path.join(repo.dir, dir);
		try {
			if ((repo.fs.readdirSync(absolute) as string[]).length) return;
			repo.fs.rmdirSync(absolute);
		} catch {
			return;
		}
	}
}

// ---------------------------------------------------------------- worktree writes

export interface Target {
	oid: string;
	mode: string;
}

/** Fetch LFS content for target blobs before files are written. */
async function prepareLfs(repo: Repo, targets: Map<string, Target>, all: Map<string, TreeEntry>) {
	const filter = await LfsFilter.load(repo);
	if (!filter.enabled || repo.ctx.env.GIT_LFS_SKIP_SMUDGE === "1")
		return new Map<string, Pointer>();
	const attributes = await treeAttributes(repo, all);
	const pointers = new Map<string, Pointer>();
	for (const [file, target] of targets) {
		if (target.mode === "160000" || attributes.get(file).get("filter") !== "lfs") continue;
		const pointer = parsePointer(await readBlob(repo, target.oid));
		if (pointer) pointers.set(file, pointer);
	}
	if (pointers.size) await download(repo, [...pointers.values()]);
	return pointers;
}

/** Write blobs to the worktree and return their new stat data. */
export async function writeFiles(
	repo: Repo,
	targets: Map<string, Target | undefined>,
	all: Map<string, TreeEntry>,
) {
	const present = new Map([...targets].filter((t): t is [string, Target] => !!t[1]));
	const pointers = await prepareLfs(repo, present, all);
	const stats = new Map<string, { mtimeMs: number; size: number }>();
	for (const [file, target] of targets) {
		repo.ctx.io.signal.throwIfAborted();
		const absolute = path.join(repo.dir, file);
		if (!target) {
			try {
				repo.fs.rmSync(absolute, { force: true, recursive: false });
			} catch {
				/* Already gone. */
			}
			removeEmptyParents(repo, file);
			continue;
		}
		repo.fs.mkdirSync(path.dirname(absolute), { recursive: true });
		try {
			const stat = repo.fs.lstatSync(absolute);
			if (stat.isDirectory() && target.mode !== "160000")
				fail(`cannot write '${file}': a directory is in the way`);
			if (!stat.isDirectory()) repo.fs.rmSync(absolute, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (target.mode === "160000") {
			repo.fs.mkdirSync(absolute, { recursive: true });
			continue;
		}
		const pointer = pointers.get(file);
		const data = pointer
			? (repo.fs.readFileSync(
					path.join(
						repo.gitdir,
						"lfs/objects",
						pointer.oid.slice(0, 2),
						pointer.oid.slice(2, 4),
						pointer.oid,
					),
				) as Uint8Array)
			: await readBlob(repo, target.oid);
		if (target.mode === "120000")
			repo.fs.symlinkSync(Buffer.from(data).toString("utf8"), absolute);
		else
			repo.fs.writeFileSync(absolute, data, {
				mode: target.mode === "100755" ? 0o755 : 0o644,
			});
		const stat = repo.fs.lstatSync(absolute);
		stats.set(file, { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) });
	}
	return stats;
}

/** Two-tree switch like `git read-tree -m -u`: carry local changes to paths
 * that are equal in both trees, refuse to overwrite anything else. */
export async function switchTrees(
	repo: Repo,
	fromCommit: string | undefined,
	toCommit: string,
	options: { force?: boolean; hard?: boolean } = {},
): Promise<void> {
	const from = await commitTree(repo, fromCommit);
	const to = await commitTree(repo, toCommit);
	const index = await readIndex(repo);
	const staged = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
	const unmerged = new Set(index.filter((e) => e.stage).map((e) => e.path));
	const worktree = await worktreeSnapshot(repo, index);
	const updates = new Map<string, Target | undefined>();
	const dirty: string[] = [];
	const untrackedConflicts: string[] = [];
	const paths = new Set([...from.keys(), ...to.keys(), ...staged.keys(), ...unmerged]);
	for (const file of [...paths].sort()) {
		const f = from.get(file),
			t = to.get(file),
			i = staged.get(file);
		const same = (x?: TreeEntry, y?: { oid: string; mode: string }) =>
			x?.oid === y?.oid && x?.mode === y?.mode;
		if (options.hard) {
			if (!t && !i && !unmerged.has(file)) continue;
			updates.set(file, t);
			continue;
		}
		if (same(f, t) && !unmerged.has(file)) continue;
		if (!options.force) {
			const w = worktree.snapshot.get(file);
			const worktreeClean = i
				? !!w && w.mode === i.mode && (await w.oid()) === i.oid
				: !repo.fs.existsSync(path.join(repo.dir, file));
			if (unmerged.has(file)) fail("you need to resolve your current index first");
			if (!i && f) {
				// Deleted in the index; fine only if the target also lacks it.
				if (t) dirty.push(file);
				continue;
			}
			if (i && !same(f, i)) {
				// A staged change: only allowed if it already equals the target.
				if (!same(t, i)) dirty.push(file);
				continue;
			}
			if (i && !worktreeClean) {
				dirty.push(file);
				continue;
			}
			if (!i && !f && t && repo.fs.existsSync(path.join(repo.dir, file))) {
				const data = repo.fs.readFileSync(path.join(repo.dir, file)) as Uint8Array;
				if ((await git.hashBlob({ object: data })).oid !== t.oid)
					untrackedConflicts.push(file);
			}
		}
		updates.set(file, t);
	}
	if (dirty.length)
		throw new GitFailure(
			`error: Your local changes to the following files would be overwritten by checkout:\n${dirty.map((f) => `\t${f}\n`).join("")}Please commit your changes or stash them before you switch branches.\nAborting`,
			1,
			true,
		);
	if (untrackedConflicts.length)
		throw new GitFailure(
			`error: The following untracked working tree files would be overwritten by checkout:\n${untrackedConflicts.map((f) => `\t${f}\n`).join("")}Please move or remove them before you switch branches.\nAborting`,
			1,
			true,
		);
	const stats = await writeFiles(repo, updates, to);
	await editIndex(repo, async (writer) => {
		if (options.hard || options.force) {
			for (const file of unmerged) writer.remove(file);
		}
		for (const [file, target] of updates) {
			if (!target) writer.remove(file);
			else writer.insert(file, target.oid, target.mode, stats.get(file));
		}
	});
}

/** Point the index at a tree without touching the worktree (mixed reset). */
async function resetIndex(repo: Repo, tree: Map<string, TreeEntry>, paths?: string[]) {
	const index = await readIndex(repo);
	const staged = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
	const conflicted = new Set(index.filter((e) => e.stage).map((e) => e.path));
	const files = new Set([...tree.keys(), ...staged.keys(), ...conflicted]);
	await editIndex(repo, async (writer) => {
		for (const file of files) {
			if (paths && !inPathspec(file, paths)) continue;
			const t = tree.get(file),
				i = staged.get(file);
			if (!conflicted.has(file) && t?.oid === i?.oid && t?.mode === i?.mode) continue;
			if (conflicted.has(file)) writer.remove(file);
			if (!t) {
				writer.remove(file);
				continue;
			}
			// Keep stat data when the worktree file already has this content so
			// status need not re-hash it.
			let stats: { mtimeMs: number; size: number } | undefined;
			try {
				const absolute = path.join(repo.dir, file);
				const stat = repo.fs.lstatSync(absolute);
				if (stat.isFile() && Number(stat.size) <= MAX_BLOB) {
					const data = repo.fs.readFileSync(absolute) as Uint8Array;
					const filter = await LfsFilter.load(repo);
					const blob = await filter.clean(file, new Uint8Array(data), false);
					if ((await git.hashBlob({ object: blob })).oid === t.oid)
						stats = { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) };
				}
			} catch {
				/* Missing in the worktree. */
			}
			writer.insert(file, t.oid, t.mode, stats);
		}
	});
}

// ---------------------------------------------------------------- reset

export async function reset(repo: Repo, cwd: string, args: string[]): Promise<number> {
	type Mode = "mixed" | "hard" | "soft";
	let mode: Mode = "mixed" as Mode,
		stdin = false,
		z = false,
		quiet = false;
	const revs: string[] = [];
	const specs: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--hard" || arg === "--soft" || arg === "--mixed") mode = arg.slice(2) as Mode;
		else if (arg === "--stdin") stdin = true;
		else if (arg === "-z") z = true;
		else if (arg === "-q" || arg === "--quiet") quiet = true;
		else if (arg === "--") specs.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("reset");
		else revs.push(arg);
	}
	if (stdin) specs.push(...(await stdinPaths(repo, z)));
	// `git reset <paths>` without `--`: a non-revision argument is a path.
	if (
		revs.length > 1 ||
		(revs.length === 1 &&
			!specs.length &&
			!(await resolveCommit(repo, revs[0] as string)) &&
			repo.fs.existsSync(path.join(cwd, revs[0] as string)))
	)
		specs.push(...revs.splice(revs.length === 1 ? 0 : 1));
	const head = await tryResolve(repo, "HEAD");
	const rev = revs[0] ?? "HEAD";
	const target = head || rev !== "HEAD" ? await resolveCommit(repo, rev) : undefined;
	if (rev !== "HEAD" && !target)
		fail(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
	if (head && !target) fail(`Failed to resolve '${rev}' as a valid ref.`);
	const tree = await commitTree(repo, target);
	if (specs.length) {
		if (mode !== "mixed") fail(`Cannot do ${mode} reset with paths.`);
		await resetIndex(
			repo,
			tree,
			specs.map((s) => repoPath(repo, cwd, s)),
		);
		return 0;
	}
	if (!target) {
		// Unborn branch: reset just clears the index.
		await resetIndex(repo, tree);
		return 0;
	}
	if (mode === "hard") await switchTrees(repo, head, target, { hard: true });
	else if (mode === "mixed") await resetIndex(repo, tree);
	const branch = await headRef(repo);
	await updateRef(repo, branch ?? "HEAD", target, `reset: moving to ${rev}`);
	for (const file of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
		repo.fs.rmSync(path.join(repo.gitdir, file), { force: true });
	if (mode === "hard" && !quiet) {
		const { commit } = await readCommit(repo, target);
		out(repo, `HEAD is now at ${target.slice(0, 7)} ${commit.message.split("\n")[0]}\n`);
	}
	return 0;
}

// ---------------------------------------------------------------- checkout

async function setHead(repo: Repo, value: string, from: string, to: string) {
	const before = await tryResolve(repo, "HEAD");
	if (value.startsWith("refs/"))
		repo.fs.writeFileSync(path.join(repo.gitdir, "HEAD"), `ref: ${value}\n`);
	else repo.fs.writeFileSync(path.join(repo.gitdir, "HEAD"), `${value}\n`);
	const after = (await tryResolve(repo, "HEAD")) ?? ZERO_OID;
	await logRef(repo, "HEAD", before, after, `checkout: moving from ${from} to ${to}`);
}

async function currentName(repo: Repo) {
	const ref = await headRef(repo);
	return ref ? ref.replace(/^refs\/heads\//, "") : ((await tryResolve(repo, "HEAD")) ?? "HEAD");
}

export async function createBranch(
	repo: Repo,
	name: string,
	start: string,
	options: { track?: boolean; force?: boolean } = {},
): Promise<string> {
	if (!isValidRefName(`refs/heads/${name}`) || name === "HEAD")
		fail(`'${name}' is not a valid branch name`);
	const exists = await tryResolve(repo, `refs/heads/${name}`);
	if (exists && !options.force) fail(`a branch named '${name}' already exists`);
	const oid = await resolveCommit(repo, start);
	if (!oid) fail(`not a valid object name: '${start}'`);
	await updateRef(repo, `refs/heads/${name}`, oid as string, `branch: Created from ${start}`);
	// branch.autoSetupMerge: track when starting from a remote-tracking branch.
	const remoteRef = start.startsWith("refs/remotes/")
		? start
		: (await tryResolve(repo, `refs/remotes/${start}`))
			? `refs/remotes/${start}`
			: undefined;
	if (options.track !== false && remoteRef) {
		const rest = remoteRef.slice("refs/remotes/".length);
		const remote = rest.split("/")[0] as string;
		const branch = rest.slice(remote.length + 1);
		if (branch && branch !== "HEAD") {
			await setLocalConfig(repo, `branch.${name}.remote`, remote);
			await setLocalConfig(repo, `branch.${name}.merge`, `refs/heads/${branch}`);
			out(repo, `branch '${name}' set up to track '${remote}/${branch}'.\n`);
		}
	}
	return oid as string;
}

export async function checkout(repo: Repo, cwd: string, args: string[]): Promise<number> {
	let create: string | undefined,
		force = false,
		detach = false,
		track: boolean | undefined;
	const positional: string[] = [];
	let specs: string[] | undefined;
	let stage: "ours" | "theirs" | undefined;
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--") {
			specs = args.splice(0);
			break;
		}
		if (arg === "-b" || arg === "-B") {
			create = args.shift() ?? unsupported("checkout");
			force = force || arg === "-B";
		} else if (
			arg === "--progress" ||
			arg === "-q" ||
			arg === "--quiet" ||
			arg === "--no-progress"
		) {
			/* Progress is not reported. */
		} else if (arg === "-f" || arg === "--force") force = true;
		else if (arg === "--detach") detach = true;
		else if (arg === "--ours" || arg === "--theirs") stage = arg.slice(2) as typeof stage;
		else if (arg === "--track" || arg === "-t") track = true;
		else if (arg === "--no-track") track = false;
		else if (arg.startsWith("-")) unsupported("checkout");
		else positional.push(arg);
	}
	if (specs?.length || stage) {
		// Restore paths from the index (or a tree-ish into index and worktree).
		if (create || positional.length > 1) unsupported("checkout");
		const files = (specs || []).map((s) => repoPath(repo, cwd, s));
		const index = await readIndex(repo);
		let source: Map<string, Target>;
		if (stage) {
			const n = stage === "ours" ? 2 : 3;
			source = new Map(index.filter((e) => e.stage === n).map((e) => [e.path, e]));
		} else if (positional[0]) {
			const oid = await resolveCommit(repo, positional[0]);
			if (!oid) fail(`invalid reference: ${positional[0]}`);
			source = await commitTree(repo, oid);
		} else source = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
		const matched = new Map([...source].filter(([file]) => inPathspec(file, files)));
		for (const spec of files)
			if (![...matched.keys()].some((f) => inPathspec(f, [spec])))
				fail(`pathspec '${spec}' did not match any file(s) known to git`);
		const all = positional[0]
			? (source as Map<string, TreeEntry>)
			: await commitTree(repo, await tryResolve(repo, "HEAD"));
		const stats = await writeFiles(repo, matched, all);
		// --ours/--theirs only writes the worktree; the path stays unmerged.
		if (!stage)
			await editIndex(repo, async (writer) => {
				for (const [file, target] of matched)
					writer.insert(file, target.oid, target.mode, stats.get(file));
			});
		return 0;
	}
	if (positional.length > (create ? 1 : 1)) unsupported("checkout");
	const head = await tryResolve(repo, "HEAD");
	const from = await currentName(repo);
	if (create) {
		const start = positional[0] ?? "HEAD";
		const target = await resolveCommit(repo, start);
		if (!target)
			fail(`'${start}' is not a commit and a branch '${create}' cannot be created from it`);
		await switchTrees(repo, head, target as string, { force });
		await createBranch(repo, create, start, { track, force });
		await setHead(repo, `refs/heads/${create}`, from, create);
		repo.ctx.io.stderr(`Switched to a new branch '${create}'\n`);
		return 0;
	}
	const name = positional[0];
	if (!name) unsupported("checkout");
	// `git checkout HEAD` keeps the current branch (attached) and only checks
	// that local changes survive; it never detaches.
	if ((name === "HEAD" || name === "@") && !detach) {
		if (head) await switchTrees(repo, head, head, { force });
		return 0;
	}
	const local = !detach && (await tryResolve(repo, `refs/heads/${name}`));
	if (local) {
		await switchTrees(repo, head, local, { force });
		await setHead(repo, `refs/heads/${name}`, from, name as string);
		repo.ctx.io.stderr(`Switched to branch '${name}'\n`);
		return 0;
	}
	// `git checkout <name>` with a unique remote-tracking branch creates it.
	if (!detach) {
		const remotes = await git.listRemotes({ fs: repo.fs, gitdir: repo.gitdir });
		const matches = [];
		for (const { remote } of remotes)
			if (await tryResolve(repo, `refs/remotes/${remote}/${name}`)) matches.push(remote);
		if (matches.length === 1) {
			const start = `refs/remotes/${matches[0]}/${name}`;
			const target = (await tryResolve(repo, start)) as string;
			await switchTrees(repo, head, target, { force });
			await createBranch(repo, name as string, start, { track: true });
			await setHead(repo, `refs/heads/${name}`, from, name as string);
			repo.ctx.io.stderr(`Switched to a new branch '${name}'\n`);
			return 0;
		}
	}
	const commit = await resolveCommit(repo, name as string);
	if (!commit) fail(`pathspec '${name}' did not match any file(s) known to git`);
	await switchTrees(repo, head, commit as string, { force });
	await setHead(repo, commit as string, from, name as string);
	repo.ctx.io.stderr(`HEAD is now at ${(commit as string).slice(0, 7)}\n`);
	return 0;
}

/** git checkout-index [-f] [-u] [-q] [-a] [--stdin] [-z] [--] <paths> */
export async function checkoutIndex(repo: Repo, cwd: string, args: string[]): Promise<number> {
	let stdin = false,
		z = false,
		all = false;
	const files: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (["-f", "--force", "-u", "--index", "-q", "--quiet"].includes(arg)) {
			/* Always overwrite and refresh stat data. */
		} else if (arg === "--stdin") stdin = true;
		else if (arg === "-z") z = true;
		else if (arg === "-a" || arg === "--all") all = true;
		else if (arg === "--") files.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("checkout-index");
		else files.push(arg);
	}
	if (stdin) files.push(...(await stdinPaths(repo, z)));
	const index = await readIndex(repo);
	const staged = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
	const wanted = all ? [...staged.keys()] : files.map((f) => repoPath(repo, cwd, f));
	const targets = new Map<string, Target>();
	for (const file of wanted) {
		const entry = staged.get(file);
		if (!entry) {
			repo.ctx.io.stderr(`git checkout-index: ${file} is not in the cache\n`);
			continue;
		}
		targets.set(file, entry);
	}
	const stats = await writeFiles(repo, targets, new Map(staged));
	await editIndex(repo, async (writer) => {
		for (const [file, target] of targets)
			writer.insert(file, target.oid, target.mode, stats.get(file));
	});
	return 0;
}

// ---------------------------------------------------------------- commit

function cleanupMessage(message: string, mode: string): string {
	let lines = message.replace(/\r\n/g, "\n").split("\n");
	if (mode === "verbatim") return message;
	if (mode === "strip") lines = lines.filter((l) => !l.startsWith("#"));
	if (mode === "scissors") {
		const cut = lines.findIndex((l) => /^# -+ >8 -+$/.test(l));
		if (cut >= 0) lines = lines.slice(0, cut);
	}
	lines = lines.map((l) => l.replace(/\s+$/, ""));
	const result: string[] = [];
	for (const line of lines) {
		if (!line && (!result.length || result.at(-1) === "")) continue;
		result.push(line);
	}
	while (result.at(-1) === "") result.pop();
	return result.length ? `${result.join("\n")}\n` : "";
}

export async function commit(repo: Repo, cwd: string, args: string[]): Promise<number> {
	let message: string | undefined,
		amend = false,
		allowEmpty = false,
		allowEmptyMessage = false,
		signoff = false,
		noEdit = false,
		all = false,
		quiet = false,
		cleanup: string | undefined;
	const messages: string[] = [];
	// Bundled short options: `-am msg` is `-a -m msg`.
	args = args.flatMap((a) =>
		/^-[asqn]+[mF]?$/.test(a) && a.length > 2 ? [...a.slice(1)].map((c) => `-${c}`) : [a],
	);
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "-F" || arg === "--file") {
			const file = args.shift() ?? unsupported("commit");
			message =
				file === "-"
					? Buffer.from(await repo.ctx.io.stdin()).toString("utf8")
					: String(
							repo.fs.readFileSync(
								path.resolve(cwd, repo.ctx.vfs.normalizePath(file)),
								"utf8",
							),
						);
		} else if (arg.startsWith("--file=")) {
			message = String(
				repo.fs.readFileSync(
					path.resolve(cwd, repo.ctx.vfs.normalizePath(arg.slice(7))),
					"utf8",
				),
			);
		} else if (arg === "-m" || arg === "--message")
			messages.push(args.shift() ?? unsupported("commit"));
		else if (arg.startsWith("--message=")) messages.push(arg.slice(10));
		else if (arg === "--amend") amend = true;
		else if (arg === "--allow-empty") allowEmpty = true;
		else if (arg === "--allow-empty-message") allowEmptyMessage = true;
		else if (arg === "--signoff" || arg === "-s") signoff = true;
		else if (arg === "--no-edit") noEdit = true;
		else if (arg === "-a" || arg === "--all") all = true;
		else if (arg === "-q" || arg === "--quiet") quiet = true;
		else if (arg.startsWith("--cleanup=")) cleanup = arg.slice(10);
		else if (
			["--no-verify", "-n", "--no-gpg-sign", "--no-status", "--no-post-rewrite"].includes(arg)
		) {
			/* Hooks and signing programs are never executed by this CLI. */
		} else unsupported("commit");
	}
	if (messages.length) message = messages.join("\n\n");
	if (all) await add(repo, cwd, ["-u"]);
	const head = await tryResolve(repo, "HEAD");
	const branch = await headRef(repo);
	const mergeHead = read(repo, "MERGE_HEAD")?.split("\n").filter(Boolean) ?? [];
	let original: git.CommitObject | undefined;
	if (amend) {
		if (!head) fail("You have nothing to amend.");
		original = (await readCommit(repo, head as string)).commit;
	}
	if (message === undefined && noEdit)
		message = amend ? original?.message : (read(repo, "MERGE_MSG") ?? read(repo, "SQUASH_MSG"));
	if (message === undefined)
		fail("no commit message given (interactive editing is not supported)");
	message = cleanupMessage(message as string, cleanup ?? (noEdit ? "strip" : "whitespace"));
	if (signoff) {
		const who = await identity(repo, repo.ctx, "committer");
		const trailer = `Signed-off-by: ${who.name} <${who.email}>`;
		if (!message.includes(trailer))
			message = `${message.trimEnd()}${/\n[\w-]+: [^\n]*$/.test(message.trimEnd()) ? "\n" : "\n\n"}${trailer}\n`;
	}
	if (!message.trim() && !allowEmptyMessage) {
		repo.ctx.io.stderr("Aborting commit due to empty commit message.\n");
		return 1;
	}
	const index = await readIndex(repo);
	if (index.some((e) => e.stage))
		fail(
			"error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.",
		);
	const tree = await writeTreeFromEntries(
		repo,
		index.map((e) => [e.path, { oid: e.oid, mode: e.mode }]),
	);
	const parents = amend
		? (original as git.CommitObject).parent
		: head
			? [head, ...mergeHead]
			: [];
	const parentTree = head ? (await readCommit(repo, head)).commit.tree : EMPTY_TREE;
	if (!amend && !allowEmpty && !mergeHead.length && tree === parentTree) {
		out(
			repo,
			`On branch ${branch?.replace(/^refs\/heads\//, "") ?? "HEAD"}\nnothing to commit, working tree clean\n`,
		);
		return 1;
	}
	const author = amend && original ? original.author : await identity(repo, repo.ctx, "author");
	const committer = await identity(repo, repo.ctx, "committer");
	const oid = await git.writeCommit({
		fs: repo.fs,
		gitdir: repo.gitdir,
		commit: { tree, parent: parents, author, committer, message },
	});
	const subject = message.split("\n")[0] || "";
	const kind = amend ? " (amend)" : !head ? " (initial)" : mergeHead.length ? " (merge)" : "";
	await updateRef(repo, branch ?? "HEAD", oid, `commit${kind}: ${subject}`);
	for (const file of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "SQUASH_MSG"])
		repo.fs.rmSync(path.join(repo.gitdir, file), { force: true });
	if (!quiet) {
		const before = await commitSnapshot(repo, amend ? parents[0] : head);
		const after = await commitSnapshot(repo, oid);
		const changes = await compare(before, after);
		const name = branch ? branch.replace(/^refs\/heads\//, "") : "detached HEAD";
		out(
			repo,
			`[${name}${head ? "" : " (root-commit)"} ${oid.slice(0, 7)}] ${subject}\n ${changes.length} file${changes.length === 1 ? "" : "s"} changed\n`,
		);
	}
	return 0;
}

/** git commit-tree <tree> [-p <parent>]... -m <message> */
export async function commitTreeCommand(repo: Repo, args: string[]): Promise<number> {
	const parents: string[] = [];
	const messages: string[] = [];
	let tree: string | undefined;
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "-p")
			parents.push((await resolveCommit(repo, args.shift() ?? "")) ?? fail("invalid parent"));
		else if (arg === "-m") messages.push(args.shift() ?? unsupported("commit-tree"));
		else if (arg === "--no-gpg-sign") {
			/* Never signs. */
		} else if (!arg.startsWith("-") && !tree) tree = arg;
		else unsupported("commit-tree");
	}
	const treeOid = tree && (await resolveRevision(repo, tree));
	if (!treeOid) fail(`not a valid object name ${tree}`);
	const message = messages.length
		? `${messages.join("\n\n")}\n`
		: Buffer.from(await repo.ctx.io.stdin()).toString("utf8");
	const oid = await git.writeCommit({
		fs: repo.fs,
		gitdir: repo.gitdir,
		commit: {
			tree: treeOid as string,
			parent: parents,
			author: await identity(repo, repo.ctx, "author"),
			committer: await identity(repo, repo.ctx, "committer"),
			message,
		},
	});
	out(repo, `${oid}\n`);
	return 0;
}

// ---------------------------------------------------------------- branch / tag

export async function branchCommand(
	repo: Repo,
	args: string[],
	listRefs: (repo: Repo, args: string[]) => Promise<string>,
): Promise<number> {
	const flags = args.filter((a) => a.startsWith("-") && a !== "--");
	const operands = args.filter((a) => !a.startsWith("-") || a === "--").filter((a) => a !== "--");
	if (args.length === 1 && args[0] === "--show-current") {
		const ref = await headRef(repo);
		if (ref) out(repo, `${ref.replace(/^refs\/heads\//, "")}\n`);
		return 0;
	}
	if (flags.some((f) => f === "-D" || f === "-d" || f === "--delete")) {
		const force = flags.includes("-D") || flags.includes("--force");
		for (const name of operands) {
			const ref = `refs/heads/${name}`;
			const oid = await tryResolve(repo, ref);
			if (!oid) fail(`branch '${name}' not found.`);
			if ((await headRef(repo)) === ref)
				fail(`cannot delete branch '${name}' used by worktree at '${repo.dir}'`);
			if (!force) {
				const head = await tryResolve(repo, "HEAD");
				if (
					head &&
					!(await git
						.isDescendent({
							fs: repo.fs,
							gitdir: repo.gitdir,
							oid: head,
							ancestor: oid as string,
							depth: -1,
							cache: repo.cache,
						})
						.catch(() => false)) &&
					head !== oid
				)
					fail(`The branch '${name}' is not fully merged.`);
			}
			await git.deleteRef({ fs: repo.fs, gitdir: repo.gitdir, ref });
			repo.fs.rmSync(path.join(repo.gitdir, "logs", ref), { force: true });
			await deleteLocalSection(repo, "branch", name).catch(() => {});
			out(repo, `Deleted branch ${name} (was ${(oid as string).slice(0, 7)}).\n`);
		}
		return 0;
	}
	if (flags.some((f) => f === "-m" || f === "-M" || f === "--move")) {
		const force = flags.includes("-M");
		const [oldName, newName] =
			operands.length === 1
				? [(await headRef(repo))?.replace(/^refs\/heads\//, ""), operands[0]]
				: operands;
		if (!oldName || !newName) unsupported("branch -m");
		const oldRef = `refs/heads/${oldName}`,
			newRef = `refs/heads/${newName}`;
		const oid = await tryResolve(repo, oldRef);
		if (!oid) fail(`branch '${oldName}' not found`);
		if (!isValidRefName(newRef)) fail(`'${newName}' is not a valid branch name`);
		if (oldRef !== newRef && (await tryResolve(repo, newRef)) && !force)
			fail(`a branch named '${newName}' already exists`);
		const isHead = (await headRef(repo)) === oldRef;
		await git.deleteRef({ fs: repo.fs, gitdir: repo.gitdir, ref: oldRef });
		await updateRef(repo, newRef, oid as string, `Branch: renamed ${oldRef} to ${newRef}`);
		if (isHead) repo.fs.writeFileSync(path.join(repo.gitdir, "HEAD"), `ref: ${newRef}\n`);
		const up = await upstreamOf(repo, oldName as string);
		await deleteLocalSection(repo, "branch", oldName as string).catch(() => {});
		if (up) {
			await setLocalConfig(repo, `branch.${newName}.remote`, up.remote);
			await setLocalConfig(repo, `branch.${newName}.merge`, up.merge);
		}
		return 0;
	}
	if (
		flags.some(
			(f) =>
				f.startsWith("--format") ||
				f === "--list" ||
				f === "-l" ||
				f === "-a" ||
				f === "-r" ||
				f.startsWith("--points-at") ||
				f.startsWith("--merged") ||
				f === "-v" ||
				f === "-vv",
		) ||
		(!operands.length && !flags.length)
	) {
		return listRefs(repo, args).then((text) => {
			out(repo, text);
			return 0;
		});
	}
	let track: boolean | undefined;
	let force = false;
	for (const flag of flags) {
		if (flag === "--no-track") track = false;
		else if (flag === "--track" || flag === "-t") track = true;
		else if (flag === "-f" || flag === "--force") force = true;
		else unsupported("branch");
	}
	const [name, start = "HEAD"] = operands;
	if (!name || operands.length > 2) unsupported("branch");
	if (force && (await headRef(repo)) === `refs/heads/${name}`)
		fail(`cannot force update the branch '${name}' used by worktree at '${repo.dir}'`);
	await createBranch(repo, name as string, start, { track, force });
	return 0;
}

export async function tagCommand(repo: Repo, args: string[]): Promise<number> {
	if (args[0] === "-d" || args[0] === "--delete") {
		for (const name of args.slice(1)) {
			const oid = await tryResolve(repo, `refs/tags/${name}`);
			if (!oid) fail(`tag '${name}' not found.`);
			await git.deleteRef({ fs: repo.fs, gitdir: repo.gitdir, ref: `refs/tags/${name}` });
			out(repo, `Deleted tag '${name}' (was ${(oid as string).slice(0, 7)})\n`);
		}
		return 0;
	}
	let annotated = false,
		message: string | undefined,
		force = false;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "-a" || arg === "--annotate") annotated = true;
		else if (arg === "-m") {
			message = args.shift() ?? unsupported("tag");
			annotated = true;
		} else if (arg === "-f" || arg === "--force") force = true;
		else if (arg === "--") operands.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("tag");
		else operands.push(arg);
	}
	if (!operands.length) {
		for (const tag of (await git.listTags({ fs: repo.fs, gitdir: repo.gitdir })).sort())
			out(repo, `${tag}\n`);
		return 0;
	}
	const [name, target = "HEAD"] = operands;
	if (!name || !isValidRefName(`refs/tags/${name}`)) fail(`'${name}' is not a valid tag name.`);
	if ((await tryResolve(repo, `refs/tags/${name}`)) && !force)
		fail(`tag '${name}' already exists`);
	const object = await resolveRevision(repo, target);
	if (!object) fail(`Failed to resolve '${target}' as a valid ref.`);
	if (!annotated) {
		await git.writeRef({
			fs: repo.fs,
			gitdir: repo.gitdir,
			ref: `refs/tags/${name}`,
			value: object as string,
			force: true,
		});
		return 0;
	}
	const tagger = await identity(repo, repo.ctx, "committer");
	const oid = await git.writeTag({
		fs: repo.fs,
		gitdir: repo.gitdir,
		tag: {
			object: object as string,
			type: (await readObjectType(repo, object as string)) as "commit",
			tag: name as string,
			tagger,
			message: cleanupMessage(message ?? "", "whitespace"),
		},
	});
	await git.writeRef({
		fs: repo.fs,
		gitdir: repo.gitdir,
		ref: `refs/tags/${name}`,
		value: oid,
		force: true,
	});
	return 0;
}

// ---------------------------------------------------------------- merge

export async function mergeInto(
	repo: Repo,
	theirsSpec: string,
	options: {
		ffOnly?: boolean;
		noFf?: boolean;
		squash?: boolean;
		message?: string;
		reflog?: string;
	} = {},
): Promise<number> {
	const head = await tryResolve(repo, "HEAD");
	const theirs = await resolveCommit(repo, theirsSpec);
	if (!theirs) fail(`${theirsSpec} - not something we can merge`);
	const branch = await headRef(repo);
	const reflog = options.reflog ?? `merge ${theirsSpec}`;
	if (!head) {
		await switchTrees(repo, undefined, theirs as string);
		await updateRef(repo, branch ?? "HEAD", theirs as string, `${reflog}: Fast-forward`);
		return 0;
	}
	if (
		head === theirs ||
		(await git.isDescendent({
			fs: repo.fs,
			gitdir: repo.gitdir,
			oid: head,
			ancestor: theirs as string,
			depth: -1,
			cache: repo.cache,
		}))
	) {
		out(repo, "Already up to date.\n");
		return 0;
	}
	const fastForward = await git.isDescendent({
		fs: repo.fs,
		gitdir: repo.gitdir,
		oid: theirs as string,
		ancestor: head,
		depth: -1,
		cache: repo.cache,
	});
	if (fastForward && !options.noFf && !options.squash) {
		await switchTrees(repo, head, theirs as string);
		await updateRef(repo, branch ?? "HEAD", theirs as string, `${reflog}: Fast-forward`);
		out(
			repo,
			`Updating ${head.slice(0, 7)}..${(theirs as string).slice(0, 7)}\nFast-forward\n`,
		);
		return 0;
	}
	if (options.ffOnly) fail("Not possible to fast-forward, aborting.");
	// A true merge: refuse to clobber local changes, then let isomorphic-git
	// do the three-way merge without touching refs and check out its result.
	const index = await readIndex(repo);
	const worktree = await worktreeSnapshot(repo, index);
	const headTree = await commitTree(repo, head);
	for (const entry of index) {
		const h = headTree.get(entry.path);
		const w = worktree.snapshot.get(entry.path);
		if (entry.stage || h?.oid !== entry.oid || !w || (await w.oid()) !== entry.oid)
			fail(
				"Your local changes would be overwritten by merge.\nPlease commit your changes or stash them before you merge.",
			);
	}
	const message =
		options.message ??
		`Merge ${theirsSpec.startsWith("refs/remotes/") ? `remote-tracking branch '${theirsSpec.slice(13)}'` : `branch '${theirsSpec.replace(/^refs\/heads\//, "")}'`}${branch && branch !== "refs/heads/main" && branch !== "refs/heads/master" ? ` into ${branch.replace(/^refs\/heads\//, "")}` : ""}`;
	let result: { oid?: string; tree?: string };
	try {
		result = await git.merge({
			fs: repo.fs,
			gitdir: repo.gitdir,
			dir: repo.dir,
			ours: head,
			theirs: theirs as string,
			fastForward: false,
			noUpdateBranch: true,
			abortOnConflict: true,
			dryRun: !!options.squash,
			message: `${message}\n`,
			author: await identity(repo, repo.ctx, "author"),
			committer: await identity(repo, repo.ctx, "committer"),
			cache: repo.cache,
		});
	} catch (error) {
		if ((error as { code?: string }).code === "MergeConflictError") {
			const files = (
				(error as { data?: { filepaths?: string[] } }).data?.filepaths || []
			).map((f) => `CONFLICT (content): Merge conflict in ${f}\n`);
			out(repo, files.join(""));
			fail(
				"Automatic merge failed; this CLI cannot record conflicted merges. Merge was not started.",
				1,
			);
		}
		throw error;
	}
	if (options.squash) {
		const { tree } = result;
		if (!tree) fail("squash merge produced no tree");
		const target = await writeTemporaryCommit(repo, tree as string, head);
		await switchTrees(repo, head, target);
		repo.fs.writeFileSync(
			path.join(repo.gitdir, "SQUASH_MSG"),
			`Squashed commit of the following:\n`,
		);
		out(
			repo,
			"Squash commit -- not updating HEAD\nAutomatic merge went well; stopped before committing as requested\n",
		);
		return 0;
	}
	const merged = result.oid as string;
	await switchTrees(repo, head, merged);
	await updateRef(repo, branch ?? "HEAD", merged, `${reflog}: Merge made by the 'ort' strategy.`);
	out(repo, "Merge made by the 'ort' strategy.\n");
	return 0;
}

async function writeTemporaryCommit(repo: Repo, tree: string, parent: string) {
	const who = await identity(repo, repo.ctx, "committer");
	return git.writeCommit({
		fs: repo.fs,
		gitdir: repo.gitdir,
		commit: { tree, parent: [parent], author: who, committer: who, message: "squash\n" },
	});
}

export async function mergeCommand(repo: Repo, args: string[]): Promise<number> {
	if (args.length === 1 && args[0] === "--abort") {
		if (!read(repo, "MERGE_HEAD")) fail("There is no merge to abort (MERGE_HEAD missing).");
		const head = (await tryResolve(repo, "HEAD")) as string;
		await switchTrees(repo, head, head, { hard: true });
		for (const file of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"])
			repo.fs.rmSync(path.join(repo.gitdir, file), { force: true });
		return 0;
	}
	let squash = false,
		ffOnly = false,
		noFf = false,
		message: string | undefined;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--squash") squash = true;
		else if (arg === "--ff-only") ffOnly = true;
		else if (arg === "--no-ff") noFf = true;
		else if (
			arg === "--ff" ||
			arg === "--no-verify" ||
			arg === "--no-edit" ||
			arg === "--progress"
		) {
			/* Default behavior; hooks never run. */
		} else if (arg === "-m") message = args.shift();
		else if (arg === "--") operands.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("merge");
		else operands.push(arg);
	}
	if (operands.length !== 1) unsupported("merge");
	return mergeInto(repo, operands[0] as string, { squash, ffOnly, noFf, message });
}

export async function mergeBaseCommand(repo: Repo, args: string[]): Promise<number> {
	const operands = args.filter((a) => a !== "--");
	if (operands.some((a) => a.startsWith("-")) && !operands.includes("--is-ancestor"))
		unsupported("merge-base");
	if (operands[0] === "--is-ancestor") {
		const [a, b] = await Promise.all([
			resolveCommit(repo, operands[1] ?? ""),
			resolveCommit(repo, operands[2] ?? ""),
		]);
		if (!a || !b) fail("Not a valid commit name");
		const ok =
			a === b ||
			(await git.isDescendent({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid: b as string,
				ancestor: a as string,
				depth: -1,
				cache: repo.cache,
			}));
		return ok ? 0 : 1;
	}
	if (operands.length !== 2) unsupported("merge-base");
	const [a, b] = await Promise.all(operands.map((o) => resolveCommit(repo, o)));
	if (!a || !b) fail(`Not a valid object name ${!a ? operands[0] : operands[1]}`);
	const base = await findMergeBase(repo, a as string, b as string);
	if (!base) return 1;
	out(repo, `${base}\n`);
	return 0;
}

// ---------------------------------------------------------------- misc

export async function init(
	ctx: GitContext,
	args: string[],
	defaultBranch?: string,
): Promise<number> {
	let quiet = false,
		branch = defaultBranch,
		bare = false;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "-q" || arg === "--quiet") quiet = true;
		else if (arg === "-b" || arg === "--initial-branch") branch = args.shift();
		else if (arg.startsWith("--initial-branch=")) branch = arg.slice(17);
		else if (arg === "--bare") bare = true;
		else if (arg.startsWith("-")) unsupported("init");
		else operands.push(arg);
	}
	if (operands.length > 1) unsupported("init");
	const dir = path.resolve(ctx.cwd, ctx.vfs.normalizePath(operands[0] ?? "."));
	ctx.vfs.fs.mkdirSync(dir, { recursive: true });
	const gitdir = bare ? dir : path.join(dir, ".git");
	const existed = ctx.vfs.fs.existsSync(path.join(gitdir, "HEAD"));
	await git.init({ fs: ctx.vfs.fs, dir, gitdir, bare, defaultBranch: branch || "master" });
	if (!quiet)
		ctx.io.stdout(
			`${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${gitdir}/\n`,
		);
	return 0;
}

export async function varCommand(
	repo: Repo | undefined,
	ctx: GitContext,
	args: string[],
): Promise<number> {
	const name = args[0];
	if (args.length !== 1) unsupported("var");
	if (name === "GIT_AUTHOR_IDENT" || name === "GIT_COMMITTER_IDENT") {
		ctx.io.stdout(
			`${formatIdent(await identity(repo, ctx, name === "GIT_AUTHOR_IDENT" ? "author" : "committer"))}\n`,
		);
		return 0;
	}
	return unsupported("var");
}
