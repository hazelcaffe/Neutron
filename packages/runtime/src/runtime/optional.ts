import { parse, stringify } from "@ungap/structured-clone/json";
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { PassThrough } from "readable-stream";
import { createStub, noteStub, withFallback } from "./fallback";

export function optionalElectron() {
	const autoUpdater = Object.assign(new EventEmitter(), {
		setFeedURL: (_options: unknown) => noteStub("autoUpdater.setFeedURL"),
		getFeedURL: () => "",
		checkForUpdates: async () => {
			noteStub("autoUpdater.checkForUpdates");
			autoUpdater.emit("checking-for-update");
			queueMicrotask(() => autoUpdater.emit("update-not-available", { version: "0.0.0" }));
			return { updateInfo: null, downloadPromise: null };
		},
		checkForUpdatesAndNotify: async () => autoUpdater.checkForUpdates(),
		downloadUpdate: async () => {
			noteStub("autoUpdater.downloadUpdate");
			return [];
		},
		quitAndInstall: () => noteStub("autoUpdater.quitAndInstall"),
	});
	class TouchBar extends EventEmitter {
		constructor(readonly options: object = {}) {
			super();
			noteStub("TouchBar");
		}
	}
	for (const name of [
		"Button",
		"ColorPicker",
		"Group",
		"Label",
		"OtherItemsProxy",
		"Popover",
		"Scrubber",
		"SegmentedControl",
		"Slider",
		"Spacer",
	])
		Object.defineProperty(TouchBar, `TouchBar${name}`, {
			value: class {
				constructor(options: object = {}) {
					Object.assign(this, options);
				}
			},
		});
	return {
		autoUpdater,
		TouchBar,
		desktopCapturer: {
			getSources: async () => {
				noteStub("desktopCapturer.getSources");
				return [];
			},
		},
		inAppPurchase: withFallback(
			{
				canMakePayments: () => false,
				getProducts: async () => [],
				purchaseProduct: async () => {
					noteStub("inAppPurchase.purchaseProduct");
					return false;
				},
			},
			"inAppPurchase",
		),
		pushNotifications: createStub("pushNotifications"),
	};
}

export function virtualChild(api: string) {
	noteStub(api);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const stdin = new PassThrough();
	let finished = false;
	const child = Object.assign(new EventEmitter(), {
		pid: 0,
		stdout,
		stderr,
		stdin,
		connected: false,
		killed: false,
		exitCode: null as number | null,
		kill: () => {
			child.killed = true;
			finish();
			return true;
		},
		send: (_message: unknown, callback?: (error: Error | null) => void) => {
			callback?.(null);
			return true;
		},
		disconnect: () => child.emit("disconnect"),
		ref: () => child,
		unref: () => child,
	});
	const finish = () => {
		if (finished) return;
		finished = true;
		child.exitCode = 0;
		stdout.end();
		stderr.end();
		stdin.end();
		child.emit("exit", 0, null);
		child.emit("close", 0, null);
	};
	queueMicrotask(() => {
		child.emit("spawn");
		finish();
	});
	return child;
}

export class VirtualServer extends EventEmitter {
	listening = false;
	private port = 0;
	constructor(
		api: string,
		optionsOrListener?: object | ((...args: unknown[]) => void),
		listener?: (...args: unknown[]) => void,
	) {
		super();
		noteStub(api);
		const callback = typeof optionsOrListener === "function" ? optionsOrListener : listener;
		if (callback)
			this.on(
				api.startsWith("net.") ? "connection" : "request",
				callback as (...args: unknown[]) => void,
			);
	}
	listen(...args: unknown[]): this {
		const first = args[0];
		this.port =
			typeof first === "number"
				? first
				: first && typeof first === "object"
					? Number(Reflect.get(first, "port")) || 0
					: 0;
		const callback = args.at(-1);
		if (typeof callback === "function") this.once("listening", callback as () => void);
		queueMicrotask(() => {
			this.listening = true;
			this.emit("listening");
		});
		return this;
	}
	address(): { address: string; family: string; port: number } | null {
		return this.listening ? { address: "127.0.0.1", family: "IPv4", port: this.port } : null;
	}
	close(callback?: () => void): this {
		this.listening = false;
		queueMicrotask(() => {
			this.emit("close");
			callback?.();
		});
		return this;
	}
	getConnections(callback: (error: Error | null, count: number) => void): void {
		queueMicrotask(() => callback(null, 0));
	}
	ref(): this {
		return this;
	}
	unref(): this {
		return this;
	}
}

/** Evaluation compatibility only, not an isolated JavaScript security context.
 * `scope` supplies the calling context's Node globals (an Electron preload's
 * process/Buffer/global), which runInThisContext code can reference. */
export function vmModule(scope: Record<string, unknown> = {}) {
	const names = Object.keys(scope).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
	const contexts = new WeakSet<object>();
	const createContext = (context: Record<string, unknown> = {}) => {
		contexts.add(context);
		context.global = context;
		context.globalThis = context;
		return context;
	};
	const runInContext = (code: string, context: Record<string, unknown>) => {
		// This explicit evaluator is the implementation of the uploaded application's vm API.
		const evaluate = new Function(
			"context",
			"source",
			"with (context) { return eval(source); }",
		);
		return evaluate(context, code);
	};
	class Script {
		constructor(readonly code: string) {}
		runInContext(context: Record<string, unknown>): unknown {
			return runInContext(this.code, context);
		}
		runInNewContext(context: Record<string, unknown> = {}): unknown {
			return runInContext(this.code, createContext(context));
		}
		runInThisContext(): unknown {
			return new Function(...names, "source", "return eval(source);")(
				...names.map((name) => scope[name]),
				this.code,
			);
		}
		createCachedData(): Buffer {
			noteStub("vm.Script.createCachedData");
			return Buffer.alloc(0);
		}
	}
	return {
		Script,
		createContext,
		isContext: (value: object) => contexts.has(value),
		runInContext,
		runInNewContext: (code: string, context: Record<string, unknown> = {}) =>
			runInContext(code, createContext(context)),
		runInThisContext: (code: string) => new Script(code).runInThisContext(),
		compileFunction: (code: string, params: string[] = []) => new Function(...params, code),
	};
}
export const v8Module = {
	serialize: (value: unknown) => Buffer.from(stringify(value)),
	deserialize: (value: Uint8Array) => parse(Buffer.from(value).toString()),
	getHeapStatistics: () => ({
		total_heap_size: 0,
		used_heap_size: 0,
		heap_size_limit: 0,
		total_available_size: 0,
		external_memory: 0,
	}),
	cachedDataVersionTag: () => 0,
};
