import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import path from "path-browserify";
import { whitespaceError } from "./git-diff";
import {
	canonicalMode,
	configGet,
	editIndex,
	fail,
	failRaw,
	findRoot,
	type GitContext,
	type IndexEntry,
	isValidPath,
	lstat,
	modeOf,
	openRepo,
	type Repo,
	readBlob,
	readIndex,
	unsupported,
} from "./git-repo";
import { removeEmptyParents } from "./git-worktree";

// git apply, following git's apply.c: unified diffs (git-style or
// traditional) applied to the worktree, the index (--cached) or both
// (--index). All patches of an input are checked in memory before anything
// is written. Patch text and file contents are bytes (latin1 strings).

interface Fragment {
	oldPos: number;
	newPos: number;
	leading: number;
	trailing: number;
	/** Lines with their terminators as they are in the old and the new file. */
	preimage: string[];
	postimage: string[];
	/** Patch line of the first blank line the hunk adds at its end, or 0. */
	blankAtEnd: number;
}

interface FilePatch {
	oldName?: string;
	newName?: string;
	/** 1 yes, 0 no, -1 unknown (traditional patches decide on the file). */
	isNew: number;
	isDelete: number;
	isRename: boolean;
	isCopy: boolean;
	oldMode?: string;
	newMode?: string;
	toplevel: boolean;
	binary: boolean;
	fragments: Fragment[];
}

interface State {
	p: number;
	reverse: boolean;
	unidiffZero: boolean;
	whitespace: "nowarn" | "warn" | "error";
	/** How many whitespace errors are reported in detail; 0 for all. */
	squelch: number;
	wsErrors: number;
	input: string;
	/** git's running patch line number, including its quirks. */
	linenr: number;
	stderr: (text: string) => void;
}

const utf8 = (bytes: string) => Buffer.from(bytes, "latin1").toString("utf8");
const corrupt = (linenr: number) => failRaw(`error: corrupt patch at line ${linenr}`, 128);

function recordWhitespace(state: State, error: string, line: string, linenr: number) {
	state.wsErrors++;
	if (state.squelch && state.wsErrors > state.squelch) return;
	state.stderr(`${state.input}:${linenr}: ${error}.\n${utf8(line)}\n`);
}

// ---------------------------------------------------------------- names

const ESCAPES: Record<string, string> = {
	a: "\x07",
	b: "\b",
	t: "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
	'"': '"',
	"\\": "\\",
};

/** Undo git's C-style quoting of `"..."`; returns the name and what follows. */
function unquote(value: string): [string, string] | undefined {
	let name = "";
	for (let i = 1; i < value.length; i++) {
		const c = value[i] as string;
		if (c === '"') return [name, value.slice(i + 1)];
		if (c !== "\\") {
			name += c;
			continue;
		}
		const next = value[++i] ?? "";
		if (/^[0-3][0-7]{2}$/.test(value.slice(i, i + 3))) {
			name += String.fromCharCode(Number.parseInt(value.slice(i, i + 3), 8));
			i += 2;
		} else if (next in ESCAPES) name += ESCAPES[next];
		else return;
	}
}

/** Drop `p` leading components (find_name_common), squashing repeated slashes. */
function strip(name: string, p: number): string | undefined {
	let start = p ? -1 : 0;
	let left = p;
	for (let i = 0; i < name.length; i++) if (name[i] === "/" && --left === 0) start = i + 1;
	if (start < 0 || start >= name.length) return;
	return name.slice(start).replace(/\/{2,}/g, "/");
}

const isDevNull = (value: string) => /^\/dev\/null(\s|$)/.test(value);

/** A name from a header line: C-quoted, or up to a tab (`---`/`+++`) or a
 * carriage return. */
function findName(value: string, p: number, toTab = true, preferred?: string) {
	let name: string | undefined;
	if (value.startsWith('"')) {
		const quoted = unquote(value);
		name = quoted && strip(quoted[0], p);
	} else {
		const end = value.search(toTab ? /[\t\r]/ : /\r/);
		name = strip(end < 0 ? value : value.slice(0, end), p);
	}
	// Prefer a shorter name the other side extends ("file" over "file.orig").
	if (name && preferred && preferred.length < name.length && name.startsWith(preferred))
		return preferred;
	return name;
}

