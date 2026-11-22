// A small read/write smart-HTTP (protocol v0) and Git LFS "basic" origin for
// tests. Repositories are bare isomorphic-git repositories in a temporary
// directory: no git binary is needed by the server or by the app under test.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import * as git from "isomorphic-git";

export interface ServerHit {
	method: string;
	path: string;
	authorization?: string;
}

function pkt(value: string | Uint8Array) {
	const body = Buffer.from(value);
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

function readPkts(data: Buffer) {
	const lines: (Buffer | null)[] = [];
	let at = 0;
	while (at + 4 <= data.length) {
		const size = Number.parseInt(data.subarray(at, at + 4).toString(), 16);
		if (Number.isNaN(size)) break;
		if (size === 0) {
			lines.push(null);
			at += 4;
			continue;
		}
		lines.push(data.subarray(at + 4, at + size));
		at += size;
	}
	return { lines, rest: data.subarray(at) };
}

export interface GitServer {
	server: Server;
	url: (name: string) => string;
	/** Bare repository directory for `name`, created on first use. */
	gitdir: (name: string) => string;
	lfsObjects: Map<string, Buffer>;
	hits: ServerHit[];
	/** Commits a series of file snapshots onto `branch` of `name`. */
	seed: (
		name: string,
		commits: { message: string; files: Record<string, string> }[],
		branch?: string,
	) => Promise<string>;
	resolve: (name: string, ref: string) => Promise<string | undefined>;
	message: (name: string, oid: string) => Promise<string>;
	close: () => Promise<void>;
}

/** Listens on an ephemeral loopback port unless one is given. */
export async function startGitServer(root: string, port = 0): Promise<GitServer> {
	const hits: ServerHit[] = [];
	const lfsObjects = new Map<string, Buffer>();
	const gitdir = (name: string) => join(root, `${name}.git`);
	const ensure = async (name: string) => {
		const dir = gitdir(name);
		if (!fs.existsSync(join(dir, "HEAD")))
			await git.init({ fs, gitdir: dir, bare: true, defaultBranch: "main" });
		return dir;
	};
	const advertise = async (dir: string, service: string) => {
		const refs = new Map<string, string>();
		for (const prefix of ["refs/heads", "refs/tags"])
			for (const name of await git.listRefs({ fs, gitdir: dir, filepath: prefix }))
				refs.set(
					`${prefix}/${name}`,
					await git.resolveRef({ fs, gitdir: dir, ref: `${prefix}/${name}` }),
				);
		const head = await git
			.resolveRef({ fs, gitdir: dir, ref: "HEAD", depth: 2 })
			.catch(() => undefined);
		const caps =
			service === "git-upload-pack"
				? `side-band-64k ofs-delta${head?.startsWith("refs/") ? ` symref=HEAD:${head}` : ""} agent=fixture`
				: "report-status delete-refs side-band-64k agent=fixture";
		const lines = [pkt(`# service=${service}\n`), Buffer.from("0000")];
		const headOid = await git
			.resolveRef({ fs, gitdir: dir, ref: "HEAD" })
			.catch(() => undefined);
		const entries: [string, string][] = [];
		if (service === "git-upload-pack" && headOid) entries.push([headOid, "HEAD"]);
		for (const [ref, oid] of [...refs].sort()) entries.push([oid, ref]);
		if (!entries.length) entries.push(["0".repeat(40), "capabilities^{}"]);
		entries.forEach(([oid, ref], i) => {
			lines.push(pkt(`${oid} ${ref}${i ? "" : `\0${caps}`}\n`));
		});
		lines.push(Buffer.from("0000"));
		return Buffer.concat(lines);
	};
	const closure = async (dir: string, from: string[], stop: Set<string>) => {
		const seen = new Set<string>();
		const visit = async (oid: string): Promise<void> => {
			if (seen.has(oid) || stop.has(oid)) return;
			seen.add(oid);
			const { type, object } = await git.readObject({
				fs,
				gitdir: dir,
				oid,
				format: "parsed",
			});
			if (type === "commit") {
				const commit = object as git.CommitObject;
				await visit(commit.tree);
				for (const parent of commit.parent) await visit(parent);
			} else if (type === "tree")
				for (const entry of object as git.TreeObject) await visit(entry.oid);
			else if (type === "tag") await visit((object as git.TagObject).object);
		};
		for (const oid of from) await visit(oid);
		return seen;
	};
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks);
		const url = new URL(req.url || "/", "http://fixture");
		hits.push({
			method: req.method || "GET",
			path: url.pathname + url.search,
			authorization: req.headers.authorization,
		});
		try {
			const lfs = /^\/(.+)\.git\/info\/lfs\/objects\/batch$/.exec(url.pathname);
			if (lfs && req.method === "POST") {
				const request = JSON.parse(body.toString()) as {
					operation: string;
					objects: { oid: string; size: number }[];
				};
				const objects = request.objects.map(({ oid, size }) => {
					const href = `http://${req.headers.host}/lfs/${oid}`;
					if (request.operation === "download")
						return lfsObjects.has(oid)
							? {
									oid,
									size,
									actions: {
										download: { href, header: { "X-Fixture": "download" } },
									},
								}
							: { oid, size, error: { code: 404, message: "Object does not exist" } };
					return lfsObjects.has(oid)
						? { oid, size }
						: {
								oid,
								size,
								actions: { upload: { href, header: { "X-Fixture": "upload" } } },
							};
				});
				res.setHeader("Content-Type", "application/vnd.git-lfs+json");
				res.end(JSON.stringify({ transfer: "basic", objects }));
				return;
			}
			const object = /^\/lfs\/([0-9a-f]{64})$/.exec(url.pathname);
			if (object) {
				const oid = object[1] as string;
				if (req.method === "PUT") {
					if (createHash("sha256").update(body).digest("hex") !== oid) {
						res.writeHead(422).end();
						return;
					}
					lfsObjects.set(oid, body);
					res.end();
				} else if (lfsObjects.has(oid)) res.end(lfsObjects.get(oid));
				else res.writeHead(404).end();
				return;
			}
			const match = /^\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
				url.pathname,
			);
			if (!match) {
				res.writeHead(404).end();
				return;
			}
			const dir = await ensure(match[1] as string);
			if (match[2] === "info/refs") {
				const service = url.searchParams.get("service") || "";
				if (!["git-upload-pack", "git-receive-pack"].includes(service)) {
					res.writeHead(403).end();
					return;
				}
				res.setHeader("Content-Type", `application/x-${service}-advertisement`);
				res.end(await advertise(dir, service));
				return;
			}
			const { lines, rest } = readPkts(body);
			if (match[2] === "git-upload-pack") {
				const wants: string[] = [];
				const haves = new Set<string>();
				for (const line of lines) {
					const text = line?.toString() ?? "";
					if (text.startsWith("want ")) wants.push(text.slice(5, 45));
					if (text.startsWith("have ")) {
						const oid = text.slice(5, 45);
						if (fs.existsSync(join(dir, "objects", oid.slice(0, 2), oid.slice(2))))
							haves.add(oid);
						else
							try {
								await git.readObject({ fs, gitdir: dir, oid });
								haves.add(oid);
							} catch {
								/* Unknown to the server. */
							}
					}
				}
				const common = haves.size
					? await closure(dir, [...haves], new Set())
					: new Set<string>();
				const oids = [...(await closure(dir, wants, common))];
				const { packfile } = await git.packObjects({ fs, gitdir: dir, oids });
				const pack = Buffer.from(packfile as Uint8Array);
				const out = [pkt("NAK\n")];
				for (let i = 0; i < pack.length; i += 65000)
					out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65000)])));
				out.push(Buffer.from("0000"));
				res.setHeader("Content-Type", "application/x-git-upload-pack-result");
				res.end(Buffer.concat(out));
				return;
			}
			// receive-pack: ref update commands, then a packfile.
			const commands: [string, string, string][] = [];
			for (const line of lines) {
				if (!line) break;
				const [oldOid = "", newOid = "", ref = ""] =
					line.toString().split("\0")[0]?.trim().split(" ") ?? [];
				commands.push([oldOid, newOid, ref]);
			}
			if (rest.length >= 12) {
				const name = `pack-${createHash("sha1").update(rest).digest("hex")}.pack`;
				fs.mkdirSync(join(dir, "objects/pack"), { recursive: true });
				fs.writeFileSync(join(dir, "objects/pack", name), rest);
				await git.indexPack({ fs, dir, gitdir: dir, filepath: join("objects/pack", name) });
			}
			const out = [pkt("unpack ok\n")];
			for (const [oldOid, newOid, ref] of commands) {
				const current = await git
					.resolveRef({ fs, gitdir: dir, ref })
					.catch(() => "0".repeat(40));
				if (current !== oldOid) out.push(pkt(`ng ${ref} fetch first\n`));
				else {
					if (/^0+$/.test(newOid)) await git.deleteRef({ fs, gitdir: dir, ref });
					else await git.writeRef({ fs, gitdir: dir, ref, value: newOid, force: true });
					out.push(pkt(`ok ${ref}\n`));
				}
			}
			out.push(Buffer.from("0000"));
			// The report travels on side-band channel 1.
			res.setHeader("Content-Type", "application/x-git-receive-pack-result");
			res.end(
				Buffer.concat([
					pkt(Buffer.concat([Buffer.from([1]), ...out])),
					Buffer.from("0000"),
				]),
			);
		} catch (error) {
			res.writeHead(500).end(String(error));
		}
	});
	await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, "127.0.0.1", ok));
	const address = server.address();
	const actual = typeof address === "object" && address ? address.port : port;
	return {
		server,
		url: (name) => `http://127.0.0.1:${actual}/${name}.git`,
		gitdir,
		lfsObjects,
		hits,
		seed: async (name, commits, branch = "main") => {
			const dir = await ensure(name);
			const who = {
				name: "Fixture",
				email: "fixture@example.org",
				timestamp: 1700000000,
				timezoneOffset: 0,
			};
			let parent: string[] = [];
			for (const { message, files } of commits) {
				const tree = await git.writeTree({
					fs,
					gitdir: dir,
					tree: await Promise.all(
						Object.entries(files)
							.sort(([a], [b]) => (a < b ? -1 : 1))
							.map(async ([path, text]) => ({
								mode: "100644",
								path,
								type: "blob" as const,
								oid: await git.writeBlob({
									fs,
									gitdir: dir,
									blob: Buffer.from(text),
								}),
							})),
					),
				});
				const oid = await git.writeCommit({
					fs,
					gitdir: dir,
					commit: { tree, parent, author: who, committer: who, message: `${message}\n` },
				});
				parent = [oid];
			}
			await git.writeRef({
				fs,
				gitdir: dir,
				ref: `refs/heads/${branch}`,
				value: parent[0] as string,
				force: true,
			});
			return parent[0] as string;
		},
		resolve: (name, ref) =>
			git.resolveRef({ fs, gitdir: gitdir(name), ref }).catch(() => undefined),
		message: async (name, oid) =>
			(await git.readCommit({ fs, gitdir: gitdir(name), oid })).commit.message,
		close: () => new Promise<void>((ok) => server.close(() => ok())),
	};
}
