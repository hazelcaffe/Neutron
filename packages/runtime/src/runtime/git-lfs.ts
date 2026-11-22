import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import { GitConfigManager } from "isomorphic-git/managers";
import path from "path-browserify";
import { Attributes } from "./git-patterns";
import {
	commitTree,
	configGet,
	editIndex,
	fail,
	findRoot,
	type GitContext,
	globalConfigPath,
	type Repo,
	unsupported,
} from "./git-repo";

// Git LFS as built-in clean/smudge/pre-push behavior of the virtual Git CLI.
// Objects live in .git/lfs/objects like git-lfs; transfers use the LFS batch
// API ("basic" adapter) over the same fetch transport as Git itself.

export const LFS_VERSION = "git-lfs/3.6.1 (Neutron; virtual isomorphic-git LFS)";
const MAX_OBJECT = 256 * 1024 * 1024;
const MEDIA = "application/vnd.git-lfs+json";

export interface Pointer {
	oid: string;
	size: number;
}

export function parsePointer(data: Uint8Array): Pointer | undefined {
	if (data.length > 1024) return;
	const text = Buffer.from(data).toString("utf8");
	const match =
		/^version https:\/\/(?:git-lfs\.github\.com\/spec\/v1|hawser\.github\.com\/spec\/v1)\n(?:[a-z0-9.-]+ [^\n]*\n)*?oid sha256:([0-9a-f]{64})\n(?:[a-z0-9.-]+ [^\n]*\n)*?size (\d+)\n(?:[a-z0-9.-]+ [^\n]*\n)*$/.exec(
			text,
		);
	if (!match) return;
	return { oid: match[1] as string, size: Number(match[2]) };
}

