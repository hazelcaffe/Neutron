import { EventEmitter } from "events";
import { PassThrough, Readable, Writable } from "readable-stream";
import { describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage, AsyncResource, Domain, diagnostics } from "../src/runtime/context";
import { dnsModule } from "../src/runtime/dns";
import { eventsModule } from "../src/runtime/events";
import { createStub, serializeFallbacks } from "../src/runtime/fallback";
import type { Network } from "../src/runtime/network";
import { readlineModules } from "../src/runtime/readline";
import { consumers, streamPromises } from "../src/runtime/streams";
import { timerPromises } from "../src/runtime/timers";

describe("Node compatibility contracts", () => {
	it("restores context after throws and binds resources to their creation scope", () => {
		const store = new AsyncLocalStorage<string>();
		const resource = store.run("captured", () => new AsyncResource("test"));
		store.run("outside", () => {
			expect(resource.runInAsyncScope(() => store.getStore())).toBe("captured");
			expect(() =>
				store.run("throw", () => {
					throw new Error("failure");
				}),
			).toThrow("failure");
			expect(store.getStore()).toBe("outside");
		});
		expect(store.getStore()).toBeUndefined();
		store.disable();
		const bound = store.run("reenabled", () => AsyncLocalStorage.bind(() => store.getStore()));
		expect(bound()).toBe("reenabled");
		store.disable();
	});
	it("publishes diagnostic errors, runs bound stores, and cleans up domain members", async () => {
		const channel = diagnostics.channel(Symbol("test"));
		const store = new AsyncLocalStorage<unknown>();
		channel.bindStore(store, (message) => message);
		expect(channel.runStores("trace", () => store.getStore())).toBe("trace");
		expect(store.getStore()).toBeUndefined();
		const tracing = diagnostics.tracingChannel("test-rejection");
		const listener = vi.fn();
		tracing.error.subscribe(listener);
		const error = new Error("rejected");
		await expect(tracing.tracePromise(() => Promise.reject(error))).rejects.toBe(error);
		expect(listener.mock.calls[0]?.[0]).toMatchObject({ error });
		tracing.error.unsubscribe(listener);
		store.disable();
		const domain = new Domain();
		const emitter = new EventEmitter();
		const caught = vi.fn();
		domain.on("error", caught);
		domain.add(emitter);
		emitter.emit("error", error);
		expect(caught).toHaveBeenCalledWith(error);
		domain.dispose();
		expect(emitter.listenerCount("error")).toBe(0);
	});
	it("handles once/on promises, aborts, and listener cleanup", async () => {
		const events = eventsModule();
		const emitter = new EventEmitter();
		const value = events.once(emitter, "value");
		emitter.emit("value", 1, "two");
		await expect(value).resolves.toEqual([1, "two"]);
		expect(emitter.listenerCount("error")).toBe(0);
		const controller = new AbortController();
		const iterator = events.on(emitter, "data", { signal: controller.signal });
		emitter.emit("data", "buffered");
		expect(await iterator.next()).toEqual({ value: ["buffered"], done: false });
		const waiting = iterator.next();
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ code: "ABORT_ERR" });
		expect(emitter.listenerCount("data")).toBe(0);
		const target = new EventTarget();
		const event = events.once(target, "ready");
		target.dispatchEvent(new Event("ready"));
		expect((await event)[0]).toBeInstanceOf(Event);
	});
	it("cancels promise timers and cleans interval iteration on abort", async () => {
		const controller = new AbortController();
		const pending = timerPromises.setTimeout(1000, "late", { signal: controller.signal });
		controller.abort("cancelled");
		await expect(pending).rejects.toMatchObject({
			name: "AbortError",
			code: "ABORT_ERR",
			cause: "cancelled",
		});
		await expect(timerPromises.setImmediate(42)).resolves.toBe(42);
		const abort = new AbortController();
		const iterator = timerPromises.setInterval(1, "tick", { signal: abort.signal });
		expect(await iterator.next()).toEqual({ done: false, value: "tick" });
		abort.abort();
		await expect(iterator.next()).rejects.toMatchObject({ code: "ABORT_ERR" });
	});
	it("consumes split UTF-8 and propagates stream failures through promise pipelines", async () => {
		const source = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array([0xe2]));
				controller.enqueue(new Uint8Array([0x82, 0xac]));
				controller.close();
			},
		});
		await expect(consumers.text(source)).resolves.toBe("€");
		expect(source.locked).toBe(false);
		await expect(consumers.json(Readable.from(['{"answer":', "42}"]))).resolves.toEqual({
			answer: 42,
		});
		const sink = new Writable({
			write(_data, _encoding, done) {
				done(new Error("write failed"));
			},
		});
		await expect(streamPromises.pipeline(Readable.from(["data"]), sink)).rejects.toThrow(
			"write failed",
		);
		const output = new PassThrough();
		const finished = streamPromises.finished(output, { readable: false, cleanup: true });
		output.end("done");
		await finished;
		expect(output.listenerCount("finish")).toBe(0);
	});
	it("reads streamed lines with split CRLF, bare CR, UTF-8, and a final unterminated line", async () => {
		const input = new PassThrough();
		const rl = readlineModules().createInterface({ input });
		const observed: string[] = [];
		const done = (async () => {
			for await (const line of rl) observed.push(line);
		})();
		input.write(Buffer.from([0xe2]));
		input.write(Buffer.from([0x82, 0xac]));
		input.write("\r");
		input.write("\nsecond\rthird\n\nlast");
		input.end();
		await done;
		expect(observed).toEqual(["€", "second", "third", "", "last"]);
		expect(input.listenerCount("data")).toBe(0);
	});
	it("supports abortable readline questions without swallowing subsequent lines", async () => {
		const input = new PassThrough();
		const rl = readlineModules().promises.createInterface({ input });
		const abort = new AbortController();
		const pending = rl.question("Name?", { signal: abort.signal });
		abort.abort();
		await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR" });
		const next = rl.question("Name?");
		input.write("Neutron\n");
		await expect(next).resolves.toBe("Neutron");
		rl.close();
	});
	it("implements DNS callback result shapes and real DoH answer parsing", async () => {
		const fetch = vi.fn(async (url: string) => {
			const type = new URL(url).searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer:
					type === "AAAA"
						? []
						: [
								{
									name: "example.com",
									type: type === "MX" ? 15 : type === "TXT" ? 16 : 1,
									TTL: 60,
									data:
										type === "MX"
											? "10 mail.example.com."
											: type === "TXT"
												? '"one" "two"'
												: "192.0.2.1",
								},
							],
			});
		});
		const dns = dnsModule({ fetch } as unknown as Network);
		await expect(dns.promises.lookup("example.com")).resolves.toEqual({
			address: "192.0.2.1",
			family: 4,
		});
		await expect(dns.promises.resolve("example.com", "MX")).resolves.toEqual([
			{ priority: 10, exchange: "mail.example.com" },
		]);
		await expect(dns.promises.resolve("example.com", "TXT")).resolves.toEqual([["one", "two"]]);
		await new Promise<void>((resolve, reject) => {
			Reflect.get(dns, "lookup")(
				"localhost",
				6,
				(error: unknown, address: string, family: number) => {
					try {
						expect(error).toBeNull();
						expect(address).toBe("::1");
						expect(family).toBe(6);
						resolve();
					} catch (error) {
						reject(error);
					}
				},
			);
		});
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it("sanitizes fallback IPC values while preserving cycles and real clone errors", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const value: Record<string, unknown> = {
				missing: createStub("test.scalar"),
				bytes: new Uint8Array([1, 2]),
			};
			value.self = value;
			const clone = structuredClone(serializeFallbacks(value)) as typeof value;
			expect(clone.missing).toBeNull();
			expect(clone.self).toBe(clone);
			expect(clone.bytes).toEqual(value.bytes);
			expect(() => structuredClone(serializeFallbacks({ callback() {} }))).toThrow();
		} finally {
			warn.mockRestore();
		}
	});
});
