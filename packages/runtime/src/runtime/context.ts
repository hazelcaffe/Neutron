import { EventEmitter } from "events";

// Browser fallback: explicit run/bind/snapshot scopes work. Automatic propagation
// across arbitrary native Promise chains is not claimed without AsyncContext.
const stores = new Set<AsyncLocalStorage<unknown>>();
let nextResource = 1;
let currentResource = 0;
export class AsyncLocalStorage<T> {
	private store?: T;
	constructor() {
		stores.add(this as AsyncLocalStorage<unknown>);
	}
	getStore(): T | undefined {
		return this.store;
	}
	enterWith(store: T): void {
		stores.add(this as AsyncLocalStorage<unknown>);
		this.store = store;
	}
	run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
		stores.add(this as AsyncLocalStorage<unknown>);
		const previous = this.store;
		this.store = store;
		try {
			return callback(...args);
		} finally {
			this.store = previous;
		}
	}
	exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
		const previous = this.store;
		this.store = undefined;
		try {
			return callback(...args);
		} finally {
			this.store = previous;
		}
	}
	disable(): void {
		this.store = undefined;
		stores.delete(this as AsyncLocalStorage<unknown>);
	}
	static snapshot(): <R>(callback: (...args: unknown[]) => R, ...args: unknown[]) => R {
		const captured = [...stores].map((store) => [store, store.store] as const);
		return <R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R => {
			const scope = new Map(captured);
			const previous = [...stores].map((store) => [store, store.store] as const);
			for (const [store] of previous) store.store = scope.get(store);
			try {
				return callback(...args);
			} finally {
				for (const [store, value] of previous) store.store = value;
			}
		};
	}
	static bind<T extends (...args: unknown[]) => unknown>(callback: T): T {
		const run = AsyncLocalStorage.snapshot();
		return function (this: unknown, ...args: unknown[]) {
			return run(() => callback.apply(this, args));
		} as T;
	}
}
export class AsyncResource {
	private id = nextResource++;
	private trigger = currentResource;
	private scope = AsyncLocalStorage.snapshot();
	constructor(
		readonly type: string,
		_options?: unknown,
	) {}
	asyncId(): number {
		return this.id;
	}
	triggerAsyncId(): number {
		return this.trigger;
	}
	runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
		const previous = currentResource;
		currentResource = this.id;
		try {
			return this.scope(() => fn.apply(thisArg, args));
		} finally {
			currentResource = previous;
		}
	}
	emitDestroy(): this {
		return this;
	}
	bind<T extends (...args: unknown[]) => unknown>(fn: T, thisArg?: unknown): T {
		return ((...args: unknown[]) => this.runInAsyncScope(fn, thisArg, ...args)) as T;
	}
	static bind<T extends (...args: unknown[]) => unknown>(
		fn: T,
		type = "bound",
		thisArg?: unknown,
	): T {
		return new AsyncResource(type).bind(fn, thisArg);
	}
}
export const asyncHooks = {
	AsyncLocalStorage,
	AsyncResource,
	executionAsyncId: () => currentResource,
	triggerAsyncId: () => 0,
	executionAsyncResource: () => ({}),
	createHook: () => {
		const hook = { enable: () => hook, disable: () => hook };
		return hook;
	},
};

