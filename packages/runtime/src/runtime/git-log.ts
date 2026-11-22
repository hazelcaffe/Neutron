import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import path from "path-browserify";
import { type Change, compare, formatChanges, parseDiffArgs } from "./git-diff";
import {
	fail,
	headRef,
	type Identity,
	type Repo,
	read,
	readBlob,
	readCommit,
	repoPath,
	resolveCommit,
	resolveRevision,
	tryResolve,
	unsupported,
	walkCommits,
} from "./git-repo";
import { commitSnapshot } from "./git-snapshot";
import { aheadBehind } from "./git-worktree";

type Who = git.CommitObject["author"];

function tz(offset: number) {
	const n = Math.abs(offset);
	return `${offset > 0 ? "-" : "+"}${String(Math.floor(n / 60)).padStart(2, "0")}${String(n % 60).padStart(2, "0")}`;
}
const rawDate = (who: Who) => `${who.timestamp} ${tz(who.timezoneOffset)}`;
function isoDate(who: Who, strict = false) {
	const local = new Date((who.timestamp - who.timezoneOffset * 60) * 1000).toISOString();
	const date = local.slice(0, 10),
		time = local.slice(11, 19);
	const zone = tz(who.timezoneOffset);
	return strict
		? `${date}T${time}${zone.slice(0, 3)}:${zone.slice(3)}`
		: `${date} ${time} ${zone}`;
}
function defaultDate(who: Who) {
	const local = new Date((who.timestamp - who.timezoneOffset * 60) * 1000);
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	return `${days[local.getUTCDay()]} ${months[local.getUTCMonth()]} ${local.getUTCDate()} ${local.toISOString().slice(11, 19)} ${local.getUTCFullYear()} ${tz(who.timezoneOffset)}`;
}

