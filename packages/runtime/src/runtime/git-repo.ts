import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import { GitConfigManager, GitIndexManager } from "isomorphic-git/managers";
import { FileSystem } from "isomorphic-git/models";
import path from "path-browserify";
import type { VirtualFileSystem } from "./filesystem";

// Shared plumbing for the virtual Git CLI. Every command works on the guest's
// virtual filesystem through isomorphic-git; nothing here executes programs.

export interface GitIO {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	signal: AbortSignal;
	stdout: (text: string | Uint8Array) => void;
	stderr: (text: string) => void;
	/** Reads standard input to EOF. Only commands that consume input call it. */
	stdin: () => Promise<Uint8Array>;
}

/** A failure that git reports on stderr with a specific exit status. */
export class GitFailure extends Error {
	constructor(
		message: string,
		readonly code = 128,
		readonly raw = false,
	) {
		super(message);
	}
}
export const fail = (message: string, code = 128): never => {
	throw new GitFailure(message, code);
};
/** A failure carrying git's own multi-line stderr text verbatim. */
export const failRaw = (message: string, code = 128): never => {
	throw new GitFailure(message, code, true);
};
export const unsupported = (command: string): never => fail(`unsupported git ${command} arguments`);

export interface GitContext {
	vfs: VirtualFileSystem;
	cwd: string;
	env: Record<string, string>;
	io: GitIO;
	/** `-c name=value` and GIT_CONFIG_PARAMETERS, in precedence order. */
	overrides: [string, string][];
}

export interface Repo {
	fs: VirtualFileSystem["fs"];
	dir: string;
	gitdir: string;
	cache: object;
	ctx: GitContext;
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const ZERO_OID = "0".repeat(40);
export const MAX_ENTRIES = 50_000;
export const MAX_BLOB = 64 * 1024 * 1024;

export function findRoot(vfs: VirtualFileSystem, cwd: string): string | undefined {
	for (let p = cwd; ; p = path.dirname(p)) {
		if (vfs.raw.existsSync(path.join(p, ".git/HEAD"))) return p;
		if (p === "/" || p === path.dirname(p)) return;
	}
}

export function openRepo(ctx: GitContext): Repo {
	const dir = findRoot(ctx.vfs, ctx.cwd);
	if (!dir) fail("not a git repository (or any of the parent directories): .git");
	return {
		fs: ctx.vfs.fs,
		dir: dir as string,
		gitdir: path.join(dir as string, ".git"),
		cache: {},
		ctx,
	};
}

export const read = (repo: Repo, file: string): string | undefined => {
	try {
		return String(repo.fs.readFileSync(path.join(repo.gitdir, file), "utf8"));
	} catch {
		return;
	}
};

// ---------------------------------------------------------------- config

export interface ConfigEntry {
	key: string;
	value: string;
	scope: "global" | "local" | "command";
}

const normalizeKey = (key: string) => {
	const parts = key.split(".");
	if (parts.length < 2) return key.toLowerCase();
	const section = parts.shift()?.toLowerCase();
	const name = parts.pop()?.toLowerCase();
	return [section, ...parts, name].join(".");
};

export function homeDir(ctx: GitContext): string {
	return path.resolve(ctx.cwd, ctx.vfs.normalizePath(ctx.env.HOME || "/home/user"));
}
export function globalConfigPath(ctx: GitContext): string {
	return path.join(homeDir(ctx), ".gitconfig");
}

export async function parseConfigFile(
	vfs: VirtualFileSystem,
	file: string,
): Promise<{ key: string; value: string }[]> {
	if (!vfs.raw.existsSync(file)) return [];
	const text = String(vfs.raw.readFileSync(file, "utf8"));
	const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
	return (ini.parsedConfig as { path: string; name: string | null; value: unknown }[])
		.filter((e) => e.name)
		.map((e) => ({ key: e.path, value: e.value === null ? "true" : String(e.value) }));
}

/** Git's GIT_CONFIG_PARAMETERS format: space separated, single-quoted `'k=v'`. */
export function parseConfigParameters(value: string | undefined): [string, string][] {
	const result: [string, string][] = [];
	if (!value) return result;
	for (const match of value.matchAll(
		/'((?:[^'\\]|\\.|'\\'')*)'(?:='((?:[^'\\]|\\.|'\\'')*)')?/g,
	)) {
		const unquote = (s: string) => s.replaceAll("'\\''", "'");
		const first = unquote(match[1] || "");
		if (match[2] !== undefined) result.push([normalizeKey(first), unquote(match[2])]);
		else {
			const eq = first.indexOf("=");
			if (eq < 0) result.push([normalizeKey(first), "true"]);
			else result.push([normalizeKey(first.slice(0, eq)), first.slice(eq + 1)]);
		}
	}
	return result;
}

