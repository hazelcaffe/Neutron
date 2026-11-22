import { EventEmitter } from "events";
import { AsyncResource } from "./context";
import { abortError } from "./timers";

type Target = EventEmitter | EventTarget;
type Listener = (...args: unknown[]) => void;
function listen(target: Target, name: string | symbol, callback: Listener): () => void {
	if ("on" in target) {
		target.on(name, callback);
		return () => {
			target.off(name, callback);
		};
	}
	const listener = (event: Event) => callback(event);
	target.addEventListener(String(name), listener);
	return () => target.removeEventListener(String(name), listener);
}
const once = (
	target: Target,
	name: string | symbol,
	options: { signal?: AbortSignal } = {},
): Promise<unknown[]> =>
	new Promise((resolve, reject) => {
		const { signal } = options;
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const removers: (() => void)[] = [];
		const clean = () => {
			for (const remove of removers) remove();
			signal?.removeEventListener("abort", abort);
		};
		const fail = (error: unknown) => {
			clean();
			reject(error);
		};
		const abort = () => fail(abortError(signal));
		removers.push(
			listen(target, name, (...args) => {
				clean();
				resolve(args);
			}),
		);
		if (name !== "error" && "on" in target) removers.push(listen(target, "error", fail));
		signal?.addEventListener("abort", abort, { once: true });
	});
function on(
	target: Target,
	name: string | symbol,
	options: { signal?: AbortSignal; close?: (string | symbol)[] } = {},
): AsyncIterableIterator<unknown[]> {
	const queued: unknown[][] = [];
	const waiting: {
		resolve(value: IteratorResult<unknown[]>): void;
		reject(error: unknown): void;
	}[] = [];
	const removers: (() => void)[] = [];
	let ended = false;
	let failure: unknown;
	const clean = () => {
		for (const remove of removers) remove();
		options.signal?.removeEventListener("abort", abort);
	};
	const finish = (error?: unknown) => {
		ended = true;
		failure = error;
		clean();
		for (const item of waiting.splice(0)) {
			if (error) item.reject(error);
			else item.resolve({ done: true, value: undefined });
		}
	};
	const abort = () => finish(abortError(options.signal));
	if (options.signal?.aborted) throw abortError(options.signal);
	removers.push(
		listen(target, name, (...args) => {
			const item = waiting.shift();
			if (item) item.resolve({ done: false, value: args });
			else queued.push(args);
		}),
	);
	if (name !== "error" && "on" in target) removers.push(listen(target, "error", finish));
	for (const event of options.close || []) removers.push(listen(target, event, () => finish()));
	options.signal?.addEventListener("abort", abort, { once: true });
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next: () =>
			queued.length
				? Promise.resolve({ done: false, value: queued.shift() as unknown[] })
				: failure
					? Promise.reject(failure)
					: ended
						? Promise.resolve({ done: true, value: undefined })
						: new Promise((resolve, reject) => waiting.push({ resolve, reject })),
		return: async () => {
			queued.length = 0;
			finish();
			return { done: true, value: undefined };
		},
	};
}
class EventEmitterAsyncResource extends EventEmitter {
	readonly asyncResource: AsyncResource;
	constructor(options: { name?: string } = {}) {
		super();
		this.asyncResource = new AsyncResource(options.name || "EventEmitter");
	}
	get asyncId(): number {
		return this.asyncResource.asyncId();
	}
	get triggerAsyncId(): number {
		return this.asyncResource.triggerAsyncId();
	}
	emit(name: string | symbol, ...args: unknown[]): boolean {
		return this.asyncResource.runInAsyncScope(() => super.emit(name, ...args));
	}
	emitDestroy(): void {
		this.asyncResource.emitDestroy();
	}
}
export function eventsModule() {
	// Keep the constructor callable for older util.inherits-based packages, while
	// avoiding mutation of the shared EventEmitter dependency.
	const emitter = Object.assign(function (this: EventEmitter, ...args: unknown[]) {
		Reflect.apply(EventEmitter, this, args);
	}, EventEmitter) as unknown as typeof EventEmitter;
	emitter.prototype = EventEmitter.prototype;
	return Object.assign(emitter, {
		EventEmitter: emitter,
		EventEmitterAsyncResource,
		once,
		on,
		addAbortListener: (signal: AbortSignal, listener: () => void) => {
			if (signal.aborted) queueMicrotask(listener);
			else signal.addEventListener("abort", listener, { once: true });
			return { [Symbol.dispose]: () => signal.removeEventListener("abort", listener) };
		},
		getEventListeners: (target: Target, name: string | symbol) =>
			"listeners" in target ? target.listeners(name) : [],
		getMaxListeners: (target: Target) =>
			"getMaxListeners" in target
				? target.getMaxListeners()
				: EventEmitter.defaultMaxListeners,
		setMaxListeners: (count: number, ...targets: Target[]) => {
			if (!targets.length) EventEmitter.defaultMaxListeners = count;
			for (const target of targets)
				if ("setMaxListeners" in target) target.setMaxListeners(count);
		},
		captureRejectionSymbol: Symbol.for("nodejs.rejection"),
	});
}
