import { Buffer } from "buffer";
import * as git from "isomorphic-git";
import { GitConfigManager } from "isomorphic-git/managers";
import path from "path-browserify";
import { VirtualFileSystem } from "./filesystem";
import { gitLog } from "./git-log";
import { formatRefs, upstream } from "./git-refs";

// Only this argument-vector adapter is executable. No shell, hooks, helpers,
// native git executable, environment-dependent transport, or host filesystem.
export const isGit = (file: string) => /^(git|git\.exe)$/i.test(file.split(/[\\/]/).pop() || "");
export const gitVersion = () => `git version isomorphic-git/${git.version()}\n`;
export interface GitIO {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	signal: AbortSignal;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}
const MAX_TRANSFER = 32 * 1024 * 1024;
const fail = (message: string): never => {
	throw new Error(message);
};
const unsupported = (command: string): never => fail(`unsupported git ${command} arguments`);

function http(io: GitIO): git.HttpClient {
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
				redirect: "manual",
				signal: io.signal,
				...(body ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
			});
			if (res.status === 401 || res.status === 403)
				fail(`HTTP ${res.status}: anonymous git access denied`);
			if (!res.ok) fail(`git remote returned HTTP ${res.status}`);
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
						if (bytes > MAX_TRANSFER)
							fail("Git response exceeds 32 MiB transfer limit");
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

// Clone in an isolated in-memory volume. Publish a complete snapshot only
// after validation/checkout and a second empty-destination check. A failed,
// cancelled or racing clone cannot delete files in an existing directory.
async function clone(
	vfs: VirtualFileSystem,
	cwd: string,
	args: string[],
	env: Record<string, string>,
	settings: Map<string, string>,
	io: GitIO,
) {
	let progress = false,
		singleBranch = false,
		ref: string | undefined,
		depth: number | undefined;
	while (args[0]?.startsWith("-")) {
		const opt = args.shift();
		if (opt === "--") break;
		if (opt === "--progress") progress = true;
		else if (opt === "--recursive" || opt === "--recurse-submodules") {
			/* Gitlinks are rejected before checkout. */
		} else if (opt === "--single-branch") singleBranch = true;
		else if (opt === "-b" || opt === "--branch") ref = args.shift() || unsupported("clone");
		else if (opt === "--depth") {
			depth = Number(args.shift());
			if (!Number.isSafeInteger(depth) || depth < 1) unsupported("clone");
			singleBranch = true;
		} else unsupported("clone");
	}
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
	const protocol = url.protocol.slice(0, -1);
	if (
		settings.get(`protocol.${protocol}.allow`) === "never" ||
		(env.GIT_ALLOW_PROTOCOL !== undefined &&
			!env.GIT_ALLOW_PROTOCOL.split(":").includes(protocol))
	)
		fail(`transport '${protocol}' not allowed`);
	const dest = args[1] ?? path.basename(url.pathname).replace(/\.git$/i, "");
	if (!dest) fail("empty clone destination");
	const dir = path.resolve(cwd, vfs.normalizePath(dest));
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
			fail("destination path already exists and is not an empty directory");
	};
	checkDestination();
	const stage = new VirtualFileSystem({}, () => {});
	const repo = { fs: stage.raw, dir: "/repo" };
	const cache = {};
	await git.clone({
		...repo,
		cache,
		http: http(io),
		url: url.href,
		ref,
		depth,
		singleBranch,
		noCheckout: true,
		onProgress: ({ phase, loaded, total }) => {
			io.signal.throwIfAborted();
			if (progress && loaded === total) io.stderr(`${phase}: ${loaded}/${total}\n`);
		},
	});
	// Validate the checked-out tree before path strings are passed to memfs or
	// normalized for a Windows guest. This subset supports ordinary files/dirs.
	let entries = 0;
	const inspect = async (oid: string, level: number) => {
		if (level > 64) fail("checkout exceeds tree depth limit");
		const { tree } = await git.readTree({ ...repo, cache, oid });
		for (const entry of tree) {
			io.signal.throwIfAborted();
			if (++entries > 10000) fail("checkout exceeds 10000 entries");
			if (
				!entry.path ||
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in remote tree entries.
				/[\\/:\x00-\x1f]/.test(entry.path) ||
				/^(?:\.{1,2}|\.git)$/i.test(entry.path) ||
				/[. ]$/.test(entry.path)
			)
				fail("unsupported checkout pathname");
			if (entry.type === "tree") await inspect(entry.oid, level + 1);
			else if (!["100644", "100755"].includes(entry.mode))
				fail("checkout of symlinks and submodules is not supported");
		}
	};
	const branch = await git.currentBranch({ ...repo });
	const branches = await git.listBranches(repo);
	if (branch && branches.includes(branch)) {
		const oid = await git.resolveRef({ ...repo, ref: "HEAD" });
		await inspect((await git.readCommit({ ...repo, cache, oid })).commit.tree, 0);
		await git.checkout({ ...repo, cache, ref: branch, force: true });
	} else fail("cloning an empty or detached repository is not supported");
	io.signal.throwIfAborted();
	checkDestination();
	const patches = Object.entries(stage.snapshot()).map(([file, entry]) => {
		if (file !== repo.dir && !file.startsWith(`${repo.dir}/`))
			return fail("invalid staged repository path");
		return { path: dir + file.slice(repo.dir.length), entry };
	});
	vfs.apply(patches, true);
}

