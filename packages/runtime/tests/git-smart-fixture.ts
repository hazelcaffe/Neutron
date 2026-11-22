// A read-only smart-HTTP v0 origin. Generate the two revisions and PACK in
// memory; neither the test server nor the app needs an installed git binary.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const sha = (data: Buffer) => createHash("sha1").update(data).digest();
const objects: Buffer[] = [];
function object(type: "commit" | "tree" | "blob", content: string | Buffer) {
	const data = Buffer.from(content);
	const id = sha(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]));
	let n = data.length;
	const header = [({ commit: 1, tree: 2, blob: 3 }[type] << 4) | (n & 15)];
	n >>>= 4;
	while (n) {
		header[header.length - 1] = (header.at(-1) ?? 0) | 128;
		header.push(n & 127);
		n >>>= 7;
	}
	objects.push(Buffer.from(header), deflateSync(data));
	return id;
}
function revision(contents: string, message: string, parent?: string) {
	const tree = object(
		"tree",
		Buffer.concat([Buffer.from("100644 hello.txt\0"), object("blob", contents)]),
	);
	const who = "Fixture <fixture@example.org> 1700000000 +0000";
	return object(
		"commit",
		`tree ${tree.toString("hex")}\n${parent ? `parent ${parent}\n` : ""}author ${who}\ncommitter ${who}\n\n${message}\n`,
	).toString("hex");
}
export const first = revision("one\n", "Initial fixture");
export const contents = "two revisions via smart HTTP\n";
export const head = revision(contents, "Second fixture commit", first);
const header = Buffer.from("5041434b0000000200000006", "hex");
const pack = Buffer.concat([header, ...objects]);
function pkt(value: string | Buffer) {
	const body = Buffer.from(value);
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}
export const repoURL = "http://127.0.0.1:4261/two.git";
export type Hit = { method?: string; path?: string; body: string };
export async function startFixture(hits: Hit[], port = 4261) {
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString();
		hits.push({ method: req.method, path: req.url, body });
		if (req.method === "GET" && req.url === "/two.git/info/refs?service=git-upload-pack") {
			res.setHeader("Content-Type", "application/x-git-upload-pack-advertisement");
			res.end(
				Buffer.concat([
					pkt("# service=git-upload-pack\n"),
					Buffer.from("0000"),
					pkt(`${head} HEAD\0side-band-64k symref=HEAD:refs/heads/main\n`),
					pkt(`${head} refs/heads/main\n`),
					Buffer.from("0000"),
				]),
			);
		} else if (
			req.method === "POST" &&
			req.url === "/two.git/git-upload-pack" &&
			body.includes(`want ${head}`) &&
			body.includes("side-band-64k")
		) {
			res.setHeader("Content-Type", "application/x-git-upload-pack-result");
			res.end(
				Buffer.concat([
					pkt("NAK\n"),
					pkt(Buffer.concat([Buffer.from([1]), pack, sha(pack)])),
					Buffer.from("0000"),
				]),
			);
		} else res.writeHead(404).end();
	});
	await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, "127.0.0.1", ok));
	return server;
}