/** The name in `diff --git a/x b/x` when both sides agree (git_header_name). */
function gitHeaderName(value: string, p: number): string | undefined {
	if (value.startsWith('"')) {
		const first = unquote(value);
		const a = first && strip(first[0], p);
		if (!first || !a) return;
		const rest = first[1].replace(/^\s+/, "");
		const second = rest.startsWith('"') ? unquote(rest)?.[0] : rest;
		return second !== undefined && strip(second, p) === a ? a : undefined;
	}
	for (let i = value.search(/[ \t]/); i >= 0; ) {
		const second = value.slice(i + 1);
		const b = second.startsWith('"') ? unquote(second)?.[0] : second;
		const a = strip(value.slice(0, i), p);
		if (a !== undefined && b !== undefined && a === strip(b, p)) return a;
		const next = value.slice(i + 1).search(/[ \t]/);
		i = next < 0 ? -1 : i + 1 + next;
	}
}

// ---------------------------------------------------------------- parsing

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

class Parser {
	at = 0;
	/** The current patch removes or keeps CRLF lines (core.whitespace cr-at-eol). */
	crAtEol = false;

	constructor(
		readonly lines: string[],
		/** The input's last line ends with a newline. */
		readonly complete: boolean,
		readonly state: State,
	) {}

	/** Whether line `i` is terminated (git rejects unterminated patch lines). */
	terminated(i: number) {
		return i < this.lines.length - 1 || this.complete;
	}

	advance() {
		this.at++;
		this.state.linenr++;
	}

	/** git's find_header + parse_single_patch: the next file patch, if any. */
	next(): FilePatch | undefined {
		const { lines, state } = this;
		while (this.at < lines.length) {
			const line = lines[this.at] as string;
			if (line.length < 5) {
				this.advance();
				continue;
			}
			if (line.startsWith("@@ -") && HUNK.test(line) && this.terminated(this.at))
				failRaw(
					`error: patch fragment without header at line ${state.linenr}: ${utf8(line)}`,
					128,
				);
			if (this.at + 1 >= lines.length) break;
			if (line.startsWith("diff --git ")) {
				const patch = this.gitHeader();
				if (patch) return this.body(patch);
				continue;
			}
			if (
				line.startsWith("--- ") &&
				lines[this.at + 1]?.startsWith("+++ ") &&
				lines[this.at + 2]?.startsWith("@@ -")
			)
				return this.body(this.traditionalHeader());
			this.advance();
		}
	}

	private traditionalHeader(): FilePatch {
		const { lines, state } = this;
		const first = (lines[this.at] as string).slice(4);
		const second = (lines[this.at + 1] as string).slice(4);
		const patch: FilePatch = {
			isNew: -1,
			isDelete: -1,
			isRename: false,
			isCopy: false,
			toplevel: false,
			binary: false,
			fragments: [],
		};
		if (isDevNull(first)) {
			patch.isNew = 1;
			patch.isDelete = 0;
			patch.newName = findName(second, state.p);
		} else if (isDevNull(second)) {
			patch.isNew = 0;
			patch.isDelete = 1;
			patch.oldName = findName(first, state.p);
		} else {
			const name = findName(second, state.p, true, findName(first, state.p));
			patch.oldName = patch.newName = name;
		}
		if (!patch.oldName && !patch.newName)
			failRaw(`error: unable to find filename in patch at line ${state.linenr}`, 128);
		this.at += 2;
		state.linenr += 2;
		return patch;
	}

