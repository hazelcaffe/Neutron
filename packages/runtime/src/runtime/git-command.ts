import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import { GitConfigManager } from "isomorphic-git/managers";
import path from "path-browserify";
import type { VirtualFileSystem } from "./filesystem";
import { diffCommand, diffIndexCommand } from "./git-diff";
import { lfsCommand } from "./git-lfs";
import { catFile, logCommand, reflog, show } from "./git-log";
import { Attributes } from "./git-patterns";
import { formatRefs, listBranches, showRef, symbolicRef } from "./git-refs";
import {
	clone,
	fetchCommand,
	lsRemote,
	pullCommand,
	pushCommand,
	remoteCommand,
} from "./git-remote";
import {
	configEntries,
	fail,
	findRoot,
	type GitContext,
	GitFailure,
	type GitIO,
	globalConfigPath,
	headRef,
	inPathspec,
	openRepo,
	parseConfigParameters,
	type Repo,
	read,
	readIndex,
	repoPath,
	resolveCommit,
	resolveRevision,
	tryResolve,
	unsupported,
	updateRef,
	upstreamOf,
	ZERO_OID,
} from "./git-repo";
import { untrackedFiles, worktreeSnapshot } from "./git-snapshot";
import { stashCommand } from "./git-stash";
import {
	add,
	branchCommand,
	checkout,
	checkoutIndex,
	commit,
	commitTreeCommand,
	init,
	mergeBaseCommand,
	mergeCommand,
	mergeTreeCommand,
	reset,
	rm,
	status,
	tagCommand,
	updateIndex,
	varCommand,
} from "./git-worktree";

export type { GitIO } from "./git-repo";

// Only this argument-vector adapter is executable. No shell, hooks, helpers,
// native git executable or host filesystem; transports go through `io.fetch`.
export const isGit = (file: string) => /^(git|git\.exe)$/i.test(file.split(/[\\/]/).pop() || "");
export const gitVersion = () => `git version isomorphic-git/${git.version()}\n`;

/** Paths as git for Windows prints them: `C:/x` rather than the guest's `/C:/x`. */
const display = (value: string) => value.replace(/^\/([a-z]:)(?=\/|$)/i, "$1");