class Channel {
	private subscribers = new Set<(message: unknown, name: string | symbol) => void>();
	private stores = new Map<AsyncLocalStorage<unknown>, (message: unknown) => unknown>();
	constructor(readonly name: string | symbol) {}
	get hasSubscribers(): boolean {
		return this.subscribers.size > 0;
	}
	subscribe(callback: (message: unknown, name: string | symbol) => void): void {
		this.subscribers.add(callback);
	}
	unsubscribe(callback: (message: unknown, name: string | symbol) => void): boolean {
		return this.subscribers.delete(callback);
	}
	publish(message: unknown): void {
		for (const listener of this.subscribers) listener(message, this.name);
	}
	bindStore(store: AsyncLocalStorage<unknown>, transform = (value: unknown) => value): void {
		this.stores.set(store, transform);
	}
	unbindStore(store: AsyncLocalStorage<unknown>): boolean {
		return this.stores.delete(store);
	}
	runStores<R>(
		message: unknown,
		fn: (...args: unknown[]) => R,
		thisArg?: unknown,
		...args: unknown[]
	): R {
		const entries = [...this.stores];
		const run = (index: number): R => {
			const item = entries[index];
			return item
				? item[0].run(item[1](message), () => run(index + 1))
				: fn.apply(thisArg, args);
		};
		return run(0);
	}
}
const channels = new Map<string | symbol, Channel>();
const channel = (name: string | symbol): Channel => {
	let value = channels.get(name);
	if (!value) {
		value = new Channel(name);
		channels.set(name, value);
	}
	return value;
};
export const diagnostics = {
	Channel,
	channel,
	hasSubscribers: (name: string | symbol) => channel(name).hasSubscribers,
	subscribe: (name: string | symbol, callback: Parameters<Channel["subscribe"]>[0]) =>
		channel(name).subscribe(callback),
	unsubscribe: (name: string | symbol, callback: Parameters<Channel["subscribe"]>[0]) =>
		channel(name).unsubscribe(callback),
	tracingChannel: (name: string) => {
		const events = Object.fromEntries(
			["start", "end", "asyncStart", "asyncEnd", "error"].map((event) => [
				event,
				channel(`tracing:${name}:${event}`),
			]),
		) as Record<"start" | "end" | "asyncStart" | "asyncEnd" | "error", Channel>;
		const traceSync = <R>(
			fn: (...args: unknown[]) => R,
			context: Record<string, unknown> = {},
			thisArg?: unknown,
			...args: unknown[]
		): R => {
			events.start.publish(context);
			try {
				const result = fn.apply(thisArg, args);
				context.result = result;
				return result;
			} catch (error) {
				context.error = error;
				events.error.publish(context);
				throw error;
			} finally {
				events.end.publish(context);
			}
		};
		return {
			...events,
			subscribe: (listeners: Record<string, Parameters<Channel["subscribe"]>[0]>) => {
				for (const [key, listener] of Object.entries(listeners))
					Reflect.get(events, key)?.subscribe(listener);
			},
			unsubscribe: (listeners: Record<string, Parameters<Channel["subscribe"]>[0]>) => {
				for (const [key, listener] of Object.entries(listeners))
					Reflect.get(events, key)?.unsubscribe(listener);
			},
			traceSync,
			tracePromise: async (
				fn: (...args: unknown[]) => unknown,
				context: Record<string, unknown> = {},
				thisArg?: unknown,
				...args: unknown[]
			) => {
				const result = traceSync(fn, context, thisArg, ...args);
				events.asyncStart.publish(context);
				try {
					context.result = await result;
					return context.result;
				} catch (error) {
					context.error = error;
					events.error.publish(context);
					throw error;
				} finally {
					events.asyncEnd.publish(context);
				}
			},
		};
	},
};

export class Domain extends EventEmitter {
	members: EventEmitter[] = [];
	private errors = new Map<EventEmitter, (error: unknown) => void>();
	run<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R | undefined {
		try {
			return fn(...args);
		} catch (error) {
			this.emit("error", error);
		}
	}
	bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
		return ((...args: unknown[]) => this.run(fn, ...args)) as T;
	}
	intercept(fn: (...args: unknown[]) => unknown) {
		return (error: unknown, ...args: unknown[]) =>
			error ? this.emit("error", error) : this.run(fn, ...args);
	}
	add(emitter: EventEmitter): void {
		if (this.errors.has(emitter)) return;
		const listener = (error: unknown) => this.emit("error", error);
		this.errors.set(emitter, listener);
		this.members.push(emitter);
		emitter.on("error", listener);
	}
	remove(emitter: EventEmitter): void {
		const listener = this.errors.get(emitter);
		if (listener) emitter.off("error", listener);
		this.errors.delete(emitter);
		this.members = this.members.filter((item) => item !== emitter);
	}
	enter(): void {}
	exit(): void {}
	dispose(): void {
		for (const member of [...this.members]) this.remove(member);
		this.removeAllListeners();
	}
}
export const domains = {
	Domain,
	create: () => new Domain(),
	createDomain: () => new Domain(),
	active: null,
};