function root(vfs: VirtualFileSystem, cwd: string): string | undefined {
	for (let p = cwd; ; p = path.dirname(p)) {
		if (vfs.raw.existsSync(path.join(p, ".git/HEAD"))) return p;
		if (p === "/") return;
	}
}

// Reuse the library's INI parser/serializer for real ~/.gitconfig as well as
// .git/config; the library's own config API only opens <gitdir>/config.
async function config(
	vfs: VirtualFileSystem,
	cwd: string,
	args: string[],
	env: Record<string, string>,
	io: GitIO,
) {
	let scope = "",
		action = "",
		end = "\n",
		bool = false;
	while (args[0]?.startsWith("-")) {
		const flag = args.shift();
		if (flag === "--global" || flag === "--local") {
			if (scope) unsupported("config");
			scope = flag;
		} else if (flag === "-z" || flag === "--null") end = "\0";
		else if (
			flag === "--get" ||
			flag === "--replace-all" ||
			flag === "--add" ||
			flag === "--get-all" ||
			flag === "--get-regexp"
		) {
			if (action) unsupported("config");
			action = flag;
		} else if (flag === "--type" && args.shift() === "bool") bool = true;
		else unsupported("config");
	}
	const [key, value] = args;
	// Bounded ERE subset for key enumeration: literal text, anchors and at
	// most one wildcard. Do not run arbitrary backtracking regexps on config.
	const regexp =
		action === "--get-regexp" &&
		key &&
		/^\^?(?:[\w/-]|\\\.)*(?:\.[+*](?:[\w/-]|\\\.)*)?\$?$/.test(key)
			? new RegExp(key)
			: undefined;
	if (
		!key ||
		(action === "--get-regexp"
			? !regexp
			: !/^[a-z][a-z\d-]*(\.[\w/-]+)*\.[a-z][a-z\d-]*$/i.test(key)) ||
		args.length > 2 ||
		(action.startsWith("--get") && args.length !== 1) ||
		(["--replace-all", "--add"].includes(action) && args.length !== 2)
	)
		return unsupported("config");
	const dir = root(vfs, cwd);
	const home = path.resolve(cwd, vfs.normalizePath(env.HOME || "/home/user"));
	const global = path.join(home, ".gitconfig");
	const local = dir && path.join(dir, ".git/config");
	if ((scope === "--local" || (!scope && value !== undefined)) && !local)
		fail("not in a git directory");
	const files =
		scope === "--global"
			? [global]
			: !local
				? [global]
				: scope === "--local" || value !== undefined
					? [local]
					: [global, local];
	const values: string[] = [];
	let matches = 0;
	for (const file of files) {
		const read = () =>
			vfs.raw.existsSync(file) ? String(vfs.raw.readFileSync(file, "utf8")) : "";
		const text = read();
		const ini = await GitConfigManager.get({ gitdir: "/", fs: { read: async () => text } });
		if (regexp) {
			for (const { path: key, name, value } of ini.parsedConfig as {
				path: string;
				name: string | null;
				value: string;
			}[]) {
				if (name && regexp.test(key)) {
					io.stdout(`${key}${end === "\0" ? "\n" : " "}${value}${end}`);
					matches++;
				}
			}
			continue;
		}
		const prior: unknown[] = await ini.getall(key);
		if (value === undefined) {
			values.push(...prior.map(String));
			continue;
		}
		if (!action && prior.length > 1) fail("cannot overwrite multiple config values");
		if (action === "--replace-all")
			for (let i = 1; i < prior.length; i++) await ini.set(key, undefined);
		await ini.set(key, value, action === "--add");
		if (read() !== text) fail("configuration changed concurrently");
		io.signal.throwIfAborted();
		vfs.fs.writeFileSync(file, ini.toString());
		return 0;
	}
	if (regexp) return matches ? 0 : 1;
	if (!values.length) return 1;
	for (let val of action === "--get-all" ? values : values.slice(-1)) {
		if (bool) {
			if (/^(true|yes|on|1)$/i.test(val)) val = "true";
			else if (/^(false|no|off|0|)$/i.test(val)) val = "false";
			else fail("invalid boolean config value");
		}
		io.stdout(val + end);
	}
	return 0;
}

