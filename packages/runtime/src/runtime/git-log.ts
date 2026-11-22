import { Buffer } from "buffer";
import * as git from "isomorphic-git";

const refuse = (): never => {
	throw new Error("unsupported git log arguments");
};
type Repo = { fs: git.FsClient; dir: string };
function rawDate(who: git.CommitObject["author"]) {
	const n = Math.abs(who.timezoneOffset);
	return `${who.timestamp} ${who.timezoneOffset > 0 ? "-" : "+"}${String(Math.floor(n / 60)).padStart(2, "0")}${String(n % 60).padStart(2, "0")}`;
}

async function decorations(repo: Repo) {
	const names = new Map<string, string[]>();
	const add = async (ref: string, label: string) => {
		const oid = await git.resolveRef({ ...repo, ref });
		// readCommit peels annotated tags; a tag can also point at a blob/tree.
		let commit = oid;
		if (ref.startsWith("refs/tags/")) {
			try {
				commit = (await git.readCommit({ ...repo, oid })).oid;
			} catch {
				return;
			}
		}
		names.set(commit, [...(names.get(commit) || []), label]);
	};
	const current = await git.currentBranch(repo);
	for (const branch of await git.listBranches(repo))
		await add(`refs/heads/${branch}`, branch === current ? `HEAD -> ${branch}` : branch);
	if (!current) await add("HEAD", "HEAD");
	for (const tag of await git.listTags(repo)) await add(`refs/tags/${tag}`, `tag: ${tag}`);
	for (const { remote } of await git.listRemotes(repo))
		for (const branch of await git.listBranches({ ...repo, remote }))
			await add(`refs/remotes/${remote}/${branch}`, `${remote}/${branch}`);
	return names;
}

// Read-only pretty-format subset. Reject ranges, arbitrary pathspecs, raw
// diffs and unknown %-escapes; never substitute empty fake commit fields.
export async function gitLog(repo: Repo, args: string[]): Promise<string> {
	if (args.includes("--raw")) return rawCommit(repo, args);
	let format: string | undefined,
		ref: string | undefined,
		limit: number | undefined,
		skip = 0,
		raw = false,
		term = "\n",
		endOptions = false;
	while (args.length) {
		const arg = args.shift() || refuse();
		if (arg === "--" && !args.length) break;
		if (!endOptions && arg === "--end-of-options") endOptions = true;
		else if (!endOptions && arg === "-z") term = "\0";
		else if (!endOptions && arg === "--date=raw") raw = true;
		else if (!endOptions && ["--no-show-signature", "--no-color"].includes(arg)) {
			/* Already plain text. */
		} else if (!endOptions && arg.startsWith("--format=")) format = arg.slice(9);
		else if (!endOptions && /^--max-count=\d+$/.test(arg)) limit = Number(arg.slice(12));
		else if (!endOptions && /^--skip=\d+$/.test(arg)) skip = Number(arg.slice(7));
		else if (!ref && /^[\w/][\w./-]*$/.test(arg) && !arg.includes("..")) ref = arg;
		else refuse();
	}
	if (format === undefined || ((format.includes("%ad") || format.includes("%cd")) && !raw))
		return refuse();
	const tokens: string[] =
		format.match(
			/%(?:x[0-7][0-9a-fA-F]|\(trailers:unfold,only\)|[ac][nedt]|[HhsbBPDn%])|[^%]+|%/g,
		) || [];
	if (tokens.includes("%")) return refuse();
	if (limit === 0) return "";
	const rows = await git.log({
		...repo,
		ref,
		depth: limit === undefined ? undefined : skip + limit,
	});
	const refs = tokens.includes("%D") ? await decorations(repo) : undefined;
	return rows
		.slice(skip)
		.map(({ oid, commit }) => {
			const paragraphs = commit.message.trim().split(/\n\s*\n/);
			const body =
				paragraphs.length > 1
					? commit.message.trimStart().replace(/^[\s\S]*?\n\s*\n/, "")
					: "";
			const fields: Record<string, string> = {
				"%%": "%",
				"%n": "\n",
				"%H": oid,
				"%h": oid.slice(0, 7),
				"%s": (paragraphs[0] || "")
					.split("\n")
					.map((s) => s.trimEnd())
					.join(" "),
				"%b": body,
				"%B": commit.message,
				"%P": commit.parent.join(" "),
				"%D": refs?.get(oid)?.join(", ") || "",
			};
			for (const [p, who] of [
				["a", commit.author],
				["c", commit.committer],
			] as const) {
				fields[`%${p}n`] = who.name;
				fields[`%${p}e`] = who.email;
				fields[`%${p}d`] = rawDate(who);
				fields[`%${p}t`] = String(who.timestamp);
			}
			if (tokens.includes("%(trailers:unfold,only)")) {
				const tail = paragraphs.length > 1 ? paragraphs.at(-1) || "" : "";
				const lines = tail.replace(/\n[ \t]+/g, " ").split("\n");
				const trailers = lines.filter((l) => /^[\w-]+\s*:/.test(l));
				if (trailers.length && trailers.length !== lines.length)
					throw new Error("mixed trailer paragraphs not supported");
				fields["%(trailers:unfold,only)"] = trailers
					.map((l) => `${l.replace(/^([\w-]+)\s*:\s*/, "$1: ")}\n`)
					.join("");
			}
			return (
				tokens
					.map((t) =>
						t.startsWith("%x")
							? String.fromCharCode(Number.parseInt(t.slice(2), 16))
							: (fields[t] ?? t),
					)
					.join("") + term
			);
		})
		.join("");
}

