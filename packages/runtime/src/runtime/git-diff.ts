import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import path from "path-browserify";
import {
	EMPTY_TREE,
	fail,
	findMergeBase,
	flattenTree,
	inPathspec,
	MAX_BLOB,
	type Repo,
	readBlob,
	readIndex,
	repoPath,
	resolveCommit,
	resolveRevision,
	unsupported,
} from "./git-repo";
import {
	commitSnapshot,
	indexSnapshot,
	type Snapshot,
	type SnapshotEntry,
	treeSnapshot,
	worktreeSnapshot,
} from "./git-snapshot";

// ---------------------------------------------------------------- line diff

type Op = 0 | 1 | 2; // equal, delete, insert
const MAX_EDIT = 2000;

export interface Lines {
	text: string[];
	/** The last line has no trailing newline. */
	noEol: boolean;
}

export function splitLines(data: Uint8Array): Lines {
	const text = Buffer.from(data).toString("latin1");
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
	const noEol = !!lines.length && !text.endsWith("\n");
	return { text: lines.map((l) => (l.endsWith("\n") ? l.slice(0, -1) : l)), noEol };
}

export const isBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0);

/** Myers' O(ND) shortest edit script; long scripts fall back to replacing
 * the differing middle, which is still a correct (non-minimal) diff. */
function editScript(a: string[], b: string[]): Op[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length,
		endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const n = endA - start,
		m = endB - start;
	const ops: Op[] = new Array(start).fill(0);
	ops.push(...myers(n, m, (x, y) => a[start + x] === b[start + y]));
	for (let i = endA; i < a.length; i++) ops.push(0);
	return ops;
}

function myers(n: number, m: number, same: (x: number, y: number) => boolean): Op[] {
	if (!n) return new Array(m).fill(2);
	if (!m) return new Array(n).fill(1);
	const max = Math.min(n + m, MAX_EDIT);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	// trace[d] holds v[k] for k in [-d-1, d+1] as it was before round d.
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d ||
				(k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
					? (v[offset + k + 1] as number)
					: (v[offset + k - 1] as number) + 1;
			let y = x - k;
			while (x < n && y < m && same(x, y)) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return backtrack(trace, n, m);
		}
	}
	return [...new Array(n).fill(1), ...new Array(m).fill(2)];
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
	const result: Op[] = [];
	let x = n,
		y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const frontier = trace[d] as Int32Array;
		const at = (k: number) => frontier[k + d + 1] as number;
		const k = x - y;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			result.push(0);
			x--;
			y--;
		}
		if (d > 0) result.push(x === prevX ? 2 : 1);
		x = prevX;
		y = prevY;
	}
	return result.reverse();
}

export interface DiffOptions {
	ignoreWhitespace?: boolean;
	context?: number;
}

/** Line counts for --numstat: [added, deleted]. */
export function countChanges(left: Uint8Array, right: Uint8Array, opts: DiffOptions = {}) {
	const a = splitLines(left),
		b = splitLines(right);
	const key = (l: string) => (opts.ignoreWhitespace ? l.replace(/\s+/g, "") : l);
	const ops = editScript(markEol(a).map(key), markEol(b).map(key));
	let added = 0,
		deleted = 0;
	for (const op of ops) {
		if (op === 1) deleted++;
		else if (op === 2) added++;
	}
	return [added, deleted] as const;
}

const markEol = (lines: Lines) =>
	lines.noEol ? [...lines.text.slice(0, -1), `${lines.text.at(-1)}\u0000noeol`] : lines.text;

