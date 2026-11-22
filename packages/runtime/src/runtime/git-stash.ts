import * as git from "isomorphic-git";
import path from "path-browserify";
import { compare } from "./git-diff";
import { logCommand } from "./git-log";
import {
	commitTree,
	editIndex,
	fail,
	GitFailure,
	headRef,
	identity,
	logRef,
	type Repo,
	read,
	readCommit,
	readIndex,
	resolveCommit,
	type TreeEntry,
	tryResolve,
	unsupported,
	writeTreeFromEntries,
	ZERO_OID,
} from "./git-repo";
import { commitSnapshot, worktreeSnapshot } from "./git-snapshot";
import { switchTrees, writeFiles } from "./git-worktree";

// git stash with git's on-disk format: refs/stash plus its reflog, a stash
// commit with parents [HEAD, index commit] whose tree is the worktree state.

interface Entry {
	line: string;
	oid: string;
}

function entries(repo: Repo): Entry[] {
	const text = read(repo, "logs/refs/stash") || "";
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ line, oid: line.split(" ")[1] as string }))
		.reverse();
}

function writeEntries(repo: Repo, list: Entry[]) {
	const file = path.join(repo.gitdir, "logs/refs/stash");
	const top = list[0];
	if (!top) {
		repo.fs.rmSync(file, { force: true });
		repo.fs.rmSync(path.join(repo.gitdir, "refs/stash"), { force: true });
		return;
	}
	repo.fs.writeFileSync(
		file,
		`${[...list]
			.reverse()
			.map((e) => e.line)
			.join("\n")}\n`,
	);
	repo.fs.writeFileSync(path.join(repo.gitdir, "refs/stash"), `${top.oid}\n`);
}

function selectEntry(repo: Repo, spec = "stash@{0}") {
	const match =
		/^(?:refs\/)?stash@\{(\d+)\}$/.exec(spec) ?? (/^\d+$/.test(spec) ? [spec, spec] : null);
	const list = entries(repo);
	const index = match ? Number(match[1]) : list.findIndex((e) => e.oid === spec);
	const entry = list[index];
	if (!entry) fail(`${spec} is not a valid reference`);
	return { list, index, entry: entry as Entry };
}

async function store(repo: Repo, oid: string, message: string) {
	const before = await tryResolve(repo, "refs/stash");
	await git.writeRef({
		fs: repo.fs,
		gitdir: repo.gitdir,
		ref: "refs/stash",
		value: oid,
		force: true,
	});
	await logRef(repo, "refs/stash", before ?? ZERO_OID, oid, message);
}