type Repo = { fs: VirtualFileSystem["fs"]; dir: string };

/** Machine-readable status for an ordinary checked-out tree. Refuse index
 * states we cannot represent rather than telling a client its tree is clean. */
async function status(repo: Repo, args: string[], io: GitIO) {
	if (
		!args.includes("--porcelain=2") ||
		!args.includes("-z") ||
		args.some((x) => !["--porcelain=2", "--branch", "--untracked-files=all", "-z"].includes(x))
	)
		unsupported("status");
	const oid = await git.resolveRef({ ...repo, ref: "HEAD" });
	const output: string[] = [];
	if (args.includes("--branch")) {
		const branch = await git.currentBranch(repo);
		output.push(`# branch.oid ${oid}`, `# branch.head ${branch || "(detached)"}`);
		const up = branch && (await upstream(repo, branch));
		if (up) {
			const target = await git.resolveRef({ ...repo, ref: up });
			if (target !== oid) fail("diverged branch status not supported");
			output.push(
				`# branch.upstream ${up.replace(/^refs\/(heads|remotes)\//, "")}`,
				"# branch.ab +0 -0",
			);
		}
	}
	const cache = {};
	const changes = new Map<string, string>();
	const untracked: string[] = [];
	for (const [name, h, w, s] of await git.statusMatrix({ ...repo, cache, refresh: false })) {
		if (h === 1 && w === 1 && s === 1) continue;
		if (!h && !s) {
			if (!args.includes("--untracked-files=all") && name.includes("/"))
				fail("summarized untracked directories not supported; use --untracked-files=all");
			untracked.push(`? ${name}`);
			continue;
		}
		if (h !== 1 || s !== 1) fail("status of staged changes not supported");
		changes.set(name, w ? ".M" : ".D");
	}
	if (changes.size)
		await git.walk({
			...repo,
			cache,
			trees: [git.TREE(), git.WORKDIR()],
			map: async (name, [h, w]) => {
				const xy = changes.get(name);
				if (!xy || !h) return;
				const m = (await h.mode()).toString(8),
					hash = await h.oid();
				if (!["100644", "100755"].includes(m)) fail("unsupported tracked file mode");
				output.push(
					`1 ${xy} N... ${m} ${m} ${w ? (await w.mode()).toString(8) : "000000"} ${hash} ${hash} ${name}`,
				);
			},
		});
	for (const line of [...output, ...untracked]) io.stdout(`${line}\0`);
}