/** Unified diff hunks (without file headers). */
export function hunks(left: Uint8Array, right: Uint8Array, opts: DiffOptions = {}): string {
	const context = opts.context ?? 3;
	const a = splitLines(left),
		b = splitLines(right);
	const key = (l: string) => (opts.ignoreWhitespace ? l.replace(/\s+/g, "") : l);
	const ops = editScript(markEol(a).map(key), markEol(b).map(key));
	const rows: [Op, number, number][] = [];
	let x = 0,
		y = 0;
	for (const op of ops) {
		rows.push([op, x, y]);
		if (op !== 2) x++;
		if (op !== 1) y++;
	}
	const changed = (i: number) => rows[i]?.[0] !== 0;
	const out: string[] = [];
	let i = 0;
	while (i < rows.length) {
		while (i < rows.length && !changed(i)) i++;
		if (i >= rows.length) break;
		const from = Math.max(0, i - context);
		let end = i;
		for (;;) {
			while (end < rows.length && changed(end)) end++;
			let next = end;
			while (next < rows.length && !changed(next)) next++;
			if (next < rows.length && next - end <= 2 * context) end = next;
			else break;
		}
		const to = Math.min(rows.length, end + context);
		const slice = rows.slice(from, to);
		const oldStart = slice[0]?.[1] ?? 0,
			newStart = slice[0]?.[2] ?? 0;
		const oldCount = slice.filter((r) => r[0] !== 2).length;
		const newCount = slice.filter((r) => r[0] !== 1).length;
		const range = (index: number, count: number) =>
			count === 1 ? `${index + 1}` : `${count ? index + 1 : index},${count}`;
		// git's default funcname: the nearest preceding line that starts with a
		// letter, `_` or `$`.
		let funcname = "";
		for (let k = oldStart - 1; k >= 0; k--) {
			const line = a.text[k] as string;
			if (/^[A-Za-z_$]/.test(line)) {
				funcname = ` ${line.slice(0, 80).trimEnd()}`;
				break;
			}
		}
		out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${funcname}\n`);
		for (const [op, ox, ny] of slice) {
			const line = op === 2 ? b.text[ny] : a.text[ox];
			out.push(`${op === 0 ? " " : op === 1 ? "-" : "+"}${line}\n`);
			const missing =
				op === 2
					? b.noEol && ny === b.text.length - 1
					: a.noEol && ox === a.text.length - 1;
			if (missing) out.push("\\ No newline at end of file\n");
		}
		i = to;
	}
	return out.join("");
}

// ---------------------------------------------------------------- tree diff

export interface Change {
	status: "A" | "D" | "M" | "T" | "R" | "C";
	oldPath: string;
	newPath: string;
	old?: SnapshotEntry;
	new?: SnapshotEntry;
	score?: number;
}

export interface CompareOptions {
	renames?: boolean;
	copies?: boolean;
	paths?: string[];
}

async function similarity(a: Uint8Array, b: Uint8Array): Promise<number> {
	if (isBinary(a) || isBinary(b)) return 0;
	const count = new Map<string, number>();
	for (const line of splitLines(a).text)
		count.set(line, (count.get(line) || 0) + line.length + 1);
	let common = 0;
	for (const line of splitLines(b).text) {
		const left = count.get(line) || 0;
		if (left > 0) {
			common += line.length + 1;
			count.set(line, left - line.length - 1);
		}
	}
	return Math.floor((common * 100) / Math.max(a.length, b.length, 1));
}

/** Compare two snapshots like git diff-tree/diff-index (sorted by path). */
export async function compare(
	before: Snapshot,
	after: Snapshot,
	opts: CompareOptions = {},
): Promise<Change[]> {
	const paths = new Set<string>();
	for (const file of [...before.keys(), ...after.keys()])
		if (inPathspec(file, opts.paths || [])) paths.add(file);
	const changes: Change[] = [];
	for (const file of [...paths].sort()) {
		const a = before.get(file),
			b = after.get(file);
		if (a && b) {
			if (a.mode !== b.mode && (a.mode === "120000") !== (b.mode === "120000"))
				changes.push({ status: "T", oldPath: file, newPath: file, old: a, new: b });
			else if (a.mode !== b.mode || (await a.oid()) !== (await b.oid()))
				changes.push({ status: "M", oldPath: file, newPath: file, old: a, new: b });
		} else if (a) changes.push({ status: "D", oldPath: file, newPath: file, old: a });
		else if (b) changes.push({ status: "A", oldPath: file, newPath: file, new: b });
	}
	if (!opts.renames && !opts.copies) return changes;
	const added = changes.filter((c) => c.status === "A");
	const deleted = changes.filter((c) => c.status === "D");
	if (!added.length) return changes;
	const removed = new Set<Change>();
	const result = [...changes];
	// Exact renames first, then content similarity for bounded candidates.
	for (const add of added) {
		const oid = await add.new?.oid();
		const source = deleted.find(
			(d) => !removed.has(d) && d.old?.known !== undefined && d.old.known === oid,
		);
		if (source) {
			removed.add(source);
			removed.add(add);
			result.push({
				status: "R",
				score: 100,
				oldPath: source.oldPath,
				newPath: add.newPath,
				old: source.old,
				new: add.new,
			});
		}
	}
	const remainingAdds = added.filter((a) => !removed.has(a));
	const remainingDeletes = deleted.filter((d) => !removed.has(d));
	if (
		remainingAdds.length &&
		remainingDeletes.length &&
		remainingAdds.length * remainingDeletes.length <= 400
	) {
		const candidates: [number, Change, Change][] = [];
		for (const add of remainingAdds)
			for (const del of remainingDeletes) {
				const [x, y] = await Promise.all([del.old?.data(), add.new?.data()]);
				if (!x || !y || x.length > 1024 * 1024 || y.length > 1024 * 1024) continue;
				const score = await similarity(x, y);
				if (score >= 50) candidates.push([score, del, add]);
			}
		candidates.sort((p, q) => q[0] - p[0]);
		for (const [score, del, add] of candidates) {
			if (removed.has(del) || removed.has(add)) continue;
			removed.add(del);
			removed.add(add);
			result.push({
				status: "R",
				score,
				oldPath: del.oldPath,
				newPath: add.newPath,
				old: del.old,
				new: add.new,
			});
		}
	}
	if (opts.copies)
		for (const add of added.filter((a) => !removed.has(a))) {
			const oid = await add.new?.oid();
			const source = changes.find(
				(c) => c.status === "M" && c.old?.known !== undefined && c.old.known === oid,
			);
			if (source) {
				removed.add(add);
				result.push({
					status: "C",
					score: 100,
					oldPath: source.oldPath,
					newPath: add.newPath,
					old: source.old,
					new: add.new,
				});
			}
		}
	return result
		.filter((c) => !removed.has(c))
		.sort((p, q) => (p.newPath < q.newPath ? -1 : p.newPath > q.newPath ? 1 : 0));
}

// ---------------------------------------------------------------- output

const abbrev = (oid: string | undefined) => (oid || "0".repeat(40)).slice(0, 7);
const ZERO7 = "0000000";

async function rawOid(entry: SnapshotEntry | undefined) {
	if (!entry) return ZERO7;
	if (entry.worktree && entry.known === undefined) return ZERO7;
	return abbrev(await entry.oid());
}

export async function formatRaw(changes: Change[], z: boolean): Promise<string> {
	const out: string[] = [];
	for (const c of changes) {
		const status =
			c.score !== undefined ? `${c.status}${String(c.score).padStart(3, "0")}` : c.status;
		const head = `:${c.old?.mode ?? "000000"} ${c.new?.mode ?? "000000"} ${await rawOid(c.old)} ${await rawOid(c.new)} ${status}`;
		const names = c.status === "R" || c.status === "C" ? [c.oldPath, c.newPath] : [c.newPath];
		out.push(z ? `${head}\0${names.join("\0")}\0` : `${head}\t${names.join("\t")}\n`);
	}
	return out.join("");
}

async function contents(
	entry: SnapshotEntry | undefined,
	filter?: (file: string, data: Uint8Array) => Promise<Uint8Array>,
	file?: string,
) {
	if (!entry) return new Uint8Array();
	const data = await entry.data();
	if (data.length > MAX_BLOB) fail("blob exceeds the diff size limit");
	return filter && file ? filter(file, data) : data;
}

export interface OutputOptions extends DiffOptions {
	/** Worktree content passes the clean filter before comparison (LFS). */
	clean?: (file: string, data: Uint8Array) => Promise<Uint8Array>;
}

export async function formatNumstat(changes: Change[], z: boolean, opts: OutputOptions = {}) {
	const out: string[] = [];
	for (const c of changes) {
		const left = await contents(c.old, c.old?.worktree ? opts.clean : undefined, c.oldPath);
		const right = await contents(c.new, c.new?.worktree ? opts.clean : undefined, c.newPath);
		const counts =
			c.old?.mode === "160000" || c.new?.mode === "160000"
				? "1\t1"
				: isBinary(left) || isBinary(right)
					? "-\t-"
					: countChanges(left, right, opts).join("\t");
		const renamed = c.status === "R" || c.status === "C";
		if (z)
			out.push(
				renamed ? `${counts}\t\0${c.oldPath}\0${c.newPath}\0` : `${counts}\t${c.newPath}\0`,
			);
		else out.push(`${counts}\t${renamed ? `${c.oldPath} => ${c.newPath}` : c.newPath}\n`);
	}
	return out.join("");
}

export async function formatPatch(changes: Change[], opts: OutputOptions = {}): Promise<string> {
	const out: string[] = [];
	for (const c of changes) {
		const oldName = `a/${c.oldPath}`,
			newName = `b/${c.newPath}`;
		out.push(`diff --git ${oldName} ${newName}\n`);
		if (c.status === "A") out.push(`new file mode ${c.new?.mode}\n`);
		else if (c.status === "D") out.push(`deleted file mode ${c.old?.mode}\n`);
		else if (c.old?.mode !== c.new?.mode)
			out.push(`old mode ${c.old?.mode}\nnew mode ${c.new?.mode}\n`);
		if (c.status === "R" || c.status === "C") {
			const verb = c.status === "R" ? "rename" : "copy";
			out.push(
				`similarity index ${c.score}%\n${verb} from ${c.oldPath}\n${verb} to ${c.newPath}\n`,
			);
		}
		const oldOid = c.old ? await c.old.oid() : undefined;
		const newOid = c.new ? await c.new.oid() : undefined;
		if (oldOid === newOid && c.status !== "A" && c.status !== "D") continue;
		const sameMode = c.old && c.new && c.old.mode === c.new.mode;
		out.push(
			`index ${abbrev(oldOid)}..${abbrev(newOid)}${sameMode ? ` ${c.new?.mode}` : ""}\n`,
		);
		if (c.old?.mode === "160000" || c.new?.mode === "160000") {
			out.push(
				`--- ${c.old ? oldName : "/dev/null"}\n+++ ${c.new ? newName : "/dev/null"}\n`,
			);
			out.push(
				`@@ -${c.old ? 1 : 0}${c.old ? "" : ",0"} +${c.new ? 1 : 0}${c.new ? "" : ",0"} @@\n`,
			);
			if (oldOid && c.old) out.push(`-Subproject commit ${oldOid}\n`);
			if (newOid && c.new) out.push(`+Subproject commit ${newOid}\n`);
			continue;
		}
		const left = await contents(c.old, c.old?.worktree ? opts.clean : undefined, c.oldPath);
		const right = await contents(c.new, c.new?.worktree ? opts.clean : undefined, c.newPath);
		if (isBinary(left) || isBinary(right)) {
			out.push(
				`Binary files ${c.old ? oldName : "/dev/null"} and ${c.new ? newName : "/dev/null"} differ\n`,
			);
			continue;
		}
		if (!left.length && !right.length) continue;
		out.push(`--- ${c.old ? oldName : "/dev/null"}\n+++ ${c.new ? newName : "/dev/null"}\n`);
		out.push(hunks(left, right, opts));
	}
	return out.join("");
}

export interface FormatFlags extends OutputOptions {
	raw: boolean;
	patch: boolean;
	numstat: boolean;
	nameOnly: boolean;
	nameStatus: boolean;
	z: boolean;
}

export async function formatChanges(changes: Change[], flags: FormatFlags): Promise<string> {
	const parts: string[] = [];
	if (flags.nameOnly) return changes.map((c) => c.newPath + (flags.z ? "\0" : "\n")).join("");
	if (flags.nameStatus)
		return changes
			.map((c) => {
				const status = c.score !== undefined ? `${c.status}${c.score}` : c.status;
				const names =
					c.status === "R" || c.status === "C" ? [c.oldPath, c.newPath] : [c.newPath];
				return flags.z
					? `${status}\0${names.join("\0")}\0`
					: `${status}\t${names.join("\t")}\n`;
			})
			.join("");
	if (flags.raw) parts.push(await formatRaw(changes, flags.z));
	if (flags.numstat) parts.push(await formatNumstat(changes, flags.z, flags));
	if (flags.patch && changes.length) {
		if (parts.length && parts.join("")) parts.push(flags.z ? "\0" : "\n");
		parts.push(await formatPatch(changes, flags));
	}
	return parts.join("");
}

// ---------------------------------------------------------------- commands

export interface ParsedDiffArgs extends FormatFlags {
	revisions: string[];
	paths: string[];
	cached: boolean;
	noIndex: boolean;
	mergeBase: boolean;
	renames: boolean;
	copies: boolean;
	exitCode: boolean;
	quiet: boolean;
	check: boolean;
}

export function parseDiffArgs(
	args: string[],
	defaultPatch: boolean,
	defaultRenames: boolean,
): ParsedDiffArgs {
	const flags: ParsedDiffArgs = {
		raw: false,
		patch: false,
		numstat: false,
		nameOnly: false,
		nameStatus: false,
		z: false,
		revisions: [],
		paths: [],
		cached: false,
		noIndex: false,
		mergeBase: false,
		renames: defaultRenames,
		copies: false,
		exitCode: false,
		check: false,
		quiet: false,
	};
	let explicitFormat = false;
	let endOfOptions = false;
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--") {
			flags.paths.push(...args.splice(0));
			break;
		}
		if (endOfOptions || !arg.startsWith("-") || arg === "-") {
			flags.revisions.push(arg);
			continue;
		}
		if (arg === "--end-of-options") endOfOptions = true;
		else if (arg === "--patch-with-raw") {
			flags.patch = flags.raw = explicitFormat = true;
		} else if (arg === "-p" || arg === "--patch" || arg === "-u") {
			flags.patch = explicitFormat = true;
		} else if (arg === "--raw") {
			flags.raw = explicitFormat = true;
		} else if (arg === "--numstat") {
			flags.numstat = explicitFormat = true;
		} else if (arg === "--name-only") flags.nameOnly = explicitFormat = true;
		else if (arg === "--name-status") flags.nameStatus = explicitFormat = true;
		else if (arg === "-z") flags.z = true;
		else if (arg === "--cached" || arg === "--staged") flags.cached = true;
		else if (arg === "--no-index") flags.noIndex = true;
		else if (arg === "--merge-base") flags.mergeBase = true;
		else if (arg === "-w" || arg === "--ignore-all-space") flags.ignoreWhitespace = true;
		else if (arg === "-M" || /^-M\d+%?$/.test(arg) || arg === "--find-renames")
			flags.renames = true;
		else if (arg === "-C" || arg === "--find-copies") flags.copies = flags.renames = true;
		else if (arg === "--no-renames") flags.renames = flags.copies = false;
		else if (arg === "--exit-code") flags.exitCode = true;
		else if (arg === "--check") flags.check = explicitFormat = true;
		else if (arg === "--quiet") flags.quiet = flags.exitCode = true;
		else if (/^-U\d+$/.test(arg) || /^--unified=\d+$/.test(arg))
			flags.context = Number(arg.replace(/^\D+/, ""));
		else if (
			[
				"--no-ext-diff",
				"--no-color",
				"--color=never",
				"--no-textconv",
				"--ignore-submodules",
				"--no-prefix-guess",
				"--full-index",
			].includes(arg) ||
			arg === "--format=" ||
			arg === "--format=format:" ||
			arg === "--no-show-signature"
		) {
			/* Plain output is all this CLI produces. */
		} else unsupported("diff");
	}
	if (!explicitFormat) flags.patch = defaultPatch;
	return flags;
}

async function noIndexDiff(
	repo: Repo | undefined,
	cwd: string,
	flags: ParsedDiffArgs,
	io: Repo["ctx"]["io"],
	vfs: Repo["ctx"]["vfs"],
) {
	if (flags.paths.length !== 2 && flags.revisions.length + flags.paths.length !== 2)
		unsupported("diff --no-index");
	const [left = "", right = ""] =
		flags.paths.length === 2 ? flags.paths : [...flags.revisions, ...flags.paths];
	const entry = async (name: string): Promise<SnapshotEntry | undefined> => {
		if (name === "/dev/null" || name === "nul" || name === "NUL") return;
		const file = path.resolve(cwd, vfs.normalizePath(name));
		const stat = vfs.fs.lstatSync(file);
		if (!stat.isFile()) unsupported("diff --no-index of directories");
		const data = new Uint8Array(vfs.fs.readFileSync(file) as Uint8Array);
		const { oid } = await git.hashBlob({ object: data });
		return {
			mode: stat.mode & 0o111 ? "100755" : "100644",
			known: oid,
			oid: async () => oid,
			data: async () => data,
		};
	};
	const before = await entry(left),
		after = await entry(right);
	const rel = (name: string) => {
		const absolute = path.resolve(cwd, vfs.normalizePath(name));
		if (repo && absolute.startsWith(`${repo.dir}/`)) return path.relative(cwd, absolute);
		return name.replace(/^\/+/, "");
	};
	const changes: Change[] = [];
	const oldName = before ? rel(left) : rel(right);
	const newName = after ? rel(right) : rel(left);
	if (before && after) {
		if ((await before.oid()) !== (await after.oid()) || before.mode !== after.mode)
			changes.push({
				status: "M",
				oldPath: oldName,
				newPath: newName,
				old: before,
				new: after,
			});
	} else if (after) changes.push({ status: "A", oldPath: newName, newPath: newName, new: after });
	else if (before) changes.push({ status: "D", oldPath: oldName, newPath: oldName, old: before });
	// git diff --no-index prints raw zero ids for the worktree side too.
	if (!flags.quiet)
		io.stdout(
			await formatChanges(
				changes.map((c) => ({
					...c,
					old: c.old && { ...c.old, worktree: true, known: undefined },
					new: c.new && { ...c.new, worktree: true, known: undefined },
				})),
				flags,
			),
		);
	return changes.length ? 1 : 0;
}

export async function diffCommand(
	repo: Repo | undefined,
	cwd: string,
	args: string[],
	ctx: Repo["ctx"],
): Promise<number> {
	const flags = parseDiffArgs(args, true, true);
	if (flags.noIndex) return noIndexDiff(repo, cwd, flags, ctx.io, ctx.vfs);
	if (!repo) return fail("not a git repository");
	if (flags.check) {
		if (flags.revisions.length || flags.cached) unsupported("diff --check");
		return checkWorktree(
			repo,
			flags.paths.map((p) => repoPath(repo, cwd, p)),
		);
	}
	const paths = flags.paths.map((p) => repoPath(repo, cwd, p));
	let revisions = flags.revisions;
	if (revisions.length === 1 && /^[^.]+\.\.\.?[^.]+$/.test(revisions[0] || "")) {
		const [a = "", b = ""] = (revisions[0] as string).split(/\.\.\.?/);
		if ((revisions[0] as string).includes("...")) flags.mergeBase = true;
		revisions = [a || "HEAD", b || "HEAD"];
	}
	const commitOrTree = async (spec: string): Promise<Snapshot> => {
		if (spec === EMPTY_TREE) return new Map();
		const oid = await resolveRevision(repo, spec);
		if (!oid) return fail(`bad revision '${spec}'`);
		const commit = await resolveCommit(repo, spec);
		if (commit) return commitSnapshot(repo, commit);
		return treeSnapshot(repo, await flattenTree(repo, oid));
	};
	let before: Snapshot, after: Snapshot;
	let clean: OutputOptions["clean"];
	if (revisions.length === 2) {
		let left = revisions[0] as string;
		if (flags.mergeBase) {
			const a = await resolveCommit(repo, left),
				b = await resolveCommit(repo, revisions[1] as string);
			if (!a || !b) return fail(`bad revision '${!a ? left : revisions[1]}'`);
			const base = await findMergeBase(repo, a, b);
			if (!base) return fail(`${left}...${revisions[1]}: no merge base`);
			left = base;
		}
		before = await commitOrTree(left);
		after = await commitOrTree(revisions[1] as string);
	} else if (revisions.length > 2) return unsupported("diff");
	else if (flags.cached) {
		before = revisions[0]
			? await commitOrTree(revisions[0])
			: await commitOrTree("HEAD").catch(() => new Map());
		after = indexSnapshot(repo, await readIndex(repo));
	} else {
		const index = await readIndex(repo);
		const worktree = await worktreeSnapshot(repo, index);
		clean = (file, data) => worktree.filter.clean(file, data, false);
		after = worktree.snapshot;
		// Index paths missing from the worktree compare as deletions.
		before = revisions[0] ? await commitOrTree(revisions[0]) : indexSnapshot(repo, index);
	}
	const changes = await compare(before, after, {
		paths,
		renames: flags.renames && revisions.length === 2,
		copies: flags.copies,
	});
	if (!flags.quiet) ctx.io.stdout(await formatChanges(changes, { ...flags, clean }));
	return flags.exitCode && changes.length ? 1 : 0;
}

/** The whitespace errors git's default core.whitespace rules find in an
 * added line (without its newline): blank-at-eol and space-before-tab. */
export function whitespaceError(text: string, crAtEol = false): string {
	const line = crAtEol ? text.replace(/\r$/, "") : text;
	const trailing = /[ \t\r\n]*$/.exec(line)?.index ?? line.length;
	const errors: string[] = [];
	if (trailing < line.length) errors.push("trailing whitespace");
	if (/^[ \t]* \t/.test(line.slice(0, trailing))) errors.push("space before tab in indent");
	return errors.join(", ");
}

/** Added lines that are line numbers in `right` (1-based). */
function addedLines(left: Uint8Array, right: Uint8Array): number[] {
	const a = splitLines(left),
		b = splitLines(right);
	const ops = editScript(markEol(a), markEol(b));
	const added: number[] = [];
	let y = 0;
	for (const op of ops) {
		if (op === 2) added.push(y + 1);
		if (op !== 1) y++;
	}
	return added;
}

/** git diff --check: whitespace errors and leftover conflict markers in the
 * worktree's changes (against "ours" for unmerged paths), exit 2 if any. */
async function checkWorktree(repo: Repo, paths: string[]) {
	const index = await readIndex(repo);
	const worktree = await worktreeSnapshot(repo, index);
	const base = new Map<string, string>();
	for (const entry of index)
		if (entry.stage === 0 || entry.stage === 2) base.set(entry.path, entry.oid);
	const out: string[] = [];
	for (const [file, oid] of [...base].sort()) {
		if (!inPathspec(file, paths)) continue;
		const w = worktree.snapshot.get(file);
		if (!w || w.mode === "160000" || (await w.oid()) === oid) continue;
		const left = await readBlob(repo, oid);
		const right = await w.data();
		if (isBinary(left) || isBinary(right)) continue;
		const lines = splitLines(right).text;
		for (const n of addedLines(left, right)) {
			const line = lines[n - 1] ?? "";
			if (/^(<{7}|={7}|>{7})( |$)/.test(line))
				out.push(`${file}:${n}: leftover conflict marker\n`);
			const error = whitespaceError(line);
			if (error) out.push(`${file}:${n}: ${error}.\n+${line}\n`);
		}
	}
	repo.ctx.io.stdout(out.join(""));
	return out.length ? 2 : 0;
}

/** git diff-index --cached --name-status [--no-renames] -z <tree> -- */
export async function diffIndexCommand(repo: Repo, cwd: string, args: string[]) {
	const flags = parseDiffArgs(args, false, false);
	if (!flags.nameStatus && !flags.raw && !flags.nameOnly) flags.raw = true;
	const [revision = "", ...rest] = flags.revisions;
	if (rest.length) unsupported("diff-index");
	const commit = revision === EMPTY_TREE ? undefined : await resolveCommit(repo, revision);
	if (!commit && revision !== EMPTY_TREE) fail(`bad revision '${revision}'`);
	const index = await readIndex(repo);
	const before = await commitSnapshot(repo, commit);
	let after: Snapshot;
	let clean: OutputOptions["clean"];
	if (flags.cached) after = indexSnapshot(repo, index);
	else {
		const worktree = await worktreeSnapshot(repo, index);
		after = worktree.snapshot;
		clean = (file, data) => worktree.filter.clean(file, data, false);
	}
	const changes = await compare(before, after, {
		paths: flags.paths.map((p) => repoPath(repo, cwd, p)),
		renames: flags.renames,
	});
	repo.ctx.io.stdout(await formatChanges(changes, { ...flags, clean }));
	return flags.exitCode && changes.length ? 1 : 0;
}
