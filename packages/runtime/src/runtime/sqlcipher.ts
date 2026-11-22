import { Buffer } from "buffer";
import path from "path-browserify";
import type { VirtualFileSystem } from "./filesystem";

/**
 * `@signalapp/sqlcipher` native-addon emulation backed by SQLite3 Multiple
 * Ciphers compiled to WebAssembly (@journeyapps/wa-sqlite, MIT). Databases are
 * encrypted with SQLCipher 4 parameters, so files are interchangeable with the
 * native addon. Pages are stored in the worker's virtual filesystem and are
 * published to other contexts only at transaction boundaries.
 */
interface WasmModule {
	HEAPU8: Uint8Array;
	HEAP32: Int32Array;
	UTF8ToString(pointer: number, maxBytes?: number): string;
	addFunction(fn: (...args: number[]) => number | undefined, signature: string): number;
	vfs_register(vfs: object, makeDefault: number): number;
	_getTempRet0(): number;
	_malloc(size: number): number;
	_free(pointer: number): void;
	[name: `_sqlite3${string}`]: (...args: number[]) => number;
}
type Factory = (options: Record<string, unknown>) => Promise<WasmModule>;

const SQLITE_OK = 0;
const SQLITE_BUSY = 5;
const SQLITE_NOTFOUND = 12;
const SQLITE_CANTOPEN = 14;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_IOERR_SHMMAP = 5386;
const OPEN_CREATE = 0x4;
const OPEN_DELETEONCLOSE = 0x8;
const OPEN_MAIN_DB = 0x100;
const LOCK_SHARED = 1;
const LOCK_RESERVED = 2;
const LOCK_PENDING = 3;
const LOCK_EXCLUSIVE = 4;
const TRANSIENT = -1;
const VFS_NAME = "neutron";
const CIPHER_VFS = `multipleciphers-${VFS_NAME}`;

const PRIMARY = [
	"OK",
	"ERROR",
	"INTERNAL",
	"PERM",
	"ABORT",
	"BUSY",
	"LOCKED",
	"NOMEM",
	"READONLY",
	"INTERRUPT",
	"IOERR",
	"CORRUPT",
	"NOTFOUND",
	"FULL",
	"CANTOPEN",
	"PROTOCOL",
	"EMPTY",
	"SCHEMA",
	"TOOBIG",
	"CONSTRAINT",
	"MISMATCH",
	"MISUSE",
	"NOLFS",
	"AUTH",
	"FORMAT",
	"RANGE",
	"NOTADB",
	"NOTICE",
	"WARNING",
];
// Extended result codes are (primary | n << 8), listed in sqlite3.h order.
const EXTENDED: Record<string, string[]> = {
	OK: ["", "LOAD_PERMANENTLY", "SYMLINK"],
	ERROR: ["", "MISSING_COLLSEQ", "RETRY", "SNAPSHOT"],
	IOERR: [
		"",
		"READ",
		"SHORT_READ",
		"WRITE",
		"FSYNC",
		"DIR_FSYNC",
		"TRUNCATE",
		"FSTAT",
		"UNLOCK",
		"RDLOCK",
		"DELETE",
		"BLOCKED",
		"NOMEM",
		"ACCESS",
		"CHECKRESERVEDLOCK",
		"LOCK",
		"CLOSE",
		"DIR_CLOSE",
		"SHMOPEN",
		"SHMSIZE",
		"SHMLOCK",
		"SHMMAP",
		"SEEK",
		"DELETE_NOENT",
		"MMAP",
		"GETTEMPPATH",
		"CONVPATH",
		"VNODE",
		"AUTH",
		"BEGIN_ATOMIC",
		"COMMIT_ATOMIC",
		"ROLLBACK_ATOMIC",
		"DATA",
		"CORRUPTFS",
		"IN_PAGE",
	],
	LOCKED: ["", "SHAREDCACHE", "VTAB"],
	BUSY: ["", "RECOVERY", "SNAPSHOT", "TIMEOUT"],
	CANTOPEN: ["", "NOTEMPDIR", "ISDIR", "FULLPATH", "CONVPATH", "DIRTYWAL", "SYMLINK"],
	CORRUPT: ["", "VTAB", "SEQUENCE", "INDEX"],
	READONLY: ["", "RECOVERY", "CANTLOCK", "ROLLBACK", "DBMOVED", "CANTINIT", "DIRECTORY"],
	ABORT: ["", "", "ROLLBACK"],
	CONSTRAINT: [
		"",
		"CHECK",
		"COMMITHOOK",
		"FOREIGNKEY",
		"FUNCTION",
		"NOTNULL",
		"PRIMARYKEY",
		"TRIGGER",
		"UNIQUE",
		"VTAB",
		"ROWID",
		"PINNED",
		"DATATYPE",
	],
	NOTICE: ["", "RECOVER_WAL", "RECOVER_ROLLBACK", "RBU"],
	WARNING: ["", "AUTOINDEX"],
	AUTH: ["", "USER"],
};
export function sqliteCodeName(code: number): string {
	if (code === SQLITE_ROW) return "SQLITE_ROW";
	if (code === SQLITE_DONE) return "SQLITE_DONE";
	const primary = PRIMARY[code & 0xff];
	if (!primary) return "unknown";
	if (code < 256) return `SQLITE_${primary}`;
	const extended = EXTENDED[primary]?.[code >> 8];
	return extended ? `SQLITE_${primary}_${extended}` : "unknown";
}

let module: WasmModule | undefined;
let table: WebAssembly.Table | undefined;
let initializing: Promise<void> | undefined;
let backing: VirtualFileSystem | undefined;

/** Emscripten builds this module with a fixed-size function table. SQL
 * functions, hooks and the FTS5 tokenizer need a few JS callbacks, so relax
 * the table's maximum before instantiation. The vendored file is unchanged. */