	/** parse_git_diff_header; undefined when the line has no header after it. */
	private gitHeader(): FilePatch | undefined {
		const { lines, state } = this;
		const p = state.p;
		const defaultName = gitHeaderName((lines[this.at] as string).slice(11), p);
		const patch: FilePatch = {
			isNew: 0,
			isDelete: 0,
			isRename: false,
			isCopy: false,
			toplevel: true,
			binary: false,
			fragments: [],
		};
		const mode = (value: string) => {
			if (!/^[0-7]+(\s|$)/.test(value))
				failRaw(`error: invalid mode on line ${state.linenr}: ${utf8(value)}`, 128);
			return canonicalMode(/^[0-7]+/.exec(value)?.[0] as string);
		};
		const verify = (value: string, isNull: boolean, side: "old" | "new") => {
			const current = side === "old" ? patch.oldName : patch.newName;
			if (!current && !isNull) {
				const name = findName(value, p);
				if (side === "old") patch.oldName = name;
				else patch.newName = name;
			} else if (current) {
				if (isNull)
					failRaw(
						`error: git apply: bad git-diff - expected /dev/null, got ${utf8(current)} on line ${state.linenr}`,
						128,
					);
				if (findName(value, p) !== current)
					failRaw(
						`error: git apply: bad git-diff - inconsistent ${side} filename on line ${state.linenr}`,
						128,
					);
			} else if (!isDevNull(value))
				failRaw(
					`error: git apply: bad git-diff - expected /dev/null on line ${state.linenr}`,
					128,
				);
		};
		let extension = 0;
		this.advance();
		const start = this.at;
		for (; this.at < lines.length && this.terminated(this.at); this.advance()) {
			const line = lines[this.at] as string;
			const after = (prefix: string) => line.slice(prefix.length);
			if (line.startsWith("@@ -")) break;
			if (line.startsWith("--- ")) verify(after("--- "), patch.isNew === 1, "old");
			else if (line.startsWith("+++ ")) verify(after("+++ "), patch.isDelete === 1, "new");
			else if (line.startsWith("old mode ")) patch.oldMode = mode(after("old mode "));
			else if (line.startsWith("new mode ")) patch.newMode = mode(after("new mode "));
			else if (line.startsWith("deleted file mode ")) {
				patch.isDelete = 1;
				patch.oldName = defaultName;
				patch.oldMode = mode(after("deleted file mode "));
			} else if (line.startsWith("new file mode ")) {
				patch.isNew = 1;
				patch.newName = defaultName;
				patch.newMode = mode(after("new file mode "));
			} else if (/^(copy (from|to)|rename (old|new|from|to)) /.test(line)) {
				const [, kind = "", which = "", value = ""] = /^(\S+) (\S+) (.*)$/.exec(line) ?? [];
				const name = findName(value, p ? p - 1 : 0, false);
				if (which === "from" || which === "old") patch.oldName = name;
				else patch.newName = name;
				if (kind === "copy") patch.isCopy = true;
				else patch.isRename = true;
			} else if (line.startsWith("index ")) {
				const m = /^index [0-9a-f]+\.\.[0-9a-f]+ (.*)$/.exec(line);
				if (m) patch.oldMode = mode(m[1] as string);
			} else if (!/^(dis)?similarity index /.test(line)) break;
			const kinds =
				Number(patch.isDelete === 1) +
				Number(patch.isNew === 1) +
				Number(patch.isRename) +
				Number(patch.isCopy);
			if (kinds > 1)
				failRaw(`error: inconsistent header lines ${extension} and ${state.linenr}`, 128);
			if (kinds && !extension) extension = state.linenr;
		}
		if (this.at === start) {
			// Only the `diff --git` line: git rescans from the next line,
			// counting the line twice.
			state.linenr++;
			return;
		}
		if (!patch.oldName && !patch.newName) {
			if (!defaultName)
				failRaw(
					`error: git diff header lacks filename information when removing ${p} leading pathname component${p === 1 ? "" : "s"} (line ${state.linenr})`,
					128,
				);
			patch.oldName = patch.newName = defaultName;
		}
		if ((!patch.newName && !patch.isDelete) || (!patch.oldName && !patch.isNew))
			failRaw(
				`error: git diff header lacks filename information (line ${state.linenr})`,
				128,
			);
		return patch;
	}