export async function configEntries(ctx: GitContext, repo?: Repo): Promise<ConfigEntry[]> {
	const entries: ConfigEntry[] = [];
	for (const { key, value } of await parseConfigFile(ctx.vfs, globalConfigPath(ctx)))
		entries.push({ key, value, scope: "global" });
	if (repo)
		for (const { key, value } of await parseConfigFile(
			ctx.vfs,
			path.join(repo.gitdir, "config"),
		))
			entries.push({ key, value, scope: "local" });
	for (const [key, value] of ctx.overrides)
		entries.push({ key: normalizeKey(key), value, scope: "command" });
	return entries;
}

export async function configGet(
	ctx: GitContext,
	repo: Repo | undefined,
	key: string,
): Promise<string | undefined> {
	const wanted = normalizeKey(key);
	return (await configEntries(ctx, repo)).findLast((e) => e.key === wanted)?.value;
}

export async function configGetAll(
	ctx: GitContext,
	repo: Repo | undefined,
	key: string,
): Promise<string[]> {
	const wanted = normalizeKey(key);
	return (await configEntries(ctx, repo)).filter((e) => e.key === wanted).map((e) => e.value);
}

export function configBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return;
	if (/^(true|yes|on|1)$/i.test(value)) return true;
	if (/^(false|no|off|0|)$/i.test(value)) return false;
	return fail(`bad boolean config value '${value}'`);
}

/** Write one local repository setting with git's own INI serializer. */
export async function setLocalConfig(
	repo: Repo,
	key: string,
	value: string | undefined,
	append = false,
): Promise<void> {
	const file = path.join(repo.gitdir, "config");
	const text = repo.fs.existsSync(file) ? String(repo.fs.readFileSync(file, "utf8")) : "";
	const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
	await ini.set(key, value, append);
	repo.fs.writeFileSync(file, ini.toString());
}

/** Remove a whole `[section "sub"]` from the repository config. */
export async function deleteLocalSection(repo: Repo, section: string, sub: string) {
	const file = path.join(repo.gitdir, "config");
	const text = repo.fs.existsSync(file) ? String(repo.fs.readFileSync(file, "utf8")) : "";
	const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
	await ini.deleteSection(section, sub);
	repo.fs.writeFileSync(file, ini.toString());
}

// ---------------------------------------------------------------- identity

export interface Identity {
	name: string;
	email: string;
	timestamp: number;
	timezoneOffset: number;
}

