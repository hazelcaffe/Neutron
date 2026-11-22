import * as git from "isomorphic-git";
import path from "path-browserify";
import {
	fail,
	headRef,
	type Repo,
	readCommit,
	resolveCommit,
	resolveRevision,
	tryResolve,
	unsupported,
	upstreamOf,
} from "./git-repo";
import { aheadBehind } from "./git-worktree";

export async function upstream(repo: Repo, branch: string) {
	return (await upstreamOf(repo, branch))?.ref;
}

/** Every ref below refs/ (loose and packed), sorted by name. */
export async function allRefs(repo: Repo): Promise<string[]> {
	const refs: string[] = [];
	for (const prefix of ["refs/heads", "refs/remotes", "refs/tags"]) {
		const names = await git.listRefs({ fs: repo.fs, gitdir: repo.gitdir, filepath: prefix });
		for (const name of names) refs.push(`${prefix}/${name}`);
	}
	if (await tryResolve(repo, "refs/stash")) refs.push("refs/stash");
	return refs.sort();
}

const shorten = (ref: string) => {
	if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) return ref.slice(13, -5);
	return ref.replace(/^refs\/(?:heads|remotes|tags)\//, "").replace(/^refs\//, "");
};

function strip(ref: string, count: number) {
	const parts = ref.split("/");
	return count >= 0 ? parts.slice(count).join("/") : parts.slice(count).join("/");
}

const TOKEN = /%%|%[0-9a-fA-F]{2}|%\([a-zA-Z:=,0-9-]+\)|[^%]+|%/g;