	/** Hunks, binary markers and the creation/deletion inference. */
	private body(patch: FilePatch): FilePatch {
		const { lines, state } = this;
		let oldLines = 0,
			newLines = 0,
			context = 0;
		this.crAtEol = false;
		while (this.at < lines.length && (lines[this.at] as string).startsWith("@@ -")) {
			const fragment = this.fragment();
			oldLines += fragment.preimage.length;
			newLines += fragment.postimage.length;
			context += fragment.leading + fragment.trailing;
			patch.fragments.push(fragment);
		}
		if (patch.isNew < 0 && (oldLines || patch.fragments.length > 1)) patch.isNew = 0;
		if (patch.isDelete < 0 && (newLines || patch.fragments.length > 1)) patch.isDelete = 0;
		if (patch.isNew > 0 && oldLines)
			failRaw(`error: new file ${utf8(patch.newName ?? "")} depends on old contents`, 128);
		if (patch.isDelete > 0 && newLines)
			failRaw(`error: deleted file ${utf8(patch.oldName ?? "")} still has contents`, 128);
		if (!patch.isDelete && !newLines && context)
			state.stderr(
				`** warning: file ${utf8(patch.newName ?? "")} becomes empty but is not deleted\n`,
			);
		if (patch.fragments.length) return patch;
		const next = lines[this.at] ?? "";
		if (next === "GIT binary patch" || /^(Binary files|Files) .* differ$/.test(next))
			patch.binary = true;
		const metadata =
			patch.isRename ||
			patch.isCopy ||
			patch.isNew > 0 ||
			patch.isDelete !== 0 ||
			(patch.oldMode !== undefined &&
				patch.newMode !== undefined &&
				patch.oldMode !== patch.newMode);
		if (!patch.binary && !metadata)
			failRaw(`error: patch with only garbage at line ${state.linenr}`, 128);
		return patch;
	}

	/** parse_fragment: one hunk, by its header's line counts. */
	private fragment(): Fragment {
		const { lines, state } = this;
		const header = HUNK.exec(lines[this.at] as string);
		if (!header || !this.terminated(this.at)) return corrupt(state.linenr);
		const headerLine = state.linenr;
		let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
		let newLeft = header[4] === undefined ? 1 : Number(header[4]);
		const fragment: Fragment = {
			oldPos: Number(header[1]),
			newPos: Number(header[3]),
			leading: 0,
			trailing: 0,
			preimage: [],
			postimage: [],
			blankAtEnd: 0,
		};
		const added = state.reverse ? "-" : "+";
		let changed = false,
			last = "",
			offset = 0,
			blanks = 0;
		this.advance();
		const take = (line: string) => {
			const sign = line === "" ? " " : (line[0] as string);
			offset++;
			if (sign === "\\") {
				if (line.length < 11 || !line.startsWith("\\ ")) corrupt(state.linenr);
				// The marker drops the newline of the line before it.
				const chop = (image: string[]) => {
					const i = image.length - 1;
					if (i >= 0) image[i] = (image[i] as string).replace(/\n$/, "");
				};
				if (last !== "+") chop(fragment.preimage);
				if (last !== "-") chop(fragment.postimage);
				return;
			}
			const body = `${line.slice(1)}\n`;
			const blank = /^[ \t\r\n]*$/.test(body);
			if (body.endsWith("\r\n") && (sign === " " || (sign === "-") !== state.reverse))
				this.crAtEol = true;
			if (sign === " ") {
				oldLeft--;
				newLeft--;
				fragment.preimage.push(body);
				fragment.postimage.push(body);
				if (changed) fragment.trailing++;
				else fragment.leading++;
				if (!blank) blanks = 0;
			} else if (sign === "-" || sign === "+") {
				if (sign === "-") {
					oldLeft--;
					fragment.preimage.push(body);
				} else {
					newLeft--;
					fragment.postimage.push(body);
				}
				changed = true;
				fragment.trailing = 0;
				if (sign === added && state.whitespace !== "nowarn") {
					const error = whitespaceError(line.slice(1), this.crAtEol);
					if (error) recordWhitespace(state, error, line.slice(1), state.linenr);
				}
				if (sign === added && blank) {
					if (!blanks) fragment.blankAtEnd = headerLine + offset;
					blanks++;
				} else blanks = 0;
			} else corrupt(state.linenr);
			last = sign;
		};
		while (oldLeft > 0 || newLeft > 0) {
			if (this.at >= lines.length || !this.terminated(this.at)) corrupt(state.linenr);
			take(lines[this.at] as string);
			if (oldLeft < 0 || newLeft < 0) corrupt(state.linenr);
			this.advance();
		}
		if (!changed) corrupt(state.linenr);
		if (!blanks) fragment.blankAtEnd = 0;
		// A trailing "\ No newline" is consumed without counting the line.
		const marker = lines[this.at];
		if (marker !== undefined && marker.length >= 12 && marker.startsWith("\\ ")) {
			take(marker);
			this.at++;
		}
		return fragment;
	}
}

