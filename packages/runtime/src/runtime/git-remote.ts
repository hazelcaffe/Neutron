import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import path from "path-browserify";
import { VirtualFileSystem } from "./filesystem";
import { compare } from "./git-diff";
import { filterEnabled, type Pointer, parsePointer, treeAttributes, upload } from "./git-lfs";
import {
	commitTree,
	configGet,
	configGetAll,
	deleteLocalSection,
	fail,
	failRaw,
	type GitContext,
	headRef,
	isValidRefName,
	logRef,
	type Repo,
	readBlob,
	readCommit,
	resolveCommit,
	setLocalConfig,
	tryResolve,
	unsupported,
	updateRef,
	upstreamOf,
	walkCommits,
} from "./git-repo";
import { commitSnapshot } from "./git-snapshot";
import { mergeInto, switchTrees } from "./git-worktree";

const MAX_TRANSFER = 256 * 1024 * 1024;

class AuthenticationRequired extends Error {}

function http(ctx: GitContext): git.HttpClient {
	const io = ctx.io;
	return {
		request: async ({ url, method, headers, body }) => {
			io.signal.throwIfAborted();
			const chunks: Uint8Array[] = [];
			let size = 0;
			if (body)
				for await (const part of body) {
					size += part.length;
					if (size > MAX_TRANSFER) fail("Git request exceeds transfer limit");
					chunks.push(part);
				}
			const res = await io.fetch(url, {
				method,
				headers,
				credentials: "omit",
				redirect: "follow",
				signal: io.signal,
				...(body ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
			});
			if (res.status === 401) throw new AuthenticationRequired(url);
			if (res.status === 403)
				fail(`unable to access '${url}': The requested URL returned error: 403`);
			if (res.status === 404) {
				const repo = url.replace(/\/(?:info\/refs\?.*|git-(?:upload|receive)-pack)$/, "");
				fail(`repository '${repo}/' not found`);
			}
			if (!res.ok)
				fail(`unable to access '${url}': The requested URL returned error: ${res.status}`);
			const reader = res.body?.getReader();
			async function* responseBody() {
				if (!reader) return;
				let bytes = 0;
				try {
					for (;;) {
						io.signal.throwIfAborted();
						const { done, value } = await reader.read();
						if (done) break;
						bytes += value.length;
						if (bytes > MAX_TRANSFER) fail("Git response exceeds the transfer limit");
						yield value;
					}
				} finally {
					await reader.cancel();
				}
			}
			return {
				url: res.url || url,
				method,
				headers: Object.fromEntries(res.headers),
				statusCode: res.status,
				statusMessage: res.statusText,
				body: responseBody(),
			};
		},
	};
}

/** Run a transfer and translate authentication challenges the way git does
 * when no credential helper supplies credentials. */
async function transfer<T>(
	ctx: GitContext,
	repo: Repo | undefined,
	url: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof AuthenticationRequired ||
			(error as { cause?: unknown }).cause instanceof AuthenticationRequired
		) {
			const origin = new URL(url).origin;
			const helpers = (await configGetAll(ctx, repo, "credential.helper")).filter(Boolean);
			const notes = helpers.length
				? `error: credential helper '${helpers.at(-1)}' was not run: this Git cannot execute credential helper programs\n`
				: "";
			if (ctx.env.GIT_TERMINAL_PROMPT === "0" || !ctx.env.GIT_TERMINAL_PROMPT)
				failRaw(
					`${notes}fatal: could not read Username for '${origin}': terminal prompts disabled`,
				);
		}
		throw error;
	}
}

function checkUrl(ctx: GitContext, value: string, settings = ctx.overrides): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail(`'${value}' does not appear to be a git repository`);
	}
	if (!["http:", "https:"].includes(url.protocol))
		fail(
			`unsupported transport '${url.protocol.slice(0, -1)}' (only anonymous HTTP(S) remotes are available)`,
		);
	if (url.username || url.password || url.hash)
		fail("remote URLs must be anonymous HTTP(S) URLs");
	const protocol = url.protocol.slice(0, -1);
	const allow = settings.findLast(
		([key]) => key.toLowerCase() === `protocol.${protocol}.allow`,
	)?.[1];
	if (
		allow === "never" ||
		(ctx.env.GIT_ALLOW_PROTOCOL !== undefined &&
			!ctx.env.GIT_ALLOW_PROTOCOL.split(":").includes(protocol))
	)
		fail(`transport '${protocol}' not allowed`);
	return url;
}

