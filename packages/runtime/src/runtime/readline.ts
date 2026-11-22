import { EventEmitter } from "events";
import type { Readable, Writable } from "readable-stream";
import { noteStub } from "./fallback";
import { abortError } from "./timers";

interface Options {
	input: Readable;
	output?: Writable;
	terminal?: boolean;
	prompt?: string;
}
export class Interface extends EventEmitter implements AsyncIterable<string> {
	private buffer = "";
	private lines: string[] = [];
	private waiting: ((value: IteratorResult<string>) => void)[] = [];
	private closed = false;
	private iterating = false;
	private lastCR = false;
	private answer?: (value: string) => void;
	private cancelQuestion?: () => void;
	readonly input: Readable;
	readonly output?: Writable;
	readonly terminal: boolean;
	private promptText: string;
	line = "";
	cursor = 0;
	constructor(options: Options) {
		super();
		this.input = options.input;
		this.output = options.output;
		this.terminal = options.terminal ?? false;
		this.promptText = options.prompt || "> ";
		this.input.setEncoding("utf8");
		this.input.on("data", this.data);
		this.input.once("end", this.end);
		this.input.on("error", this.error);
	}
	private error = (error: Error) => {
		this.emit("error", error);
		this.close();
	};
	private data = (chunk: string) => {
		if (this.closed) return;
		if (this.lastCR && chunk.startsWith("\n")) chunk = chunk.slice(1);
		this.lastCR = chunk.endsWith("\r");
		this.buffer += chunk;
		const lines = this.buffer.split(/\r\n|[\r\n]/);
		this.buffer = lines.pop() || "";
		for (const line of lines) {
			if (this.closed) break;
			this.emitLine(line);
		}
		this.line = this.buffer;
		this.cursor = this.line.length;
	};
	private emitLine(value: string): void {
		if (this.answer) {
			const done = this.answer;
			this.cancelQuestion?.();
			done(value);
			return;
		}
		this.emit("line", value);
		if (this.iterating) {
			const next = this.waiting.shift();
			if (next) next({ value, done: false });
			else this.lines.push(value);
		}
	}
	private end = () => {
		if (this.buffer) this.emitLine(this.buffer);
		this.buffer = "";
		this.close();
	};
	close(): this {
		if (this.closed) return this;
		this.closed = true;
		this.cancelQuestion?.();
		this.input.off("data", this.data);
		this.input.off("end", this.end);
		this.input.off("error", this.error);
		for (const next of this.waiting.splice(0)) next({ value: undefined, done: true });
		this.emit("close");
		return this;
	}
	pause(): this {
		this.input.pause();
		this.emit("pause");
		return this;
	}
	resume(): this {
		this.input.resume();
		this.emit("resume");
		return this;
	}
	setPrompt(value: string): void {
		this.promptText = value;
	}
	getPrompt(): string {
		return this.promptText;
	}
	prompt(): void {
		this.output?.write(this.promptText);
		this.resume();
	}
	question(
		query: string,
		optionsOrCallback: { signal?: AbortSignal } | ((answer: string) => void),
		callback?: (answer: string) => void,
	): void {
		const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
		if (!done) throw new TypeError("question callback is required");
		if (this.closed)
			throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
		const signal =
			typeof optionsOrCallback === "function" ? undefined : optionsOrCallback.signal;
		if (signal?.aborted || this.answer) return;
		const cancel = () => {
			signal?.removeEventListener("abort", cancel);
			this.answer = undefined;
			this.cancelQuestion = undefined;
		};
		this.cancelQuestion = cancel;
		this.answer = done;
		signal?.addEventListener("abort", cancel, { once: true });
		this.output?.write(query);
		this.resume();
	}
	write(data: string): void {
		this.data(data);
	}
	[Symbol.asyncIterator](): AsyncIterator<string> {
		this.iterating = true;
		return {
			next: () =>
				this.lines.length
					? Promise.resolve({ value: this.lines.shift() as string, done: false })
					: this.closed
						? Promise.resolve({ value: undefined, done: true })
						: new Promise((resolve) => this.waiting.push(resolve)),
			return: async () => {
				this.close();
				return { value: undefined, done: true };
			},
		};
	}
}
export function readlineModules() {
	const createInterface = (input: Options | Readable, output?: Writable) =>
		new Interface("input" in input ? input : { input, output });
	const control = (stream: Writable, text: string, callback?: () => void) =>
		stream.write(text, callback);
	const promises = {
		createInterface: (options: Options) => {
			const result = createInterface(options);
			const question = result.question.bind(result);
			Object.assign(result, {
				question: (query: string, options: { signal?: AbortSignal } = {}) =>
					new Promise<string>((resolve, reject) => {
						const { signal } = options;
						if (signal?.aborted) {
							reject(abortError(signal));
							return;
						}
						const clean = () => {
							signal?.removeEventListener("abort", abort);
							result.off("close", close);
						};
						const abort = () => {
							clean();
							reject(abortError(signal));
						};
						const close = () => {
							clean();
							reject(
								Object.assign(new Error("readline was closed"), {
									code: "ERR_USE_AFTER_CLOSE",
								}),
							);
						};
						try {
							question(query, options, (answer) => {
								clean();
								resolve(answer);
							});
							signal?.addEventListener("abort", abort, { once: true });
							result.once("close", close);
						} catch (error) {
							clean();
							reject(error);
						}
					}),
			});
			return result as unknown as Omit<Interface, "question"> & {
				question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
			};
		},
	};
	return {
		Interface,
		createInterface,
		promises,
		cursorTo: (stream: Writable, x: number, y?: number, callback?: () => void) =>
			control(
				stream,
				y === undefined ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`,
				callback,
			),
		clearLine: (stream: Writable, direction: number, callback?: () => void) =>
			control(stream, `\x1b[${direction < 0 ? 1 : direction > 0 ? 0 : 2}K`, callback),
		clearScreenDown: (stream: Writable, callback?: () => void) =>
			control(stream, "\x1b[0J", callback),
		moveCursor: (stream: Writable, dx: number, dy: number, callback?: () => void) =>
			control(
				stream,
				`${dx ? `\x1b[${Math.abs(dx)}${dx < 0 ? "D" : "C"}` : ""}${dy ? `\x1b[${Math.abs(dy)}${dy < 0 ? "A" : "B"}` : ""}`,
				callback,
			),
		emitKeypressEvents: () => noteStub("readline.emitKeypressEvents"),
	};
}
