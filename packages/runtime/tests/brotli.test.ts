import { promisify } from "node:util";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { Readable } from "readable-stream";
import { expect, it } from "vitest";
import { brotli } from "../src/runtime/brotli";

it("interoperates with Node's Brotli streams and enforces decompressed output limits", async () => {
	const text = Buffer.from("hello, 你好 ♪\n".repeat(8192));
	const native = brotliCompressSync(text);
	expect(brotli.brotliDecompressSync(native, { chunkSize: 128 }).equals(text)).toBe(true);
	expect(() => brotli.brotliDecompressSync(native, { maxOutputLength: 4096 })).toThrow(
		/maxOutputLength/,
	);
	expect(() => brotli.brotliDecompressSync(native.subarray(0, -1))).toThrow(/end of Brotli/);
	const stream = Readable.from([text.subarray(0, 71), text.subarray(71)]).pipe(
		brotli.createBrotliCompress({ params: { 1: 3 } }),
	);
	const parts = [];
	for await (const chunk of stream) parts.push(chunk);
	expect(brotliDecompressSync(Buffer.concat(parts)).equals(text)).toBe(true);
	expect(await promisify(brotli.brotliDecompress)(native)).toEqual(text);
});