export async function formatRefs(repo: Repo, args: string[], defaultPrefixes?: string[]) {
	let format = "%(objectname) %(objecttype)\t%(refname)";
	let pointsAt: string | undefined,
		merged: string | undefined,
		noMerged: string | undefined,
		count: number | undefined,
		sort = "refname";
	const patterns: string[] = [];
	let z = false;
	while (args.length) {
		const arg = args.shift() as string;
		if (arg.startsWith("--format=")) format = arg.slice(9);
		else if (arg === "--format") format = args.shift() ?? unsupported("for-each-ref");
		else if (arg === "--points-at") pointsAt = args.shift();
		else if (arg.startsWith("--points-at=")) pointsAt = arg.slice(12);
		else if (arg === "--merged") merged = args.shift();
		else if (arg.startsWith("--merged=")) merged = arg.slice(9);
		else if (arg === "--no-merged") noMerged = args.shift();
		else if (arg.startsWith("--count=")) count = Number(arg.slice(8));
		else if (arg.startsWith("--sort=")) sort = arg.slice(7);
		else if (arg === "-z") z = true;
		else if (arg === "--") patterns.push(...args.splice(0));
		else if (arg === "-a" || arg === "--all") patterns.push("refs/heads", "refs/remotes");
		else if (arg === "-r" || arg === "--remotes") patterns.push("refs/remotes");
		else if (arg === "--list" || arg === "-l" || arg === "--no-color") {
			/* Listing is the default. */
		} else if (arg.startsWith("-")) unsupported("for-each-ref");
		else patterns.push(defaultPrefixes && !arg.startsWith("refs/") ? `refs/heads/${arg}` : arg);
	}
	const tokens: string[] = format.match(TOKEN) || [];
	if (tokens.includes("%")) fail("unsupported git ref format");
	const wanted = patterns.length ? patterns : (defaultPrefixes ?? []);
	const matchPattern = (ref: string) =>
		!wanted.length ||
		wanted.some((p) =>
			/[*?[]/.test(p)
				? new RegExp(
						`^${p
							.replace(/[.+^${}()|\\]/g, "\\$&")
							.replace(/\*/g, "[^/]*")
							.replace(/\?/g, "[^/]")}$`,
					).test(ref)
				: ref === p || ref.startsWith(p.endsWith("/") ? p : `${p}/`),
		);
	let refs = (await allRefs(repo)).filter(matchPattern);
	const pointsAtOid = pointsAt !== undefined ? await resolveRevision(repo, pointsAt) : undefined;
	if (pointsAt !== undefined && !pointsAtOid) fail(`malformed object name ${pointsAt}`);
	const mergedOid = merged !== undefined ? await resolveCommit(repo, merged) : undefined;
	if (merged !== undefined && !mergedOid) fail(`malformed object name ${merged}`);
	const noMergedOid = noMerged !== undefined ? await resolveCommit(repo, noMerged) : undefined;
	const isAncestor = async (ancestor: string, of: string) =>
		ancestor === of ||
		(await git
			.isDescendent({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid: of,
				ancestor,
				depth: -1,
				cache: repo.cache,
			})
			.catch(() => false));
	const head = await headRef(repo);
	const rows: { ref: string; text: string; key: string | number }[] = [];
	const filtered: string[] = [];
	for (const ref of refs) {
		const oid = await tryResolve(repo, ref);
		if (!oid) continue;
		if (pointsAtOid && oid !== pointsAtOid) continue;
		if (mergedOid || noMergedOid) {
			const commit = await resolveCommit(repo, oid);
			if (!commit) continue;
			if (mergedOid && !(await isAncestor(commit, mergedOid))) continue;
			if (noMergedOid && (await isAncestor(commit, noMergedOid))) continue;
		}
		filtered.push(ref);
	}
	refs = filtered;
	for (const ref of refs) {
		const oid = (await tryResolve(repo, ref)) as string;
		const target = await git
			.resolveRef({ fs: repo.fs, gitdir: repo.gitdir, ref, depth: 2 })
			.catch(() => oid);
		const symref = target.startsWith("refs/") && target !== ref ? target : "";
		let type: string | undefined;
		const objectType = async () => {
			type ??= (
				await git.readObject({
					fs: repo.fs,
					gitdir: repo.gitdir,
					oid,
					cache: repo.cache,
					format: "content",
				})
			).type;
			return type;
		};
		const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : undefined;
		const up = branch ? await upstreamOf(repo, branch) : undefined;
		const commit = async () => {
			const commitOid = await resolveCommit(repo, oid);
			return commitOid ? (await readCommit(repo, commitOid)).commit : undefined;
		};
		const field = async (name: string): Promise<string> => {
			if (name === "refname") return ref;
			if (name === "refname:short") return shorten(ref);
			const lstrip = /^refname:(?:l?strip)=(-?\d+)$/.exec(name);
			if (lstrip) return strip(ref, Number(lstrip[1]));
			if (name === "objectname") return oid;
			if (name === "objectname:short") return oid.slice(0, 7);
			if (name === "objecttype") return objectType();
			if (name === "symref") return symref;
			if (name === "symref:short") return symref ? shorten(symref) : "";
			if (name === "HEAD") return head === ref ? "*" : " ";
			if (name === "upstream") return up?.ref ?? "";
			if (name === "upstream:short") return up ? shorten(up.ref) : "";
			if (name === "upstream:remotename") return up?.remote ?? "";
			if (name === "upstream:remoteref") return up?.merge ?? "";
			if (name === "upstream:track" || name === "upstream:trackshort") {
				if (!up) return "";
				const remote = await tryResolve(repo, up.ref);
				if (!remote) return name.endsWith("short") ? "" : "[gone]";
				const [ahead, behind] = await aheadBehind(repo, oid, remote);
				if (name.endsWith("short"))
					return ahead && behind ? "<>" : ahead ? ">" : behind ? "<" : "=";
				const parts = [
					ahead ? `ahead ${ahead}` : "",
					behind ? `behind ${behind}` : "",
				].filter(Boolean);
				return parts.length ? `[${parts.join(", ")}]` : "";
			}
			if (name === "subject" || name === "contents:subject")
				return ((await commit())?.message.split("\n")[0] ?? "").trim();
			if (/^(committerdate|authordate|creatordate)(:unix|:raw)?$/.test(name)) {
				const c = await commit();
				const who = name.startsWith("author") ? c?.author : c?.committer;
				if (!who) return "";
				return name.endsWith(":unix") ? String(who.timestamp) : `${who.timestamp}`;
			}
			if (name === "authorname") return (await commit())?.author.name ?? "";
			if (name === "authoremail") return `<${(await commit())?.author.email ?? ""}>`;
			if (name === "worktreepath") return head === ref ? repo.dir : "";
			return fail(`unsupported git ref field %(${name})`);
		};
		let text = "";
		for (const token of tokens) {
			if (token === "%%") text += "%";
			else if (/^%[0-9a-fA-F]{2}$/.test(token))
				text += String.fromCharCode(Number.parseInt(token.slice(1), 16));
			else if (token.startsWith("%(")) text += await field(token.slice(2, -1));
			else text += token;
		}
		const key = sort.replace(/^-/, "");
		rows.push({
			ref,
			text,
			key:
				key === "refname"
					? ref
					: key.endsWith("date")
						? Number(await field(`${key}:unix`))
						: await field(key),
		});
	}
	rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	if (sort.startsWith("-")) rows.reverse();
	return rows
		.slice(0, count)
		.map((r) => r.text + (z ? "\0" : "\n"))
		.join("");
}

/** `git branch` listing: --format, --points-at, --merged, -a/-r. */
export async function listBranches(repo: Repo, args: string[]) {
	const rest = args.filter((a) => !["-v", "-vv", "--list", "-l"].includes(a));
	const hasFormat = rest.some((a) => a.startsWith("--format"));
	const remote = rest.includes("-r") || rest.includes("--remotes");
	const all = rest.includes("-a") || rest.includes("--all");
	const filtered = rest.filter((a) => !["-r", "--remotes", "-a", "--all"].includes(a));
	const prefixes = all
		? ["refs/heads", "refs/remotes"]
		: remote
			? ["refs/remotes"]
			: ["refs/heads"];
	if (!hasFormat)
		filtered.unshift(
			`--format=%(HEAD) %(${remote || all ? "refname:short" : "refname:short"})`,
		);
	return formatRefs(repo, filtered, prefixes);
}

export async function showRef(repo: Repo, args: string[]): Promise<number> {
	let tags = false,
		heads = false,
		dereference = false,
		verify = false,
		quiet = false,
		hash = false;
	const patterns: string[] = [];
	for (const arg of args) {
		if (arg === "--tags") tags = true;
		else if (arg === "--heads" || arg === "--branches") heads = true;
		else if (arg === "-d" || arg === "--dereference") dereference = true;
		else if (arg === "--verify") verify = true;
		else if (arg === "-q" || arg === "--quiet") quiet = true;
		else if (arg === "-s" || arg === "--hash") hash = true;
		else if (arg === "--") continue;
		else if (arg.startsWith("-")) unsupported("show-ref");
		else patterns.push(arg);
	}
	let refs = await allRefs(repo);
	if (verify) refs = patterns.filter((p) => refs.includes(p));
	else {
		if (tags || heads)
			refs = refs.filter(
				(r) =>
					(tags && r.startsWith("refs/tags/")) || (heads && r.startsWith("refs/heads/")),
			);
		if (patterns.length)
			refs = refs.filter((r) => patterns.some((p) => r === p || r.endsWith(`/${p}`)));
	}
	if (!refs.length) {
		if (verify && !quiet)
			repo.ctx.io.stderr(`fatal: '${patterns[0] ?? ""}' - not a valid ref\n`);
		return 1;
	}
	if (quiet) return 0;
	for (const ref of refs) {
		const oid = (await tryResolve(repo, ref)) as string;
		repo.ctx.io.stdout(hash ? `${oid}\n` : `${oid} ${ref}\n`);
		if (dereference) {
			let target = oid;
			let object = await git.readObject({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid,
				cache: repo.cache,
				format: "parsed",
			});
			while (object.type === "tag") {
				target = (object.object as git.TagObject).object;
				object = await git.readObject({
					fs: repo.fs,
					gitdir: repo.gitdir,
					oid: target,
					cache: repo.cache,
					format: "parsed",
				});
			}
			if (target !== oid) repo.ctx.io.stdout(hash ? `${target}\n` : `${target} ${ref}^{}\n`);
		}
	}
	return 0;
}

export async function symbolicRef(repo: Repo, args: string[]): Promise<number> {
	let quiet = false,
		short = false,
		del = false,
		message: string | undefined;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "-q" || arg === "--quiet") quiet = true;
		else if (arg === "--short") short = true;
		else if (arg === "-d" || arg === "--delete") del = true;
		else if (arg === "-m") message = args.shift();
		else if (arg === "--") operands.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("symbolic-ref");
		else operands.push(arg);
	}
	const [name, target] = operands;
	if (!name || operands.length > 2 || !/^(HEAD|refs\/[\w./-]+)$/.test(name))
		unsupported("symbolic-ref");
	const file = path.join(repo.gitdir, name as string);
	if (del) {
		repo.fs.rmSync(file, { force: true });
		return 0;
	}
	if (target !== undefined) {
		if (!target.startsWith("refs/")) fail(`Refusing to point ${name} outside of refs/`);
		repo.fs.mkdirSync(path.dirname(file), { recursive: true });
		repo.fs.writeFileSync(file, `ref: ${target}\n`);
		void message;
		return 0;
	}
	let value: string;
	try {
		value = String(repo.fs.readFileSync(file, "utf8"));
	} catch {
		if (!quiet) repo.ctx.io.stderr(`fatal: ref ${name} is not a symbolic ref\n`);
		return quiet ? 1 : 128;
	}
	if (!value.startsWith("ref: ")) {
		if (!quiet) repo.ctx.io.stderr(`fatal: ref ${name} is not a symbolic ref\n`);
		return quiet ? 1 : 128;
	}
	const ref = value.slice(5).trim();
	repo.ctx.io.stdout(`${short ? shorten(ref) : ref}\n`);
	return 0;
}
