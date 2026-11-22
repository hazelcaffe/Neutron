import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "readable-stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { httpModule } from "../src/runtime/http";

const server = createServer(async (req, res) => {
	if (req.url === "/redirect") {
		res.writeHead(302, { location: "/echo" });
		res.end();
		return;
	}
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	res.setHeader("set-cookie", ["one=1; Path=/", "two=2; Path=/"]);
	res.end(
		JSON.stringify({
			method: req.method,
			headers: req.headers,
			body: Buffer.concat(chunks).toString(),
			url: req.url,
		}),
	);
});
let base: string;
beforeAll(async () => {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(
	() =>
		new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		),
);

describe("Node HTTP client over fetch", () => {
	it("pipes request bodies, normalizes headers, applies URL options and exposes Node response metadata", async () => {
		const http = httpModule(fetch);
		const req = http.request(`${base}/original`, {
			path: "/echo?query=1",
			method: "post",
			auth: "user:pass",
			headers: { "X-Test": "a" },
		});
		expect(req.getHeader("x-test")).toBe("a");
		req.appendHeader("X-Test", "b");
		expect(req.getHeaders()["x-test"]).toEqual(["a", "b"]);
		expect(Object.getPrototypeOf(req.getHeaders())).toBe(null);
		const result = new Promise<void>((resolve, reject) => {
			req.on("error", reject);
			req.on("response", async (response) => {
				try {
					expect(response).toBeInstanceOf(http.IncomingMessage);
					expect(response.statusCode).toBe(200);
					expect(response.statusMessage).toBe(http.STATUS_CODES[200]);
					expect(response.headers["set-cookie"]).toEqual([
						"one=1; Path=/",
						"two=2; Path=/",
					]);
					expect(response.req).toBe(req);
					const chunks = [];
					for await (const chunk of response) chunks.push(chunk);
					expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
						method: "POST",
						headers: { "x-test": "a, b", authorization: "Basic dXNlcjpwYXNz" },
						body: "piped-body",
						url: "/echo?query=1",
					});
					expect(response.complete).toBe(true);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
		Readable.from(["piped-", "body"]).pipe(req);
		await result;
		expect(req.finished).toBe(true);
		expect(req.destroyed).toBe(true);
	});
	it("preserves redirects for Node consumers and follows them for Electron net", async () => {
		for (const electron of [false, true]) {
			const http = httpModule(fetch, "http:", electron);
			await new Promise<void>((resolve, reject) => {
				http.get(`${base}/redirect`, (response) => {
					expect(response.statusCode).toBe(electron ? 200 : 302);
					response.resume();
					response.once("end", resolve);
				}).on("error", reject);
			});
		}
	});
	it("destroy aborts an in-flight fetch even when an external signal was supplied", async () => {
		let signal: AbortSignal | undefined;
		const transport = vi.fn((_url: string, init: RequestInit) => {
			signal = init.signal as AbortSignal;
			return new Promise<Response>((_resolve, reject) =>
				signal?.addEventListener("abort", () => reject(signal?.reason)),
			);
		});
		const http = httpModule(transport);
		const external = new AbortController();
		const req = http.get(`${base}/wait`, { signal: external.signal });
		const closed = once(req, "close");
		req.destroy();
		await closed;
		expect(signal?.aborted).toBe(true);
		expect(external.signal.aborted).toBe(false);
	});
	it("validates headers and disposes timeouts on completion", async () => {
		const http = httpModule(fetch);
		const req = http.request(`${base}/echo`);
		expect(() => req.setHeader("bad header", "x")).toThrow();
		expect(() => req.setHeader("x-test", "one\r\ntwo")).toThrow();
		const timeout = vi.fn();
		req.setTimeout(100, timeout);
		const closed = once(req, "close");
		req.end();
		await closed;
		expect(timeout).not.toHaveBeenCalled();
	});
});