async function remoteUrl(repo: Repo, name: string): Promise<{ remote?: string; url: string }> {
	const configured = await configGet(repo.ctx, repo, `remote.${name}.url`);
	if (configured) return { remote: name, url: checkUrl(repo.ctx, configured).href };
	if (/^https?:\/\//i.test(name)) return { url: checkUrl(repo.ctx, name).href };
	return fail(
		`'${name}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`,
	);
}

function progress(ctx: GitContext, enabled: boolean) {
	let last = "";
	return ({ phase, loaded, total }: git.GitProgressEvent) => {
		ctx.io.signal.throwIfAborted();
		if (!enabled) return;
		const line = total
			? `${phase}: ${Math.floor((loaded / total) * 100)}% (${loaded}/${total})`
			: `${phase}: ${loaded}`;
		if (line !== last && (!total || loaded === total || loaded % 50 === 0)) {
			ctx.io.stderr(`${line}${total && loaded === total ? ", done.\n" : "\r"}`);
			last = line;
		}
	};
}

// ---------------------------------------------------------------- fetch

export async function fetchCommand(repo: Repo, args: string[]): Promise<number> {
	let prune = false,
		showProgress = false,
		writeFetchHead = true,
		stdin = false,
		tags: boolean | undefined;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--prune" || arg === "-p") prune = true;
		else if (arg === "--progress") showProgress = true;
		else if (arg === "--stdin") stdin = true;
		else if (arg === "--tags" || arg === "-t") tags = true;
		else if (arg === "--no-tags" || arg === "-n") tags = false;
		else if (
			[
				"--show-forced-updates",
				"--recurse-submodules=on-demand",
				"--recurse-submodules=no",
				"--no-recurse-submodules",
				"-q",
				"--quiet",
				"--verbose",
				"-v",
			].includes(arg)
		) {
			/* Submodules are not fetched. */
		} else if (arg === "--no-write-fetch-head") writeFetchHead = false;
		else if (arg === "--") operands.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("fetch");
		else operands.push(arg);
	}
	if (stdin) {
		const text = Buffer.from(await repo.ctx.io.stdin()).toString("utf8");
		operands.push(...text.split(/\r?\n/).filter(Boolean));
	}
	const [name = (await defaultRemote(repo)) ?? "origin", ...refspecs] = operands;
	if (name === ".") return fetchLocal(repo, refspecs);
	const { remote, url } = await remoteUrl(repo, name);
	if (refspecs.length > 1) unsupported("fetch");
	let ref: string | undefined, remoteRef: string | undefined;
	if (refspecs[0]) {
		const [src = "", dst = ""] = refspecs[0].replace(/^\+/, "").split(":");
		remoteRef = src.replace(/^refs\/heads\//, "");
		ref = dst
			? dst.replace(/^refs\/remotes\/[^/]+\//, "").replace(/^refs\/heads\//, "")
			: remoteRef;
	}
	const before = await refsSnapshot(repo, remote);
	const result = await transfer(repo.ctx, repo, url, () =>
		git.fetch({
			fs: repo.fs,
			gitdir: repo.gitdir,
			http: http(repo.ctx),
			url,
			remote,
			ref,
			remoteRef,
			singleBranch: !!ref,
			tags: tags ?? !!remote,
			prune,
			onProgress: progress(repo.ctx, showProgress),
			onMessage: (message) => repo.ctx.io.stderr(`remote: ${message}`),
			cache: repo.cache,
		}),
	);
	// isomorphic-git returns early for a remote without refs; --prune still
	// removes every remote-tracking branch of that remote, as git does.
	if (prune && remote && !result.fetchHead && !result.defaultBranch) {
		const pruned: string[] = [];
		for (const name of await git.listRefs({
			fs: repo.fs,
			gitdir: repo.gitdir,
			filepath: `refs/remotes/${remote}`,
		})) {
			await git.deleteRef({
				fs: repo.fs,
				gitdir: repo.gitdir,
				ref: `refs/remotes/${remote}/${name}`,
			});
			if (name !== "HEAD") pruned.push(`refs/remotes/${remote}/${name}`);
		}
		result.pruned = pruned;
	}
	const after = await refsSnapshot(repo, remote);
	const lines: string[] = [];
	for (const [refName, oid] of after) {
		const prior = before.get(refName);
		if (prior === oid) continue;
		const short = refName.replace(/^refs\/remotes\//, "").replace(/^refs\/tags\//, "");
		const label = refName.startsWith("refs/tags/")
			? "[new tag]"
			: prior
				? `${prior.slice(0, 7)}..${oid.slice(0, 7)}`
				: "[new branch]";
		lines.push(
			` ${prior ? " " : "*"} ${label.padEnd(17)} ${short.replace(/^[^/]+\//, "").padEnd(10)} -> ${short}`,
		);
		await logRef(
			repo,
			refName,
			prior,
			oid,
			`fetch: ${prior ? "fast-forward" : "storing head"}`,
		);
	}
	for (const pruned of result.pruned || [])
		lines.push(` - [deleted]         (none)     -> ${pruned.replace(/^refs\/remotes\//, "")}`);
	if (lines.length) repo.ctx.io.stderr(`From ${url}\n${lines.join("\n")}\n`);
	// Like git, record what was fetched (empty for an empty remote); tools
	// read its modification time as the last fetch time.
	if (writeFetchHead)
		repo.fs.writeFileSync(
			path.join(repo.gitdir, "FETCH_HEAD"),
			result.fetchHead ? `${result.fetchHead}\t\t${result.fetchHeadDescription ?? ""}\n` : "",
		);
	return 0;
}

async function refsSnapshot(repo: Repo, remote?: string) {
	const refs = new Map<string, string>();
	const prefixes = remote ? [`refs/remotes/${remote}`, "refs/tags"] : ["refs/tags"];
	for (const prefix of prefixes)
		for (const name of await git.listRefs({
			fs: repo.fs,
			gitdir: repo.gitdir,
			filepath: prefix,
		})) {
			const oid = await tryResolve(repo, `${prefix}/${name}`);
			if (oid && !name.endsWith("HEAD")) refs.set(`${prefix}/${name}`, oid);
		}
	return refs;
}

async function defaultRemote(repo: Repo) {
	const branch = (await headRef(repo))?.replace(/^refs\/heads\//, "");
	return branch ? (await upstreamOf(repo, branch))?.remote : undefined;
}

/** `git fetch . src:dst...` fast-forwards local refs from local refs. */
async function fetchLocal(repo: Repo, refspecs: string[]): Promise<number> {
	let failed = false;
	const reflogAction = repo.ctx.env.GIT_REFLOG_ACTION || "fetch";
	const head = await headRef(repo);
	for (const spec of refspecs) {
		const force = spec.startsWith("+");
		const [src = "", dst = ""] = spec.replace(/^\+/, "").split(":");
		const from = await resolveCommit(repo, src);
		if (!from) fail(`couldn't find remote ref ${src}`);
		const target = dst.startsWith("refs/") ? dst : `refs/heads/${dst}`;
		if (!isValidRefName(target)) fail(`invalid refspec '${spec}'`);
		if (target === head) {
			repo.ctx.io.stderr(
				` ! [rejected]        ${src} -> ${dst}  (refusing to fetch into branch '${target}' checked out at '${repo.dir}')\n`,
			);
			failed = true;
			continue;
		}
		const current = await tryResolve(repo, target);
		if (current === from) continue;
		const ff =
			!current ||
			(await git.isDescendent({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid: from as string,
				ancestor: current,
				depth: -1,
				cache: repo.cache,
			}));
		if (!ff && !force) {
			repo.ctx.io.stderr(` ! [rejected]        ${src} -> ${dst}  (non-fast-forward)\n`);
			failed = true;
			continue;
		}
		await updateRef(repo, target, from as string, `${reflogAction}: fast-forward`);
	}
	return failed ? 1 : 0;
}

// ---------------------------------------------------------------- pull

export async function pullCommand(repo: Repo, args: string[]): Promise<number> {
	let ffOnly = false,
		noFf = false,
		showProgress = false,
		rebase: boolean | undefined;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--ff") noFf = false;
		else if (arg === "--ff-only") ffOnly = true;
		else if (arg === "--no-ff") noFf = true;
		else if (arg === "--progress") showProgress = true;
		else if (arg === "--rebase" || arg === "-r") rebase = true;
		else if (arg === "--no-rebase") rebase = false;
		else if (
			[
				"--recurse-submodules",
				"--no-recurse-submodules",
				"--no-verify",
				"-q",
				"--quiet",
				"--no-edit",
			].includes(arg)
		) {
			/* Hooks and submodules are not run. */
		} else if (arg === "--") operands.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("pull");
		else operands.push(arg);
	}
	const branch = (await headRef(repo))?.replace(/^refs\/heads\//, "");
	if (!branch) fail("You are not currently on a branch.");
	const up = await upstreamOf(repo, branch as string);
	const remote = operands[0] ?? up?.remote;
	if (!remote)
		failRaw(
			`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.`,
			1,
		);
	const configRebase =
		(await configGet(repo.ctx, repo, `branch.${branch}.rebase`)) ??
		(await configGet(repo.ctx, repo, "pull.rebase"));
	if (rebase ?? (configRebase !== undefined && !/^(false|no|off|0)$/i.test(configRebase)))
		fail("pull with rebase is not supported by this Git; use merge (git pull --no-rebase)");
	const pullFf = await configGet(repo.ctx, repo, "pull.ff");
	if (pullFf === "only") ffOnly = true;
	if (pullFf === "false") noFf = noFf || true;
	const remoteBranch =
		operands[1]?.replace(/^refs\/heads\//, "") ??
		(up?.remote === remote ? up?.merge.replace(/^refs\/heads\//, "") : undefined);
	if (!remoteBranch) fail(`no candidate branch to merge from '${remote}'`);
	await fetchCommand(repo, [...(showProgress ? ["--progress"] : []), "--", remote as string]);
	const theirs = `refs/remotes/${remote}/${remoteBranch}`;
	if (!(await tryResolve(repo, theirs)))
		failRaw(
			`Your configuration specifies to merge with the ref 'refs/heads/${remoteBranch}'\nfrom the remote, but no such ref was fetched.`,
			1,
		);
	const url = (await remoteUrl(repo, remote as string)).url;
	return mergeInto(repo, theirs, {
		ffOnly,
		noFf,
		reflog: `pull ${remote}`,
		message: `Merge branch '${remoteBranch}' of ${url.replace(/\.git$/, "")}`,
	});
}

// ---------------------------------------------------------------- push

/** LFS objects referenced by commits the remote does not have (pre-push). */
async function pushLfs(
	repo: Repo,
	remote: string,
	local: string,
	remoteTips: string[],
	ref: string,
) {
	if (!(await filterEnabled(repo))) return;
	const known = [];
	for (const oid of remoteTips) {
		try {
			await readCommit(repo, oid);
			known.push(oid);
		} catch {
			/* Not present locally. */
		}
	}
	for (const name of await git.listRefs({
		fs: repo.fs,
		gitdir: repo.gitdir,
		filepath: `refs/remotes/${remote}`,
	})) {
		const oid = await tryResolve(repo, `refs/remotes/${remote}/${name}`);
		if (oid) known.push(oid);
	}
	const commits = await walkCommits(repo, [local], known, { limit: 10_000 });
	const pointers = new Map<string, Pointer>();
	for (const { oid, commit } of commits) {
		const after = await commitTree(repo, oid);
		const attributes = await treeAttributes(repo, after);
		const changes = await compare(
			await commitSnapshot(repo, commit.parent[0]),
			await commitSnapshot(repo, oid),
		);
		for (const change of changes) {
			if (!change.new || change.new.mode === "160000") continue;
			if (attributes.get(change.newPath).get("filter") !== "lfs") continue;
			const pointer = parsePointer(await readBlob(repo, await change.new.oid()));
			if (pointer) pointers.set(pointer.oid, pointer);
		}
	}
	if (pointers.size) {
		const sent = await upload(repo, [...pointers.values()], remote, ref);
		if (sent) repo.ctx.io.stderr(`Uploading LFS objects: 100% (${sent}/${sent}), done.\n`);
	}
}

export async function pushCommand(repo: Repo, args: string[]): Promise<number> {
	let setUpstream = false,
		force = false,
		lease = false,
		dryRun = false,
		porcelain = false,
		followTags = false,
		showProgress = false,
		deleteRefs = false,
		pushTags = false;
	const operands: string[] = [];
	while (args.length) {
		const arg = args.shift() as string;
		if (arg === "--set-upstream" || arg === "-u") setUpstream = true;
		else if (arg === "--force" || arg === "-f") force = true;
		else if (arg === "--force-with-lease") lease = true;
		else if (arg === "--dry-run" || arg === "-n") dryRun = true;
		else if (arg === "--porcelain") porcelain = true;
		else if (arg === "--follow-tags") followTags = true;
		else if (arg === "--progress") showProgress = true;
		else if (arg === "--delete" || arg === "-d") deleteRefs = true;
		else if (arg === "--tags") pushTags = true;
		else if (
			["--no-verify", "-q", "--quiet", "--verbose", "-v", "--no-progress"].includes(arg)
		) {
			/* Hooks never run; LFS pre-push is built in. */
		} else if (arg === "--") operands.push(...args.splice(0));
		else if (arg.startsWith("-")) unsupported("push");
		else operands.push(arg);
	}
	const current = (await headRef(repo))?.replace(/^refs\/heads\//, "");
	const name =
		operands.shift() ??
		(current ? (await upstreamOf(repo, current))?.remote : undefined) ??
		"origin";
	const { remote, url } = await remoteUrl(repo, name);
	if (!operands.length) {
		if (!current) fail("You are not currently on a branch.");
		const up = await upstreamOf(repo, current as string);
		if (!up && !setUpstream)
			failRaw(
				`fatal: The current branch ${current} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${name} ${current}\n`,
			);
		operands.push(`${current}:${up?.merge.replace(/^refs\/heads\//, "") ?? current}`);
	}
	if (pushTags)
		for (const tag of await git.listTags({ fs: repo.fs, gitdir: repo.gitdir }))
			operands.push(`refs/tags/${tag}`);
	const info = await transfer(repo.ctx, repo, url, () =>
		git.getRemoteInfo2({ http: http(repo.ctx), url, forPush: true, protocolVersion: 1 }),
	);
	const advertised = new Map<string, string>();
	if (info.protocolVersion === 1)
		for (const { ref, oid } of info.refs ?? [])
			if (!ref.endsWith("^{}")) advertised.set(ref, oid);
	const lines: string[] = [];
	let rejected = false;
	const updates: { src?: string; dst: string; local?: string; forced: boolean }[] = [];
	for (const spec of operands) {
		const forced = force || spec.startsWith("+");
		const [srcRaw = "", dstRaw] = spec.replace(/^\+/, "").split(":");
		const src = deleteRefs ? "" : srcRaw;
		const dstName = deleteRefs ? srcRaw : (dstRaw ?? srcRaw);
		const isTag =
			src.startsWith("refs/tags/") ||
			(!!src &&
				!!(await tryResolve(repo, `refs/tags/${src}`)) &&
				!(await tryResolve(repo, `refs/heads/${src}`)));
		const dst = dstName.startsWith("refs/")
			? dstName
			: `refs/${isTag ? "tags" : "heads"}/${dstName}`;
		if (!src) {
			updates.push({ dst, forced });
			continue;
		}
		const local = await resolveCommit(repo, src);
		if (!local) fail(`src refspec ${src} does not match any`);
		updates.push({
			src,
			dst,
			local:
				(await tryResolve(
					repo,
					src.startsWith("refs/")
						? src
						: isTag
							? `refs/tags/${src}`
							: `refs/heads/${src}`,
				)) ?? (local as string),
			forced,
		});
	}
	if (followTags) {
		for (const tag of await git.listTags({ fs: repo.fs, gitdir: repo.gitdir })) {
			const ref = `refs/tags/${tag}`;
			if (advertised.has(ref) || updates.some((u) => u.dst === ref)) continue;
			const tagOid = (await tryResolve(repo, ref)) as string;
			const object = await git.readObject({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid: tagOid,
				cache: repo.cache,
				format: "parsed",
			});
			if (object.type !== "tag") continue;
			const target = (object.object as git.TagObject).object;
			for (const update of updates)
				if (
					update.local &&
					(update.local === target ||
						(await git
							.isDescendent({
								fs: repo.fs,
								gitdir: repo.gitdir,
								oid: update.local,
								ancestor: target,
								depth: -1,
								cache: repo.cache,
							})
							.catch(() => false)))
				) {
					updates.push({ src: ref, dst: ref, local: tagOid, forced: false });
					break;
				}
		}
	}
	if (dryRun) {
		if (porcelain) lines.push(`To ${url}`);
		for (const u of updates) {
			const prior = advertised.get(u.dst);
			const flag = !u.local ? "-" : !prior ? "*" : u.forced ? "+" : " ";
			if (porcelain)
				lines.push(
					`${flag}\t${u.src ?? ""}:${u.dst}\t${!prior ? `[new ${u.dst.startsWith("refs/tags/") ? "tag" : "branch"}]` : `${prior.slice(0, 7)}..${u.local?.slice(0, 7)}`}`,
				);
		}
		if (porcelain) lines.push("Done");
		repo.ctx.io.stdout(`${lines.join("\n")}\n`);
		return 0;
	}
	for (const u of updates) {
		const prior = advertised.get(u.dst);
		const short = u.dst.replace(/^refs\/(heads|tags)\//, "");
		const srcShort = (u.src ?? "").replace(/^refs\/(heads|tags)\//, "");
		if (lease && prior !== undefined && remote) {
			const tracking = await tryResolve(repo, `refs/remotes/${remote}/${short}`);
			if (tracking !== prior) {
				lines.push(` ! [rejected]        ${srcShort} -> ${short} (stale info)`);
				rejected = true;
				continue;
			}
		}
		if (u.local && prior && prior === u.local) {
			lines.push(`   ${short} -> ${short} (up to date)`);
			continue;
		}
		if (u.local && prior && !u.forced && !lease) {
			let known = true;
			try {
				await readCommit(repo, prior);
			} catch {
				known = false;
			}
			const ff =
				known &&
				(await git
					.isDescendent({
						fs: repo.fs,
						gitdir: repo.gitdir,
						oid: u.local,
						ancestor: prior,
						depth: -1,
						cache: repo.cache,
					})
					.catch(() => false));
			if (!ff) {
				lines.push(
					` ! [rejected]        ${srcShort} -> ${short} (${known ? "non-fast-forward" : "fetch first"})`,
				);
				rejected = true;
				continue;
			}
		}
		if (u.local && remote && u.dst.startsWith("refs/heads/"))
			await pushLfs(repo, remote, u.local, [...advertised.values()], u.dst);
		const result = await transfer(repo.ctx, repo, url, () =>
			git
				.push({
					fs: repo.fs,
					gitdir: repo.gitdir,
					http: http(repo.ctx),
					url,
					remote,
					ref: u.src
						? u.src.startsWith("refs/")
							? u.src
							: u.dst.startsWith("refs/tags/")
								? `refs/tags/${u.src}`
								: `refs/heads/${u.src}`
						: undefined,
					remoteRef: u.dst,
					force: u.forced || lease,
					delete: !u.local,
					onProgress: progress(repo.ctx, showProgress),
					onMessage: (message) => repo.ctx.io.stderr(`remote: ${message}`),
					cache: repo.cache,
				})
				.catch((error: { code?: string; data?: { reason?: string } }) => {
					if (error.code === "PushRejectedError")
						return { ok: false, error: error.data?.reason ?? "rejected", refs: {} };
					throw error;
				}),
		);
		const status = (
			result.refs as Record<string, { ok: boolean; error?: string }> | undefined
		)?.[u.dst];
		if (!result.ok || (status && !status.ok)) {
			const reason = status?.error || result.error || "rejected";
			lines.push(` ! [remote rejected] ${srcShort || "(delete)"} -> ${short} (${reason})`);
			rejected = true;
			continue;
		}
		if (!u.local) lines.push(` - [deleted]         ${short}`);
		else if (!prior)
			lines.push(
				` * [new ${u.dst.startsWith("refs/tags/") ? "tag" : "branch"}]      ${srcShort} -> ${short}`,
			);
		else
			lines.push(
				`   ${prior.slice(0, 7)}${u.forced ? "..." : ".."}${u.local.slice(0, 7)}  ${srcShort} -> ${short}`,
			);
		if (remote && u.dst.startsWith("refs/heads/")) {
			const tracking = `refs/remotes/${remote}/${u.dst.slice(11)}`;
			if (u.local) await updateRef(repo, tracking, u.local, "update by push");
			else
				await git
					.deleteRef({ fs: repo.fs, gitdir: repo.gitdir, ref: tracking })
					.catch(() => {});
		}
		if (setUpstream && u.local && remote && u.src && u.dst.startsWith("refs/heads/")) {
			const localBranch = u.src.replace(/^refs\/heads\//, "");
			if (await tryResolve(repo, `refs/heads/${localBranch}`)) {
				await setLocalConfig(repo, `branch.${localBranch}.remote`, remote);
				await setLocalConfig(repo, `branch.${localBranch}.merge`, u.dst);
				lines.push(
					`branch '${localBranch}' set up to track '${remote}/${u.dst.slice(11)}'.`,
				);
			}
		}
	}
	repo.ctx.io.stderr(`To ${url}\n${lines.join("\n")}\n`);
	if (rejected) {
		failRaw(
			`error: failed to push some refs to '${url}'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. Integrate the remote changes (e.g.\nhint: 'git pull ...') before pushing again.`,
			1,
		);
	}
	return 0;
}

// ---------------------------------------------------------------- remote

export async function remoteCommand(repo: Repo, args: string[]): Promise<number> {
	const io = repo.ctx.io;
	const remotes = async () => git.listRemotes({ fs: repo.fs, gitdir: repo.gitdir });
	const sub = args[0] && !args[0].startsWith("-") ? (args.shift() as string) : undefined;
	const operands = args.filter((a) => a !== "--" && !a.startsWith("-"));
	const flags = args.filter((a) => a.startsWith("-") && a !== "--");
	if (!sub) {
		const verbose = flags.includes("-v") || flags.includes("--verbose");
		if (flags.some((f) => f !== "-v" && f !== "--verbose")) unsupported("remote");
		for (const { remote, url } of await remotes())
			io.stdout(
				verbose ? `${remote}\t${url} (fetch)\n${remote}\t${url} (push)\n` : `${remote}\n`,
			);
		return 0;
	}
	const [name = "", value] = operands;
	const exists = (await remotes()).some((r) => r.remote === name);
	if (sub === "add") {
		if (flags.some((f) => f !== "-f") || operands.length !== 2) unsupported("remote add");
		if (exists) failRaw(`error: remote ${name} already exists.`, 3);
		if (!/^[\w.-]+$/.test(name)) fail(`'${name}' is not a valid remote name`);
		checkUrl(repo.ctx, value as string);
		await setLocalConfig(repo, `remote.${name}.url`, value);
		await setLocalConfig(repo, `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`);
		if (flags.includes("-f")) return fetchCommand(repo, ["--", name]);
		return 0;
	}
	if (!exists && sub !== "get-url") failRaw(`error: No such remote: '${name}'`, 2);
	if (sub === "remove" || sub === "rm") {
		await deleteLocalSection(repo, "remote", name);
		for (const ref of await git.listRefs({
			fs: repo.fs,
			gitdir: repo.gitdir,
			filepath: `refs/remotes/${name}`,
		}))
			await git.deleteRef({
				fs: repo.fs,
				gitdir: repo.gitdir,
				ref: `refs/remotes/${name}/${ref}`,
			});
		repo.fs.rmSync(path.join(repo.gitdir, "refs/remotes", name), {
			recursive: true,
			force: true,
		});
		for (const branch of await git.listBranches({ fs: repo.fs, gitdir: repo.gitdir }))
			if ((await configGet(repo.ctx, repo, `branch.${branch}.remote`)) === name) {
				await setLocalConfig(repo, `branch.${branch}.remote`, undefined);
				await setLocalConfig(repo, `branch.${branch}.merge`, undefined);
			}
		return 0;
	}
	if (sub === "set-url") {
		if (flags.length || operands.length !== 2) unsupported("remote set-url");
		checkUrl(repo.ctx, value as string);
		await setLocalConfig(repo, `remote.${name}.url`, value);
		return 0;
	}
	if (sub === "get-url") {
		const url = await configGet(repo.ctx, repo, `remote.${name}.url`);
		if (!url) failRaw(`error: No such remote '${name}'`, 2);
		io.stdout(`${url}\n`);
		return 0;
	}
	if (sub === "set-head") {
		if (flags.includes("-d") || flags.includes("--delete")) {
			repo.fs.rmSync(path.join(repo.gitdir, `refs/remotes/${name}/HEAD`), { force: true });
			return 0;
		}
		let target = value;
		if (flags.includes("-a") || flags.includes("--auto")) {
			const { url } = await remoteUrl(repo, name);
			const refs = await transfer(repo.ctx, repo, url, () =>
				git.listServerRefs({ http: http(repo.ctx), url, symrefs: true, prefix: "HEAD" }),
			);
			const head = refs.find((r) => r.ref === "HEAD")?.target;
			if (!head?.startsWith("refs/heads/")) fail("Cannot determine remote HEAD");
			target = (head as string).slice(11);
		}
		if (!target) unsupported("remote set-head");
		if (!(await tryResolve(repo, `refs/remotes/${name}/${target}`)))
			fail(`Not a valid ref: refs/remotes/${name}/${target}`);
		const file = path.join(repo.gitdir, `refs/remotes/${name}/HEAD`);
		repo.fs.mkdirSync(path.dirname(file), { recursive: true });
		repo.fs.writeFileSync(file, `ref: refs/remotes/${name}/${target}\n`);
		io.stdout(`${name}/HEAD set to ${target}\n`);
		return 0;
	}
	if (sub === "rename") {
		if (operands.length !== 2) unsupported("remote rename");
		const url = await configGet(repo.ctx, repo, `remote.${name}.url`);
		await deleteLocalSection(repo, "remote", name);
		await setLocalConfig(repo, `remote.${value}.url`, url);
		await setLocalConfig(
			repo,
			`remote.${value}.fetch`,
			`+refs/heads/*:refs/remotes/${value}/*`,
		);
		for (const ref of await git.listRefs({
			fs: repo.fs,
			gitdir: repo.gitdir,
			filepath: `refs/remotes/${name}`,
		})) {
			const oid = await tryResolve(repo, `refs/remotes/${name}/${ref}`);
			if (oid && ref !== "HEAD")
				await git.writeRef({
					fs: repo.fs,
					gitdir: repo.gitdir,
					ref: `refs/remotes/${value}/${ref}`,
					value: oid,
					force: true,
				});
		}
		repo.fs.rmSync(path.join(repo.gitdir, "refs/remotes", name), {
			recursive: true,
			force: true,
		});
		for (const branch of await git.listBranches({ fs: repo.fs, gitdir: repo.gitdir }))
			if ((await configGet(repo.ctx, repo, `branch.${branch}.remote`)) === name)
				await setLocalConfig(repo, `branch.${branch}.remote`, value);
		return 0;
	}
	return unsupported(`remote ${sub}`);
}

/** git ls-remote [--heads] [--tags] [--refs] [--symref] [-q] [--exit-code] <remote> [<patterns>] */
export async function lsRemote(
	ctx: GitContext,
	repo: Repo | undefined,
	args: string[],
): Promise<number> {
	if (args[0] === "--get-url") {
		const name = args.filter((a) => a !== "--").at(1) ?? "origin";
		const url = repo ? await configGet(ctx, repo, `remote.${name}.url`) : undefined;
		ctx.io.stdout(`${url ?? name}\n`);
		return 0;
	}
	let heads = false,
		tags = false,
		refsOnly = false,
		symref = false,
		exitCode = false;
	const operands: string[] = [];
	for (const arg of args) {
		if (arg === "--heads" || arg === "--branches" || arg === "-h") heads = true;
		else if (arg === "--tags" || arg === "-t") tags = true;
		else if (arg === "--refs") refsOnly = true;
		else if (arg === "--symref") symref = true;
		else if (arg === "--exit-code") exitCode = true;
		else if (arg === "-q" || arg === "--quiet" || arg === "--") continue;
		else if (arg.startsWith("-")) unsupported("ls-remote");
		else operands.push(arg);
	}
	const [name = "origin", ...patterns] = operands;
	const url = repo ? (await remoteUrl(repo, name)).url : checkUrl(ctx, name).href;
	const refs = await transfer(ctx, repo, url, () =>
		git.listServerRefs({ http: http(ctx), url, symrefs: symref, peelTags: !refsOnly }),
	);
	let shown = 0;
	for (const ref of refs) {
		if (
			heads &&
			!ref.ref.startsWith("refs/heads/") &&
			!(tags && ref.ref.startsWith("refs/tags/"))
		)
			continue;
		if (tags && !heads && !ref.ref.startsWith("refs/tags/")) continue;
		if (refsOnly && (ref.ref === "HEAD" || ref.ref.endsWith("^{}"))) continue;
		if (patterns.length && !patterns.some((p) => ref.ref === p || ref.ref.endsWith(`/${p}`)))
			continue;
		if (symref && ref.target) ctx.io.stdout(`ref: ${ref.target}\t${ref.ref}\n`);
		ctx.io.stdout(`${ref.oid}\t${ref.ref}\n`);
		if (ref.peeled) ctx.io.stdout(`${ref.peeled}\t${ref.ref}^{}\n`);
		shown++;
	}
	return exitCode && !shown ? 2 : 0;
}

// ---------------------------------------------------------------- clone

/** Clone in an isolated in-memory volume. Publish a complete snapshot only
 * after validation/checkout and a second empty-destination check. A failed,
 * cancelled or racing clone cannot delete files in an existing directory. */
export async function clone(
	ctx: GitContext,
	args: string[],
	defaultBranch?: string,
): Promise<number> {
	const { vfs, io } = ctx;
	let showProgress = false,
		singleBranch = false,
		ref: string | undefined,
		depth: number | undefined,
		bare = false;
	while (args[0]?.startsWith("-")) {
		const opt = args.shift();
		if (opt === "--") break;
		if (opt === "--progress") showProgress = true;
		else if (opt === "--recursive" || opt === "--recurse-submodules") {
			/* Gitlinks are rejected before checkout. */
		} else if (opt === "--single-branch") singleBranch = true;
		else if (opt === "-b" || opt === "--branch") ref = args.shift() || unsupported("clone");
		else if (opt === "--depth") {
			depth = Number(args.shift());
			if (!Number.isSafeInteger(depth) || depth < 1) unsupported("clone");
			singleBranch = true;
		} else if (opt === "-q" || opt === "--quiet") {
			/* Quiet is the default. */
		} else if (opt === "--bare") bare = true;
		else unsupported("clone");
	}
	if (bare) unsupported("clone --bare");
	if (args.length < 1 || args.length > 2) unsupported("clone");
	let url: URL;
	try {
		url = new URL(args[0] || "");
	} catch {
		return fail("clone requires an anonymous HTTP(S) URL");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		fail("clone requires an anonymous HTTP(S) URL");
	checkUrl(ctx, url.href);
	const dest = args[1] ?? path.basename(url.pathname).replace(/\.git$/i, "");
	if (!dest) fail("empty clone destination");
	const dir = path.resolve(ctx.cwd, vfs.normalizePath(dest));
	const checkDestination = () => {
		for (let p = dir; p !== "/"; p = path.dirname(p)) {
			try {
				if (!vfs.raw.lstatSync(p).isDirectory())
					fail("clone destination must be a directory without symlink components");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (vfs.raw.existsSync(dir) && vfs.raw.readdirSync(dir).length)
			fail(`destination path '${dest}' already exists and is not an empty directory.`);
	};
	checkDestination();
	if (showProgress) io.stderr(`Cloning into '${dest}'...\n`);
	const stage = new VirtualFileSystem({}, () => {});
	// Global settings (user identity, LFS filter) apply inside the stage too.
	const home = path.resolve(ctx.cwd, vfs.normalizePath(ctx.env.HOME || "/home/user"));
	if (vfs.raw.existsSync(path.join(home, ".gitconfig"))) {
		stage.raw.mkdirSync(home, { recursive: true });
		stage.raw.writeFileSync(
			path.join(home, ".gitconfig"),
			vfs.raw.readFileSync(path.join(home, ".gitconfig")),
		);
	}
	const stageCtx: GitContext = { ...ctx, vfs: stage, cwd: "/" };
	const repo: Repo = {
		fs: stage.fs,
		dir: "/repo",
		gitdir: "/repo/.git",
		cache: {},
		ctx: stageCtx,
	};
	await transfer(ctx, undefined, url.href, () =>
		git.clone({
			fs: stage.raw,
			dir: repo.dir,
			cache: repo.cache,
			http: http(ctx),
			url: url.href,
			ref,
			depth,
			singleBranch,
			noCheckout: true,
			onProgress: progress(ctx, showProgress),
			onMessage: (message) => io.stderr(`remote: ${message}`),
		}),
	);
	if (defaultBranch && !(await tryResolve(repo, "HEAD"))) {
		stage.raw.writeFileSync(
			path.join(repo.gitdir, "HEAD"),
			`ref: refs/heads/${defaultBranch}\n`,
		);
	}
	// Validate the checked-out tree before path strings are passed to memfs or
	// normalized for a Windows guest. This subset supports ordinary files/dirs.
	const head = await tryResolve(repo, "HEAD");
	const branch = await git.currentBranch({ fs: stage.raw, dir: repo.dir });
	if (head && branch) {
		const tree = await commitTree(repo, head);
		for (const [file, entry] of tree) {
			io.signal.throwIfAborted();
			for (const part of file.split("/"))
				if (
					!part ||
					// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in remote tree entries.
					/[\\:\x00-\x1f]/.test(part) ||
					/^(?:\.{1,2}|\.git)$/i.test(part) ||
					/[. ]$/.test(part)
				)
					fail("unsupported checkout pathname");
			if (!["100644", "100755"].includes(entry.mode))
				fail("checkout of symlinks and submodules is not supported");
		}
		await switchTrees(repo, undefined, head);
		const remoteHead = path.join(repo.gitdir, "refs/remotes/origin/HEAD");
		if (!stage.raw.existsSync(remoteHead)) {
			stage.raw.mkdirSync(path.dirname(remoteHead), { recursive: true });
			stage.raw.writeFileSync(remoteHead, `ref: refs/remotes/origin/${branch}\n`);
		}
		await logRef(repo, `refs/heads/${branch}`, undefined, head, `clone: from ${url.href}`);
	} else if (head) fail("cloning a detached repository is not supported");
	else io.stderr("warning: You appear to have cloned an empty repository.\n");
	io.signal.throwIfAborted();
	checkDestination();
	const patches = Object.entries(stage.snapshot()).flatMap(([file, entry]) => {
		if (file !== repo.dir && !file.startsWith(`${repo.dir}/`)) return [];
		return [{ path: dir + file.slice(repo.dir.length), entry }];
	});
	vfs.apply(patches, true);
	return 0;
}