async function decorations(repo: Repo) {
	const names = new Map<string, string[]>();
	const add = async (ref: string, label: string) => {
		const oid = await tryResolve(repo, ref);
		if (!oid) return;
		let commit = oid;
		if (ref.startsWith("refs/tags/")) {
			try {
				commit = (await readCommit(repo, oid)).oid;
			} catch {
				return;
			}
		}
		names.set(commit, [...(names.get(commit) || []), label]);
	};
	const current = (await headRef(repo))?.replace(/^refs\/heads\//, "");
	if (!current) await add("HEAD", "HEAD");
	for (const branch of await git.listBranches({ fs: repo.fs, gitdir: repo.gitdir }))
		await add(`refs/heads/${branch}`, branch === current ? `HEAD -> ${branch}` : branch);
	for (const tag of await git.listTags({ fs: repo.fs, gitdir: repo.gitdir }))
		await add(`refs/tags/${tag}`, `tag: ${tag}`);
	for (const { remote } of await git.listRemotes({ fs: repo.fs, gitdir: repo.gitdir }))
		for (const branch of await git.listRefs({
			fs: repo.fs,
			gitdir: repo.gitdir,
			filepath: `refs/remotes/${remote}`,
		}))
			await add(`refs/remotes/${remote}/${branch}`, `${remote}/${branch}`);
	return names;
}

const TOKENS =
	/%(?:x[0-9a-fA-F]{2}|\((?:trailers(?::[a-z,=]*)?)\)|[ac][nNeEdDtiIrs]|g[dDsneE]|[HhTtPpsbBnDdNe%])|[^%]+|%/g;

export interface Reflog {
	selector: string;
	short: string;
	message: string;
	who: Identity;
}

function readReflog(repo: Repo, ref: string): { oid: string; message: string; who: Identity }[] {
	const text = read(repo, path.join("logs", ref));
	if (!text) return [];
	const entries = [];
	for (const line of text.split("\n")) {
		const match =
			/^([0-9a-f]{40}) ([0-9a-f]{40}) (.*) <([^>]*)> (\d+) ([+-])(\d\d)(\d\d)\t?(.*)$/.exec(
				line,
			);
		if (!match) continue;
		const minutes = Number(match[7]) * 60 + Number(match[8]);
		entries.push({
			oid: match[2] as string,
			message: match[9] as string,
			who: {
				name: match[3] as string,
				email: match[4] as string,
				timestamp: Number(match[5]),
				timezoneOffset: match[6] === "-" ? minutes : -minutes,
			},
		});
	}
	return entries.reverse();
}

interface LogOptions {
	format?: string;
	/** `--format=format:` separates entries; tformat/plain formats terminate them. */
	separator: boolean;
	pseudo: { kind: "remotes" | "branches" | "tags" | "all"; not: boolean }[];
	oneline: boolean;
	abbrevCommit: boolean;
	z: boolean;
	date: "raw" | "iso" | "iso-strict" | "unix" | "default";
	limit?: number;
	skip: number;
	reflog: boolean;
	firstParent: boolean;
	merges?: boolean;
	reverse: boolean;
	noWalk: boolean;
	stdin: boolean;
	diff: string[];
	include: string[];
	exclude: string[];
	symmetric?: [string, string];
	paths: string[];
	/** Revision text as given, for git's "bad revision" message. */
	origin: Map<string, string>;
	/** `--` or `--end-of-options` rules out paths: unknown revisions are bad. */
	strict: boolean;
	leftRight: boolean;
	count: boolean;
}

function parseLogArgs(args: string[], revList: boolean): LogOptions {
	const o: LogOptions = {
		separator: false,
		pseudo: [],
		oneline: false,
		abbrevCommit: false,
		z: false,
		date: "default",
		skip: 0,
		reflog: false,
		firstParent: false,
		reverse: false,
		noWalk: false,
		stdin: false,
		diff: [],
		include: [],
		exclude: [],
		paths: [],
		origin: new Map(),
		strict: false,
		leftRight: false,
		count: false,
	};
	let endOfOptions = false,
		not = false;
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--") {
			o.paths.push(...args.splice(0));
			o.strict = true;
			break;
		}
		if (endOfOptions || !arg.startsWith("-")) {
			if (arg.includes("...")) {
				const [a = "", b = ""] = arg.split("...");
				o.symmetric = [a || "HEAD", b || "HEAD"];
				for (const spec of o.symmetric) o.origin.set(spec, arg);
			} else if (arg.includes("..")) {
				const [a = "", b = ""] = arg.split("..");
				o.exclude.push(a || "HEAD");
				o.include.push(b || "HEAD");
				o.origin.set(a || "HEAD", arg);
				o.origin.set(b || "HEAD", arg);
			} else if (arg.startsWith("^")) o.exclude.push(arg.slice(1));
			else (not ? o.exclude : o.include).push(arg);
			continue;
		}
		if (arg === "--end-of-options") endOfOptions = o.strict = true;
		else if (arg === "--not") not = !not;
		else if (["--remotes", "--branches", "--tags", "--all"].includes(arg))
			o.pseudo.push({ kind: arg.slice(2) as LogOptions["pseudo"][number]["kind"], not });
		else if (arg === "-z") o.z = true;
		else if (arg.startsWith("--date=")) {
			const date = arg.slice(7);
			if (
				![
					"raw",
					"iso",
					"iso8601",
					"iso-strict",
					"iso8601-strict",
					"unix",
					"default",
				].includes(date)
			)
				unsupported("log --date");
			o.date = date.startsWith("iso8601")
				? (date.replace("iso8601", "iso") as LogOptions["date"])
				: (date as LogOptions["date"]);
		} else if (arg.startsWith("--format=") || arg.startsWith("--pretty=")) {
			const value = arg.slice(arg.indexOf("=") + 1);
			if (value === "oneline") o.oneline = true;
			else if (value.startsWith("format:") || value.startsWith("tformat:")) {
				o.format = value.slice(value.indexOf(":") + 1);
				o.separator = value.startsWith("format:");
			} else if (value === "") o.format = "";
			else if (!["medium", "short", "full", "fuller", "raw"].includes(value))
				o.format = value;
		} else if (arg === "--oneline") {
			o.oneline = true;
			o.abbrevCommit = true;
		} else if (arg === "--no-abbrev-commit") o.abbrevCommit = false;
		else if (arg === "--abbrev-commit") o.abbrevCommit = true;
		else if (/^--max-count=\d+$/.test(arg)) o.limit = Number(arg.slice(12));
		else if (/^-\d+$/.test(arg)) o.limit = Number(arg.slice(1));
		else if (arg === "-n" || arg === "--max-count") o.limit = Number(args.shift());
		else if (/^-n\d+$/.test(arg)) o.limit = Number(arg.slice(2));
		else if (/^--skip=\d+$/.test(arg)) o.skip = Number(arg.slice(7));
		else if (arg === "-g" || arg === "--walk-reflogs") o.reflog = true;
		else if (arg === "--first-parent") {
			o.firstParent = true;
			o.diff.push(arg);
		} else if (arg === "--merges") o.merges = true;
		else if (arg === "--no-merges") o.merges = false;
		else if (arg === "--reverse") o.reverse = true;
		else if (arg === "--no-walk" || arg.startsWith("--no-walk=")) o.noWalk = true;
		else if (arg === "--stdin") o.stdin = true;
		else if (arg === "--left-right" && revList) o.leftRight = true;
		else if (arg === "--count" && revList) o.count = true;
		else if (
			[
				"--no-show-signature",
				"--no-color",
				"--color=never",
				"--topo-order",
				"--date-order",
				"--no-decorate",
				"--decorate=short",
				"--decorate",
				"--no-mailmap",
				"--use-mailmap",
			].includes(arg)
		) {
			/* Plain output; date order approximates topological order. */
		} else if (
			[
				"-m",
				"--raw",
				"--numstat",
				"--patch-with-raw",
				"-p",
				"--patch",
				"-C",
				"-M",
				"-w",
				"--name-only",
				"--name-status",
				"--no-renames",
				"--no-ext-diff",
				"--ignore-submodules",
			].includes(arg) ||
			/^-U\d+$/.test(arg)
		)
			o.diff.push(arg);
		else unsupported(revList ? "rev-list" : "log");
	}
	return o;
}