function growableTable(bytes: Uint8Array): Uint8Array {
	let offset = 8;
	const leb = () => {
		let result = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = bytes[offset++] ?? 0;
			result |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		return result >>> 0;
	};
	while (offset < bytes.length) {
		const header = offset;
		const id = bytes[offset++];
		const size = leb();
		const start = offset;
		if (id === 4) {
			const count = leb();
			const type = bytes[offset++] ?? 0;
			const flags = bytes[offset++];
			const minimum = offset;
			leb();
			if (count !== 1 || flags !== 1) return bytes;
			const body = [1, type, 0, ...bytes.subarray(minimum, offset)];
			const result = new Uint8Array(bytes.length - size + body.length - (start - header) + 2);
			result.set(bytes.subarray(0, header));
			result.set([4, body.length, ...body], header);
			result.set(bytes.subarray(start + size), header + 2 + body.length);
			return result;
		}
		offset = start + size;
	}
	return bytes;
}

export function initializeSQLCipher(
	load: () => Promise<{ factory: Factory; wasm: Uint8Array }> = async () => {
		const url = "/vendor/wa-sqlite/mc-wa-sqlite.mjs";
		const [imported, response] = await Promise.all([
			import(/* @vite-ignore */ url) as Promise<{ default: Factory }>,
			fetch("/vendor/wa-sqlite/mc-wa-sqlite.wasm"),
		]);
		if (!response.ok) throw new Error(`SQLCipher WASM unavailable (${response.status})`);
		return {
			factory: imported.default,
			wasm: new Uint8Array(await response.arrayBuffer()),
		};
	},
): Promise<void> {
	initializing ??= (async () => {
		const { factory, wasm } = await load();
		const bytes = growableTable(wasm);
		module = await factory({
			wasmBinary: bytes,
			instantiateWasm(
				imports: WebAssembly.Imports,
				done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
			) {
				void WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, imports).then(
					({ instance, module }) => {
						table = Object.values(instance.exports).find(
							(value): value is WebAssembly.Table =>
								value instanceof WebAssembly.Table,
						);
						done(instance, module);
					},
				);
				return {};
			},
		});
		registerVFS(module);
	})();
	return initializing;
}

// ---- Strings and memory -------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
function wasm(): WasmModule {
	if (!module) throw new Error("SQLCipher WebAssembly has not been initialized in this worker");
	return module;
}
function allocate(value: Uint8Array): number {
	const sqlite = wasm();
	const pointer = sqlite._malloc(Math.max(1, value.length + 1));
	sqlite.HEAPU8.set(value, pointer);
	sqlite.HEAPU8[pointer + value.length] = 0;
	return pointer;
}
function cstring(value: string): [number, number] {
	const bytes = encoder.encode(value);
	return [allocate(bytes), bytes.length];
}
function readText(pointer: number, length: number): string {
	return pointer ? decoder.decode(wasm().HEAPU8.subarray(pointer, pointer + length)) : "";
}
function readInt(pointer: number): number {
	return wasm().HEAP32[pointer >> 2] ?? 0;
}
function writeInt(pointer: number, value: number): void {
	wasm().HEAP32[pointer >> 2] = value;
}
function view(): DataView {
	return new DataView(wasm().HEAPU8.buffer);
}
function int64(lo: number, hi: number, bigint: boolean): number | bigint {
	if (bigint) return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
	if ((hi === 0 && lo >= 0) || (hi === -1 && lo < 0)) return lo;
	return hi * 2 ** 32 + (lo >>> 0);
}
function call<T>(name: string, ...args: number[]): T {
	const fn = wasm()[`_sqlite3${name}`];
	if (!fn) throw new Error(`SQLite export sqlite3${name} is unavailable`);
	return fn(...args) as T;
}

// ---- Virtual filesystem ---------------------------------------------------

interface OpenFile {
	path: string;
	main: boolean;
	lock: number;
	fd?: number;
	deleteOnClose: boolean;
}
const handles = new Map<number, OpenFile>();
/** Journals and temporary files stay in worker memory. With cache spilling
 * disabled, the shared database file only changes inside a COMMIT, so other
 * contexts never observe a half-written transaction or a hot journal. */
const memory = new Map<string, { data: Uint8Array; size: number }>();
const dirty = new Set<string>();

function fs() {
	if (!backing) throw new Error("SQLCipher has no virtual filesystem");
	return backing.raw;
}
function exists(filename: string): boolean {
	try {
		return fs().statSync(filename).isFile();
	} catch {
		return false;
	}
}
function descriptor(file: OpenFile, create: boolean): number | undefined {
	if (file.fd !== undefined) return file.fd;
	if (!exists(file.path)) {
		if (!create) return undefined;
		fs().mkdirSync(path.dirname(file.path), { recursive: true });
		file.fd = fs().openSync(file.path, "w+");
	} else file.fd = fs().openSync(file.path, "r+");
	return file.fd;
}
function publish(filename: string): void {
	if (!dirty.delete(filename)) return;
	backing?.flush();
}
function others(file: OpenFile): OpenFile[] {
	return [...handles.values()].filter((item) => item !== file && item.path === file.path);
}