export async function runGit(
	vfs: VirtualFileSystem,
	argv: string[],
	options: { cwd?: string; env?: Record<string, string>; shell?: boolean | string },
	io: GitIO,
): Promise<number> {
	const args = [...argv],
		env = options.env || {};
	const settings = new Map<string, string>();
	let cwd = path.resolve(vfs.cwd, vfs.normalizePath(options.cwd || vfs.cwd));
	let explicitGitDir: string | undefined;
	try {
		io.signal.throwIfAborted();
		if (options.shell) fail("shell execution is not supported");
		while (args.length) {
			if (args[0] === "-C") {
				args.shift();
				cwd = path.resolve(cwd, vfs.normalizePath(args.shift() ?? unsupported("-C")));
			} else if (args[0] === "--git-dir") {
				args.shift();
				explicitGitDir = path.resolve(
					cwd,
					vfs.normalizePath(args.shift() ?? unsupported("--git-dir")),
				);
			} else if (args[0] === "--no-optional-locks") args.shift();
			else if (args[0] === "-c") {
				args.shift();
				const match =
					/^(init\.defaultbranch|protocol\.[a-z.]+\.allow|transfer\.credentialsinurl)=(.+)$/i.exec(
						args.shift() || "",
					);
				if (
					!match?.[1] ||
					!match[2] ||
					(match[1].toLowerCase().startsWith("protocol.") && match[2] !== "never")
				)
					return unsupported("-c");
				settings.set(match[1].toLowerCase(), match[2]);
			} else break;
		}
		const command = args.shift();
		if (
			settings.has("transfer.credentialsinurl") &&
			(command !== "ls-remote" || settings.get("transfer.credentialsinurl") !== "allow")
		)
			unsupported("-c");
		if (
			command !== "clone" &&
			Array.from(settings.keys()).some((k) => k !== "transfer.credentialsinurl")
		)
			unsupported("-c");
		if (explicitGitDir) {
			if (
				command !== "worktree" ||
				path.basename(explicitGitDir) !== ".git" ||
				!vfs.raw.existsSync(path.join(explicitGitDir, "HEAD"))
			)
				unsupported("--git-dir");
			cwd = path.dirname(explicitGitDir);
		}
		if ((command === "--version" || command === "version") && !args.length)
			io.stdout(gitVersion());
		else if (command === "clone") await clone(vfs, cwd, args, env, settings, io);
		else if (command === "config") return await config(vfs, cwd, args, env, io);
		else {
			if (
				![
					"rev-parse",
					"ls-files",
					"log",
					"remote",
					"ls-remote",
					"branch",
					"status",
					"worktree",
					"symbolic-ref",
					"for-each-ref",
					"show-ref",
				].includes(command || "")
			)
				return fail(`unsupported git command: ${command || "(missing)"}`);
			const dir = root(vfs, cwd) ?? fail("not a git repository");
			const repo = { fs: vfs.fs, dir };
			if (command === "status") await status(repo, args, io);
			else if (command === "for-each-ref") io.stdout(await formatRefs(repo, args));
			else if (command === "show-ref" && args.join(" ") === "--tags -d") {
				const tags = await git.listTags(repo);
				if (!tags.length) return 1;
				for (const tag of tags) {
					const ref = `refs/tags/${tag}`;
					const oid = await git.resolveRef({ ...repo, ref });
					io.stdout(`${oid} ${ref}\n`);
					let object = await git.readObject({ ...repo, oid, format: "parsed" });
					while (object.type === "tag")
						object = await git.readObject({
							...repo,
							oid: (object.object as git.TagObject).object,
							format: "parsed",
						});
					if (object.oid !== oid) io.stdout(`${object.oid} ${ref}^{}\n`);
				}
			} else if (command === "worktree" && args.join(" ") === "list --porcelain -z") {
				if (vfs.raw.existsSync(path.join(dir, ".git/worktrees")))
					fail("linked worktrees not supported");
				const branch = await git.currentBranch({ ...repo, fullname: true });
				io.stdout(
					`worktree ${dir}\0HEAD ${await git.resolveRef({ ...repo, ref: "HEAD" })}\0${branch ? `branch ${branch}` : "detached"}\0\0`,
				);
			} else if (
				command === "ls-remote" &&
				args[0] === "--get-url" &&
				args[1] === "--" &&
				args.length === 3
			) {
				const remotes = await git.listRemotes(repo);
				const url = remotes.find((r) => r.remote === args[2])?.url ?? args[2];
				io.stdout(`${url}\n`);
			} else if (
				command === "symbolic-ref" &&
				args.length === 1 &&
				(args[0] === "HEAD" || (args[0]?.startsWith("refs/") && /^[\w/-]+$/.test(args[0])))
			) {
				const value = String(vfs.fs.readFileSync(path.join(dir, ".git", args[0]), "utf8"));
				if (!value.startsWith("ref: ")) return 1;
				io.stdout(`${value.slice(5).trimEnd()}\n`);
			} else if (
				command === "rev-parse" &&
				args.length === 2 &&
				args[0] === "--symbolic-full-name" &&
				args[1] === "@{upstream}"
			) {
				const branch = await git.currentBranch(repo);
				const up = branch && (await upstream(repo, branch));
				if (!up) fail("no upstream configured");
				io.stdout(`${up}\n`);
			} else if (command === "rev-parse" && args.length) {
				const output = [];
				for (const arg of args) {
					if (arg === "--is-bare-repository") output.push("false");
					else if (arg === "--show-cdup") {
						const up = path.relative(cwd, dir);
						output.push(up ? `${up}/` : "");
					} else if (arg === "--show-toplevel") output.push(dir);
					else if (arg === "--git-dir")
						output.push(dir === cwd ? ".git" : path.join(dir, ".git"));
					else if (/^[\w/-]+$/.test(arg) && !arg.startsWith("-"))
						output.push(await git.resolveRef({ ...repo, ref: arg }));
					else unsupported(command);
				}
				io.stdout(`${output.join("\n")}\n`);
			} else if (
				command === "ls-files" &&
				cwd === dir &&
				(!args.length || (args.length === 1 && args[0] === "-z"))
			) {
				for (const file of await git.listFiles(repo))
					io.stdout(file + (args.length ? "\0" : "\n"));
			} else if (command === "log") {
				io.stdout(await gitLog(repo, args));
			} else if (command === "branch" && args.length === 1 && args[0] === "--show-current") {
				const branch = await git.currentBranch(repo);
				if (branch) io.stdout(`${branch}\n`);
			} else if (command === "remote" && !args.length) {
				for (const { remote } of await git.listRemotes(repo)) io.stdout(`${remote}\n`);
			} else unsupported(command || "");
		}
		return 0;
	} catch (error) {
		io.stderr(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
		return 128;
	}
}