async function push(repo: Repo, message?: string, quiet = false) {
	const head = await tryResolve(repo, "HEAD");
	if (!head) {
		repo.ctx.io.stderr("You do not have the initial commit yet\n");
		return 1;
	}
	const branch = (await headRef(repo))?.replace(/^refs\/heads\//, "") ?? "(no branch)";
	const { commit } = await readCommit(repo, head);
	const description = `${head.slice(0, 7)} ${commit.message.split("\n")[0]}`;
	const index = await readIndex(repo);
	if (index.some((e) => e.stage)) fail("could not save index tree: unmerged paths");
	const staged = new Map<string, TreeEntry>(
		index.map((e) => [e.path, { oid: e.oid, mode: e.mode }]),
	);
	const worktree = await worktreeSnapshot(repo, index);
	const work = new Map<string, TreeEntry>();
	for (const [file, entry] of staged) {
		const w = worktree.snapshot.get(file);
		if (!w) continue;
		const oid = await w.oid();
		if (oid !== entry.oid) {
			const data = await worktree.filter.clean(file, await w.data(), true);
			work.set(file, {
				oid: await git.writeBlob({ fs: repo.fs, gitdir: repo.gitdir, blob: data }),
				mode: w.mode,
			});
		} else work.set(file, { oid, mode: w.mode });
	}
	const indexTree = await writeTreeFromEntries(repo, staged);
	const workTree = await writeTreeFromEntries(repo, work);
	if (indexTree === commit.tree && workTree === commit.tree) {
		repo.ctx.io.stdout("No local changes to save\n");
		return 0;
	}
	const who = await identity(repo, repo.ctx, "committer");
	const indexCommit = await git.writeCommit({
		fs: repo.fs,
		gitdir: repo.gitdir,
		commit: {
			tree: indexTree,
			parent: [head],
			author: who,
			committer: who,
			message: `index on ${branch}: ${description}\n`,
		},
	});
	const subject = message ? `On ${branch}: ${message}` : `WIP on ${branch}: ${description}`;
	const stash = await git.writeCommit({
		fs: repo.fs,
		gitdir: repo.gitdir,
		commit: {
			tree: workTree,
			parent: [head, indexCommit],
			author: who,
			committer: who,
			message: `${subject}\n`,
		},
	});
	await store(repo, stash, subject);
	await switchTrees(repo, head, head, { hard: true });
	if (!quiet) repo.ctx.io.stdout(`Saved working directory and index state ${subject}\n`);
	return 0;
}

/** Apply a stash's worktree changes on top of the current HEAD. */
async function apply(repo: Repo, oid: string) {
	const { commit: stash } = await readCommit(repo, oid);
	const base = stash.parent[0];
	const indexParent = stash.parent[1];
	if (!base) fail(`${oid} is not a stash-like commit`);
	const head = await tryResolve(repo, "HEAD");
	const baseTree = await commitTree(repo, base);
	const stashTree = await commitTree(repo, oid);
	const indexTree = indexParent ? await commitTree(repo, indexParent) : baseTree;
	const headTree = await commitTree(repo, head);
	const index = await readIndex(repo);
	const worktree = await worktreeSnapshot(repo, index);
	const staged = new Map(index.filter((e) => e.stage === 0).map((e) => [e.path, e]));
	const changes = await compare(
		await commitSnapshot(repo, base),
		await commitSnapshot(repo, oid),
	);
	const conflicts: string[] = [];
	const dirty: string[] = [];
	for (const change of changes) {
		const file = change.newPath;
		const b = baseTree.get(file),
			h = headTree.get(file),
			i = staged.get(file),
			w = worktree.snapshot.get(file);
		if (b?.oid !== h?.oid) conflicts.push(file);
		else if (
			(i && (i.oid !== h?.oid || !w || (await w.oid()) !== i.oid)) ||
			(!i && repo.fs.existsSync(path.join(repo.dir, file)))
		)
			dirty.push(file);
	}
	if (dirty.length)
		throw new GitFailure(
			`error: Your local changes to the following files would be overwritten by merge:\n${dirty.map((f) => `\t${f}\n`).join("")}Please commit your changes or stash them before you merge.\nAborting`,
			1,
			true,
		);
	if (conflicts.length)
		throw new GitFailure(
			`${conflicts.map((f) => `CONFLICT (content): Merge conflict in ${f}\n`).join("")}error: this Git cannot record stash conflicts; the stash was not applied`,
			1,
			true,
		);
	const targets = new Map<string, TreeEntry | undefined>();
	for (const change of changes) targets.set(change.newPath, stashTree.get(change.newPath));
	const stats = await writeFiles(repo, targets, stashTree);
	await editIndex(repo, async (writer) => {
		for (const [file, target] of targets) {
			if (!target) writer.remove(file);
			// Files the stash added are staged again, like git stash apply.
			else if (!baseTree.has(file) && indexTree.has(file))
				writer.insert(file, target.oid, target.mode, stats.get(file));
		}
	});
}

export async function stashCommand(repo: Repo, args: string[]): Promise<number> {
	const sub = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : "push";
	if (sub === "push" || sub === "save") {
		let message: string | undefined,
			quiet = false;
		while (args.length) {
			const arg = args.shift() as string;
			if (arg === "-m" || arg === "--message") message = args.shift();
			else if (arg === "-q" || arg === "--quiet") quiet = true;
			else if (sub === "save" && !arg.startsWith("-"))
				message = [arg, ...args.splice(0)].join(" ");
			else unsupported("stash push");
		}
		return push(repo, message, quiet);
	}
	if (sub === "list")
		return logCommand(repo, repo.dir, ["-g", "--format=%gd: %gs", "refs/stash", ...args]);
	if (sub === "show") {
		const spec = args.find((a) => !a.startsWith("-")) ?? "stash@{0}";
		const { entry } = /^[0-9a-f]{40}$/.test(spec)
			? { entry: { oid: spec } }
			: selectEntry(repo, spec);
		const rest = args.filter((a) => a !== spec);
		return logCommand(repo, repo.dir, [
			"-1",
			"-m",
			"--first-parent",
			...rest.filter((a) => a !== "--"),
			entry.oid,
			"--",
		]);
	}
	if (sub === "drop" || sub === "pop" || sub === "apply") {
		const quiet = args.includes("--quiet") || args.includes("-q");
		if (args.some((a) => a.startsWith("-") && a !== "--quiet" && a !== "-q"))
			unsupported(`stash ${sub}`);
		const spec = args.find((a) => !a.startsWith("-"));
		const { list, index, entry } = selectEntry(repo, spec);
		if (sub !== "drop") await apply(repo, entry.oid);
		if (sub !== "apply") {
			writeEntries(
				repo,
				list.filter((_, i) => i !== index),
			);
			if (!quiet) repo.ctx.io.stdout(`Dropped ${spec ?? "refs/stash@{0}"} (${entry.oid})\n`);
		}
		return 0;
	}
	if (sub === "store") {
		let message: string | undefined;
		const operands: string[] = [];
		while (args.length) {
			const arg = args.shift() as string;
			if (arg === "-m" || arg === "--message") message = args.shift();
			else if (arg === "-q" || arg === "--quiet") continue;
			else if (arg.startsWith("-")) unsupported("stash store");
			else operands.push(arg);
		}
		const oid = operands[0] && (await resolveCommit(repo, operands[0]));
		if (!oid || operands.length !== 1) fail('"git stash store" requires one <commit> argument');
		await store(repo, oid as string, message ?? 'Created via "git stash store".');
		return 0;
	}
	if (sub === "clear") {
		writeEntries(repo, []);
		return 0;
	}
	return unsupported(`stash ${sub}`);
}