function reverse(patch: FilePatch) {
	[patch.oldName, patch.newName] = [patch.newName, patch.oldName];
	[patch.oldMode, patch.newMode] = [patch.newMode, patch.oldMode];
	[patch.isNew, patch.isDelete] = [patch.isDelete, patch.isNew];
	for (const f of patch.fragments) {
		[f.oldPos, f.newPos] = [f.newPos, f.oldPos];
		[f.preimage, f.postimage] = [f.postimage, f.preimage];
	}
}

// ---------------------------------------------------------------- applying

/** File contents as git's apply holds them: lines with their terminators,
 * and whether a hunk already produced each line. */
class Image {
	patched: boolean[];

	constructor(readonly lines: string[]) {
		this.patched = lines.map(() => false);
	}

	/** match_fragment: every line equal ignoring whitespace (git's line hash)
	 * and the preimage's bytes a prefix of the image's from that line. */
	matches(pre: string[], at: number, matchBeginning: boolean, matchEnd: boolean) {
		const { lines } = this;
		if (at + pre.length > lines.length) return false;
		if (matchEnd && at + pre.length !== lines.length) return false;
		if (matchBeginning && at !== 0) return false;
		const squash = (line: string) => line.replace(/[ \t\n\r]/g, "");
		for (let i = 0; i < pre.length; i++)
			if (
				this.patched[at + i] ||
				squash(pre[i] as string) !== squash(lines[at + i] as string)
			)
				return false;
		const want = pre.join("");
		const span = lines.slice(at, at + pre.length).join("");
		if (matchEnd) return span === want;
		if (want.length <= span.length) return span.startsWith(want);
		return lines.slice(at).join("").startsWith(want);
	}

	/** update_image: the matched image lines become the postimage. */
	replace(at: number, count: number, post: string[]) {
		this.lines.splice(at, count, ...post);
		this.patched.splice(at, count, ...post.map(() => true));
	}
}

/** find_pos: search outward from the expected line for the preimage. */
function findPosition(
	image: Image,
	pre: string[],
	line: number,
	matchBeginning: boolean,
	matchEnd: boolean,
): number {
	const size = image.lines.length;
	if (matchBeginning) line = 0;
	else if (matchEnd) line = size - pre.length;
	if (line < 0 || line > size) line = size;
	const matches = (at: number) => image.matches(pre, at, matchBeginning, matchEnd);
	let backwards = line,
		forwards = line,
		current = line;
	for (let i = 0; ; i++) {
		if (matches(current)) return current;
		// Alternate one line further forward, then one further back.
		for (;;) {
			if (backwards === 0 && forwards === size) return -1;
			if (i & 1) {
				if (backwards === 0) {
					i++;
					continue;
				}
				current = --backwards;
			} else {
				if (forwards === size) {
					i++;
					continue;
				}
				current = ++forwards;
			}
			break;
		}
	}
}

interface FileState {
	data: string;
	mode: string;
}

type Mode = "worktree" | "cached" | "index";

/** Where patches read from and write to, plus the in-memory results. */
class Target {
	readonly results = new Map<string, FileState | null>();
	private index = new Map<string, IndexEntry>();

	constructor(
		readonly fs: GitContext["vfs"]["fs"],
		readonly root: string,
		readonly mode: Mode,
		readonly repo?: Repo,
	) {}

	async load() {
		if (this.repo && this.mode !== "worktree")
			this.index = new Map(
				(await readIndex(this.repo)).filter((e) => !e.stage).map((e) => [e.path, e]),
			);
	}

	private file(name: string) {
		return path.join(this.root, utf8(name));
	}

	worktree(name: string): FileState | undefined {
		const absolute = this.file(name);
		const stat = lstat({ fs: this.fs }, absolute);
		if (!stat || stat.isDirectory()) return;
		const data = stat.isSymbolicLink()
			? Buffer.from(String(this.fs.readlinkSync(absolute))).toString("latin1")
			: Buffer.from(this.fs.readFileSync(absolute) as Uint8Array).toString("latin1");
		return { data, mode: modeOf(stat) };
	}

	async indexed(name: string): Promise<FileState | undefined> {
		const entry = this.index.get(utf8(name));
		if (!entry || !this.repo) return;
		const blob = await readBlob(this.repo, entry.oid);
		return { data: Buffer.from(blob).toString("latin1"), mode: entry.mode };
	}