function render(
	tokens: string[],
	oid: string,
	commit: git.CommitObject,
	o: LogOptions,
	refs: Map<string, string[]> | undefined,
	reflog?: Reflog,
): string {
	const paragraphs = commit.message.trim().split(/\n\s*\n/);
	const subject = (paragraphs[0] || "")
		.split("\n")
		.map((s) => s.trim())
		.join(" ");
	const body =
		paragraphs.length > 1 ? commit.message.trimStart().replace(/^[\s\S]*?\n\s*\n/, "") : "";
	const date = (who: Who) =>
		o.date === "raw"
			? rawDate(who)
			: o.date === "iso"
				? isoDate(who)
				: o.date === "iso-strict"
					? isoDate(who, true)
					: o.date === "unix"
						? String(who.timestamp)
						: defaultDate(who);
	let result = "";
	for (const t of tokens) {
		if (!t.startsWith("%") || t.length === 1) {
			result += t;
			continue;
		}
		if (t.startsWith("%x")) {
			result += String.fromCharCode(Number.parseInt(t.slice(2), 16));
			continue;
		}
		if (t.startsWith("%(trailers")) {
			const tail = paragraphs.length > 1 ? paragraphs.at(-1) || "" : "";
			const lines = tail.replace(/\n[ \t]+/g, " ").split("\n");
			const trailers = lines.filter((l) => /^[\w-]+\s*:/.test(l));
			// git only treats the last paragraph as trailers if most of it is.
			if (trailers.length && trailers.length * 4 >= lines.length * 3)
				result += trailers
					.map((l) => `${l.replace(/^([\w-]+)\s*:\s*/, "$1: ")}\n`)
					.join("");
			continue;
		}
		const who = t[1] === "a" ? commit.author : t[1] === "c" ? commit.committer : undefined;
		if (who && t.length === 3) {
			const f = t[2];
			result +=
				f === "n" || f === "N"
					? who.name
					: f === "e" || f === "E"
						? who.email
						: f === "d" || f === "D"
							? date(who)
							: f === "t"
								? String(who.timestamp)
								: f === "i"
									? isoDate(who)
									: f === "I"
										? isoDate(who, true)
										: f === "r"
											? date(who)
											: rawDate(who);
			continue;
		}
		switch (t) {
			case "%%":
				result += "%";
				break;
			case "%n":
				result += "\n";
				break;
			case "%H":
				result += oid;
				break;
			case "%h":
				result += oid.slice(0, 7);
				break;
			case "%T":
				result += commit.tree;
				break;
			case "%t":
				result += commit.tree.slice(0, 7);
				break;
			case "%P":
				result += commit.parent.join(" ");
				break;
			case "%p":
				result += commit.parent.map((p) => p.slice(0, 7)).join(" ");
				break;
			case "%s":
				result += subject;
				break;
			case "%b":
				result += body;
				break;
			case "%B":
				result += commit.message;
				break;
			case "%e":
				break;
			case "%N":
				break;
			case "%D":
				result += refs?.get(oid)?.join(", ") || "";
				break;
			case "%d": {
				const names = refs?.get(oid);
				result += names?.length ? ` (${names.join(", ")})` : "";
				break;
			}
			case "%gD":
				result += reflog?.selector ?? "";
				break;
			case "%gd":
				result += reflog?.short ?? "";
				break;
			case "%gs":
				result += reflog?.message ?? "";
				break;
			case "%gn":
				result += reflog?.who.name ?? "";
				break;
			case "%ge":
				result += reflog?.who.email ?? "";
				break;
			default:
				return fail(`unsupported git log format ${t}`);
		}
	}
	return result;
}

