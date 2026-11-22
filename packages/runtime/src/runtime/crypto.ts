// Node crypto functions that crypto-browserify lacks.

function bytes(value: unknown, name: string): Uint8Array {
	if (ArrayBuffer.isView(value))
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	const tag = Object.prototype.toString.call(value);
	if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]")
		return new Uint8Array(value as ArrayBufferLike);
	throw Object.assign(
		new TypeError(
			`The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`,
		),
		{ code: "ERR_INVALID_ARG_TYPE" },
	);
}

/** Compares two equal-length buffers in time independent of their contents. */
export function timingSafeEqual(a: unknown, b: unknown): boolean {
	const left = bytes(a, "buf1");
	const right = bytes(b, "buf2");
	if (left.byteLength !== right.byteLength)
		throw Object.assign(new RangeError("Input buffers must have the same byte length"), {
			code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
		});
	let difference = 0;
	for (let index = 0; index < left.byteLength; index++)
		difference |= (left[index] as number) ^ (right[index] as number);
	return difference === 0;
}