	/** check_preimage: the file a patch starts from (undefined when it is
	 * missing), or git's error. */
	async source(name: string): Promise<FileState | string | undefined> {
		if (this.results.has(name))
			return this.results.get(name) ?? `path ${utf8(name)} has been renamed/deleted`;
		if (this.mode === "worktree") return this.worktree(name);
		const indexed = await this.indexed(name);
		if (!indexed || this.mode === "cached") return indexed;
		// --index: a missing worktree file is checked out from the index.
		const current = this.worktree(name);
		if (current && current.data !== indexed.data) return `${utf8(name)}: does not match index`;
		return current ?? indexed;
	}

	/** check_to_create: why `name` cannot be created, if it cannot. */
	exists(name: string): string | undefined {
		const shown = utf8(name);
		if (this.results.has(name) && !this.results.get(name)) return;
		if (this.mode !== "worktree" && this.index.has(shown))
			return `${shown}: already exists in index`;
		if (this.mode === "cached") return;
		const stat = lstat({ fs: this.fs }, this.file(name));
		if (stat && !stat.isDirectory()) return `${shown}: already exists in working directory`;
	}

	/** A leading directory of `name` that is a symbolic link. */
	beyondSymlink(name: string): boolean {
		const parts = utf8(name).split("/");
		for (let i = parts.length - 1; i > 0; i--) {
			const dir = parts.slice(0, i).join("/");
			if (this.mode !== "worktree") {
				if (this.index.get(dir)?.mode === "120000") return true;
			} else if (lstat({ fs: this.fs }, path.join(this.root, dir))?.isSymbolicLink())
				return true;
		}
		return false;
	}

	async write() {
		const removed = [...this.results].filter(([, s]) => !s).map(([n]) => utf8(n));
		const written = [...this.results]
			.filter((e): e is [string, FileState] => !!e[1])
			.map(([n, s]) => [utf8(n), s] as const);
		const stats = new Map<string, { mtimeMs: number; size: number }>();
		if (this.mode !== "cached") {
			for (const file of removed) {
				this.fs.rmSync(path.join(this.root, file), { force: true });
				removeEmptyParents({ fs: this.fs, dir: this.root }, file);
			}
			for (const [file, state] of written) {
				const absolute = path.join(this.root, file);
				const existing = lstat({ fs: this.fs }, absolute);
				if (existing?.isDirectory()) fail(`unable to write file '${file}': Is a directory`);
				this.fs.mkdirSync(path.dirname(absolute), { recursive: true });
				if (existing) this.fs.rmSync(absolute, { force: true });
				const data = Buffer.from(state.data, "latin1");
				if (state.mode === "120000") this.fs.symlinkSync(data.toString("utf8"), absolute);
				else
					this.fs.writeFileSync(absolute, data, {
						mode: state.mode === "100755" ? 0o755 : 0o644,
					});
				const stat = lstat({ fs: this.fs }, absolute);
				if (stat)
					stats.set(file, { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) });
			}
		}
		const repo = this.repo;
		if (this.mode === "worktree" || !repo) return;
		const blobs = new Map<string, string>();
		for (const [file, state] of written)
			blobs.set(
				file,
				await git.writeBlob({
					fs: repo.fs,
					gitdir: repo.gitdir,
					blob: new Uint8Array(Buffer.from(state.data, "latin1")),
				}),
			);
		await editIndex(repo, async (writer) => {
			for (const file of removed) writer.remove(file);
			for (const [file, state] of written)
				writer.insert(file, blobs.get(file) as string, state.mode, stats.get(file));
		});
	}
}