async function selectCommits(repo: Repo, o: LogOptions, cwd: string) {
	if (o.stdin) {
		const text = Buffer.from(await repo.ctx.io.stdin()).toString("utf8");
		o.include.push(...text.split(/\s+/).filter(Boolean));
	}
	if (o.symmetric) {
		const [a, b] = o.symmetric;
		o.include.push(a, b);
	}
	for (const { kind, not } of o.pseudo) {
		const prefixes =
			kind === "all"
				? ["refs/heads", "refs/remotes", "refs/tags"]
				: [`refs/${kind === "branches" ? "heads" : kind}`];
		for (const prefix of prefixes)
			for (const name of await git.listRefs({
				fs: repo.fs,
				gitdir: repo.gitdir,
				filepath: prefix,
			}))
				if (!name.endsWith("/HEAD") && name !== "HEAD")
					(not ? o.exclude : o.include).push(`${prefix}/${name}`);
		if (kind === "all" && !not && (await tryResolve(repo, "HEAD"))) o.include.push("HEAD");
	}
	if (!o.include.length && !o.stdin && !o.pseudo.some((p) => !p.not)) o.include.push("HEAD");
	const resolve = async (spec: string) => {
		const oid = await resolveCommit(repo, spec);
		const given = o.origin.get(spec) ?? spec;
		if (!oid && o.strict) fail(`bad revision '${given}'`);
		if (!oid)
			fail(
				`ambiguous argument '${given}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`,
			);
		return oid as string;
	};
	const include = await Promise.all(o.include.map(resolve));
	const exclude = await Promise.all(o.exclude.map(resolve));
	if (o.symmetric) {
		const [a, b] = await Promise.all(o.symmetric.map(resolve));
		const bases = await git.findMergeBase({
			fs: repo.fs,
			gitdir: repo.gitdir,
			oids: [a as string, b as string],
			cache: repo.cache,
		});
		exclude.push(...(bases as string[]));
	}
	if (o.noWalk) {
		const unique = [...new Set(include)];
		return Promise.all(
			unique.map(async (oid) => ({ oid, commit: (await readCommit(repo, oid)).commit })),
		);
	}
	const paths = o.paths.map((p) => repoPath(repo, cwd, p));
	const wantMore = paths.length || o.merges !== undefined || o.reverse;
	let rows = await walkCommits(repo, include, exclude, {
		firstParent: o.firstParent,
		limit: !wantMore && o.limit !== undefined ? o.limit + o.skip : undefined,
	});
	if (o.merges !== undefined) rows = rows.filter((r) => r.commit.parent.length > 1 === o.merges);
	if (paths.length) {
		const kept = [];
		for (const row of rows) {
			if (o.limit !== undefined && !o.reverse && kept.length >= o.limit + o.skip) break;
			const changes = await compare(
				await commitSnapshot(repo, row.commit.parent[0]),
				await commitSnapshot(repo, row.oid),
				{ paths },
			);
			if (changes.length) kept.push(row);
		}
		rows = kept;
	}
	if (o.reverse) {
		rows = rows.slice(o.skip, o.limit === undefined ? undefined : o.skip + o.limit).reverse();
		return rows;
	}
	return rows.slice(o.skip, o.limit === undefined ? undefined : o.skip + o.limit);
}