function registerVFS(sqlite: WasmModule): void {
	const heap = () => sqlite.HEAPU8;
	const vfs = {
		name: VFS_NAME,
		mxPathname: 1024,
		hasAsyncMethod: () => false,
		xOpen(_vfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) {
			const filename = zName
				? path.resolve(backing?.cwd || "/", sqlite.UTF8ToString(zName))
				: `/.sqlite-temp/${pFile}-${Date.now()}`;
			const main = (flags & OPEN_MAIN_DB) !== 0 && Boolean(zName);
			if (main) {
				if (!exists(filename) && !(flags & OPEN_CREATE)) return SQLITE_CANTOPEN;
			} else if (!memory.has(filename)) {
				if (!(flags & OPEN_CREATE)) return SQLITE_CANTOPEN;
				memory.set(filename, { data: new Uint8Array(0), size: 0 });
			}
			handles.set(pFile, {
				path: filename,
				main,
				lock: 0,
				deleteOnClose: (flags & OPEN_DELETEONCLOSE) !== 0 || !zName,
			});
			if (pOutFlags) writeInt(pOutFlags, flags);
			return SQLITE_OK;
		},
		xDelete(_vfs: number, zName: number) {
			const filename = path.resolve(backing?.cwd || "/", sqlite.UTF8ToString(zName));
			if (memory.delete(filename)) return SQLITE_OK;
			if (exists(filename)) {
				fs().rmSync(filename, { force: true });
				backing?.flush();
			}
			return SQLITE_OK;
		},
		xAccess(_vfs: number, zName: number, _flags: number, pResOut: number) {
			const filename = path.resolve(backing?.cwd || "/", sqlite.UTF8ToString(zName));
			writeInt(pResOut, memory.has(filename) || exists(filename) ? 1 : 0);
			return SQLITE_OK;
		},
		xFullPathname(_vfs: number, zName: number, nOut: number, zOut: number) {
			const bytes = encoder.encode(
				path.resolve(backing?.cwd || "/", sqlite.UTF8ToString(zName)),
			);
			if (bytes.length >= nOut) return SQLITE_CANTOPEN;
			heap().set(bytes, zOut);
			heap()[zOut + bytes.length] = 0;
			return SQLITE_OK;
		},
		xRandomness(_vfs: number, nByte: number, zOut: number) {
			for (let offset = 0; offset < nByte; offset += 65536)
				crypto.getRandomValues(
					heap().subarray(
						zOut + offset,
						zOut + Math.min(nByte, offset + 65536),
					) as Uint8Array<ArrayBuffer>,
				);
			return nByte;
		},
		xSleep(_vfs: number, microseconds: number) {
			if (typeof SharedArrayBuffer !== "undefined" && typeof window === "undefined")
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, microseconds / 1000);
			return microseconds;
		},
		xCurrentTime(_vfs: number, pTime: number) {
			view().setFloat64(pTime, Date.now() / 86_400_000 + 2440587.5, true);
			return SQLITE_OK;
		},
		xCurrentTimeInt64(_vfs: number, pTime: number) {
			view().setBigInt64(pTime, 24405875n * 8640000n + BigInt(Date.now()), true);
			return SQLITE_OK;
		},
		xGetLastError: () => SQLITE_OK,
		xClose(pFile: number) {
			const file = handles.get(pFile);
			if (!file) return SQLITE_OK;
			handles.delete(pFile);
			if (file.fd !== undefined) fs().closeSync(file.fd);
			if (file.main) publish(file.path);
			else if (file.deleteOnClose) memory.delete(file.path);
			return SQLITE_OK;
		},
		xRead(pFile: number, pData: number, iAmt: number, lo: number, hi: number) {
			const file = handles.get(pFile);
			if (!file) return SQLITE_IOERR_SHORT_READ;
			const position = hi * 2 ** 32 + (lo >>> 0);
			let read = 0;
			if (file.main) {
				const fd = descriptor(file, false);
				if (fd !== undefined)
					read = fs().readSync(
						fd,
						heap().subarray(pData, pData + iAmt),
						0,
						iAmt,
						position,
					);
			} else {
				const entry = memory.get(file.path);
				const chunk = entry
					? entry.data.subarray(position, Math.min(entry.size, position + iAmt))
					: new Uint8Array(0);
				heap().set(chunk, pData);
				read = chunk.length;
			}
			if (read < iAmt) {
				heap().fill(0, pData + read, pData + iAmt);
				return SQLITE_IOERR_SHORT_READ;
			}
			return SQLITE_OK;
		},
		xWrite(pFile: number, pData: number, iAmt: number, lo: number, hi: number) {
			const file = handles.get(pFile);
			if (!file) return 778;
			const position = hi * 2 ** 32 + (lo >>> 0);
			if (file.main) {
				const fd = descriptor(file, true) as number;
				fs().writeSync(
					fd,
					Buffer.from(heap().slice(pData, pData + iAmt)),
					0,
					iAmt,
					position,
				);
				dirty.add(file.path);
			} else {
				const entry = memory.get(file.path) || { data: new Uint8Array(0), size: 0 };
				if (entry.data.length < position + iAmt) {
					const grown = new Uint8Array(
						Math.max(position + iAmt, Math.ceil(entry.data.length * 1.5)),
					);
					grown.set(entry.data.subarray(0, entry.size));
					entry.data = grown;
				}
				if (position > entry.size) entry.data.fill(0, entry.size, position);
				entry.data.set(heap().subarray(pData, pData + iAmt), position);
				entry.size = Math.max(entry.size, position + iAmt);
				memory.set(file.path, entry);
			}
			return SQLITE_OK;
		},
		xTruncate(pFile: number, lo: number, hi: number) {
			const file = handles.get(pFile);
			if (!file) return 1546;
			const size = hi * 2 ** 32 + (lo >>> 0);
			if (file.main) {
				const fd = descriptor(file, size > 0);
				if (fd !== undefined) {
					fs().ftruncateSync(fd, size);
					dirty.add(file.path);
				}
			} else {
				const entry = memory.get(file.path);
				if (entry) {
					if (size > entry.size) {
						if (entry.data.length < size) {
							const grown = new Uint8Array(size);
							grown.set(entry.data.subarray(0, entry.size));
							entry.data = grown;
						} else entry.data.fill(0, entry.size, size);
					}
					entry.size = size;
				}
			}
			return SQLITE_OK;
		},
		xSync: () => SQLITE_OK,
		xFileSize(pFile: number, pSize: number) {
			const file = handles.get(pFile);
			let size = 0;
			if (file?.main) {
				const fd = descriptor(file, false);
				size = fd === undefined ? 0 : Number(fs().fstatSync(fd).size);
			} else if (file) size = memory.get(file.path)?.size ?? 0;
			view().setBigInt64(pSize, BigInt(size), true);
			return SQLITE_OK;
		},
		xLock(pFile: number, level: number) {
			const file = handles.get(pFile);
			if (!file || file.lock >= level) return SQLITE_OK;
			const peers = others(file);
			if (level === LOCK_SHARED && peers.some((peer) => peer.lock >= LOCK_PENDING))
				return SQLITE_BUSY;
			if (level === LOCK_RESERVED && peers.some((peer) => peer.lock >= LOCK_RESERVED))
				return SQLITE_BUSY;
			if (level === LOCK_EXCLUSIVE && peers.some((peer) => peer.lock >= LOCK_SHARED)) {
				file.lock = LOCK_PENDING;
				return SQLITE_BUSY;
			}
			file.lock = level;
			return SQLITE_OK;
		},
		xUnlock(pFile: number, level: number) {
			const file = handles.get(pFile);
			if (!file) return SQLITE_OK;
			const wrote = file.lock >= LOCK_RESERVED;
			file.lock = Math.min(file.lock, level);
			if (wrote && file.lock <= LOCK_SHARED && file.main) publish(file.path);
			return SQLITE_OK;
		},
		xCheckReservedLock(pFile: number, pResOut: number) {
			const file = handles.get(pFile);
			writeInt(
				pResOut,
				file &&
					[...handles.values()].some(
						(item) => item.path === file.path && item.lock >= LOCK_RESERVED,
					)
					? 1
					: 0,
			);
			return SQLITE_OK;
		},
		xFileControl: () => SQLITE_NOTFOUND,
		xSectorSize: () => 4096,
		// SQLITE_IOCAP_POWERSAFE_OVERWRITE
		xDeviceCharacteristics: () => 0x1000,
		// Shared memory is deliberately unavailable: WAL indexes cannot be shared
		// between browser workers, so WAL requests stay in rollback-journal mode.
		xShmMap: () => SQLITE_IOERR_SHMMAP,
		xShmLock: () => SQLITE_OK,
		xShmBarrier: () => SQLITE_OK,
		xShmUnmap: () => SQLITE_OK,
	};
	if (sqlite.vfs_register(vfs, 0)) throw new Error("Unable to register the SQLCipher VFS");
	const [name] = cstring(VFS_NAME);
	const result = call<number>("mc_vfs_create", name, 0);
	sqlite._free(name);
	if (result) throw new Error(`Unable to create the SQLCipher VFS (${result})`);
}