function parseDate(value: string): { timestamp: number; timezoneOffset: number } | undefined {
	const raw = /^@?(\d+)(?: ([+-])(\d\d)(\d\d))?$/.exec(value.trim());
	if (raw) {
		const minutes = Number(raw[3] || 0) * 60 + Number(raw[4] || 0);
		return {
			timestamp: Number(raw[1]),
			timezoneOffset: raw[2] === "-" ? minutes : -minutes,
		};
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return;
	return { timestamp: Math.floor(date.getTime() / 1000), timezoneOffset: 0 };
}

export async function identity(
	repo: Repo | undefined,
	ctx: GitContext,
	kind: "author" | "committer",
) {
	const upper = kind.toUpperCase();
	const env = ctx.env;
	const name =
		env[`GIT_${upper}_NAME`] ??
		(await configGet(ctx, repo, `${kind}.name`)) ??
		(await configGet(ctx, repo, "user.name"));
	const email =
		env[`GIT_${upper}_EMAIL`] ??
		(await configGet(ctx, repo, `${kind}.email`)) ??
		(await configGet(ctx, repo, "user.email")) ??
		env.EMAIL;
	if (!name || !email)
		fail(
			`${kind === "author" ? "Author" : "Committer"} identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address`,
		);
	const date = env[`GIT_${upper}_DATE`] ? parseDate(env[`GIT_${upper}_DATE`] || "") : undefined;
	return {
		name: name as string,
		email: email as string,
		timestamp: date?.timestamp ?? Math.floor(Date.now() / 1000),
		timezoneOffset: date?.timezoneOffset ?? new Date().getTimezoneOffset(),
	} satisfies Identity;
}

export function formatIdent(who: Identity): string {
	const n = Math.abs(who.timezoneOffset);
	return `${who.name} <${who.email}> ${who.timestamp} ${who.timezoneOffset > 0 ? "-" : "+"}${String(Math.floor(n / 60)).padStart(2, "0")}${String(n % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- refs

/** Append to a reflog the way git does for operations this adapter performs. */
export async function logRef(
	repo: Repo,
	ref: string,
	from: string | undefined,
	to: string,
	message: string,
): Promise<void> {
	let who: Identity;
	try {
		who = await identity(repo, repo.ctx, "committer");
	} catch {
		return;
	}
	const line = `${from || ZERO_OID} ${to} ${formatIdent(who)}\t${message.split("\n")[0]}\n`;
	const targets = [ref];
	const head = read(repo, "HEAD")?.trim();
	if (ref !== "HEAD" && head === `ref: ${ref}`) targets.push("HEAD");
	for (const target of targets) {
		const file = path.join(repo.gitdir, "logs", target);
		repo.fs.mkdirSync(path.dirname(file), { recursive: true });
		repo.fs.appendFileSync(file, line);
	}
}

/** Update a ref, record it in the reflog and refuse a racing update. */
export async function updateRef(
	repo: Repo,
	ref: string,
	value: string,
	message: string,
	expected?: string,
): Promise<void> {
	const before = await tryResolve(repo, ref);
	if (expected !== undefined && (before ?? ZERO_OID) !== expected)
		fail(`cannot lock ref '${ref}': is at ${before ?? ZERO_OID} but expected ${expected}`);
	await git.writeRef({ fs: repo.fs, gitdir: repo.gitdir, ref, value, force: true });
	await logRef(repo, ref, before, value, message);
}

export async function tryResolve(repo: Repo, ref: string): Promise<string | undefined> {
	try {
		return await git.resolveRef({ fs: repo.fs, gitdir: repo.gitdir, ref });
	} catch {
		return;
	}
}

export async function headRef(repo: Repo): Promise<string | undefined> {
	const value = read(repo, "HEAD")?.trim();
	return value?.startsWith("ref: ") ? value.slice(5) : undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: git check-ref-format rejects control bytes.
const BAD_REF = /(^|\/)\.|\.\.|[\x00-\x20~^:?*[\\\x7f]|@\{|\/\/|\/$|\.lock$|\.$|^-|^@$/;
export const isValidRefName = (name: string) => !!name && !BAD_REF.test(name);

export async function upstreamOf(repo: Repo, branch: string) {
	const remote = await configGet(repo.ctx, repo, `branch.${branch}.remote`);
	const merge = await configGet(repo.ctx, repo, `branch.${branch}.merge`);
	if (!remote || !merge?.startsWith("refs/heads/")) return;
	return {
		remote,
		merge,
		ref: remote === "." ? merge : `refs/remotes/${remote}/${merge.slice(11)}`,
	};
}

// ---------------------------------------------------------------- revisions

export async function readObjectType(repo: Repo, oid: string): Promise<string> {
	if (oid === EMPTY_TREE) return "tree";
	const { type } = await git.readObject({
		fs: repo.fs,
		gitdir: repo.gitdir,
		oid,
		cache: repo.cache,
		format: "content",
	});
	return type;
}

async function peel(repo: Repo, oid: string, want?: string): Promise<string> {
	for (let i = 0; i < 32; i++) {
		if (oid === EMPTY_TREE) {
			if (!want || want === "tree") return oid;
			return fail(`${oid} is a tree, not a ${want}`);
		}
		const object = await git.readObject({
			fs: repo.fs,
			gitdir: repo.gitdir,
			oid,
			cache: repo.cache,
			format: "parsed",
		});
		if (want === undefined || object.type === want) return oid;
		if (object.type === "tag") oid = (object.object as git.TagObject).object;
		else if (object.type === "commit" && want === "tree")
			oid = (object.object as git.CommitObject).tree;
		else return fail(`object ${oid} is a ${object.type}, not a ${want}`);
	}
	return fail("tag chain too long");
}

async function resolveBase(repo: Repo, name: string): Promise<string | undefined> {
	if (name === "@" || name === "") name = "HEAD";
	if (/^[0-9a-f]{40}$/i.test(name)) return name.toLowerCase();
	const upstream = /^(.*)@\{(?:upstream|u|push)\}$/i.exec(name);
	if (upstream) {
		const branch = upstream[1]
			? upstream[1].replace(/^refs\/heads\//, "")
			: (await headRef(repo))?.replace(/^refs\/heads\//, "");
		if (!branch) return fail("HEAD does not point to a branch");
		const up = await upstreamOf(repo, branch);
		if (!up) return fail(`no upstream configured for branch '${branch}'`);
		return tryResolve(repo, up.ref);
	}
	const candidates = name.startsWith("refs/")
		? [name]
		: name === "HEAD" || /^[A-Z_]+_HEAD$/.test(name)
			? [name]
			: [
					name,
					`refs/${name}`,
					`refs/tags/${name}`,
					`refs/heads/${name}`,
					`refs/remotes/${name}`,
					`refs/remotes/${name}/HEAD`,
				];
	for (const ref of candidates) {
		if (ref !== "HEAD" && !/^[A-Z_]+$/.test(ref) && !ref.startsWith("refs/")) continue;
		const oid = await tryResolve(repo, ref);
		if (oid) return oid;
	}
	if (/^[0-9a-f]{4,39}$/i.test(name)) {
		try {
			return await git.expandOid({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid: name.toLowerCase(),
				cache: repo.cache,
			});
		} catch {
			return;
		}
	}
}

/** Resolve `rev`, `rev^n`, `rev~n`, `rev^{type}`, `rev:path`, `:path`. */
export async function resolveRevision(repo: Repo, spec: string): Promise<string | undefined> {
	if (spec.startsWith(":")) {
		const match = /^:(?:([0-3]):)?(.*)$/.exec(spec);
		const stage = Number(match?.[1] || 0);
		const file = match?.[2] || "";
		const entries = await readIndex(repo);
		const entry = entries.find((e) => e.path === file && e.stage === stage);
		return entry?.oid;
	}
	const colon = spec.indexOf(":");
	if (colon > 0) {
		const commit = await resolveRevision(repo, spec.slice(0, colon));
		if (!commit) return;
		const tree = await peel(repo, commit, "tree");
		const file = spec.slice(colon + 1).replace(/^\.\//, "");
		if (!file) return tree;
		try {
			const { oid } = await git
				.readTree({
					fs: repo.fs,
					gitdir: repo.gitdir,
					oid: tree,
					filepath: path.dirname(file) === "." ? undefined : path.dirname(file),
					cache: repo.cache,
				})
				.then(({ tree: entries }) => {
					const entry = entries.find((e) => e.path === path.basename(file));
					if (!entry) throw new Error("missing");
					return entry;
				});
			return oid;
		} catch {
			return;
		}
	}
	const match = /^(.*?)((?:\^\{[a-z]*\}|\^\d*|~\d*)*)$/.exec(spec);
	const base = match?.[1] ?? spec;
	let oid = await resolveBase(repo, base);
	if (!oid) return;
	for (const op of (match?.[2] || "").match(/\^\{[a-z]*\}|\^\d*|~\d*/g) || []) {
		if (op.startsWith("^{")) {
			const type = op.slice(2, -1);
			oid = await peel(repo, oid, type || undefined);
			if (!type) {
				let object = await git.readObject({
					fs: repo.fs,
					gitdir: repo.gitdir,
					oid,
					cache: repo.cache,
					format: "parsed",
				});
				while (object.type === "tag") {
					oid = (object.object as git.TagObject).object;
					object = await git.readObject({
						fs: repo.fs,
						gitdir: repo.gitdir,
						oid,
						cache: repo.cache,
						format: "parsed",
					});
				}
			}
			continue;
		}
		const count = op.length > 1 ? Number(op.slice(1)) : 1;
		const commitOid = await peel(repo, oid, "commit");
		if (op.startsWith("^")) {
			if (count === 0) {
				oid = commitOid;
				continue;
			}
			const { commit } = await readCommit(repo, commitOid);
			const parent = commit.parent[count - 1];
			if (!parent) return;
			oid = parent;
		} else {
			oid = commitOid;
			for (let i = 0; i < count; i++) {
				const { commit } = await readCommit(repo, oid);
				const parent = commit.parent[0];
				if (!parent) return;
				oid = parent;
			}
		}
	}
	return oid;
}

export async function resolveCommit(repo: Repo, spec: string): Promise<string | undefined> {
	const oid = await resolveRevision(repo, spec);
	if (!oid) return;
	try {
		return await peel(repo, oid, "commit");
	} catch {
		return;
	}
}

export async function readCommit(repo: Repo, oid: string) {
	return git.readCommit({ fs: repo.fs, gitdir: repo.gitdir, oid, cache: repo.cache });
}

export async function findMergeBase(repo: Repo, a: string, b: string) {
	const bases = await git.findMergeBase({
		fs: repo.fs,
		gitdir: repo.gitdir,
		oids: [a, b],
		cache: repo.cache,
	});
	return bases[0] as string | undefined;
}

/** All commits reachable from `from`, bounded. */
export async function reachable(repo: Repo, from: string[], limit = 200_000): Promise<Set<string>> {
	const seen = new Set<string>();
	const queue = [...from];
	while (queue.length) {
		const oid = queue.pop() as string;
		if (seen.has(oid)) continue;
		if (seen.size >= limit) fail("history exceeds the commit walk limit");
		seen.add(oid);
		repo.ctx.io.signal.throwIfAborted();
		const { commit } = await readCommit(repo, oid);
		for (const parent of commit.parent) if (!seen.has(parent)) queue.push(parent);
	}
	return seen;
}

/** Walk commits from `include` excluding ancestors of `exclude`, newest
 * committer date first (git's default order). */
export async function walkCommits(
	repo: Repo,
	include: string[],
	exclude: string[],
	options: { firstParent?: boolean; limit?: number } = {},
): Promise<{ oid: string; commit: git.CommitObject }[]> {
	const hidden = exclude.length ? await reachable(repo, exclude) : new Set<string>();
	const result: { oid: string; commit: git.CommitObject }[] = [];
	const seen = new Set<string>();
	const queue: { oid: string; commit: git.CommitObject }[] = [];
	const push = async (oid: string) => {
		if (seen.has(oid) || hidden.has(oid)) return;
		seen.add(oid);
		const { commit } = await readCommit(repo, oid);
		// Keep the queue sorted ascending; pop() takes the newest commit.
		let lo = 0,
			hi = queue.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (
				(queue[mid] as { commit: git.CommitObject }).commit.committer.timestamp <=
				commit.committer.timestamp
			)
				lo = mid + 1;
			else hi = mid;
		}
		queue.splice(lo, 0, { oid, commit });
	};
	for (const oid of include) await push(oid);
	while (queue.length) {
		repo.ctx.io.signal.throwIfAborted();
		const next = queue.pop() as { oid: string; commit: git.CommitObject };
		result.push(next);
		if (options.limit !== undefined && result.length >= options.limit) break;
		if (result.length > 200_000) fail("history exceeds the commit walk limit");
		const parents = options.firstParent ? next.commit.parent.slice(0, 1) : next.commit.parent;
		for (const parent of parents) await push(parent);
	}
	return result;
}

export async function readBlob(repo: Repo, oid: string): Promise<Uint8Array> {
	const { blob } = await git.readBlob({
		fs: repo.fs,
		gitdir: repo.gitdir,
		oid,
		cache: repo.cache,
	});
	return blob;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
	oid: string;
	mode: string;
}

/** Flatten a tree to path → blob entries (gitlinks are kept as mode 160000). */
export async function flattenTree(
	repo: Repo,
	treeOid: string | undefined,
	limit = MAX_ENTRIES,
): Promise<Map<string, TreeEntry>> {
	const result = new Map<string, TreeEntry>();
	if (!treeOid || treeOid === EMPTY_TREE) return result;
	const visit = async (oid: string, prefix: string, depth: number) => {
		if (depth > 64) fail("tree exceeds depth limit");
		const { tree } = await git.readTree({
			fs: repo.fs,
			gitdir: repo.gitdir,
			oid,
			cache: repo.cache,
		});
		for (const entry of tree) {
			repo.ctx.io.signal.throwIfAborted();
			const name = prefix + entry.path;
			if (entry.type === "tree") await visit(entry.oid, `${name}/`, depth + 1);
			else {
				if (result.size >= limit) fail(`tree exceeds ${limit} entries`);
				result.set(name, { oid: entry.oid, mode: entry.mode });
			}
		}
	};
	await visit(treeOid, "", 0);
	return result;
}

export async function commitTree(repo: Repo, commit: string | undefined) {
	if (!commit) return new Map<string, TreeEntry>();
	return flattenTree(repo, (await readCommit(repo, commit)).commit.tree);
}

/** Build tree objects from a flat path → entry map. */
export async function writeTreeFromEntries(
	repo: Repo,
	entries: Iterable<[string, TreeEntry]>,
): Promise<string> {
	interface Node {
		files: Map<string, TreeEntry>;
		dirs: Map<string, Node>;
	}
	const root: Node = { files: new Map(), dirs: new Map() };
	for (const [file, entry] of entries) {
		const parts = file.split("/");
		const name = parts.pop() as string;
		let node = root;
		for (const part of parts) {
			let next = node.dirs.get(part);
			if (!next) {
				next = { files: new Map(), dirs: new Map() };
				node.dirs.set(part, next);
			}
			node = next;
		}
		node.files.set(name, entry);
	}
	const write = async (node: Node): Promise<string> => {
		const tree: git.TreeEntry[] = [];
		for (const [name, entry] of node.files)
			tree.push({
				mode: entry.mode,
				path: name,
				oid: entry.oid,
				type: entry.mode === "160000" ? "commit" : "blob",
			});
		for (const [name, child] of node.dirs)
			tree.push({ mode: "040000", path: name, oid: await write(child), type: "tree" });
		return git.writeTree({ fs: repo.fs, gitdir: repo.gitdir, tree });
	};
	return write(root);
}

// ---------------------------------------------------------------- index

export interface IndexEntry {
	path: string;
	oid: string;
	mode: string;
	stage: number;
	mtimeMs: number;
	size: number;
}

const indexFs = (repo: Repo) => new FileSystem(repo.fs);

export async function readIndex(repo: Repo): Promise<IndexEntry[]> {
	if (!repo.fs.existsSync(path.join(repo.gitdir, "index"))) return [];
	return GitIndexManager.acquire(
		{ fs: indexFs(repo), gitdir: repo.gitdir, cache: repo.cache },
		async (index: { entriesFlat: Record<string, unknown>[] }) =>
			index.entriesFlat.map((e) => ({
				path: String(e.path),
				oid: String(e.oid),
				mode: Number(e.mode).toString(8),
				stage: Number((e.flags as { stage: number }).stage),
				mtimeMs:
					Number(e.mtimeSeconds) * 1000 + Math.floor(Number(e.mtimeNanoseconds) / 1e6),
				size: Number(e.size),
			})),
	);
}

export interface IndexWriter {
	insert(
		file: string,
		oid: string,
		mode: string,
		stats?: { mtimeMs: number; size: number },
	): void;
	remove(file: string): void;
	clear(): void;
	has(file: string): boolean;
}

/** Mutate the index under isomorphic-git's lock; written once at the end. */
export async function editIndex<T>(
	repo: Repo,
	closure: (index: IndexWriter) => Promise<T>,
): Promise<T> {
	return GitIndexManager.acquire(
		{ fs: indexFs(repo), gitdir: repo.gitdir, cache: repo.cache },
		async (index: {
			insert(entry: object): void;
			delete(entry: object): void;
			clear(): void;
			has(entry: object): boolean;
			_dirty: boolean;
		}) =>
			closure({
				insert: (filepath, oid, mode, stats) => {
					const ms = stats?.mtimeMs ?? 0;
					index.insert({
						filepath,
						oid,
						stats: {
							mtimeSeconds: Math.floor(ms / 1000),
							mtimeNanoseconds: Math.round((ms % 1000) * 1e6),
							ctimeSeconds: Math.floor(ms / 1000),
							ctimeNanoseconds: Math.round((ms % 1000) * 1e6),
							size: stats?.size ?? 0,
							mode: Number.parseInt(mode, 8),
							dev: 0,
							ino: 0,
							uid: 0,
							gid: 0,
						},
					});
				},
				remove: (filepath) => index.delete({ filepath }),
				clear: () => index.clear(),
				has: (filepath) => index.has({ filepath }),
			}),
	);
}

// ---------------------------------------------------------------- paths

/** Convert a pathspec argument to a repository-relative path. */
export function repoPath(repo: Repo, cwd: string, value: string): string {
	let spec = value;
	const magic = /^:\(([^)]*)\)(.*)$/.exec(spec);
	let top = false;
	if (magic) {
		const words = (magic[1] || "").split(",");
		if (words.some((w) => !["top", "literal"].includes(w))) unsupported("pathspec");
		top = words.includes("top");
		spec = magic[2] || "";
	}
	const normalized = repo.ctx.vfs.normalizePath(spec);
	const absolute = path.isAbsolute(normalized)
		? normalized
		: path.resolve(top ? repo.dir : cwd, normalized);
	const relative = path.relative(repo.dir, absolute);
	if (relative.startsWith("..")) fail(`'${value}' is outside repository at '${repo.dir}'`);
	return relative === "" ? "." : relative;
}

const C_ESCAPES: Record<number, string> = {
	7: "\\a",
	8: "\\b",
	9: "\\t",
	10: "\\n",
	11: "\\v",
	12: "\\f",
	13: "\\r",
	34: '\\"',
	92: "\\\\",
};

/** Git's C-style path quoting (core.quotepath=true) for non -z output. */
export function quotePath(file: string): string {
	const data = Buffer.from(file);
	if (!data.some((b) => b < 0x20 || b === 0x22 || b === 0x5c || b >= 0x7f)) return file;
	let quoted = "";
	for (const b of data)
		quoted +=
			C_ESCAPES[b] ??
			(b < 0x20 || b >= 0x7f
				? `\\${b.toString(8).padStart(3, "0")}`
				: String.fromCharCode(b));
	return `"${quoted}"`;
}

export const inPathspec = (file: string, specs: string[]) =>
	!specs.length ||
	specs.some((s) => s === "." || file === s || file.startsWith(s.endsWith("/") ? s : `${s}/`));

/** The subset of fs.Stats this CLI reads (memfs types it as bigint-capable). */
export interface Stat {
	mode: number;
	size: number;
	mtimeMs: number;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}
export function lstat(repo: { fs: VirtualFileSystem["fs"] }, file: string): Stat | undefined {
	try {
		return repo.fs.lstatSync(file) as unknown as Stat;
	} catch {
		return;
	}
}

/** An index mode as git canonicalizes it (create_ce_mode). */
export function canonicalMode(value: string): string {
	const mode = Number.parseInt(value, 8);
	const type = mode & 0o170000;
	if (type === 0o120000) return "120000";
	if (type === 0o160000) return "160000";
	if (type === 0o100000 || type === 0) return mode & 0o100 ? "100755" : "100644";
	return fail(`invalid mode ${value}`);
}

/** git's verify_path: no empty, `.`, `..` or `.git` components. */
export const isValidPath = (file: string) =>
	!!file &&
	!/[\0\\]/.test(file) &&
	file
		.split("/")
		.every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

export function modeOf(stat: { mode: number; isSymbolicLink(): boolean }): string {
	if (stat.isSymbolicLink()) return "120000";
	return stat.mode & 0o111 ? "100755" : "100644";
}

export function bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? new Uint8Array(Buffer.from(value)) : value;
}