async function commitDiff(
	repo: Repo,
	cwd: string,
	oid: string,
	commit: git.CommitObject,
	diffArgs: string[],
	paths: string[],
	z: boolean,
) {
	const flags = parseDiffArgs(
		[...diffArgs.filter((a) => a !== "-m" && a !== "--first-parent"), ...(z ? ["-z"] : [])],
		false,
		true,
	);
	const parent = commit.parent[0];
	if (commit.parent.length > 1 && !diffArgs.includes("-m")) return "";
	const changes: Change[] = await compare(
		await commitSnapshot(repo, parent),
		await commitSnapshot(repo, oid),
		{
			paths: paths.map((p) => repoPath(repo, cwd, p)),
			renames: flags.renames,
			copies: flags.copies,
		},
	);
	return formatChanges(changes, flags);
}

export async function logCommand(
	repo: Repo,
	cwd: string,
	args: string[],
	revList = false,
): Promise<number> {
	const o = parseLogArgs(args, revList);
	const io = repo.ctx.io;
	if (o.reflog) return reflogCommand(repo, o);
	const rows = await selectCommits(repo, o, cwd);
	if (revList) {
		if (o.count) {
			if (o.leftRight && o.symmetric) {
				const left = await resolveCommit(repo, o.symmetric[0]);
				const right = await resolveCommit(repo, o.symmetric[1]);
				const [a, b] = await aheadBehind(repo, left as string, right as string);
				io.stdout(`${a}\t${b}\n`);
			} else io.stdout(`${rows.length}\n`);
			return 0;
		}
		for (const row of rows) io.stdout(`${row.oid}\n`);
		return 0;
	}
	const diffFlags = o.diff.filter((a) => a !== "--first-parent");
	const diff = diffFlags.length > 0;
	if (o.format === undefined && !o.oneline && diff && o.z) o.format = "";
	const tokens: string[] = o.format ? o.format.match(TOKENS) || [] : [];
	if (tokens.includes("%")) unsupported("log format");
	const refs = tokens.some((t) => t === "%D" || t === "%d") ? await decorations(repo) : undefined;
	const term = o.z ? "\0" : "\n";
	const formatted = o.format !== undefined;
	for (const [i, { oid, commit }] of rows.entries()) {
		let text: string;
		if (o.oneline)
			text = `${o.abbrevCommit ? oid.slice(0, 7) : oid} ${commit.message.split("\n")[0]}`;
		else if (formatted) text = render(tokens, oid, commit, o, refs);
		else
			text = `commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${render(["%ad"], oid, commit, o, refs)}\n\n${commit.message
				.trimEnd()
				.split("\n")
				.map((l) => `    ${l}`)
				.join("\n")}\n`;
		if (diff) {
			const patch = await commitDiff(repo, cwd, oid, commit, diffFlags, o.paths, o.z);
			// `--format=` with -z prints nothing for the commit itself.
			if (formatted && !o.format) io.stdout(patch);
			else io.stdout(`${text}${term}${patch}`);
		} else if (o.separator) io.stdout(i ? term + text : text);
		else io.stdout(text + term);
	}
	return 0;
}

