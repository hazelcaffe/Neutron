import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureCompatibility, createStub, withFallback } from "../src/runtime/fallback";
import { optionalElectron, virtualChild, vmModule } from "../src/runtime/optional";

afterEach(() => {
	configureCompatibility(false);
	vi.restoreAllMocks();
});
describe("permissive compatibility", () => {
	it("allows promisification without inventing a custom-promisify symbol", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const api = withFallback(
			{
				read(callback: (error: Error | null, value: string) => void) {
					callback(null, "read");
				},
			},
			"api",
		);
		expect(await promisify(api.read)()).toBe("read");
		const stub = createStub("native.getMetadata") as (
			callback: (error: Error | null, value: object) => void,
		) => void;
		expect(await promisify(stub)()).toEqual({});
	});
	it("does not invoke module getters while deciding whether to wrap an API", () => {
		let reads = 0;
		const api = {
			method: () => 42,
			get property() {
				reads++;
				return "value";
			},
		};
		const wrapped = withFallback({ api }, "test");
		expect(wrapped.api.method()).toBe(42);
		expect(reads).toBe(0);
		expect(wrapped.api.property).toBe("value");
		expect(reads).toBe(1);
	});
	it("preserves absent data fields and invalidates replaced method wrappers", () => {
		const target = withFallback(
			{ env: { HOME: "/home/user" }, versions: { node: "22" }, getValue: (): number => 1 },
			"process",
		);
		expect(Reflect.get(target.env, "XDG_RUNTIME_DIR")).toBeUndefined();
		expect(target.getValue()).toBe(1);
		target.getValue = () => 2;
		expect(target.getValue()).toBe(2);
		const missing = Reflect.get(target, "newMethod");
		expect(typeof missing).toBe("function");
		Reflect.set(target, "newMethod", () => 42);
		expect(Reflect.get(target, "newMethod")()).toBe(42);
	});
	it("supports calls, constructors, events, callbacks and await without becoming a thenable", async () => {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stub = createStub("native") as {
			then?: unknown;
			on(name: string, listener: (value: number) => void): unknown;
			emit(name: string, value: number): boolean;
			isSupported(): boolean;
			getSources(): Promise<unknown[]>;
			getMetadata(callback: (error: unknown, value: unknown) => void): void;
			Widget: new () => { setValue(value: number): void };
		};
		expect(stub.then).toBeUndefined();
		expect(await Promise.resolve(stub)).toBe(stub);
		expect(stub.isSupported()).toBe(true);
		expect(await stub.getSources()).toEqual([]);
		const listener = vi.fn();
		stub.on("message", listener);
		stub.emit("message", 42);
		expect(listener).toHaveBeenCalledWith(42);
		expect(
			await new Promise((resolve) => stub.getMetadata((_error, value) => resolve(value))),
		).toEqual({});
		new stub.Widget().setValue(1);
		stub.isSupported();
		expect(
			warnings.mock.calls.filter(([message]) =>
				String(message).includes("native.isSupported"),
			),
		).toHaveLength(1);
	});
	it("keeps implemented methods working, and makes missing APIs strict only on request", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const target = withFallback(
			{
				value: 41,
				increment() {
					return this.value + 1;
				},
				fail() {
					throw new Error("real application failure");
				},
			},
			"test",
		);
		expect(target.increment()).toBe(42);
		expect(() => target.fail()).toThrow("real application failure");
		expect((Reflect.get(target, "isSupported") as () => boolean)()).toBe(true);
		configureCompatibility(true);
		expect(() => (Reflect.get(target, "missing") as () => unknown)()).toThrow(
			"ERR_UNSUPPORTED_API",
		);
	});
	it("completes updater and native-process lifecycles rather than hanging", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const updater = optionalElectron().autoUpdater;
		const noUpdate = vi.fn();
		updater.on("update-not-available", noUpdate);
		await updater.checkForUpdates();
		expect(noUpdate).toHaveBeenCalled();
		const child = virtualChild("spawn native-tool");
		expect(await new Promise((resolve) => child.once("exit", resolve))).toBe(0);
	});
	it("evaluates basic vm scripts in their supplied context", () => {
		const vm = vmModule();
		const context = vm.createContext({ answer: 40 });
		expect(vm.runInContext("answer += 2; answer", context)).toBe(42);
		expect(context.answer).toBe(42);
	});
});