// ---- Callbacks --------------------------------------------------------------

const callbacks = new Map<number, (...args: unknown[]) => unknown>();
let nextCallback = 1;
let dispatch:
	| {
			fn: number;
			destroy: number;
			wal: number;
			log: number;
			tokenizer: number;
	  }
	| undefined;
let logger: ((code: string, message: string) => void) | undefined;

function translateValue(value: number, bigint: boolean): unknown {
	switch (call<number>("_value_type", value)) {
		case 1: {
			const lo = call<number>("_value_int64", value);
			return int64(lo, wasm()._getTempRet0(), bigint);
		}
		case 2:
			return call<number>("_value_double", value);
		case 3: {
			const pointer = call<number>("_value_text", value);
			return readText(pointer, call<number>("_value_bytes", value));
		}
		case 4: {
			const pointer = call<number>("_value_blob", value);
			const length = call<number>("_value_bytes", value);
			return Buffer.from(wasm().HEAPU8.slice(pointer, pointer + length));
		}
		default:
			return null;
	}
}
function resultError(context: number, message: string): void {
	const [pointer, length] = cstring(message);
	call("_result_error", context, pointer, length);
	wasm()._free(pointer);
}
function callbackTable() {
	if (dispatch) return dispatch;
	const sqlite = wasm();
	const fn = sqlite.addFunction((context: number, argc: number, argv: number) => {
		const entry = callbacks.get(call<number>("_user_data", context)) as
			| ((context: number, args: number[]) => void)
			| undefined;
		const args: number[] = [];
		for (let index = 0; index < argc; index++) args.push(readInt(argv + index * 4));
		entry?.(context, args);
		return undefined;
	}, "viii");
	const destroy = sqlite.addFunction((id: number) => {
		callbacks.delete(id);
		return undefined;
	}, "vi");
	const wal = sqlite.addFunction((id: number, _db: number, zDb: number, pages: number) => {
		try {
			callbacks.get(id)?.(sqlite.UTF8ToString(zDb), pages);
		} catch {
			/* Native addon ignores hook exceptions. */
		}
		return SQLITE_OK;
	}, "iiiii");
	const log = sqlite.addFunction((_context: number, code: number, message: number) => {
		try {
			logger?.(sqliteCodeName(code), sqlite.UTF8ToString(message));
		} catch {
			/* Native addon ignores logger exceptions. */
		}
		return undefined;
	}, "viii");
	const tokenizer = sqlite._malloc(12);
	const create = sqlite.addFunction(
		(_context: number, _args: number, _count: number, output: number) => {
			writeInt(output, tokenizer);
			return SQLITE_OK;
		},
		"iiiii",
	);
	const remove = sqlite.addFunction(() => undefined, "vi");
	const tokenize = sqlite.addFunction(
		(
			_tokenizer: number,
			context: number,
			flags: number,
			pText: number,
			nText: number,
			xToken: number,
		) => {
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					sqlite.HEAPU8.subarray(pText, pText + nText),
				);
			} catch {
				return SQLITE_OK;
			}
			const emit = table?.get(xToken) as
				| ((
						context: number,
						flags: number,
						token: number,
						length: number,
						start: number,
						end: number,
				  ) => number)
				| undefined;
			if (!emit) return 2;
			for (const token of signalTokens(text, flags)) {
				const [pointer, length] = cstring(token.value);
				const rc = emit(
					context,
					token.colocated ? 1 : 0,
					pointer,
					length,
					token.start,
					token.end,
				);
				sqlite._free(pointer);
				if (rc !== SQLITE_OK) return rc;
			}
			return SQLITE_OK;
		},
		"iiiiiii",
	);
	writeInt(tokenizer, create);
	writeInt(tokenizer + 4, remove);
	writeInt(tokenizer + 8, tokenize);
	dispatch = { fn, destroy, wal, log, tokenizer };
	return dispatch;
}
function register(callback: (...args: never[]) => unknown): number {
	const id = nextCallback++;
	callbacks.set(id, callback as (...args: unknown[]) => unknown);
	return id;
}