// Reuse the library's INI parser/serializer for ~/.gitconfig as well as
// .git/config; the library's own config API only opens <gitdir>/config.
async function config(ctx: GitContext, args: string[]) {
	const { vfs, cwd, io } = ctx;
	let scope = "",
		action = "",
		end = "\n",
		type = "",
		fixed = false,
		file: string | undefined;
	while (args[0]?.startsWith("-")) {
		const flag = args.shift();
		if (flag === "--global" || flag === "--local" || flag === "--system") {
			if (scope) unsupported("config");
			scope = flag;
		} else if (flag === "-f" || flag === "--file") {
			file = path.resolve(cwd, vfs.normalizePath(args.shift() ?? unsupported("config")));
			scope = "--file";
		} else if (flag === "-z" || flag === "--null") end = "\0";
		else if (flag === "--fixed-value") fixed = true;
		else if (
			flag === "--get" ||
			flag === "--replace-all" ||
			flag === "--add" ||
			flag === "--get-all" ||
			flag === "--get-regexp" ||
			flag === "--unset" ||
			flag === "--unset-all" ||
			flag === "--list" ||
			flag === "-l" ||
			flag === "--edit" ||
			flag === "-e"
		) {
			if (action) unsupported("config");
			action = flag === "-l" ? "--list" : flag === "-e" ? "--edit" : (flag as string);
		} else if (flag === "--type") type = args.shift() ?? unsupported("config");
		else if (flag?.startsWith("--type=")) type = flag.slice(7);
		else if (flag === "--bool" || flag === "--int" || flag === "--path") type = flag.slice(2);
		else if (flag === "--show-origin" || flag === "--includes" || flag === "--no-includes") {
			/* Include directives are not followed; origins are not reported. */
		} else unsupported("config");
	}
	if (type && !["bool", "int", "path", "bool-or-int"].includes(type))
		unsupported("config --type");
	const dir = findRoot(vfs, cwd);
	const global = globalConfigPath(ctx);
	const local = dir && path.join(dir, ".git/config");
	if (scope === "--system") {
		// There is no system configuration in the virtual machine.
		return action === "--list" || action.startsWith("--get") || !action
			? 1
			: unsupported("config --system");
	}
	if (action === "--edit") {
		const target = scope === "--global" ? global : (file ?? local);
		if (!target) return fail("not in a git directory");
		if (!vfs.fs.existsSync(target)) {
			vfs.fs.mkdirSync(path.dirname(target), { recursive: true });
			vfs.fs.writeFileSync(target, "");
		}
		// Desktop-style callers resolve the path with GIT_EDITOR='printf %s'.
		if (/^(printf %s|echo)$/.test((ctx.env.GIT_EDITOR || "").trim())) {
			io.stdout(display(target));
			return 0;
		}
		return fail("cannot launch an editor");
	}
	if (action === "--list") {
		const entries =
			scope === "--global"
				? (await configEntries({ ...ctx, overrides: [] })).filter(
						(e) => e.scope === "global",
					)
				: scope === "--local"
					? (
							await configEntries(
								{ ...ctx, overrides: [] },
								dir ? openRepo(ctx) : undefined,
							)
						).filter((e) => e.scope === "local")
					: await configEntries(ctx, dir ? openRepo(ctx) : undefined);
		for (const { key, value } of entries)
			io.stdout(`${key}${end === "\0" ? "\n" : "="}${value}${end}`);
		return 0;
	}
	const [key, value, pattern] = args;
	// Bounded ERE subset for key enumeration: literal text, anchors and at
	// most one wildcard. Do not run arbitrary backtracking regexps on config.
	const regexp =
		action === "--get-regexp" &&
		key &&
		/^\^?(?:[\w/-]|\\\.)*(?:\.[+*](?:[\w/-]|\\\.)*)?\$?$/.test(key)
			? new RegExp(key, "i")
			: undefined;
	const reading = !action ? value === undefined : action.startsWith("--get");
	const maxArgs =
		action === "--get-regexp"
			? 1
			: reading
				? fixed
					? 2
					: 1
				: action.startsWith("--unset")
					? fixed
						? 2
						: 1
					: fixed || action === "--replace-all"
						? 3
						: 2;
	if (
		!key ||
		(action === "--get-regexp"
			? !regexp
			: !/^[a-z][a-z\d-]*(\.[^\n]+)?\.[a-z][a-z\d-]*$/i.test(key)) ||
		args.length > maxArgs ||
		(["--replace-all", "--add"].includes(action) && args.length < 2)
	)
		return unsupported("config");
	if ((scope === "--local" || (!scope && !reading)) && !local) fail("not in a git directory");
	const files =
		scope === "--file"
			? [file as string]
			: scope === "--global"
				? [global]
				: !local
					? [global]
					: scope === "--local" || !reading
						? [local]
						: [global, local];
	const valueFilter =
		reading && fixed
			? value
			: action === "--replace-all" || action.startsWith("--unset")
				? fixed
					? action.startsWith("--unset")
						? value
						: pattern
					: undefined
				: undefined;
	const values: string[] = [];
	let matches = 0;
	for (const target of files) {
		const read = () =>
			vfs.raw.existsSync(target) ? String(vfs.raw.readFileSync(target, "utf8")) : "";
		const text = read();
		const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
		if (regexp) {
			for (const { path: name, name: variable, value: item } of ini.parsedConfig as {
				path: string;
				name: string | null;
				value: string;
			}[]) {
				if (variable && regexp.test(name)) {
					io.stdout(`${name}${end === "\0" ? "\n" : " "}${item}${end}`);
					matches++;
				}
			}
			continue;
		}
		const prior: string[] = (await ini.getall(key)).map((v: unknown) =>
			v === null ? "true" : String(v),
		);
		if (reading) {
			values.push(...prior.filter((v) => valueFilter === undefined || v === valueFilter));
			continue;
		}
		if (action.startsWith("--unset")) {
			const keep = prior.filter((v) => valueFilter !== undefined && v !== valueFilter);
			const removing = prior.length - keep.length;
			if (!removing) return 5;
			if (action === "--unset" && removing > 1) {
				io.stderr(`warning: ${key} has multiple values\n`);
				return 5;
			}
			while ((await ini.getall(key)).length) await ini.set(key, undefined);
			for (const v of keep) await ini.set(key, v, true);
		} else {
			if (!action && prior.length > 1) {
				io.stderr(
					`warning: ${key} has multiple values\nerror: cannot overwrite multiple values with a single value\n`,
				);
				return 5;
			}
			if (action === "--replace-all") {
				const keep =
					valueFilter !== undefined ? prior.filter((v) => v !== valueFilter) : [];
				while ((await ini.getall(key)).length) await ini.set(key, undefined);
				for (const v of keep) await ini.set(key, v, true);
				await ini.set(key, value, true);
			} else await ini.set(key, value, action === "--add");
		}
		if (read() !== text) fail("configuration changed concurrently");
		io.signal.throwIfAborted();
		vfs.fs.mkdirSync(path.dirname(target), { recursive: true });
		vfs.fs.writeFileSync(target, ini.toString());
		return 0;
	}
	if (!reading) return 0;
	if (regexp) return matches ? 0 : 1;
	// -c overrides take precedence when no explicit file scope was given.
	if (!scope)
		for (const [k, v] of ctx.overrides)
			if (k.toLowerCase() === key.toLowerCase()) values.push(v);
	if (!values.length) return 1;
	for (let val of action === "--get-all" ? values : values.slice(-1)) {
		if (type === "bool" || (type === "bool-or-int" && !/^-?\d+$/.test(val))) {
			if (/^(true|yes|on|1)$/i.test(val)) val = "true";
			else if (/^(false|no|off|0|)$/i.test(val)) val = "false";
			else fail(`bad boolean config value '${val}' for '${key}'`);
		} else if (type === "int") {
			const match = /^(-?\d+)([kmg]?)$/i.exec(val);
			if (!match) fail(`bad numeric config value '${val}' for '${key}': invalid unit`);
			val = String(
				Number(match?.[1]) *
					1024 ** ["", "k", "m", "g"].indexOf((match?.[2] || "").toLowerCase()),
			);
		} else if (type === "path")
			val = val.replace(
				/^~(?=\/|$)/,
				display(path.resolve(cwd, vfs.normalizePath(ctx.env.HOME || "/home/user"))),
			);
		io.stdout(val + end);
	}
	return 0;
}

