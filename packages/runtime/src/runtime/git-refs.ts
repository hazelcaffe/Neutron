import * as git from "isomorphic-git";

type Repo = { fs: git.FsClient; dir: string };
export async function upstream(repo: Repo, branch: string) {
	const remote = await git.getConfig({ ...repo, path: `branch.${branch}.remote` });
	const merge = await git.getConfig({ ...repo, path: `branch.${branch}.merge` });
	if (typeof remote !== "string" || typeof merge !== "string" || !merge.startsWith("refs/heads/"))
		return;
	return remote === "." ? merge : `refs/remotes/${remote}/${merge.slice(11)}`;
}

export async function formatRefs(repo: Repo, args: string[]) {
	const fmt = args.shift();
	if (!fmt?.startsWith("--format=")) throw new Error("unsupported git for-each-ref format");
	const filters = args.length ? args : ["refs/heads", "refs/tags", "refs/remotes"];
	if (filters.some((f) => !["refs/heads", "refs/tags", "refs/remotes"].includes(f)))
		throw new Error("unsupported git ref filter");
	const tokens: string[] =
		fmt
			.slice(9)
			.match(
				/%%|%00|%\((?:refname(?::short)?|upstream:short|objectname|symref)\)|[^%]+|%/g,
			) || [];
	if (tokens.includes("%")) throw new Error("unsupported git ref field");
	const refs: string[] = [];
	if (filters.includes("refs/heads"))
		for (const name of await git.listBranches(repo)) refs.push(`refs/heads/${name}`);
	if (filters.includes("refs/tags"))
		for (const name of await git.listTags(repo)) refs.push(`refs/tags/${name}`);
	if (filters.includes("refs/remotes"))
		for (const { remote } of await git.listRemotes(repo))
			for (const name of await git.listBranches({ ...repo, remote }))
				refs.push(`refs/remotes/${remote}/${name}`);
	const rows = [];
	for (const ref of refs.sort()) {
		const short = ref.replace(/^refs\/(?:heads|remotes|tags)\//, "");
		const target = await git.resolveRef({ ...repo, ref, depth: 1 });
		const up =
			ref.startsWith("refs/heads/") && tokens.includes("%(upstream:short)")
				? await upstream(repo, short)
				: undefined;
		const fields: Record<string, string> = {
			"%%": "%",
			"%00": "\0",
			"%(refname)": ref,
			"%(refname:short)": short,
			"%(objectname)": await git.resolveRef({ ...repo, ref }),
			"%(symref)": target.startsWith("refs/") ? target : "",
			"%(upstream:short)": up?.replace(/^refs\/(?:heads|remotes)\//, "") ?? "",
		};
		rows.push(`${tokens.map((t) => fields[t] ?? t).join("")}\n`);
	}
	return rows.join("");
}