// Single ordinary commit, machine-readable raw + numstat. Calculate actual
// changed blob IDs, modes and line counts; decline rename/copy candidates
// rather than claiming they are independent adds/deletes.
async function rawCommit(repo: Repo, args: string[]) {
	const allowed = [
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
	];
	const opts = args.filter((a) => a.startsWith("-") && a !== "--");
	const refs = args.filter((a) => !a.startsWith("-"));
	if (
		(args.includes("--") && args.at(-1) !== "--") ||
		opts.some((a) => !allowed.includes(a)) ||
		!["-1", "--raw", "--format=format:", "--numstat", "-z"].every((a) => opts.includes(a)) ||
		refs.length !== 1 ||
		!/^[\da-f]{40}$/.test(refs[0] || "")
	)
		return refuse();
	const { oid, commit } = await git.readCommit({ ...repo, oid: refs[0] ?? refuse() });
	if (commit.parent.length > 1) throw new Error("raw merge diff not supported");
	const trees = [git.TREE({ ref: oid })];
	if (commit.parent[0]) trees.push(git.TREE({ ref: commit.parent[0] }));
	const raw: string[] = [],
		stats: string[] = [];
	let added = false,
		source = false;
	await git.walk({
		...repo,
		trees,
		map: async (name, [after, before]) => {
			if (name === ".") return;
			const a = after && (await after.type()),
				b = before && (await before.type());
			if (a === "tree" || b === "tree") {
				if (a && b && a !== b) refuse();
				return;
			}
			const oldOid = before && (await before.oid()),
				newOid = after && (await after.oid());
			const oldMode = before ? (await before.mode()).toString(8) : "000000",
				newMode = after ? (await after.mode()).toString(8) : "000000";
			if (oldOid === newOid && oldMode === newMode) return;
			if ((a && a !== "blob") || (b && b !== "blob")) refuse();
			const stat = after && before ? "M" : after ? "A" : "D";
			added ||= stat === "A";
			source ||= stat !== "A";
			const left = (before && (await before.content())) || undefined,
				right = (after && (await after.content())) || undefined;
			if ((left && left.length > 1024 * 1024) || (right && right.length > 1024 * 1024))
				throw new Error("blob exceeds numstat limit");
			const lines = (v?: Uint8Array) =>
				v
					? Buffer.from(v)
							.toString("latin1")
							.match(/[^\n]*\n|[^\n]+$/g) || []
					: [];
			let count = "-\t-";
			if (!left?.subarray(0, 8000).includes(0) && !right?.subarray(0, 8000).includes(0)) {
				const x = lines(left),
					y = lines(right);
				if (x.length * y.length > 2_000_000)
					throw new Error("text diff exceeds numstat limit");
				const lcs = new Uint32Array(y.length + 1);
				for (const l of x) {
					let prev = 0;
					for (const [k, r] of y.entries()) {
						const prior = lcs[k + 1] ?? 0;
						lcs[k + 1] = l === r ? prev + 1 : Math.max(prior, lcs[k] ?? 0);
						prev = prior;
					}
				}
				const kept = lcs[y.length] ?? 0;
				count = `${y.length - kept}\t${x.length - kept}`;
			}
			raw.push(
				`:${oldMode} ${newMode} ${(oldOid || "0000000").slice(0, 7)} ${(newOid || "0000000").slice(0, 7)} ${stat}\0${name}\0`,
			);
			stats.push(`${count}\t${name}\0`);
		},
	});
	if (added && source && (opts.includes("-M") || opts.includes("-C")))
		throw new Error("rename/copy detection not supported");
	return raw.join("") + stats.join("");
}
