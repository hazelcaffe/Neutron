const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

export class Timeout {
	private id: ReturnType<typeof setTimeout>;
	private referenced = true;
	constructor(
		private callback: (...args: unknown[]) => void,
		private delay: number,
		private args: unknown[],
		private interval = false,
	) {
		this.id = (interval ? nativeSetInterval : nativeSetTimeout)(callback, delay, ...args);
	}
	ref(): this {
		this.referenced = true;
		return this;
	}
	unref(): this {
		this.referenced = false;
		return this;
	}
	hasRef(): boolean {
		return this.referenced;
	}
	refresh(): this {
		this.close();
		this.id = (this.interval ? nativeSetInterval : nativeSetTimeout)(
			this.callback,
			this.delay,
			...this.args,
		);
		return this;
	}
	close(): this {
		nativeClearTimeout(this.id);
		nativeClearInterval(this.id);
		return this;
	}
	[Symbol.toPrimitive](): number {
		return Number(this.id);
	}
	[Symbol.dispose](): void {
		this.close();
	}
}
const clear = (timer?: Timeout | number) => {
	if (timer instanceof Timeout) timer.close();
	else nativeClearTimeout(timer);
};
export const nodeTimers = {
	setTimeout: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) =>
		new Timeout(callback, delay, args),
	setInterval: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) =>
		new Timeout(callback, delay, args, true),
	setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
		new Timeout(callback, 0, args),
	clearTimeout: clear,
	clearInterval: clear,
	clearImmediate: clear,
};

export function abortError(signal?: AbortSignal): Error {
	return Object.assign(new Error("The operation was aborted", { cause: signal?.reason }), {
		name: "AbortError",
		code: "ABORT_ERR",
	});
}
interface TimerOptions {
	signal?: AbortSignal;
	ref?: boolean;
}
const delay = <T>(ms = 1, value?: T, options: TimerOptions = {}): Promise<T | undefined> =>
	new Promise((resolve, reject) => {
		const { signal } = options;
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const abort = () => {
			nativeClearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = nativeSetTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve(value);
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
export const timerPromises = {
	setTimeout: delay,
	setImmediate: <T>(value?: T, options?: TimerOptions) => delay(0, value, options),
	async *setInterval<T>(ms = 1, value?: T, options: TimerOptions = {}) {
		const { signal } = options;
		if (signal?.aborted) throw abortError(signal);
		let ticks = 0;
		let wake: (() => void) | undefined;
		const abort = () => wake?.();
		const timer = nativeSetInterval(() => {
			ticks++;
			wake?.();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			while (true) {
				if (!ticks && !signal?.aborted)
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				wake = undefined;
				if (signal?.aborted) throw abortError(signal);
				ticks--;
				yield value;
			}
		} finally {
			nativeClearInterval(timer);
			signal?.removeEventListener("abort", abort);
		}
	},
	scheduler: {
		wait: (ms: number, options?: TimerOptions) => delay(ms, undefined, options),
		yield: () => delay(0),
	},
};
