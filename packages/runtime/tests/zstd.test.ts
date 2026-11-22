import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { zstd } from "../src/runtime/zstd";

it("reads concatenated native Zstandard frames, checks bounds and produces a native-readable stream", async () => {
	const plain = Buffer.from("text repeated for compression ".repeat(6000));
	const block = zstdCompressSync(plain);
	const two = Buffer.concat([block, block]);
	expect(zstd.zstdDecompressSync(two).equals(Buffer.concat([plain, plain]))).toBe(true);
	expect(() => zstd.zstdDecompressSync(two, { maxOutputLength: plain.length + 100 })).toThrow();
	expect(() => zstd.zstdDecompressSync(block, { params: { 100: 10 } })).toThrow(/window/);
	const compress = zstd.createZstdCompress({ params: { 100: 3, 201: 1 } });
	compress.write(plain.subarray(0, 73));
	compress.end(plain.subarray(73));
	const chunks = [];
	for await (const chunk of compress) chunks.push(chunk);
	expect(zstdDecompressSync(Buffer.concat(chunks)).equals(plain)).toBe(true);
});