async function reflogCommand(repo: Repo, o: LogOptions): Promise<number> {
	const ref = o.include[0] ?? "HEAD";
	if (o.include.length > 1 || o.exclude.length) unsupported("log -g");
	const full =
		ref === "HEAD" || ref.startsWith("refs/")
			? ref
			: (await tryResolve(repo, `refs/heads/${ref}`))
				? `refs/heads/${ref}`
				: `refs/${ref}`;
	if (!(await tryResolve(repo, full)) && o.strict) fail(`bad revision '${ref}'`);
	if (!(await tryResolve(repo, full)))
		fail(
			`ambiguous argument '${ref}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`,
		);
	const entries = readReflog(repo, full);
	const short = full.replace(/^refs\/(?:heads\/)?/, "");
	const tokens: string[] = o.format !== undefined ? o.format.match(TOKENS) || [] : [];
	const term = o.z ? "\0" : "\n";
	const selected = entries.slice(o.skip, o.limit === undefined ? undefined : o.skip + o.limit);
	for (const [n, entry] of selected.entries()) {
		const index = n + o.skip;
		const at =
			o.date === "iso"
				? isoDate(entry.who)
				: o.date === "raw"
					? rawDate(entry.who)
					: String(index);
		const reflog: Reflog = {
			selector: `${full}@{${at}}`,
			short: `${short}@{${at}}`,
			message: entry.message,
			who: entry.who,
		};
		let commit: git.CommitObject;
		try {
			commit = (await readCommit(repo, entry.oid)).commit;
		} catch {
			continue;
		}
		if (o.oneline)
			repo.ctx.io.stdout(
				`${o.abbrevCommit ? entry.oid.slice(0, 7) : entry.oid} ${full === "HEAD" ? "HEAD" : short}@{${index}}: ${entry.message}${term}`,
			);
		else repo.ctx.io.stdout(render(tokens, entry.oid, commit, o, undefined, reflog) + term);
	}
	return 0;
}

/** git reflog [show] [--date=iso] [-n N] [--pretty=...] [<ref>] */
export async function reflog(repo: Repo, cwd: string, args: string[]) {
	if (args[0] === "show") args.shift();
	return logCommand(repo, cwd, ["-g", ...args]);
}

/** git show <rev>:<path> (raw blob), or a commit's message and patch. */
export async function show(repo: Repo, cwd: string, args: string[]): Promise<number> {
	const operands = args.filter((a) => !a.startsWith("-"));
	const options = args.filter((a) => a.startsWith("-") && a !== "--");
	if (operands.length === 1 && (operands[0] as string).includes(":")) {
		const spec = operands[0] as string;
		const oid = await resolveRevision(repo, spec);
		if (!oid) {
			const [rev = "", file = ""] = spec.split(/:(.*)/s);
			if (!(await resolveCommit(repo, rev || "HEAD"))) fail(`invalid object name '${rev}'.`);
			fail(`path '${file}' does not exist in '${rev}'`);
		}
		if (options.some((o) => !["--no-color", "--textconv", "--no-textconv"].includes(o)))
			unsupported("show");
		repo.ctx.io.stdout(await readBlob(repo, oid as string));
		return 0;
	}
	return logCommand(repo, cwd, [
		"-1",
		"--patch-with-raw",
		...args.filter((a) => a !== "--patch"),
	]);
}

/** git cat-file (-t|-s|-e|-p|blob|commit|tree) <object> */
export async function catFile(repo: Repo, args: string[]): Promise<number> {
	const [mode, spec] = args;
	if (args.length !== 2 || !mode || !spec) return unsupported("cat-file");
	const oid = await resolveRevision(repo, spec);
	if (!oid) {
		if (mode === "-e") return 1;
		return fail(`Not a valid object name ${spec}`);
	}
	const object = await git.readObject({
		fs: repo.fs,
		gitdir: repo.gitdir,
		oid,
		cache: repo.cache,
		format: "content",
	});
	const data = object.object as Uint8Array;
	if (mode === "-e") return 0;
	if (mode === "-t") repo.ctx.io.stdout(`${object.type}\n`);
	else if (mode === "-s") repo.ctx.io.stdout(`${data.length}\n`);
	else if (mode === object.type || (mode === "-p" && object.type !== "tree"))
		repo.ctx.io.stdout(data);
	else if (mode === "-p") {
		const { tree } = await git.readTree({
			fs: repo.fs,
			gitdir: repo.gitdir,
			oid,
			cache: repo.cache,
		});
		for (const e of tree)
			repo.ctx.io.stdout(`${e.mode.padStart(6, "0")} ${e.type} ${e.oid}\t${e.path}\n`);
	} else unsupported("cat-file");
	return 0;
}
