import type { BrotliWasmType } from "brotli-wasm";
import { Buffer } from "buffer";
import { Transform } from "readable-stream";

type Input = string | ArrayBuffer | ArrayBufferView;
interface Options {
	params?: Record<number, number>;
	chunkSize?: number;
	maxOutputLength?: number;
}
type Callback = (err: Error | null, result?: Buffer) => void;
export const brotliConstants = {
	BROTLI_PARAM_QUALITY: 1,
	BROTLI_MIN_QUALITY: 0,
	BROTLI_MAX_QUALITY: 11,
	BROTLI_DEFAULT_QUALITY: 11,
};

function asBytes(input: Input): Uint8Array {
	if (typeof input === "string") return Buffer.from(input);
	if (ArrayBuffer.isView(input))
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	throw new TypeError("Expected a string, ArrayBuffer, or ArrayBuffer view");
}
function integer(name: string, value: number, min: number, max: number) {
	if (!Number.isInteger(value) || value < min || value > max)
		throw Object.assign(new RangeError(`Invalid ${name}: ${value}`), {
			code: "ERR_OUT_OF_RANGE",
		});
	return value;
}
function codec(encode: boolean, options: Options = {}) {
	// Lazy require: the WASM asset is loaded only on actual use in this realm.
	const binding: BrotliWasmType = require("brotli-wasm");
	const chunkSize = integer("chunkSize", options.chunkSize ?? 16384, 64, 0x7fffffff);
	const max = integer(
		"maxOutputLength",
		options.maxOutputLength ?? 0x7fffffff,
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const quality = integer(
		"quality",
		options.params?.[brotliConstants.BROTLI_PARAM_QUALITY] ?? 11,
		0,
		11,
	);
	if (Object.keys(options.params ?? {}).some((key) => key !== "1"))
		throw new Error("This Brotli backend supports the quality parameter only");
	const encoder = encode ? new binding.CompressStream(quality) : undefined;
	const decoder = encode ? undefined : new binding.DecompressStream();
	let complete = false;
	let total = 0;
	return {
		write(bytes: Uint8Array | undefined, emit: (data: Buffer) => void) {
			if (complete) return;
			if (!bytes && decoder)
				throw Object.assign(new Error("Unexpected end of Brotli stream"), {
					code: "Z_BUF_ERROR",
				});
			let pos = 0;
			while (true) {
				const input = bytes?.subarray(pos);
				const result = encoder
					? encoder.compress(input, chunkSize)
					: decoder?.decompress(input ?? new Uint8Array(0), chunkSize);
				if (!result) throw new Error("Brotli codec unavailable");
				try {
					pos += result.input_offset;
					const data = result.buf;
					total += data.length;
					if (total > max)
						throw Object.assign(
							new RangeError("Brotli output exceeds maxOutputLength"),
							{ code: "ERR_BUFFER_TOO_LARGE" },
						);
					if (data.length) emit(Buffer.from(data));
					if (result.code === binding.BrotliStreamResultCode.ResultSuccess) {
						complete = true;
						break;
					}
					if (
						result.code === binding.BrotliStreamResultCode.NeedsMoreInput &&
						bytes &&
						pos === bytes.length
					)
						break;
					if (!data.length && !result.input_offset)
						throw new Error("Brotli codec made no progress");
				} finally {
					result.free();
				}
			}
		},
		free() {
			encoder?.free();
			decoder?.free();
		},
	};
}
function oneShot(encode: boolean, input: Input, options?: Options): Buffer {
	const bytes = asBytes(input),
		parts: Buffer[] = [];
	const state = codec(encode, options);
	try {
		state.write(bytes, (data) => parts.push(data));
		state.write(undefined, (data) => parts.push(data));
		return Buffer.concat(parts);
	} finally {
		state.free();
	}
}
function asyncMethod(encode: boolean) {
	return (input: Input, options: Options | Callback, callback?: Callback) => {
		const done = typeof options === "function" ? options : callback;
		if (typeof done !== "function") throw new TypeError("Expected a callback");
		queueMicrotask(() => {
			let result: Buffer;
			try {
				result = oneShot(
					encode,
					input,
					typeof options === "function" ? undefined : options,
				);
			} catch (error) {
				done(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			done(null, result);
		});
	};
}
class BrotliTransform extends Transform {
	private codec: ReturnType<typeof codec>;
	constructor(encode: boolean, options?: Options) {
		super();
		this.codec = codec(encode, options);
	}
	_transform(chunk: Buffer, _encoding: string, done: (error?: Error) => void): void {
		try {
			this.codec.write(chunk, (data) => this.push(data));
		} catch (error) {
			done(error as Error);
			return;
		}
		done();
	}
	_flush(done: (error?: Error) => void): void {
		try {
			this.codec.write(undefined, (data) => this.push(data));
		} catch (error) {
			done(error as Error);
			return;
		}
		done();
	}
	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this.codec.free();
		callback(error);
	}
}
class BrotliCompress extends BrotliTransform {
	constructor(options?: Options) {
		super(true, options);
	}
}
class BrotliDecompress extends BrotliTransform {
	constructor(options?: Options) {
		super(false, options);
	}
}
export const brotli = {
	brotliCompressSync: (input: Input, options?: Options) => oneShot(true, input, options),
	brotliDecompressSync: (input: Input, options?: Options) => oneShot(false, input, options),
	brotliCompress: asyncMethod(true),
	brotliDecompress: asyncMethod(false),
	BrotliCompress,
	BrotliDecompress,
	createBrotliCompress: (options?: Options) => new BrotliCompress(options),
	createBrotliDecompress: (options?: Options) => new BrotliDecompress(options),
};