async function revParse(ctx: GitContext, args: string[]): Promise<number> {
	const { vfs, cwd, io } = ctx;
	const dir = findRoot(vfs, cwd);
	const output: string[] = [];
	let verify = false,
		quiet = false,
		short: number | undefined,
		abbrevRef = false,
		symbolicFull = false,
		endOfOptions = false;
	const repo = dir ? openRepo(ctx) : undefined;
	const needRepo = () =>
		repo ?? fail("not a git repository (or any of the parent directories): .git");
	const revisions: string[] = [];
	for (const arg of args) {
		if (!endOfOptions && arg.startsWith("-")) {
			if (arg === "--end-of-options") endOfOptions = true;
			else if (arg === "--verify") verify = true;
			else if (arg === "-q" || arg === "--quiet") quiet = true;
			else if (arg === "--short") short = 7;
			else if (/^--short=\d+$/.test(arg)) short = Number(arg.slice(8));
			else if (arg === "--abbrev-ref") abbrevRef = true;
			else if (arg === "--symbolic-full-name") symbolicFull = true;
			else if (arg === "--is-bare-repository" && needRepo()) output.push("false");
			else if (arg === "--is-inside-work-tree" && needRepo()) output.push("true");
			else if (arg === "--is-inside-git-dir" && needRepo()) output.push("false");
			else if (arg === "--show-cdup") {
				const up = path.relative(cwd, needRepo().dir);
				output.push(up ? `${up}/` : "");
			} else if (arg === "--show-prefix") {
				const prefix = path.relative(needRepo().dir, cwd);
				output.push(prefix ? `${prefix}/` : "");
			} else if (arg === "--show-toplevel") output.push(display(needRepo().dir));
			else if (arg === "--git-dir")
				output.push(needRepo().dir === cwd ? ".git" : display(needRepo().gitdir));
			else if (arg === "--absolute-git-dir" || arg === "--git-common-dir")
				output.push(
					arg === "--git-common-dir" && needRepo().dir === cwd
						? ".git"
						: display(needRepo().gitdir),
				);
			else if (arg === "--") break;
			else unsupported("rev-parse");
			continue;
		}
		revisions.push(arg);
	}
	if (verify && revisions.length !== 1) {
		if (!quiet) io.stderr("fatal: Needed a single revision\n");
		return 128;
	}
	for (const spec of revisions) {
		const r = needRepo();
		const upstreamSpec = /^(.*)@\{(?:upstream|u)\}$/i.exec(spec);
		if (symbolicFull || abbrevRef) {
			if (upstreamSpec) {
				const branch = upstreamSpec[1] || (await headRef(r))?.replace(/^refs\/heads\//, "");
				const up = branch ? await upstreamOf(r, branch) : undefined;
				if (!up) {
					io.stderr(
						branch
							? `fatal: no upstream configured for branch '${branch}'\n`
							: "fatal: HEAD does not point to a branch\n",
					);
					return 128;
				}
				output.push(abbrevRef ? up.ref.replace(/^refs\/(heads|remotes)\//, "") : up.ref);
				continue;
			}
			if (spec === "HEAD") {
				const ref = await headRef(r);
				output.push(
					ref
						? abbrevRef
							? ref.replace(/^refs\/heads\//, "")
							: ref
						: abbrevRef
							? "HEAD"
							: "HEAD",
				);
				continue;
			}
			for (const candidate of [
				spec,
				`refs/heads/${spec}`,
				`refs/tags/${spec}`,
				`refs/remotes/${spec}`,
			])
				if (candidate.startsWith("refs/") && (await tryResolve(r, candidate))) {
					output.push(
						abbrevRef
							? candidate.replace(/^refs\/(heads|remotes|tags)\//, "")
							: candidate,
					);
					break;
				}
			continue;
		}
		const oid = await resolveRevision(r, spec).catch(() => undefined);
		if (!oid) {
			if (verify) {
				if (!quiet) io.stderr("fatal: Needed a single revision\n");
				return quiet ? 1 : 128;
			}
			io.stderr(
				`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n`,
			);
			return 128;
		}
		output.push(short ? oid.slice(0, short) : oid);
	}
	io.stdout(output.length ? `${output.join("\n")}\n` : "");
	return 0;
}

async function lsFiles(repo: Repo, cwd: string, args: string[]) {
	let z = false,
		stage = false,
		others = false,
		cached = false,
		excludeStandard = false,
		errorUnmatch = false,
		unmerged = false,
		deleted = false,
		modified = false;
	const specs: string[] = [];
	for (const arg of args) {
		if (arg === "-z") z = true;
		else if (arg === "-s" || arg === "--stage") stage = true;
		else if (arg === "-o" || arg === "--others") others = true;
		else if (arg === "-c" || arg === "--cached") cached = true;
		else if (arg === "--exclude-standard") excludeStandard = true;
		else if (arg === "--error-unmatch") errorUnmatch = true;
		else if (arg === "-u" || arg === "--unmerged") unmerged = stage = true;
		else if (arg === "-d" || arg === "--deleted") deleted = true;
		else if (arg === "-m" || arg === "--modified") modified = true;
		else if (arg === "--") continue;
		else if (arg.startsWith("-")) unsupported("ls-files");
		else specs.push(arg);
	}
	if (others && !excludeStandard) unsupported("ls-files --others without --exclude-standard");
	const paths = specs.map((s) => repoPath(repo, cwd, s));
	const prefix = path.relative(repo.dir, cwd);
	const show = (file: string) => (prefix ? path.relative(prefix, file) : file);
	const index = (await readIndex(repo)).filter((e) => inPathspec(e.path, paths));
	const term = z ? "\0" : "\n";
	const lines: string[] = [];
	if (!others || cached || deleted || modified || unmerged) {
		let entries = index;
		if (unmerged) entries = entries.filter((e) => e.stage);
		if (deleted || modified) {
			const worktree = await worktreeSnapshot(repo, index);
			const kept = [];
			for (const e of entries) {
				const w = worktree.snapshot.get(e.path);
				if ((deleted && !w) || (modified && (!w || (await w.oid()) !== e.oid)))
					kept.push(e);
			}
			entries = kept;
		}
		for (const e of entries)
			lines.push(stage ? `${e.mode} ${e.oid} ${e.stage}\t${show(e.path)}` : show(e.path));
	}
	if (others) {
		for (const file of await untrackedFiles(repo, new Set(index.map((e) => e.path))))
			if (inPathspec(file, paths)) lines.push(show(file));
	}
	if (errorUnmatch && !lines.length)
		fail(`pathspec '${specs[0] ?? ""}' did not match any file(s) known to git`);
	repo.ctx.io.stdout([...new Set(lines)].map((l) => l + term).join(""));
	return 0;
}

async function checkAttr(repo: Repo, cwd: string, args: string[]) {
	let stdin = false,
		z = false,
		all = false;
	const attrs: string[] = [];
	const files: string[] = [];
	let seenDash = false;
	for (const arg of args) {
		if (arg === "--stdin") stdin = true;
		else if (arg === "-z") z = true;
		else if (arg === "-a" || arg === "--all") all = true;
		else if (arg === "--cached") continue;
		else if (arg === "--") seenDash = true;
		else if (arg.startsWith("-")) unsupported("check-attr");
		else if (seenDash || (attrs.length && (all || files.length))) files.push(arg);
		else attrs.push(arg);
	}
	// Without --, the last operands are paths: `check-attr filter path`.
	if (!seenDash && !stdin && !all && attrs.length > 1)
		files.push(...attrs.splice(attrs.length - 1));
	if (all && !seenDash) files.push(...attrs.splice(0));
	if (stdin) {
		const text = Buffer.from(await repo.ctx.io.stdin()).toString("utf8");
		files.push(...text.split(z ? "\0" : /\r?\n/).filter(Boolean));
	}
	const attributes = new Attributes(repo);
	for (const name of files) {
		const file = repoPath(repo, cwd, name);
		const values = attributes.get(file);
		const pairs: [string, string][] = all
			? [...values].map(([k, v]) => [k, v === true ? "set" : v === false ? "unset" : v])
			: attrs.map((a) => {
					const v = values.get(a);
					return [
						a,
						v === undefined
							? "unspecified"
							: v === true
								? "set"
								: v === false
									? "unset"
									: v,
					];
				});
		for (const [attr, value] of pairs)
			repo.ctx.io.stdout(z ? `${name}\0${attr}\0${value}\0` : `${name}: ${attr}: ${value}\n`);
	}
	return 0;
}

async function updateRefCommand(repo: Repo, args: string[]) {
	let message = "update-ref",
		del = false,
		deref = true;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "-m") message = args.shift() ?? unsupported("update-ref");
		else if (arg === "-d") del = true;
		else if (arg === "--no-deref") deref = false;
		else if (arg === "--create-reflog") continue;
		else if (arg.startsWith("-")) unsupported("update-ref");
		else operands.push(arg);
	}
	const [name = "", value, old] = operands;
	if (!/^(HEAD|refs\/[\w./-]+)$/.test(name)) fail(`invalid ref ${name}`);
	// Like git, update the branch a symbolic ref (HEAD) points to.
	const symbolic = deref ? /^ref: (refs\/\S+)/.exec(read(repo, name) ?? "")?.[1] : undefined;
	const ref = symbolic ?? name;
	const expected = del ? value : old;
	const current = await tryResolve(repo, ref);
	if (expected !== undefined) {
		const want =
			expected === ""
				? undefined
				: expected === ZERO_OID
					? undefined
					: await resolveCommit(repo, expected);
		if (current !== want)
			fail(`cannot lock ref '${ref}': is at ${current ?? ZERO_OID} but expected ${expected}`);
	}
	if (del) {
		await git.deleteRef({ fs: repo.fs, gitdir: repo.gitdir, ref });
		repo.fs.rmSync(path.join(repo.gitdir, "logs", ref), { force: true });
		return 0;
	}
	const target = value && (await resolveRevision(repo, value));
	if (!target) fail(`${value}: not a valid SHA1`);
	await updateRef(repo, ref, target as string, message);
	return 0;
}

async function interpretTrailers(repo: Repo | undefined, ctx: GitContext, args: string[]) {
	let parse = false,
		unfold = false;
	const trailers: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--parse") parse = unfold = true;
		else if (arg === "--unfold") unfold = true;
		else if (arg === "--no-divider" || arg === "--only-input" || arg === "--only-trailers")
			continue;
		else if (arg === "--trailer")
			trailers.push(args.shift() ?? unsupported("interpret-trailers"));
		else if (arg.startsWith("--trailer=")) trailers.push(arg.slice(10));
		else unsupported("interpret-trailers");
	}
	void repo;
	const message = Buffer.from(await ctx.io.stdin()).toString("utf8");
	const paragraphs = message.replace(/\s+$/, "").split(/\n\s*\n/);
	const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? "") : "";
	const lines = (unfold ? last.replace(/\n[ \t]+/g, " ") : last).split("\n");
	const existing = lines.filter((l) => /^[\w-]+\s*:/.test(l));
	const isTrailerBlock = existing.length > 0 && existing.length * 4 >= lines.length * 3;
	if (parse) {
		if (isTrailerBlock)
			for (const line of existing)
				ctx.io.stdout(`${line.replace(/^([\w-]+)\s*:\s*/, "$1: ")}\n`);
		return 0;
	}
	const added = trailers.map((t) => {
		const sep = t.search(/[=:]/);
		return sep < 0 ? `${t}: ` : `${t.slice(0, sep).trim()}: ${t.slice(sep + 1).trim()}`;
	});
	const body = message.replace(/\s+$/, "");
	if (!added.length) ctx.io.stdout(message);
	else if (isTrailerBlock) ctx.io.stdout(`${body}\n${added.join("\n")}\n`);
	else ctx.io.stdout(`${body}${body ? "\n\n" : ""}${added.join("\n")}\n`);
	return 0;
}

async function submodule(repo: Repo, args: string[]) {
	const index = await readIndex(repo);
	const gitlinks = index.filter((e) => e.mode === "160000");
	const sub = args[0];
	if (sub === "status" || sub === undefined) {
		for (const link of gitlinks) {
			const inner = { ...repo, gitdir: path.join(repo.dir, link.path, ".git") };
			const head = await tryResolve(inner, "HEAD");
			const prefix = !head ? "-" : head !== link.oid ? "+" : " ";
			repo.ctx.io.stdout(`${prefix}${head ?? link.oid} ${link.path}\n`);
		}
		return 0;
	}
	if ((sub === "update" || sub === "sync" || sub === "foreach") && !gitlinks.length) return 0;
	return unsupported(`submodule ${sub}`);
}

async function worktree(repo: Repo, args: string[]) {
	if (args[0] !== "list") return unsupported("worktree");
	if (repo.fs.existsSync(path.join(repo.gitdir, "worktrees")))
		fail("linked worktrees not supported");
	const porcelain = args.includes("--porcelain");
	const z = args.includes("-z");
	if (args.slice(1).some((a) => !["--porcelain", "-z"].includes(a))) unsupported("worktree list");
	const head = (await tryResolve(repo, "HEAD")) ?? ZERO_OID;
	const branch = await headRef(repo);
	if (porcelain) {
		const t = z ? "\0" : "\n";
		repo.ctx.io.stdout(
			`worktree ${display(repo.dir)}${t}HEAD ${head}${t}${branch ? `branch ${branch}` : "detached"}${t}${t}`,
		);
	} else
		repo.ctx.io.stdout(
			`${display(repo.dir)}  ${head.slice(0, 7)} ${branch ? `[${branch.replace(/^refs\/heads\//, "")}]` : "(detached HEAD)"}\n`,
		);
	return 0;
}

const REPO_COMMANDS = new Set([
	"rev-parse",
	"ls-files",
	"log",
	"rev-list",
	"reflog",
	"show",
	"cat-file",
	"remote",
	"branch",
	"status",
	"worktree",
	"symbolic-ref",
	"for-each-ref",
	"show-ref",
	"add",
	"rm",
	"update-index",
	"reset",
	"checkout",
	"checkout-index",
	"commit",
	"commit-tree",
	"tag",
	"merge",
	"merge-base",
	"merge-tree",
	"fetch",
	"pull",
	"push",
	"diff-index",
	"update-ref",
	"check-attr",
	"submodule",
	"stash",
	"switch",
]);

export async function runGit(
	vfs: VirtualFileSystem,
	argv: string[],
	options: { cwd?: string; env?: Record<string, string>; shell?: boolean | string },
	io: GitIO,
): Promise<number> {
	const args = [...argv],
		env = options.env || {};
	let cwd = path.resolve(vfs.cwd, vfs.normalizePath(options.cwd || vfs.cwd));
	const overrides = parseConfigParameters(env.GIT_CONFIG_PARAMETERS);
	try {
		io.signal.throwIfAborted();
		if (options.shell) fail("shell execution is not supported");
		while (args.length) {
			const arg = args[0] as string;
			if (arg === "-C") {
				args.shift();
				cwd = path.resolve(cwd, vfs.normalizePath(args.shift() ?? unsupported("-C")));
			} else if (arg === "--git-dir" || arg.startsWith("--git-dir=")) {
				args.shift();
				const value = arg === "--git-dir" ? args.shift() : arg.slice(10);
				const gitdir = path.resolve(
					cwd,
					vfs.normalizePath(value ?? unsupported("--git-dir")),
				);
				if (
					path.basename(gitdir) !== ".git" ||
					!vfs.raw.existsSync(path.join(gitdir, "HEAD"))
				)
					unsupported("--git-dir");
				cwd = path.dirname(gitdir);
			} else if (
				[
					"--no-optional-locks",
					"--no-pager",
					"-P",
					"--no-replace-objects",
					"--literal-pathspecs",
				].includes(arg)
			)
				args.shift();
			else if (arg === "-c") {
				args.shift();
				const setting = args.shift() ?? unsupported("-c");
				const eq = setting.indexOf("=");
				const key = eq < 0 ? setting : setting.slice(0, eq);
				if (!/^[a-z][\w-]*(\.[^\n=]+)?\.[a-z][\w-]*$/i.test(key)) unsupported("-c");
				overrides.push([key.toLowerCase(), eq < 0 ? "true" : setting.slice(eq + 1)]);
			} else break;
		}
		const command = args.shift();
		const ctx: GitContext = { vfs, cwd, env, io, overrides };
		const defaultBranch = overrides.findLast(([k]) => k === "init.defaultbranch")?.[1];
		if ((command === "--version" || command === "version") && !args.length) {
			io.stdout(gitVersion());
			return 0;
		}
		switch (command) {
			case "clone":
				return await clone(ctx, args, defaultBranch);
			case "init":
				return await init(ctx, args, defaultBranch);
			case "config":
				return await config(ctx, args);
			case "lfs":
				return await lfsCommand(ctx, args);
			case "ls-remote":
				return await lsRemote(ctx, findRoot(vfs, cwd) ? openRepo(ctx) : undefined, args);
			case "diff":
				return await diffCommand(
					findRoot(vfs, cwd) ? openRepo(ctx) : undefined,
					cwd,
					args,
					ctx,
				);
			case "var":
				return await varCommand(findRoot(vfs, cwd) ? openRepo(ctx) : undefined, ctx, args);
			case "rev-parse":
				return await revParse(ctx, args);
			case "interpret-trailers":
				return await interpretTrailers(undefined, ctx, args);
		}
		if (!REPO_COMMANDS.has(command || ""))
			return fail(`unsupported git command: ${command || "(missing)"}`);
		const repo = openRepo(ctx);
		switch (command) {
			case "status":
				return await status(repo, args);
			case "for-each-ref":
				io.stdout(await formatRefs(repo, args));
				return 0;
			case "show-ref":
				return await showRef(repo, args);
			case "symbolic-ref":
				return await symbolicRef(repo, args);
			case "worktree":
				return await worktree(repo, args);
			case "ls-files":
				return await lsFiles(repo, cwd, args);
			case "log":
				return await logCommand(repo, cwd, args);
			case "rev-list":
				return await logCommand(repo, cwd, args, true);
			case "reflog":
				return await reflog(repo, cwd, args);
			case "show":
				return await show(repo, cwd, args);
			case "cat-file":
				return await catFile(repo, args);
			case "branch":
				return await branchCommand(repo, args, listBranches);
			case "remote":
				return await remoteCommand(repo, args);
			case "add":
				return await add(repo, cwd, args);
			case "rm":
				return await rm(repo, cwd, args);
			case "update-index":
				return await updateIndex(repo, cwd, args);
			case "reset":
				return await reset(repo, cwd, args);
			case "checkout":
				return await checkout(repo, cwd, args);
			case "switch":
				return await checkout(
					repo,
					cwd,
					args.map((a) => (a === "-c" ? "-b" : a === "-C" ? "-B" : a)),
				);
			case "checkout-index":
				return await checkoutIndex(repo, cwd, args);
			case "commit":
				return await commit(repo, cwd, args);
			case "commit-tree":
				return await commitTreeCommand(repo, args);
			case "tag":
				return await tagCommand(repo, args);
			case "merge":
				return await mergeCommand(repo, args);
			case "merge-base":
				return await mergeBaseCommand(repo, args);
			case "merge-tree":
				return await mergeTreeCommand(repo, args);
			case "fetch":
				return await fetchCommand(repo, args);
			case "pull":
				return await pullCommand(repo, args);
			case "push":
				return await pushCommand(repo, args);
			case "diff-index":
				return await diffIndexCommand(repo, cwd, args);
			case "update-ref":
				return await updateRefCommand(repo, args);
			case "check-attr":
				return await checkAttr(repo, cwd, args);
			case "submodule":
				return await submodule(repo, args);
			case "stash":
				return await stashCommand(repo, args);
		}
		return fail(`unsupported git command: ${command}`);
	} catch (error) {
		if (error instanceof GitFailure) {
			io.stderr(error.raw ? `${error.message}\n` : `fatal: ${error.message}\n`);
			return error.code;
		}
		io.stderr(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
		return 128;
	}
}