// ---- Signal FTS5 tokenizer --------------------------------------------------

interface Token {
	value: string;
	start: number;
	end: number;
	colocated: boolean;
}
const FTS5_TOKENIZE_QUERY = 1;
const segmenter =
	typeof Intl !== "undefined" && "Segmenter" in Intl
		? new Intl.Segmenter(undefined, { granularity: "word" })
		: undefined;
const separate = /[\p{Script=Han}\p{Script=Hiragana}]/u;
// Mirrors linkify's URL finder without a required scheme: e-mail addresses are
// not links unless a port or path follows; IPv4 hosts are links.
const URL_PATTERN = (() => {
	const label = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
	const host = `(?:(?:${label}\\.)+\\p{L}{2,}|\\d{1,3}(?:\\.\\d{1,3}){3})`;
	const tail = `[/?#][^\\s<>"]*`;
	const boundary = "(?<![\\p{L}\\p{N}@._%+-])";
	const scheme = `[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s<>"]+`;
	const login = `${boundary}[\\p{L}\\p{N}._~%!$&'*+,;=:-]+@${host}(?::\\d{1,5}(?:${tail})?|${tail})`;
	const bare = `${boundary}${host}(?::\\d{1,5})?(?:${tail})?`;
	return new RegExp(`${scheme}|${login}|${bare}`, "gu");
})();
function normalize(value: string): string {
	let result = "";
	for (const character of value.normalize("NFD"))
		if (!/[\u0300-\u036f]/.test(character)) result += character.toLowerCase();
	return result;
}
function trimLink(value: string): string {
	let end = value.length;
	while (end > 0) {
		const character = value[end - 1] as string;
		if (".,:;!?'\"".includes(character)) end--;
		else if (")]}".includes(character)) {
			const open = { ")": "(", "]": "[", "}": "{" }[character] as string;
			const body = value.slice(0, end);
			if (body.split(open).length >= body.split(character).length) break;
			end--;
		} else break;
	}
	return value.slice(0, end);
}
/** JavaScript port of Signal-FTS5-Extension's tokenizer: links are split into
 * scheme/userinfo/host/port/path terms (host suffixes as colocated synonyms in
 * documents); other text uses Unicode word segmentation. Tokens are NFD-folded,
 * stripped of combining diacritics and lowercased. Offsets are UTF-8 bytes. */
