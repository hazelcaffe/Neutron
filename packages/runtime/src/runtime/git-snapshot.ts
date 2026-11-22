import * as git from "isomorphic-git";
import path from "path-browserify";
import { LfsFilter } from "./git-lfs";
import { IgnoreRules } from "./git-patterns";
import {
	configBool,
	configGet,
	fail,
	flattenTree,
	type IndexEntry,
	lstat,
	MAX_BLOB,
	MAX_ENTRIES,
	modeOf,
	type Repo,
	readBlob,
	readIndex,
} from "./git-repo";

/** One side of a comparison. `oid()` may hash worktree content lazily. */
export interface SnapshotEntry {
	mode: string;
	/** Object id when known without reading content (trees, index, clean stat). */
	known?: string;
	oid(): Promise<string>;
	data(): Promise<Uint8Array>;
	/** Worktree entries print a zero object id in raw diff output. */
	worktree?: boolean;
}
export type Snapshot = Map<string, SnapshotEntry>;

export function treeSnapshot(repo: Repo, entries: Map<string, { oid: string; mode: string }>) {
	const snapshot: Snapshot = new Map();
	for (const [file, { oid, mode }] of entries)
		snapshot.set(file, {
			mode,
			known: oid,
			oid: async () => oid,
			data: () =>
				mode === "160000" ? Promise.resolve(new Uint8Array()) : readBlob(repo, oid),
		});
	return snapshot;
}

export async function commitSnapshot(repo: Repo, commit: string | undefined): Promise<Snapshot> {
	if (!commit) return new Map();
	const { commit: object } = await git.readCommit({
		fs: repo.fs,
		gitdir: repo.gitdir,
		oid: commit,
		cache: repo.cache,
	});
	return treeSnapshot(repo, await flattenTree(repo, object.tree));
}

export function indexSnapshot(repo: Repo, entries: IndexEntry[]): Snapshot {
	return treeSnapshot(
		repo,
		new Map(
			entries.filter((e) => e.stage === 0).map((e) => [e.path, { oid: e.oid, mode: e.mode }]),
		),
	);
}

/** Stat-only change test against an index entry (mtime/size/mode). */
export function statClean(entry: IndexEntry, stat: { mtimeMs: number; size: number }) {
	return Math.floor(Number(stat.mtimeMs)) === entry.mtimeMs && Number(stat.size) === entry.size;
}

export interface Worktree {
	snapshot: Snapshot;
	filter: LfsFilter;
	fileMode: boolean;
}

/** Tracked worktree files (paths in the index). Missing files are absent. */
export async function worktreeSnapshot(repo: Repo, entries?: IndexEntry[]): Promise<Worktree> {
	const index = entries ?? (await readIndex(repo));
	const filter = await LfsFilter.load(repo);
	const fileMode = configBool(await configGet(repo.ctx, repo, "core.filemode")) ?? true;
	const snapshot: Snapshot = new Map();
	const seen = new Set<string>();
	for (const entry of index) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		const file = path.join(repo.dir, entry.path);
		const stat = lstat(repo, file);
		if (!stat) continue;
		if (entry.mode === "160000") {
			if (!stat.isDirectory()) continue;
			snapshot.set(entry.path, {
				mode: "160000",
				known: entry.oid,
				oid: async () => entry.oid,
				data: async () => new Uint8Array(),
				worktree: true,
			});
			continue;
		}
		if (!stat.isFile() && !stat.isSymbolicLink()) continue;
		let mode = modeOf(stat);
		if (!fileMode && mode !== "120000" && entry.mode !== "120000") mode = entry.mode;
		const stage0 = entry.stage === 0;
		const clean = stage0 && statClean(entry, stat) && mode === entry.mode;
		let content: Promise<Uint8Array> | undefined;
		let hash: Promise<string> | undefined;
		const data = () => {
			content ??= (async () => {
				if (stat.isSymbolicLink())
					return new TextEncoder().encode(String(repo.fs.readlinkSync(file)));
				if (Number(stat.size) > MAX_BLOB) fail(`${entry.path} exceeds the blob size limit`);
				return new Uint8Array(repo.fs.readFileSync(file) as Uint8Array);
			})();
			return content;
		};
		snapshot.set(entry.path, {
			mode,
			known: clean ? entry.oid : undefined,
			worktree: true,
			data,
			oid: () => {
				hash ??= clean
					? Promise.resolve(entry.oid)
					: data()
							.then((bytes) => filter.clean(entry.path, bytes, false))
							.then(async (object) => (await git.hashBlob({ object })).oid);
				return hash;
			},
		});
	}
	return { snapshot, filter, fileMode };
}

/** The blob content git stores for a worktree file (after the clean filter). */
export async function cleanData(worktree: Worktree, file: string): Promise<Uint8Array> {
	const entry = worktree.snapshot.get(file);
	if (!entry) return new Uint8Array();
	return worktree.filter.clean(file, await entry.data(), false);
}

export interface UntrackedOptions {
	/** Report wholly untracked directories as `dir/` like git's default mode. */
	collapse: boolean;
	ignored?: string[];
}

/** Untracked, non-ignored files below the repository root. */
export async function untrackedFiles(
	repo: Repo,
	tracked: Set<string>,
	options: UntrackedOptions = { collapse: false },
): Promise<string[]> {
	const rules = await IgnoreRules.load(repo);
	const trackedDirs = new Set<string>();
	for (const file of tracked)
		for (let dir = path.dirname(file); dir !== "."; dir = path.dirname(dir))
			trackedDirs.add(dir);
	const result: string[] = [];
	let count = 0;
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = (
				repo.fs.readdirSync(dir ? path.join(repo.dir, dir) : repo.dir) as string[]
			).sort();
		} catch {
			return;
		}
		for (const name of names) {
			repo.ctx.io.signal.throwIfAborted();
			if (++count > MAX_ENTRIES) fail(`working tree exceeds ${MAX_ENTRIES} entries`);
			const rel = dir ? `${dir}/${name}` : name;
			if (!dir && name === ".git") continue;
			const stat = lstat(repo, path.join(repo.dir, rel));
			if (!stat) continue;
			const directory = stat.isDirectory();
			if (tracked.has(rel)) continue;
			if (rules.ignored(rel, directory)) {
				if (options.ignored) options.ignored.push(directory ? `${rel}/` : rel);
				continue;
			}
			if (directory) {
				// A nested repository is reported as an untracked directory.
				if (repo.fs.existsSync(path.join(repo.dir, rel, ".git"))) {
					result.push(`${rel}/`);
					continue;
				}
				if (options.collapse && !trackedDirs.has(rel)) {
					const before = result.length;
					walk(rel);
					if (result.length > before) {
						result.splice(before);
						result.push(`${rel}/`);
					}
				} else walk(rel);
			} else result.push(rel);
		}
	};
	walk("");
	return result;
}
