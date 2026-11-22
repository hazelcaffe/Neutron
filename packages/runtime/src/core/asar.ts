import type { Snapshot } from "../shared/types";

interface AsarNode {
	files?: Record<string, AsarNode>;
	size?: number;
	offset?: string;
	link?: string;
	unpacked?: boolean;
	integrity?: { algorithm?: string; hash?: string };
}
export interface ParsedAsar {
	snapshot: Snapshot;
	unpacked: string[];
	fileCount: number;
}

/** Chromium Pickle: size pickle (8 bytes), header pickle, then raw file bytes. */
export function parseAsar(bytes: Uint8Array, mount = "/app"): ParsedAsar {
	if (bytes.byteLength < 16) throw new Error("Invalid ASAR: truncated Pickle header.");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerSize = view.getUint32(4, true);
	const jsonSize = view.getUint32(12, true);
	if (
		view.getUint32(0, true) !== 4 ||
		headerSize < 8 ||
		headerSize > 64 * 1024 * 1024 ||
		8 + headerSize > bytes.length ||
		jsonSize > headerSize - 8 ||
		view.getUint32(8, true) + 4 !== headerSize
	) {
		throw new Error("Invalid ASAR: malformed header lengths.");
	}
	const header: AsarNode = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(16, 16 + jsonSize)),
	);
	if (!header.files || typeof header.files !== "object")
		throw new Error("Invalid ASAR: missing file tree.");
	const snapshot: Snapshot = { [mount]: { kind: "directory" } };
	const unpacked: string[] = [];
	let fileCount = 0;
	const walk = (node: AsarNode, prefix: string, depth: number): void => {
		if (depth > 128) throw new Error("ASAR directory nesting exceeds 128 levels.");
		for (const [name, child] of Object.entries(node.files || {})) {
			if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
				throw new Error(`Invalid ASAR filename: ${name}`);
			const path = `${prefix}/${name}`;
			if (++fileCount > 250_000) throw new Error("ASAR has more than 250,000 entries.");
			if (child.files) {
				snapshot[path] = { kind: "directory" };
				walk(child, path, depth + 1);
			} else if (typeof child.link === "string") {
				if (
					child.link.startsWith("/") ||
					child.link.split(/[\\/]/).includes("..") ||
					child.link.includes("\0")
				)
					throw new Error(`Invalid ASAR link: ${path}`);
				snapshot[path] = { kind: "symlink", target: `${mount}/${child.link}` };
			} else if (child.unpacked) {
				unpacked.push(path);
			} else if (
				Number.isSafeInteger(child.size) &&
				typeof child.size === "number" &&
				child.size < 0 &&
				child.offset === "0" &&
				child.integrity?.algorithm === "SHA256" &&
				child.integrity.hash ===
					"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
			) {
				// A negative extent cannot address data. Accept an empty entry only
				// when its zero offset and independent content digest agree.
				snapshot[path] = { kind: "file", data: new Uint8Array() };
			} else {
				const offset = Number(child.offset);
				const size = child.size;
				if (
					!Number.isSafeInteger(offset) ||
					offset < 0 ||
					typeof size !== "number" ||
					!Number.isSafeInteger(size) ||
					size < 0 ||
					offset + size > bytes.length - (8 + headerSize)
				) {
					throw new Error(`Invalid ASAR file extent: ${path}`);
				}
				// ASAR entries are independent offset/size references. Optimized archives
				// (including Postman) can share or overlap payload ranges; Electron reads
				// each entry's slice without requiring exclusive ownership of the bytes.
				snapshot[path] = {
					kind: "file",
					data: new Uint8Array(
						bytes.subarray(8 + headerSize + offset, 8 + headerSize + offset + size),
					),
				};
			}
		}
	};
	walk(header, mount, 0);
	return { snapshot, unpacked, fileCount };
}

/** Also used for the downloadable demo: emits real Electron-compatible ASAR bytes. */
export function createAsar(files: Record<string, string | Uint8Array>): Uint8Array {
	const root: AsarNode = { files: {} };
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (const [path, value] of Object.entries(files)) {
		const parts = path.split("/");
		const name = parts.pop();
		if (!name) throw new Error("Empty archive filename");
		let node = root;
		for (const part of parts) {
			node.files ??= {};
			node.files[part] ??= { files: {} };
			node = node.files[part];
		}
		const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
		node.files ??= {};
		node.files[name] = { size: data.length, offset: String(offset) };
		chunks.push(data);
		offset += data.length;
	}
	const json = new TextEncoder().encode(JSON.stringify(root));
	const payloadSize = (4 + json.length + 3) & ~3;
	const headerSize = 4 + payloadSize;
	const result = new Uint8Array(8 + headerSize + offset);
	const view = new DataView(result.buffer);
	view.setUint32(0, 4, true);
	view.setUint32(4, headerSize, true);
	view.setUint32(8, payloadSize, true);
	view.setUint32(12, json.length, true);
	result.set(json, 16);
	let position = 8 + headerSize;
	for (const chunk of chunks) {
		result.set(chunk, position);
		position += chunk.length;
	}
	return result;
}