export function signalTokens(text: string, flags = 0): Token[] {
	const raw: Token[] = [];
	const rawToken = (value: string, start: number, end: number, colocated = false) => {
		if (value) raw.push({ value: normalize(value), start, end, colocated });
	};
	const words = (value: string, offset: number) => {
		if (!segmenter) {
			for (const match of value.matchAll(/[\p{L}\p{N}_]+(?:['’:.][\p{L}\p{N}_]+)*/gu))
				rawToken(match[0], offset + match.index, offset + match.index + match[0].length);
			return;
		}
		for (const segment of segmenter.segment(value)) {
			if (!segment.isWordLike) continue;
			let run = "";
			let runStart = segment.index;
			let cursor = segment.index;
			for (const character of segment.segment) {
				if (separate.test(character)) {
					rawToken(run, offset + runStart, offset + cursor);
					rawToken(character, offset + cursor, offset + cursor + character.length);
					run = "";
					runStart = cursor + character.length;
				} else run += character;
				cursor += character.length;
			}
			rawToken(run, offset + runStart, offset + cursor);
		}
	};
	let cursor = 0;
	for (const match of text.matchAll(URL_PATTERN)) {
		const link = trimLink(match[0]);
		if (!link) continue;
		const index = match.index;
		words(text.slice(cursor, index), cursor);
		cursor = index + link.length;
		const schemeEnd = link.indexOf("://");
		let start = index;
		let rest = link;
		if (schemeEnd >= 0) {
			words(link.slice(0, schemeEnd), index);
			start = index + schemeEnd + 3;
			rest = link.slice(schemeEnd + 3);
		}
		const pathIndex = rest.search(/[/?#]/);
		let host = pathIndex < 0 ? rest : rest.slice(0, pathIndex);
		const pathStart = start + (pathIndex < 0 ? rest.length : pathIndex + 1);
		const pathText = pathIndex < 0 ? "" : rest.slice(pathIndex + 1);
		const at = host.indexOf("@");
		if (at >= 0) {
			words(host.slice(0, at), start);
			start += at + 1;
			host = host.slice(at + 1);
		}
		const colon = host.indexOf(":");
		const port = colon < 0 ? "" : host.slice(colon + 1);
		const portStart = start + (colon < 0 ? host.length : colon + 1);
		if (colon >= 0) host = host.slice(0, colon);
		if (flags & FTS5_TOKENIZE_QUERY) rawToken(host, start, start + host.length);
		else {
			let last = 0;
			for (let dot = host.indexOf("."); dot >= 0; dot = host.indexOf(".", dot + 1)) {
				rawToken(host.slice(last), start, start + host.length, last !== 0);
				last = dot + 1;
			}
			if (last === 0) rawToken(host, start, start + host.length);
		}
		words(port, portStart);
		words(pathText, pathStart);
	}
	words(text.slice(cursor), cursor);
	// Convert UTF-16 indices to UTF-8 byte offsets, as SQLite expects.
	const bytes = new Uint32Array(text.length + 1);
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		const width =
			code < 0x80
				? 1
				: code < 0x800
					? 2
					: code >= 0xd800 && code < 0xdc00
						? 4
						: code < 0xe000 && code >= 0xdc00
							? 0
							: 3;
		bytes[index + 1] = (bytes[index] ?? 0) + width;
	}
	return raw.map((token) => ({
		...token,
		start: bytes[token.start] ?? 0,
		end: bytes[token.end] ?? 0,
	}));
}

// ---- Native addon API ---------------------------------------------------------

class NativeDatabase {
	handle: number;
	statements = new Set<NativeStatement>();
	walHook?: number;
	constructor(handle: number) {
		this.handle = handle;
	}
}
class NativeStatement {
	constructor(
		public database: NativeDatabase,
		public handle: number,
		readonly persistent: boolean,
		readonly pluck: boolean,
		readonly bigint: boolean,
	) {}
}
function sqliteError(database: NativeDatabase): Error {
	const message = wasm().UTF8ToString(call("_errmsg", database.handle));
	const offset = call<number>("_error_offset", database.handle);
	const code = sqliteCodeName(call<number>("_extended_errcode", database.handle));
	return Object.assign(
		new Error(
			offset === -1
				? `sqlite error(${code}): ${message}`
				: `sqlite error(${code}): ${message}, offset: ${offset}`,
		),
		{ code },
	);
}
function openDatabase(value: unknown): NativeDatabase {
	if (!(value instanceof NativeDatabase)) throw new TypeError("Invalid database handle");
	if (!value.handle) throw new Error("Database closed");
	return value;
}
function openStatement(value: unknown): NativeStatement {
	if (!(value instanceof NativeStatement)) throw new TypeError("Invalid statement handle");
	if (!value.handle) throw new Error("Statement closed");
	return value;
}
/** Browser workers cannot share a WAL index. Keep rollback-journal mode, which
 * is what SQLite reports when a VFS lacks shared memory. */
function compatibleSQL(sql: string): string {
	return sql.replace(/\bjournal_mode\s*=\s*(['"]?)wal\1/gi, "journal_mode");
}
/** Signal's SQLCipher is built with SQLITE_ENABLE_UPDATE_DELETE_LIMIT; this
 * WebAssembly build is not. When SQLite rejects `DELETE ... [ORDER BY] LIMIT`,
 * express the same row selection as a rowid subquery. RETURNING rows are not
 * guaranteed to follow ORDER BY. Returns undefined for anything else. */
export function limitedDelete(sql: string): string | undefined {
	const head = /^\s*DELETE\s+FROM\s+/i.exec(sql);
	if (!head) return undefined;
	const clauses: { name: string; index: number }[] = [];
	let depth = 0;
	for (let index = head[0].length; index < sql.length; index++) {
		const character = sql[index] as string;
		if (character === "'" || character === '"' || character === "`" || character === "[") {
			const close = character === "[" ? "]" : character;
			index = sql.indexOf(close, index + 1);
			while (index >= 0 && close !== "]" && sql[index + 1] === close)
				index = sql.indexOf(close, index + 2);
			if (index < 0) return undefined;
		} else if (sql.startsWith("--", index)) {
			const end = sql.indexOf("\n", index);
			index = end < 0 ? sql.length : end;
		} else if (sql.startsWith("/*", index)) {
			const end = sql.indexOf("*/", index + 2);
			if (end < 0) return undefined;
			index = end + 1;
		} else if (character === "(") depth++;
		else if (character === ")") depth--;
		else if (depth === 0 && /[A-Za-z]/.test(character) && !/[\w$]/.test(sql[index - 1] || "")) {
			const keyword = /^(WHERE|RETURNING|ORDER\s+BY|LIMIT)\b/i.exec(sql.slice(index));
			if (keyword) {
				clauses.push({
					name: (keyword[1] as string).split(/\s/)[0]?.toUpperCase() as string,
					index,
				});
				index += keyword[0].length - 1;
			}
		}
	}
	const position = (name: string) => clauses.find((clause) => clause.name === name)?.index;
	const limit = position("LIMIT");
	if (limit === undefined) return undefined;
	const bounds = clauses.map((clause) => clause.index).concat(sql.length);
	const part = (name: string) => {
		const start = position(name);
		if (start === undefined) return "";
		return sql
			.slice(
				start,
				bounds.find((value) => value > start),
			)
			.trim();
	};
	const target = sql.slice(head[0].length, clauses[0]?.index).trim();
	const limitText = part("LIMIT").replace(/;\s*$/, "");
	return `DELETE FROM ${target} WHERE rowid IN (SELECT rowid FROM ${target} ${part("WHERE")} ${part("ORDER")} ${limitText}) ${part("RETURNING")}`;
}
function hasTail(tail: string): boolean {
	let value = tail;
	while (value) {
		if (/^[\s;]/.test(value)) value = value.slice(1);
		else if (value.startsWith("--")) {
			const end = value.indexOf("\n");
			if (end < 0) return false;
			value = value.slice(end + 1);
		} else if (value.startsWith("/*")) {
			const end = value.indexOf("*/", 2);
			if (end < 0) return false;
			value = value.slice(end + 2);
		} else return true;
	}
	return false;
}
function resetStatement(statement: NativeStatement): void {
	call("_reset", statement.handle);
	call("_clear_bindings", statement.handle);
}
function bindParameter(
	statement: NativeStatement,
	index: number,
	value: unknown,
): string | undefined {
	const handle = statement.handle;
	let rc: number;
	if (value === null) rc = call("_bind_null", handle, index);
	else if (typeof value === "number") rc = call("_bind_double", handle, index, value);
	else if (typeof value === "string") {
		const [pointer, length] = cstring(value);
		rc = call("_bind_text", handle, index, pointer, length, TRANSIENT);
		wasm()._free(pointer);
	} else if (typeof value === "bigint") {
		if (value !== BigInt.asIntN(64, value)) return "failed to convert bigint to int64";
		rc = call(
			"_bind_int64",
			handle,
			index,
			Number(BigInt.asIntN(32, value)),
			Number(BigInt.asIntN(32, value >> 32n)),
		);
	} else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		const pointer = allocate(bytes);
		rc = call("_bind_blob", handle, index, pointer, bytes.length, TRANSIENT);
		wasm()._free(pointer);
	} else
		return typeof value === "object"
			? "unexpected type `object`"
			: `unexpected type \`${typeof value}\``;
	return rc === SQLITE_OK
		? undefined
		: wasm().UTF8ToString(call("_errmsg", statement.database.handle));
}
function bindParameters(statement: NativeStatement, params: unknown): void {
	const count = call<number>("_bind_parameter_count", statement.handle);
	if (params === null) return;
	if (params === undefined) {
		if (count === 0) return;
		throw new Error(`Expected ${count} parameters, got 0`);
	}
	if (!Array.isArray(params)) return;
	if (params.length !== count)
		throw new Error(`Expected ${count} parameters, got ${params.length}`);
	for (let index = 1; index <= params.length; index++) {
		const error = bindParameter(statement, index, params[index - 1]);
		if (error === undefined) continue;
		const name = call<number>("_bind_parameter_name", statement.handle, index);
		throw new Error(
			name
				? `Failed to bind param ${wasm().UTF8ToString(name + 1)}, error ${error}`
				: `Failed to bind param ${index}, error ${error}`,
		);
	}
}
function columnValue(statement: NativeStatement, column: number): unknown {
	const handle = statement.handle;
	switch (call<number>("_column_type", handle, column)) {
		case 1: {
			const lo = call<number>("_column_int64", handle, column);
			return int64(lo, wasm()._getTempRet0(), statement.bigint);
		}
		case 2:
			return call<number>("_column_double", handle, column);
		case 3: {
			const pointer = call<number>("_column_text", handle, column);
			return readText(pointer, call<number>("_column_bytes", handle, column));
		}
		case 4: {
			const pointer = call<number>("_column_blob", handle, column);
			const length = call<number>("_column_bytes", handle, column);
			return Buffer.from(wasm().HEAPU8.slice(pointer, pointer + length));
		}
		default:
			return null;
	}
}
function columnName(statement: NativeStatement, column: number): string {
	return wasm().UTF8ToString(call("_column_name", statement.handle, column));
}

export function signalSQLCipherAddon(vfs: VirtualFileSystem): Record<string, unknown> | undefined {
	if (!module) return undefined;
	backing = vfs;
	const sqlite = module;
	const scratch = sqlite._malloc(8);
	return {
		databaseOpen(filename: string) {
			if (typeof filename !== "string") throw new TypeError("Invalid database path");
			const [name] = cstring(filename);
			const [vfsName] = cstring(CIPHER_VFS);
			// SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
			const rc = call<number>("_open_v2", name, scratch, 0x2 | 0x4, vfsName);
			sqlite._free(name);
			sqlite._free(vfsName);
			const handle = readInt(scratch);
			if (rc !== SQLITE_OK) {
				const message = sqlite.UTF8ToString(call("_errstr", rc));
				if (handle) call("_close", handle);
				throw new Error(`sqlite open error: ${message}`);
			}
			const database = new NativeDatabase(handle);
			call("_extended_result_codes", handle, 1);
			// SQLCipher 4 page format/KDF; keys still come from the app's PRAGMA key.
			const [setup] = cstring(
				"PRAGMA cipher = 'sqlcipher'; PRAGMA legacy = 4; PRAGMA cache_spill = OFF;",
			);
			const result = call<number>("_exec", handle, setup, 0, 0, 0);
			sqlite._free(setup);
			if (result !== SQLITE_OK) {
				const error = sqliteError(database);
				call("_close", handle);
				throw error;
			}
			return database;
		},
		databaseInitTokenizer(value: unknown) {
			const database = openDatabase(value);
			const slots = callbackTable();
			const [query] = cstring("SELECT fts5(?1)");
			let rc = call<number>("_prepare_v2", database.handle, query, -1, scratch, 0);
			sqlite._free(query);
			if (rc !== SQLITE_OK) throw sqliteError(database);
			const statement = readInt(scratch);
			const output = sqlite._malloc(4);
			writeInt(output, 0);
			const [type] = cstring("fts5_api_ptr");
			call("_bind_pointer", statement, 1, output, type, 0);
			call("_step", statement);
			rc = call<number>("_finalize", statement);
			sqlite._free(type);
			const api = readInt(output);
			sqlite._free(output);
			if (rc !== SQLITE_OK) throw sqliteError(database);
			const createTokenizer = table?.get(readInt(api + 4)) as
				| ((
						api: number,
						name: number,
						context: number,
						tokenizer: number,
						destroy: number,
				  ) => number)
				| undefined;
			if (!createTokenizer) throw new Error("FTS5 is unavailable");
			const [name] = cstring("signal_tokenizer");
			rc = createTokenizer(api, name, 0, slots.tokenizer, 0);
			sqlite._free(name);
			if (rc !== SQLITE_OK) throw sqliteError(database);
		},
		databaseClose(value: unknown) {
			const database = openDatabase(value);
			for (const statement of database.statements) {
				const rc = call<number>("_finalize", statement.handle);
				if (rc !== SQLITE_OK) throw sqliteError(database);
				statement.handle = 0;
			}
			database.statements.clear();
			if (database.walHook) {
				call("_wal_hook", database.handle, 0, 0);
				callbacks.delete(database.walHook);
				database.walHook = undefined;
			}
			const rc = call<number>("_close", database.handle);
			if (rc !== SQLITE_OK) throw sqliteError(database);
			database.handle = 0;
		},
		databaseExec(value: unknown, sql: string) {
			const database = openDatabase(value);
			const [pointer] = cstring(compatibleSQL(sql));
			const rc = call<number>("_exec", database.handle, pointer, 0, 0, 0);
			sqlite._free(pointer);
			if (rc !== SQLITE_OK) throw sqliteError(database);
		},
		databaseCreateFunction(
			value: unknown,
			name: string,
			fn: (...args: unknown[]) => unknown,
			bigint: boolean,
		) {
			const database = openDatabase(value);
			const slots = callbackTable();
			const id = register((context: number, args: number[]) => {
				let result: unknown;
				try {
					result = fn(...args.map((arg) => translateValue(arg, bigint)));
				} catch (error) {
					resultError(context, error instanceof Error ? error.message : String(error));
					return;
				}
				if (result === undefined) call("_result_null", context);
				else resultError(context, "Function must not return a value");
			});
			const [pointer] = cstring(name);
			// nArg -1, SQLITE_UTF8
			const rc = call<number>(
				"_create_function_v2",
				database.handle,
				pointer,
				-1,
				1,
				id,
				slots.fn,
				0,
				0,
				slots.destroy,
			);
			sqlite._free(pointer);
			if (rc !== SQLITE_OK) throw sqliteError(database);
		},
		databaseSetWalHook(value: unknown, fn: (name: string, pages: number) => void) {
			const database = openDatabase(value);
			const slots = callbackTable();
			const id = register(fn);
			if (database.walHook) callbacks.delete(database.walHook);
			database.walHook = id;
			call("_wal_hook", database.handle, slots.wal, id);
		},
		statementNew(
			value: unknown,
			query: string,
			persistent: boolean,
			pluck: boolean,
			bigint: boolean,
			paramNames: unknown[],
		) {
			const database = openDatabase(value);
			const prepare = (sql: string) => {
				const bytes = encoder.encode(sql);
				const pointer = allocate(bytes);
				const tail = sqlite._malloc(4);
				// SQLITE_PREPARE_PERSISTENT
				const rc = call<number>(
					"_prepare_v3",
					database.handle,
					pointer,
					bytes.length,
					persistent ? 1 : 0,
					scratch,
					tail,
				);
				const rest = readInt(tail) - pointer;
				sqlite._free(tail);
				sqlite._free(pointer);
				return {
					rc,
					handle: readInt(scratch),
					remaining: decoder.decode(bytes.subarray(Math.max(0, rest))),
				};
			};
			let prepared = prepare(compatibleSQL(query));
			const emulated = prepared.rc === 1 ? limitedDelete(query) : undefined;
			if (emulated) prepared = prepare(emulated);
			const { rc, handle, remaining } = prepared;
			if (rc !== SQLITE_OK) throw sqliteError(database);
			if (hasTail(remaining)) {
				const finalized = call<number>("_finalize", handle);
				if (finalized === SQLITE_OK)
					throw new Error("Can't prepare more than one statement");
				throw sqliteError(database);
			}
			const statement = new NativeStatement(database, handle, persistent, pluck, bigint);
			if (handle) database.statements.add(statement);
			const count = handle ? call<number>("_bind_parameter_count", handle) : 0;
			for (let index = 1; index <= count; index++) {
				const name = call<number>("_bind_parameter_name", handle, index);
				// Skip the "$"/":"/"@" prefix, as the native addon does.
				paramNames[index - 1] = name ? sqlite.UTF8ToString(name + 1) : null;
			}
			return statement;
		},
		statementClose(value: unknown) {
			const statement = openStatement(value);
			const rc = call<number>("_finalize", statement.handle);
			if (rc !== SQLITE_OK) throw sqliteError(statement.database);
			statement.handle = 0;
			statement.database.statements.delete(statement);
		},
		statementRun(value: unknown, params: unknown, result: unknown[]) {
			const statement = openStatement(value);
			bindParameters(statement, params);
			const database = statement.database.handle;
			const before = call<number>("_total_changes", database);
			const rc = call<number>("_step", statement.handle);
			resetStatement(statement);
			if (rc !== SQLITE_DONE && rc !== SQLITE_ROW) throw sqliteError(statement.database);
			const after = call<number>("_total_changes", database);
			const lo = call<number>("_last_insert_rowid", database);
			result[0] = after === before ? 0 : call<number>("_changes", database);
			result[1] = int64(lo, sqlite._getTempRet0(), false);
		},
		statementStep(
			value: unknown,
			params: unknown,
			cache: unknown[] | undefined,
			isGet: boolean,
		) {
			const statement = openStatement(value);
			bindParameters(statement, params);
			const rc = call<number>("_step", statement.handle);
			if (rc === SQLITE_DONE) {
				resetStatement(statement);
				return undefined;
			}
			if (rc !== SQLITE_ROW) {
				resetStatement(statement);
				throw sqliteError(statement.database);
			}
			try {
				const count = call<number>("_column_count", statement.handle);
				if (statement.pluck) {
					if (count !== 1) {
						resetStatement(statement);
						throw new Error("Invalid column count for pluck");
					}
					return columnValue(statement, 0);
				}
				if (!statement.persistent) {
					const row: Record<string, unknown> = {};
					for (let index = 0; index < count; index++)
						row[columnName(statement, index)] = columnValue(statement, index);
					return row;
				}
				// SQLITE_STMTSTATUS_REPREPARE, reset counter
				const recompiled = call<number>("_stmt_status", statement.handle, 5, 1);
				let row = cache;
				if (recompiled || row === undefined) {
					row = new Array(2 * count);
					for (let index = 0; index < count; index++)
						row[index] = columnName(statement, index);
				}
				for (let index = 0; index < count; index++)
					row[count + index] = columnValue(statement, index);
				return row;
			} finally {
				if (isGet && statement.handle) resetStatement(statement);
			}
		},
		statementScanStats() {
			throw new Error("Not available in production builds");
		},
		setLogger(fn: (code: string, message: string) => void) {
			logger = fn;
			const slots = callbackTable();
			// sqlite3_config(SQLITE_CONFIG_LOG, callback, context) is variadic;
			// Emscripten passes variadic arguments through a memory block.
			const args = sqlite._malloc(8);
			writeInt(args, slots.log);
			writeInt(args + 4, 0);
			call("_config", 16, args);
			sqlite._free(args);
		},
		signalTokenize(value: string) {
			if (typeof value !== "string") throw new TypeError("Invalid value");
			return signalTokens(value).map((token) => token.value);
		},
	};
}
