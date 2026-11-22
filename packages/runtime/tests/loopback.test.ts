import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { browserLoopback } from "../src/core/loopback-fetch";
import { httpModule } from "../src/runtime/http";
import { LoopbackRegistry } from "../src/runtime/loopback";
import { type CallbackReply, LOOPBACK_BYTES, LOOPBACK_TIMEOUT } from "../src/shared/loopback";

function run() {
	const registry = new LoopbackRegistry();
	const session = {
		appId: "fixture",
		runId: crypto.randomUUID(),
		id: crypto.randomUUID(),
		wisp: "",
		browser: true,
	};
	const owner = {
		url: "https://shell.invalid/",
		postMessage: (probe: { origin: string }, ports: MessagePort[]) => {
			const port = ports[0];
			if (!port) throw new Error("Missing private reply port");
			registry.probe(probe.origin, port);
		},
	} as Client;
	return {
		http: httpModule(fetch, "http:", false, registry),
		registry,
		request: (url: string, method = "GET", body?: ArrayBuffer) =>
			browserLoopback(session, owner, new URL(url), method, {
				owner: "shell",
				caller: true,
				headers: [],
				body,
			}),
	};
}

describe("main-process virtual HTTP callbacks", () => {
	it.each(["localhost", "127.0.0.1", "::1"])(
		"allocates an ephemeral %s authority; exposes stream data, header arrays, status, and no fragment",
		async (host) => {
			const app = run();
			const server = app.http.createServer(async (req, res) => {
				expect(req.url).toBe("/return?literal=%2B&same=x&same=y");
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(chunk);
				res.setHeader("Set-Cookie", ["a=1", "b=2"]);
				res.writeHead(201, "Fixture", { "X-Seen-Method": req.method });
				res.end(Buffer.concat(chunks));
			});
			server.listen({ port: 0, host });
			await once(server, "listening");
			const port = server.address()?.port;
			expect(port).toBeGreaterThanOrEqual(49152);
			const origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
			const response = await app.request(
				`${origin}/return?literal=%2B&same=x&same=y#not-on-wire`,
				"PATCH",
				Uint8Array.from([0, 255, 17]).buffer,
			);
			expect(response?.status).toBe(201);
			expect(response?.statusText).toBe("Fixture");
			expect(response?.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
			expect(response?.headers.get("x-seen-method")).toBe("PATCH");
			expect(await response?.bytes()).toEqual(Uint8Array.from([0, 255, 17]));
			app.registry.dispose();
		},
	);

	it("keeps same-port listeners independent across runs and hosts, rejects duplicate binds, and drains then rebinds", async () => {
		const a = run(),
			b = run();
		const origin = "http://localhost:4268";
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const s = a.http
			.createServer(async (_req, res) => {
				started.resolve();
				await release.promise;
				res.end("a");
			})
			.listen(4268, "localhost");
		b.http.createServer((_req, res) => res.end("b")).listen(4268, "localhost");
		const duplicate = a.http.createServer().listen(4268, "localhost");
		expect((await once(duplicate, "error"))[0]).toMatchObject({ code: "EADDRINUSE" });
		expect(duplicate.address()).toBeNull();
		expect(await a.request("http://127.0.0.1:4268")).toBeUndefined();
		expect(await (await b.request(origin))?.text()).toBe("b");
		const first = a.request(origin);
		await started.promise;
		const closed = vi.fn();
		s.close(closed);
		expect((await a.request(origin))?.status).toBe(410);
		expect(closed).not.toHaveBeenCalled();
		release.resolve();
		expect(await (await first)?.text()).toBe("a");
		expect(closed).toHaveBeenCalledOnce();
		s.listen(4268, "localhost");
		expect(await (await a.request(origin))?.text()).toBe("a");
		a.registry.dispose();
		expect((await a.request(origin))?.status).toBe(410);
		expect(await (await b.request(origin))?.text()).toBe("b");
		b.registry.dispose();
	});

	it("does not dispatch a previously admitted probe to a replacement binding", async () => {
		const a = run(),
			hit = vi.fn();
		const s = a.http.createServer(hit).listen(4268, "localhost");
		const { port1, port2 } = new MessageChannel();
		const next = () =>
			new Promise<CallbackReply>((resolve) => {
				port1.onmessage = (e) => resolve(e.data);
			});
		a.registry.probe("http://localhost:4268", port2);
		expect(await next()).toEqual({ type: "bound" });
		s.close();
		a.http.createServer(hit).listen(4268, "localhost");
		port1.postMessage({ method: "GET", path: "/old", headers: [] });
		expect(await next()).toEqual({ type: "failed", status: 410 });
		expect(hit).not.toHaveBeenCalled();
		port1.close();
		a.registry.dispose();
	});

	it("rejects unsupported server/listen contracts instead of claiming a working listener", () => {
		const a = run(),
			s = a.http.createServer();
		for (const args of [
			[0],
			[0, "0.0.0.0"],
			[0, "localhost.example"],
			["/tmp/callback"],
			[{ fd: 1 }],
			[{ port: 0, host: "::1", backlog: 1 }],
		])
			expect(() => s.listen(...args)).toThrow(
				expect.objectContaining({ code: "ERR_NOT_SUPPORTED" }),
			);
		expect(() => s.listen(-1, "localhost")).toThrow(
			expect.objectContaining({ code: "ERR_SOCKET_BAD_PORT" }),
		);
		expect(s.listening).toBe(false);
		expect(() => httpModule(fetch, "https:", false, a.registry).createServer()).toThrow(
			/plain HTTP/,
		);
		expect(() => httpModule(fetch).createServer()).toThrow(/main process/);
		expect(() => a.http.createServer({ keepAlive: true })).toThrow(/loopback/);
	});

	it("limits buffered bodies in both directions and discards a HEAD body", async () => {
		const a = run(),
			hit = vi.fn();
		a.http
			.createServer((req, res) => {
				hit();
				res.end(req.method === "HEAD" ? "skip" : Buffer.alloc(LOOPBACK_BYTES + 1));
			})
			.listen(80, "localhost");
		expect(
			(await a.request("http://localhost/", "POST", new ArrayBuffer(LOOPBACK_BYTES + 1)))
				?.status,
		).toBe(413);
		expect(hit).not.toHaveBeenCalled();
		expect((await a.request("http://localhost/"))?.status).toBe(502);
		const head = await a.request("http://localhost/", "HEAD");
		expect(head?.status).toBe(200);
		expect(head?.body).toBeNull();
		a.registry.dispose();
	});

	it("times out and closes an unfinished response without emitting finish", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const a = run();
		try {
			const started = Promise.withResolvers<void>(),
				closed = Promise.withResolvers<void>(),
				finished = vi.fn();
			a.http
				.createServer((_req, res) => {
					res.once("close", closed.resolve);
					res.once("finish", finished);
					started.resolve();
				})
				.listen(4269, "localhost");
			const response = a.request("http://localhost:4269/");
			await started.promise;
			await vi.advanceTimersByTimeAsync(LOOPBACK_TIMEOUT + 1);
			expect((await response)?.status).toBe(504);
			await closed.promise;
			expect(finished).not.toHaveBeenCalled();
		} finally {
			a.registry.dispose();
			vi.useRealTimers();
		}
	});
});
