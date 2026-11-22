import * as buffer from "buffer";

let installed = false;
export function bufferModule() {
	const { Buffer } = buffer;
	if (!installed && !Buffer.isEncoding("base64url")) {
		installed = true;
		// buffer@6 predates Node's URL-safe encoding. Its base64 decoder already
		// accepts '-' and '_'; normalize encoding names without changing byte views.
		const isEncoding = Buffer.isEncoding;
		Buffer.isEncoding = (value: string): value is BufferEncoding =>
			(typeof value === "string" && value.toLowerCase() === "base64url") || isEncoding(value);
		for (const key of ["from", "byteLength"] as const) {
			const method = Buffer[key];
			Reflect.set(Buffer, key, (...args: unknown[]) => {
				if (typeof args[1] === "string" && args[1].toLowerCase() === "base64url")
					args[1] = "base64";
				return Reflect.apply(method, Buffer, args);
			});
		}
		for (const key of ["write", "fill"] as const) {
			const method = Buffer.prototype[key];
			Reflect.set(Buffer.prototype, key, function (this: buffer.Buffer, ...args: unknown[]) {
				for (let index = 1; index < args.length; index++) {
					const value = args[index];
					if (typeof value === "string" && value.toLowerCase() === "base64url")
						args[index] = "base64";
				}
				return Reflect.apply(method, this, args);
			});
		}
		const encode = Buffer.prototype.toString;
		Buffer.prototype.toString = function (
			encoding?: BufferEncoding,
			start?: number,
			end?: number,
		): string {
			if (encoding?.toLowerCase() !== "base64url")
				return encode.call(this, encoding, start, end);
			return encode
				.call(this, "base64", start, end)
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, "");
		};
	}
	return {
		...buffer,
		Blob: globalThis.Blob,
		File: globalThis.File,
		atob: globalThis.atob,
		btoa: globalThis.btoa,
		isUtf8: (value: Uint8Array) => {
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(value);
				return true;
			} catch {
				return false;
			}
		},
		isAscii: (value: Uint8Array) => value.every((byte) => byte < 128),
		constants: { MAX_LENGTH: buffer.kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 },
	};
}