/** check_patch + apply_data for one file patch; returns git's errors. */
async function checkPatch(target: Target, patch: FilePatch, state: State): Promise<string[]> {
	const name = utf8(patch.oldName ?? patch.newName ?? "");
	let source: FileState | undefined;
	if (patch.oldName !== undefined) {
		const found = await target.source(patch.oldName);
		if (typeof found === "string") return [found];
		if (!found) {
			if (patch.isNew >= 0)
				return [
					target.mode === "worktree"
						? `${utf8(patch.oldName)}: No such file or directory`
						: `${utf8(patch.oldName)}: does not exist in index`,
				];
			patch.isNew = 1;
			patch.isDelete = 0;
			patch.oldName = undefined;
		} else {
			source = found;
			if (patch.isNew < 0) patch.isNew = 0;
			patch.oldMode ??= found.mode;
			if ((found.mode === "120000") !== (patch.oldMode === "120000"))
				return [`${utf8(patch.oldName)}: wrong type`];
			if (found.mode !== patch.oldMode)
				state.stderr(
					`warning: ${utf8(patch.oldName)} has type ${found.mode}, expected ${patch.oldMode}\n`,
				);
			if (!patch.newMode && patch.isDelete <= 0) patch.newMode = found.mode;
		}
	}
	if (patch.newName !== undefined && (patch.isNew > 0 || patch.isRename || patch.isCopy)) {
		const exists = target.exists(patch.newName);
		if (exists) return [exists];
		patch.newMode ??= patch.isNew > 0 ? "100644" : patch.oldMode;
	}
	if (patch.newName !== undefined && patch.oldName !== undefined) {
		patch.newMode ??= patch.oldMode;
		if ((patch.oldMode === "120000") !== (patch.newMode === "120000"))
			return [
				`new mode (${patch.newMode}) of ${utf8(patch.newName)} does not match old mode`,
			];
	}
	const unsafe = [
		patch.isDelete || (!patch.isNew && !patch.isCopy) ? patch.oldName : undefined,
		patch.isDelete ? undefined : patch.newName,
	];
	for (const file of unsafe)
		if (file !== undefined && !isValidPath(utf8(file)))
			failRaw(`error: invalid path '${utf8(file)}'`, 128);
	if (!patch.isDelete && patch.newName !== undefined && target.beyondSymlink(patch.newName))
		return [`affected file '${utf8(patch.newName)}' is beyond a symbolic link`];

	const image = new Image((source?.data ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? []);
	for (const fragment of patch.fragments) {
		const at = findPosition(
			image,
			fragment.preimage,
			fragment.newPos ? fragment.newPos - 1 : 0,
			!fragment.oldPos || (fragment.oldPos === 1 && !state.unidiffZero),
			!state.unidiffZero && !fragment.trailing,
		);
		if (at < 0)
			return [`patch failed: ${name}:${fragment.oldPos}`, `${name}: patch does not apply`];
		if (
			fragment.blankAtEnd &&
			at + fragment.preimage.length >= image.lines.length &&
			state.whitespace !== "nowarn"
		)
			recordWhitespace(state, "new blank line at EOF", "+", fragment.blankAtEnd);
		image.replace(at, fragment.preimage.length, fragment.postimage);
	}
	const data = image.lines.join("");
	if (patch.isDelete > 0) {
		if (data) return ["removal patch leaves file contents", `${name}: patch does not apply`];
		target.results.set(patch.oldName as string, null);
		return [];
	}
	if (patch.isRename && patch.oldName !== undefined) target.results.set(patch.oldName, null);
	const file = patch.newName ?? (patch.oldName as string);
	target.results.set(file, { data, mode: patch.newMode ?? source?.mode ?? "100644" });
	return [];
}

/** git apply [--cached|--index] [--check] [-R] [-p<n>] [--unidiff-zero]
 * [--whitespace=<action>] [--allow-empty] [<patch>...|-] */
export async function applyCommand(ctx: GitContext, args: string[]): Promise<number> {
	const state: State = {
		p: 1,
		reverse: false,
		unidiffZero: false,
		whitespace: "warn",
		squelch: 5,
		wsErrors: 0,
		input: "<stdin>",
		linenr: 1,
		stderr: (text) => ctx.io.stderr(text),
	};
	let mode: Mode = "worktree",
		check = false,
		allowEmpty = false,
		whitespace: string | undefined;
	const inputs: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--") inputs.push(...args.splice(0));
		else if (arg === "--cached") mode = "cached";
		else if (arg === "--index") mode = mode === "cached" ? "cached" : "index";
		else if (arg === "--check") check = true;
		else if (arg === "-R" || arg === "--reverse") state.reverse = true;
		else if (arg === "--unidiff-zero") state.unidiffZero = true;
		else if (arg === "--allow-empty") allowEmpty = true;
		else if (/^-p\d*$/.test(arg)) {
			const value = arg.length > 2 ? arg.slice(2) : args.shift();
			if (!/^\d+$/.test(value ?? "")) unsupported("apply -p");
			state.p = Number(value);
		} else if (arg === "--whitespace") whitespace = args.shift();
		else if (arg.startsWith("--whitespace=")) whitespace = arg.slice(13);
		else if (arg !== "-" && arg.startsWith("-")) unsupported("apply");
		else inputs.push(arg);
	}
	const root = findRoot(ctx.vfs, ctx.cwd);
	if (!root && mode !== "worktree") return failRaw(`error: --${mode} outside a repository`, 128);
	const repo = root ? openRepo(ctx) : undefined;
	whitespace ??= await configGet(ctx, repo, "apply.whitespace");
	if (whitespace === "nowarn" || whitespace === "warn") state.whitespace = whitespace;
	else if (whitespace === "error") state.whitespace = "error";
	else if (whitespace === "error-all") {
		state.whitespace = "error";
		state.squelch = 0;
	} else if (whitespace === undefined) state.whitespace = check ? "nowarn" : "warn";
	else unsupported(`apply --whitespace=${whitespace}`);

	const prefix = root ? path.relative(root, ctx.cwd) : "";
	for (const input of inputs.length ? inputs : ["-"]) {
		ctx.io.signal.throwIfAborted();
		let data: Uint8Array;
		if (input === "-") data = await ctx.io.stdin();
		else
			try {
				data = ctx.vfs.fs.readFileSync(
					path.resolve(ctx.cwd, ctx.vfs.normalizePath(input)),
				) as Uint8Array;
			} catch {
				return failRaw(
					`error: can't open patch '${input}': No such file or directory`,
					128,
				);
			}
		state.input = input === "-" ? "<stdin>" : input;
		const text = Buffer.from(data).toString("latin1");
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const parser = new Parser(lines, text.endsWith("\n"), state);
		const patches: FilePatch[] = [];
		let skipped = 0;
		for (let patch = parser.next(); patch; patch = parser.next()) {
			if (patch.binary)
				fail(
					`binary patches are not supported: ${utf8(patch.newName ?? patch.oldName ?? "")}`,
				);
			if (patch.oldMode === "160000" || patch.newMode === "160000")
				fail(
					`submodule patches are not supported: ${utf8(patch.newName ?? patch.oldName ?? "")}`,
				);
			if (state.reverse) reverse(patch);
			// From a subdirectory, traditional names are relative to it and
			// patches outside it are skipped.
			if (prefix && !patch.toplevel) {
				const scope = Buffer.from(`${prefix}/`).toString("latin1");
				if (patch.oldName !== undefined) patch.oldName = scope + patch.oldName;
				if (patch.newName !== undefined) patch.newName = scope + patch.newName;
			}
			if (prefix && !utf8(patch.newName ?? patch.oldName ?? "").startsWith(`${prefix}/`)) {
				skipped++;
				continue;
			}
			// -R applies later patches first.
			if (state.reverse) patches.unshift(patch);
			else patches.push(patch);
		}
		if (!patches.length && !skipped) {
			if (allowEmpty) continue;
			return failRaw('error: No valid patches in input (allow with "--allow-empty")', 128);
		}
		const apply = !check && !(state.wsErrors && state.whitespace === "error");
		if (!check && !apply) continue;
		const target = new Target(ctx.vfs.fs, root ?? ctx.cwd, mode, repo);
		await target.load();
		const errors: string[] = [];
		for (const patch of patches) errors.push(...(await checkPatch(target, patch, state)));
		if (errors.length) return failRaw(errors.map((e) => `error: ${e}`).join("\n"), 1);
		if (apply && !(state.wsErrors && state.whitespace === "error")) await target.write();
	}
	if (state.wsErrors) {
		if (state.squelch && state.wsErrors > state.squelch) {
			const squelched = state.wsErrors - state.squelch;
			ctx.io.stderr(
				`warning: squelched ${squelched} whitespace error${squelched === 1 ? "" : "s"}\n`,
			);
		}
		const summary = `${state.wsErrors} line${state.wsErrors === 1 ? " adds" : "s add"} whitespace errors.`;
		if (state.whitespace === "error") return failRaw(`error: ${summary}`, 128);
		ctx.io.stderr(`warning: ${summary}\n`);
	}
	return 0;
}
