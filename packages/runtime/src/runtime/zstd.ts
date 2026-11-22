import { Buffer } from "buffer";
import { Transform } from "readable-stream";
import { compress } from "zstdify/compress";
import { decompress } from "zstdify/decompress";

export const zstdConstants = {
	ZSTD_c_compressionLevel: 100,
	ZSTD_c_checksumFlag: 201,
	ZSTD_d_windowLogMax: 100,
};
type Input = string | ArrayBuffer | ArrayBufferView;
interface Options {
	params?: Record<number, number>;
	maxOutputLength?: number;
}
const budget = 256 * 1024 * 1024;
function buffer(input: Input) {
	if (typeof input === "string") return Buffer.from(input);
	if (ArrayBuffer.isView(input))
		return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	return Buffer.from(input);
}
function limit(value: number) {
	if (!Number.isSafeInteger(value) || value < 1 || value > budget)
		throw new RangeError("Zstandard output limit outside the runtime memory budget");
	return value;
}
// Check the declared history window before giving a frame to the decoder.
// Walk block extents to enforce this for concatenated and skippable frames too.
function validateWindows(data: Buffer, windowLog: number): void {
	if (!Number.isInteger(windowLog) || windowLog < 10 || windowLog > 31)
		throw new RangeError("Invalid ZSTD_d_windowLogMax");
	let p = 0;
	const take = (n: number) => {
		const start = p;
		p += n;
		if (p > data.length) throw new Error("Truncated Zstandard frame");
		return start;
	};
	while (p < data.length) {
		const magic = data.readUInt32LE(take(4));
		if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
			take(data.readUInt32LE(take(4)));
			continue;
		}
		if (magic !== 0xfd2fb528) throw new Error("Invalid Zstandard frame");
		const flags = data.readUInt8(take(1)),
			single = !!(flags & 32);
		let size = 0;
		if (!single) {
			const wd = data.readUInt8(take(1));
			size = 2 ** (10 + (wd >>> 3)) * (1 + (wd & 7) / 8);
		}
		take([0, 1, 2, 4][flags & 3] ?? 0);
		const length = [single ? 1 : 0, 2, 4, 8][flags >>> 6] ?? 0;
		const fcs = take(length);
		if (single)
			size =
				length === 8
					? Number(data.readBigUInt64LE(fcs))
					: data.readUIntLE(fcs, length) + (length === 2 ? 256 : 0);
		if (size > Math.min(budget, 2 ** windowLog))
			throw new RangeError("Zstandard window exceeds configured limit");
		let block: number;
		do {
			block = data.readUIntLE(take(3), 3);
			const type = (block >>> 1) & 3;
			if (type === 3) throw new Error("Invalid Zstandard block type");
			take(type === 1 ? 1 : block >>> 3);
		} while (!(block & 1));
		if (flags & 4) take(4);
	}
}
function convert(encode: boolean, input: Input, options: Options = {}): Buffer {
	const data = buffer(input),
		maxSize = limit(options.maxOutputLength ?? budget);
	if (data.length > budget)
		throw new RangeError("Zstandard input exceeds the runtime memory budget");
	const params = options.params ?? {};
	if (Object.keys(params).some((key) => key !== "100" && !(encode && key === "201")))
		throw new Error("Unsupported Zstandard parameter");
	if (!encode) validateWindows(data, params[100] || 27);
	const bytes = encode
		? compress(data, { level: params[100] ?? 3, checksum: !!params[201] })
		: decompress(data, { maxSize });
	if (bytes.length > maxSize) throw new RangeError("Zstandard output exceeds configured limit");
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
type Callback = (error: Error | null, value?: Buffer) => void;
function callbackMethod(encode: boolean) {
	return (input: Input, options: Options | Callback, callback?: Callback) => {
		const cb = typeof options === "function" ? options : callback;
		if (typeof cb !== "function") throw new TypeError("Expected a callback");
		queueMicrotask(() => {
			let data: Buffer;
			try {
				data = convert(encode, input, typeof options === "function" ? {} : options);
			} catch (error) {
				cb(error as Error);
				return;
			}
			cb(null, data);
		});
	};
}
// The JS codec operates on complete frames; collect bounded input, rather
// than decompressing individual transport chunks as separate frames.
class ZstdTransform extends Transform {
	private parts: Buffer[] = [];
	private length = 0;
	constructor(
		private encode: boolean,
		private options: Options = {},
	) {
		super();
	}
	_transform(chunk: Buffer, _encoding: string, callback: (err?: Error) => void): void {
		this.length += chunk.length;
		if (this.length > budget) {
			callback(new RangeError("Zstandard input exceeds the runtime memory budget"));
			return;
		}
		this.parts.push(Buffer.from(chunk));
		callback();
	}
	_flush(callback: (err?: Error) => void): void {
		try {
			this.push(convert(this.encode, Buffer.concat(this.parts, this.length), this.options));
		} catch (error) {
			callback(error as Error);
			return;
		} finally {
			this.parts = [];
		}
		callback();
	}
}
class ZstdCompress extends ZstdTransform {
	constructor(options?: Options) {
		super(true, options);
	}
}
class ZstdDecompress extends ZstdTransform {
	constructor(options?: Options) {
		super(false, options);
	}
}
export const zstd = {
	zstdCompressSync: (input: Input, options?: Options) => convert(true, input, options),
	zstdDecompressSync: (input: Input, options?: Options) => convert(false, input, options),
	zstdCompress: callbackMethod(true),
	zstdDecompress: callbackMethod(false),
	ZstdCompress,
	ZstdDecompress,
	createZstdCompress: (options?: Options) => new ZstdCompress(options),
	createZstdDecompress: (options?: Options) => new ZstdDecompress(options),
};