export const formatPointer = ({ oid, size }: Pointer) =>
	`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

export async function sha256(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
	return Buffer.from(digest).toString("hex");
}

const objectPath = (repo: Repo, oid: string) =>
	path.join(repo.gitdir, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);

export function hasObject(repo: Repo, pointer: Pointer): boolean {
	try {
		return repo.fs.statSync(objectPath(repo, pointer.oid)).size === pointer.size;
	} catch {
		return false;
	}
}

function storeObject(repo: Repo, oid: string, data: Uint8Array) {
	const file = objectPath(repo, oid);
	if (repo.fs.existsSync(file)) return;
	repo.fs.mkdirSync(path.dirname(file), { recursive: true });
	repo.fs.writeFileSync(file, data);
}

/** Whether the LFS filter is configured (git lfs install) for this repo. */
export async function filterEnabled(repo: Repo): Promise<boolean> {
	return !!(
		(await configGet(repo.ctx, repo, "filter.lfs.clean")) ||
		(await configGet(repo.ctx, repo, "filter.lfs.process"))
	);
}

export class LfsFilter {
	private constructor(
		private repo: Repo,
		private attributes: Attributes,
		readonly enabled: boolean,
	) {}
	static async load(repo: Repo, attributes = new Attributes(repo)) {
		return new LfsFilter(repo, attributes, await filterEnabled(repo));
	}
	applies(file: string): boolean {
		return this.enabled && this.attributes.get(file).get("filter") === "lfs";
	}
	/** The blob git would store for this worktree content. */
	async clean(file: string, data: Uint8Array, store: boolean): Promise<Uint8Array> {
		if (!this.applies(file) || parsePointer(data)) return data;
		const pointer = { oid: await sha256(data), size: data.length };
		if (store) storeObject(this.repo, pointer.oid, data);
		return new Uint8Array(Buffer.from(formatPointer(pointer)));
	}
}

// ---------------------------------------------------------------- transfers

async function endpoint(repo: Repo, remote = "origin"): Promise<string | undefined> {
	const explicit =
		(await configGet(repo.ctx, repo, `remote.${remote}.lfsurl`)) ??
		(await configGet(repo.ctx, repo, "lfs.url"));
	if (explicit) return explicit;
	const lfsconfig = path.join(repo.dir, ".lfsconfig");
	if (repo.fs.existsSync(lfsconfig)) {
		const text = String(repo.fs.readFileSync(lfsconfig, "utf8"));
		const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
		const value = (await ini.get(`remote.${remote}.lfsurl`)) ?? (await ini.get("lfs.url"));
		if (typeof value === "string") return value;
	}
	const url =
		(await configGet(repo.ctx, repo, `remote.${remote}.url`)) ??
		(/^https?:\/\//.test(remote) ? remote : undefined);
	if (!url || !/^https?:\/\//.test(url)) return;
	const base = url.replace(/\/+$/, "");
	return `${base}${base.endsWith(".git") ? "" : ".git"}/info/lfs`;
}

interface BatchObject {
	oid: string;
	size: number;
	actions?: Record<string, { href: string; header?: Record<string, string> }>;
	error?: { code: number; message: string };
}

async function batch(
	repo: Repo,
	url: string,
	operation: "download" | "upload",
	objects: Pointer[],
	ref?: string,
): Promise<BatchObject[]> {
	const io = repo.ctx.io;
	const res = await io.fetch(`${url}/objects/batch`, {
		method: "POST",
		headers: { Accept: MEDIA, "Content-Type": MEDIA },
		credentials: "omit",
		signal: io.signal,
		body: JSON.stringify({
			operation,
			transfers: ["basic"],
			...(ref ? { ref: { name: ref } } : {}),
			objects: objects.map(({ oid, size }) => ({ oid, size })),
			hash_algo: "sha256",
		}),
	});
	if (res.status === 401 || res.status === 403)
		fail(
			`batch response: Authorization error: ${url}/objects/batch\nCheck that you have proper access to the repository`,
		);
	if (!res.ok) fail(`batch response: HTTP ${res.status} from ${url}/objects/batch`);
	const body = (await res.json()) as { objects?: BatchObject[]; transfer?: string };
	if (body.transfer && body.transfer !== "basic")
		fail(`unsupported LFS transfer adapter ${body.transfer}`);
	if (!Array.isArray(body.objects)) fail("invalid LFS batch response");
	return body.objects as BatchObject[];
}

async function readLimited(res: Response, limit: number, signal: AbortSignal) {
	const reader = res.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (!reader) return new Uint8Array();
	for (;;) {
		signal.throwIfAborted();
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			fail("LFS object exceeds its declared size");
		}
		chunks.push(value);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

/** Download missing objects into .git/lfs/objects. */
export async function download(repo: Repo, pointers: Pointer[], remote = "origin", ref?: string) {
	const missing = [...new Map(pointers.map((p) => [p.oid, p])).values()].filter(
		(p) => !hasObject(repo, p),
	);
	if (!missing.length) return;
	const url = await endpoint(repo, remote);
	if (!url) fail(`LFS: no HTTP endpoint for remote '${remote}'`);
	const io = repo.ctx.io;
	for (let i = 0; i < missing.length; i += 100) {
		const answer = await batch(repo, url as string, "download", missing.slice(i, i + 100), ref);
		for (const object of answer) {
			const wanted = missing.find((p) => p.oid === object.oid);
			if (!wanted) continue;
			if (object.error) fail(`LFS: ${object.error.message} (${object.oid})`);
			const action = object.actions?.download;
			if (!action) fail(`LFS: object ${object.oid} has no download action`);
			if (wanted.size > MAX_OBJECT)
				fail(`LFS: object ${object.oid} exceeds the transfer limit`);
			const res = await io.fetch(action?.href as string, {
				headers: action?.header || {},
				credentials: "omit",
				signal: io.signal,
			});
			if (!res.ok) fail(`LFS: object ${object.oid} download returned HTTP ${res.status}`);
			const data = await readLimited(res, wanted.size, io.signal);
			if (data.length !== wanted.size || (await sha256(data)) !== wanted.oid)
				fail(`LFS: object ${object.oid} failed verification`);
			storeObject(repo, wanted.oid, data);
		}
	}
}

/** Upload local objects the remote does not have yet (git-lfs pre-push). */
export async function upload(repo: Repo, pointers: Pointer[], remote: string, ref?: string) {
	const unique = [...new Map(pointers.map((p) => [p.oid, p])).values()];
	if (!unique.length) return 0;
	const url = await endpoint(repo, remote);
	if (!url) fail(`LFS: no HTTP endpoint for remote '${remote}'`);
	const io = repo.ctx.io;
	let sent = 0;
	for (let i = 0; i < unique.length; i += 100) {
		const answer = await batch(repo, url as string, "upload", unique.slice(i, i + 100), ref);
		for (const object of answer) {
			if (object.error) fail(`LFS: ${object.error.message} (${object.oid})`);
			const action = object.actions?.upload;
			if (!action) continue; // The server already has it.
			const pointer = unique.find((p) => p.oid === object.oid);
			if (!pointer || !hasObject(repo, pointer))
				fail(`LFS upload missing objects (missing ${object.oid})`);
			const data = repo.fs.readFileSync(objectPath(repo, object.oid)) as Uint8Array;
			const res = await io.fetch(action.href, {
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream", ...(action.header || {}) },
				credentials: "omit",
				signal: io.signal,
				body: new Uint8Array(data),
			});
			if (!res.ok) fail(`LFS: upload of ${object.oid} returned HTTP ${res.status}`);
			const verify = object.actions?.verify;
			if (verify) {
				const check = await io.fetch(verify.href, {
					method: "POST",
					headers: { Accept: MEDIA, "Content-Type": MEDIA, ...(verify.header || {}) },
					credentials: "omit",
					signal: io.signal,
					body: JSON.stringify({ oid: object.oid, size: pointer?.size }),
				});
				if (!check.ok)
					fail(`LFS: verification of ${object.oid} returned HTTP ${check.status}`);
			}
			sent++;
		}
	}
	return sent;
}

/** Pointers in blobs that are tracked as LFS in their own tree. */
export async function pointersIn(
	repo: Repo,
	entries: Map<string, { oid: string; mode: string }>,
	attributes: Attributes,
): Promise<Map<string, Pointer>> {
	const result = new Map<string, Pointer>();
	for (const [file, entry] of entries) {
		if (entry.mode === "160000" || attributes.get(file).get("filter") !== "lfs") continue;
		const { blob } = await git.readBlob({
			fs: repo.fs,
			gitdir: repo.gitdir,
			oid: entry.oid,
			cache: repo.cache,
		});
		const pointer = parsePointer(blob);
		if (pointer) result.set(file, pointer);
	}
	return result;
}

/** Attributes as recorded in a flattened tree (used for checkout). */
export async function treeAttributes(
	repo: Repo,
	entries: Map<string, { oid: string; mode: string }>,
): Promise<Attributes> {
	const texts = new Map<string, string>();
	for (const [file, entry] of entries)
		if (path.basename(file) === ".gitattributes") {
			const { blob } = await git.readBlob({
				fs: repo.fs,
				gitdir: repo.gitdir,
				oid: entry.oid,
				cache: repo.cache,
			});
			texts.set(file, Buffer.from(blob).toString("utf8"));
		}
	return new Attributes(repo, (file) => texts.get(file));
}

/** Replace checked-out pointer files with their content (git-lfs smudge). */
export async function smudge(
	repo: Repo,
	entries: Map<string, { oid: string; mode: string }>,
	files?: Set<string>,
	remote = "origin",
): Promise<number> {
	if (repo.ctx.env.GIT_LFS_SKIP_SMUDGE === "1" || !(await filterEnabled(repo))) return 0;
	const attributes = await treeAttributes(repo, entries);
	const subset = files ? new Map([...entries].filter(([file]) => files.has(file))) : entries;
	const pointers = await pointersIn(repo, subset, attributes);
	if (!pointers.size) return 0;
	await download(repo, [...pointers.values()], remote);
	const written: [string, { mtimeMs: number; size: number }][] = [];
	for (const [file, pointer] of pointers) {
		const target = path.join(repo.dir, file);
		const data = repo.fs.readFileSync(objectPath(repo, pointer.oid)) as Uint8Array;
		repo.fs.writeFileSync(target, data);
		const stat = repo.fs.statSync(target);
		written.push([file, { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) }]);
	}
	// The index keeps the pointer blob; record the smudged file's stat data so
	// status does not need to re-clean unchanged content.
	await editIndex(repo, async (index) => {
		for (const [file, stats] of written) {
			const entry = entries.get(file);
			if (entry && index.has(file)) index.insert(file, entry.oid, entry.mode, stats);
		}
	});
	return pointers.size;
}

// ---------------------------------------------------------------- commands

async function editGlobal(
	ctx: GitContext,
	edit: (ini: {
		set(key: string, value: string | undefined): Promise<void>;
		deleteSection(section: string, sub?: string): Promise<void>;
	}) => Promise<void>,
	file = globalConfigPath(ctx),
) {
	const text = ctx.vfs.raw.existsSync(file) ? String(ctx.vfs.raw.readFileSync(file, "utf8")) : "";
	const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
	await edit(ini);
	ctx.vfs.fs.mkdirSync(path.dirname(file), { recursive: true });
	ctx.vfs.fs.writeFileSync(file, ini.toString());
}

export async function lfsCommand(ctx: GitContext, args: string[]): Promise<number> {
	const io = ctx.io;
	const sub = args.shift();
	if (sub === "version" || sub === "--version") {
		io.stdout(`${LFS_VERSION}\n`);
		return 0;
	}
	if (sub === "install" || sub === "uninstall") {
		let local = false;
		for (const arg of args) {
			if (arg === "--skip-repo" || arg === "--skip-smudge") {
				/* No repository hooks are written either way (see below). */
			} else if (arg === "--force" || arg === "-f") {
				/* The filter is always rewritten to the canonical values. */
			} else if (arg === "--local") local = true;
			else unsupported(`lfs ${sub}`);
		}
		const dir = findRoot(ctx.vfs, ctx.cwd);
		if (local && !dir) fail("not in a git repository");
		const file = local && dir ? path.join(dir, ".git/config") : globalConfigPath(ctx);
		const skipSmudge = args.includes("--skip-smudge");
		await editGlobal(
			ctx,
			async (ini) => {
				if (sub === "uninstall") await ini.deleteSection("filter", "lfs");
				else {
					await ini.set("filter.lfs.clean", "git-lfs clean -- %f");
					await ini.set(
						"filter.lfs.smudge",
						skipSmudge ? "git-lfs smudge --skip -- %f" : "git-lfs smudge -- %f",
					);
					await ini.set(
						"filter.lfs.process",
						skipSmudge ? "git-lfs filter-process --skip" : "git-lfs filter-process",
					);
					await ini.set("filter.lfs.required", "true");
				}
			},
			file,
		);
		// The pre-push/post-checkout work that git-lfs installs as hooks is part
		// of this CLI's push and checkout, so no hook scripts are written.
		if (sub === "install") io.stdout("Git LFS initialized.\n");
		else
			io.stdout(
				local
					? "Local Git LFS configuration has been removed.\n"
					: "Global Git LFS configuration has been removed.\n",
			);
		return 0;
	}
	const dir = findRoot(ctx.vfs, ctx.cwd);
	if (!dir) return fail("not in a Git repository.");
	const repo: Repo = { fs: ctx.vfs.fs, dir, gitdir: path.join(dir, ".git"), cache: {}, ctx };
	if (sub === "track" || sub === "untrack") {
		const json = args.includes("--json");
		const patterns = args.filter((a) => !a.startsWith("-"));
		if (args.some((a) => a.startsWith("-") && !["--json", "--no-modify-attrs"].includes(a)))
			unsupported(`lfs ${sub}`);
		const file = path.join(dir, ".gitattributes");
		const attributes = new Attributes(repo);
		if (!patterns.length) {
			if (sub === "untrack") unsupported("lfs untrack");
			const tracked = attributes.patterns("lfs");
			if (json)
				io.stdout(
					`${JSON.stringify({
						patterns: tracked.map((p) => ({ ...p, lockable: false, tracked: true })),
					})}\n`,
				);
			else {
				io.stdout("Listing tracked patterns\n");
				for (const p of tracked) io.stdout(`    ${p.pattern} (${p.source})\n`);
			}
			return 0;
		}
		let text = repo.fs.existsSync(file) ? String(repo.fs.readFileSync(file, "utf8")) : "";
		for (const p of patterns) {
			const escaped = p.replaceAll(" ", "[[:space:]]");
			const exists = text
				.split("\n")
				.some((l) => l.split(/\s+/)[0] === escaped && /filter=lfs/.test(l));
			if (sub === "track") {
				if (exists) io.stdout(`"${p}" already supported\n`);
				else {
					if (text && !text.endsWith("\n")) text += "\n";
					text += `${escaped} filter=lfs diff=lfs merge=lfs -text\n`;
					io.stdout(`Tracking "${p}"\n`);
				}
			} else if (exists) {
				text = text
					.split("\n")
					.filter((l) => !(l.split(/\s+/)[0] === escaped && /filter=lfs/.test(l)))
					.join("\n");
				io.stdout(`Untracking "${p}"\n`);
			}
		}
		repo.fs.writeFileSync(file, text);
		return 0;
	}
	if (sub === "env") {
		io.stdout(
			`${LFS_VERSION}\n\nEndpoint=${(await endpoint(repo)) ?? ""} (auth=none)\nLocalWorkingDir=${dir}\nLocalGitDir=${repo.gitdir}\nLocalMediaDir=${path.join(repo.gitdir, "lfs/objects")}\n`,
		);
		return 0;
	}
	if (sub === "ls-files") {
		if (args.length) unsupported("lfs ls-files");
		const head = await git
			.resolveRef({ fs: repo.fs, gitdir: repo.gitdir, ref: "HEAD" })
			.catch(() => undefined);
		const entries = await commitTree(repo, head);
		for (const [file, pointer] of await pointersIn(
			repo,
			entries,
			await treeAttributes(repo, entries),
		))
			io.stdout(
				`${pointer.oid.slice(0, 10)} ${hasObject(repo, pointer) ? "*" : "-"} ${file}\n`,
			);
		return 0;
	}
	if (sub === "pull" || sub === "checkout" || sub === "fetch") {
		if (args.length > (sub === "checkout" ? 0 : 1)) unsupported(`lfs ${sub}`);
		const head = await git.resolveRef({ fs: repo.fs, gitdir: repo.gitdir, ref: "HEAD" });
		const entries = await commitTree(repo, head);
		const remote = args[0] || "origin";
		if (sub === "fetch") {
			const pointers = await pointersIn(repo, entries, await treeAttributes(repo, entries));
			await download(repo, [...pointers.values()], remote);
		} else if (!(await filterEnabled(repo)))
			fail("Git LFS is not installed; run git lfs install");
		else await smudge(repo, entries, undefined, remote);
		return 0;
	}
	return fail(`unsupported git lfs command: ${sub || "(missing)"}`);
}
