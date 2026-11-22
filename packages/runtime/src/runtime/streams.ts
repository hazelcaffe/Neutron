import { Buffer } from "buffer";
import {
	Duplex,
	finished,
	pipeline,
	Readable,
	type ReadableOptions,
	Writable,
	type WritableOptions,
} from "readable-stream";

/** readable-stream's browser build exposes the statics, but lacks the native
 * adapters behind them. Keep the original constructors for instanceof checks. */
export function installWebStreamAdapters(): void {
	Object.assign(Readable, { fromWeb: fromWebReadable, toWeb: toWebReadable });
	Object.assign(Writable, { fromWeb: fromWebWritable, toWeb: toWebWritable });
	Object.assign(Duplex, {
		fromWeb: (pair: ReadableWritablePair, options?: ReadableOptions & WritableOptions) =>
			Duplex.from({
				readable: fromWebReadable(pair.readable, options),
				writable: fromWebWritable(pair.writable, options),
			}),
		toWeb: (duplex: Duplex) => ({
			readable: toWebReadable(duplex),
			writable: toWebWritable(duplex),
		}),
	});
}
function fromWebReadable(source: ReadableStream, options: ReadableOptions = {}): Readable {
	const reader = source.getReader();
	let ended = false;
	return new Readable({
		...options,
		read() {
			void reader
				.read()
				.then(({ done, value }) => {
					if ((this as Readable).destroyed) return;
					if (done) {
						ended = true;
						reader.releaseLock();
						this.push(null);
					} else this.push(value);
				})
				.catch((error) => this.destroy(error));
		},
		destroy(error, callback) {
			if (ended) {
				callback(error);
				return;
			}
			void reader.cancel(error).then(
				() => {
					reader.releaseLock();
					callback(error);
				},
				(reason) => {
					reader.releaseLock();
					callback(error || reason);
				},
			);
		},
	});
}
function fromWebWritable(destination: WritableStream, options: WritableOptions = {}): Writable {
	const writer = destination.getWriter();
	let ended = false;
	const stream = new Writable({
		...options,
		write(chunk, _encoding, done) {
			void writer.write(chunk).then(() => done(), done);
		},
		final(done) {
			void writer.close().then(() => {
				ended = true;
				writer.releaseLock();
				done();
			}, done);
		},
		destroy(error, done) {
			if (ended) {
				done(error);
				return;
			}
			void writer.abort(error).then(
				() => {
					writer.releaseLock();
					done(error);
				},
				(reason) => {
					writer.releaseLock();
					done(error || reason);
				},
			);
		},
	});
	void writer.closed.catch((error) => {
		if (!ended) stream.destroy(error);
	});
	return stream;
}
function toWebReadable(source: Readable, options?: { strategy?: QueuingStrategy }): ReadableStream {
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream(
		{
			async pull(controller) {
				const { done, value } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			async cancel() {
				source.destroy();
				await iterator.return?.();
			},
		},
		options?.strategy,
	);
}
function toWebWritable(destination: Writable): WritableStream {
	return new WritableStream({
		start(controller) {
			destination.once("error", (error) => controller.error(error));
		},
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				destination.write(chunk, (error) => (error ? reject(error) : resolve()));
			});
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				destination.once("error", reject);
				destination.end(() => {
					destination.removeListener("error", reject);
					resolve();
				});
			});
		},
		abort(reason) {
			destination.destroy(reason instanceof Error ? reason : undefined);
		},
	});
}

type Source =
	| AsyncIterable<Uint8Array | string>
	| Iterable<Uint8Array | string>
	| ReadableStream<Uint8Array | string>;
async function* chunks(source: Source): AsyncGenerator<Uint8Array | string> {
	if ("getReader" in source) {
		const reader = source.getReader();
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) return;
				yield next.value;
			}
		} finally {
			reader.releaseLock();
		}
	} else yield* source;
}
const buffer = async (source: Source): Promise<Buffer> => {
	const parts: Buffer[] = [];
	for await (const part of chunks(source)) parts.push(Buffer.from(part));
	return Buffer.concat(parts);
};
export const consumers = {
	buffer,
	arrayBuffer: async (source: Source) => new Uint8Array(await buffer(source)).buffer,
	text: async (source: Source) => new TextDecoder().decode(await buffer(source)),
	json: async (source: Source): Promise<unknown> => JSON.parse(await consumers.text(source)),
	blob: async (source: Source) => new Blob([new Uint8Array(await buffer(source))]),
};
export const streamPromises = {
	pipeline: (...args: unknown[]) =>
		new Promise((resolve, reject) => {
			Reflect.apply(pipeline, undefined, [
				...args,
				(error?: Error | null, value?: unknown) => (error ? reject(error) : resolve(value)),
			]);
		}),
	finished: (
		source: Parameters<typeof finished>[0],
		options: {
			readable?: boolean;
			writable?: boolean;
			error?: boolean;
			cleanup?: boolean;
		} = {},
	) =>
		new Promise<void>((resolve, reject) => {
			const cleanup = finished(source, options, (error) => {
				if (options.cleanup) cleanup();
				if (error) reject(error);
				else resolve();
			});
		}),
};
export function webStreams(): Record<string, unknown> {
	return Object.fromEntries(
		[
			"ReadableStream",
			"ReadableStreamDefaultReader",
			"ReadableStreamBYOBReader",
			"ReadableStreamDefaultController",
			"ReadableByteStreamController",
			"ReadableStreamBYOBRequest",
			"WritableStream",
			"WritableStreamDefaultWriter",
			"WritableStreamDefaultController",
			"TransformStream",
			"TransformStreamDefaultController",
			"ByteLengthQueuingStrategy",
			"CountQueuingStrategy",
			"TextEncoderStream",
			"TextDecoderStream",
			"CompressionStream",
			"DecompressionStream",
		].map((name) => [name, Reflect.get(globalThis, name)]),
	);
}
