import type { WriteStream } from "node:fs";
import { Buffer } from "buffer";
import { createFsFromVolume, Volume } from "memfs";
import path from "path-browserify";
import type { FilePatch, Snapshot } from "../shared/types";

const MUTATIONS =
	/^(write|append|mkdir|mkdtemp|unlink|rmdir|rm|rename|copyFile|cp|truncate|ftruncate|symlink|link|chmod|chown|utimes|fchmod|fchown|futimes)/;

// Directories owned by root in a root-owned parent (/tmp also has the sticky
// bit). The unprivileged guest user can use them but cannot remove or rename
// them; e.g. "rmdir(dirname(tempFile))" must fail as it does on a real system.
const SYSTEM_DIRECTORIES = new Set(["/", "/tmp", "/home", "/etc", "/neutron"]);
const REMOVALS = /^(rmdir|rm|rename|unlink)(Sync)?$/;
function systemDirectoryError(syscall: string, target: string) {
	return Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${target}'`), {
		errno: -1,
		code: "EPERM",
		syscall,
		path: target,
	});
}

// memfs uses close() to release its descriptor on finish/destroy. Node's
// *public* close() must first end the writable side and drain queued writes.
function drainingClose(release: WriteStream["close"]) {
	return function (
		this: WriteStream & {
			autoClose: boolean;
			_writableState: { finished: boolean; emitClose: boolean };
		},
		callback?: Parameters<WriteStream["close"]>[0],
	) {
		if (this.closed) {
			if (callback) queueMicrotask(callback);
			return;
		}
		if (this.destroyed || this._writableState.finished) {
			// The descriptor release emits 'close' itself. Writable auto-destroy
			// must not emit a second event for that same descriptor.
			this._writableState.emitClose = false;
			return release.call(this, callback);
		}
		if (callback) this.once("close", callback);
		if (!this.autoClose) this.once("finish", () => this.close());
		this.end();
	};
}

export class VirtualFileSystem {
	cwd = "/app";
	readonly volume = Volume.fromJSON({}, "/", {
		process: {
			cwd: () => this.cwd,
			platform: "linux",
			getuid: () => 1000,
			getgid: () => 1000,
			env: {},
			emitWarning: () => {},
		},
	});
	readonly raw = createFsFromVolume(this.volume);
	readonly fs: typeof this.raw;
	private previous: Snapshot = {};
	private muted = false;
	private archives = new Map<number, Uint8Array>();
	private fileContents = new WeakMap<
		object,
		{ modified: Date; size: number; data: Uint8Array }
	>();
	private pendingWrites = 0;
	private writeStreams = new Set<{
		writableLength?: number;
		_writableState?: { length?: number; writing?: boolean; pendingcb?: number };
		on(name: string, callback: () => void): unknown;
	}>();
	private trackWriteStream(stream: unknown): void {
		const value = stream as Parameters<VirtualFileSystem["writeStreams"]["add"]>[0];
		if (this.writeStreams.has(value)) return;
		this.writeStreams.add(value);
		const finish = () => {
			if (this.writeStreams.delete(value))
				this.flushMutation("writeFile", Reflect.get(value, "path"));
		};
		value.on("finish", finish);
		value.on("close", finish);
	}
	async settle(): Promise<void> {
		const deadline = performance.now() + 250;
		let quiet = 0;
		do {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const busy =
				this.pendingWrites > 0 ||
				[...this.writeStreams].some(
					(stream) =>
						(stream.writableLength || stream._writableState?.length || 0) > 0 ||
						stream._writableState?.writing ||
						(stream._writableState?.pendingcb || 0) > 0,
				);
			quiet = busy ? 0 : quiet + 1;
		} while (quiet < 2 && performance.now() < deadline);
		this.flush();
	}
	private observers = new Set<(patches: FilePatch[], origin?: unknown) => void>();
	subscribe(listener: (patches: FilePatch[], origin?: unknown) => void): () => void {
		this.observers.add(listener);
		return () => this.observers.delete(listener);
	}
	constructor(
		snapshot: Snapshot,
		private onChange: (patches: FilePatch[]) => void,
	) {
		this.apply(Object.entries(snapshot).map(([path, entry]) => ({ path, entry })));
		// Node's fs stream constructors are callable by old-style subclasses such
		// as graceful-fs. memfs exposes ES classes behind symbol-backed accessors.
		for (const [name, write] of [
			["ReadStream", false],
			["WriteStream", true],
		] as const) {
			const streamClass = this.volume[name];
			const base = Object.getPrototypeOf(streamClass.prototype).constructor;
			const volume = this.volume;
			const normalize = (value: unknown) =>
				typeof value === "string" ? this.normalizePath(value) : value;
			const track = (stream: object) => this.trackWriteStream(stream);
			function BoundStream(this: object, ...args: unknown[]): object {
				if (!(this instanceof BoundStream)) return Reflect.construct(BoundStream, args);
				Reflect.apply(base, this, [volume, normalize(args[0]), ...args.slice(1)]);
				if (write) track(this);
				return this;
			}
			BoundStream.prototype = Object.create(base.prototype, {
				constructor: { value: BoundStream, writable: true, configurable: true },
			});
			if (write) {
				BoundStream.prototype.close = drainingClose(base.prototype.close);
				// Both fs.createWriteStream and FileHandle.createWriteStream use the
				// volume's constructor, rather than the fs export below.
				Reflect.set(volume, name, BoundStream);
			}
			for (const key of [name, `File${name}`])
				Object.defineProperty(this.raw, key, {
					value: BoundStream,
					enumerable: true,
					configurable: true,
					writable: true,
				});
		}
		const wrap = (target: object, promises = false, fileHandle = false): object => {
			const cache = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
			const proxy: object = new Proxy(target, {
				get: (object, key) => {
					const value: unknown = Reflect.get(object, key, object);
					if (key === "promises") {
						const saved = cache.get(key);
						if (saved && saved.original === value) return saved.wrapped;
						const wrapped = wrap(this.raw.promises, true);
						cache.set(key, { original: value, wrapped });
						return wrapped;
					}
					if (typeof value !== "function") return value;
					if (
						/^(ReadStream|WriteStream|FileReadStream|FileWriteStream|Stats|Dir|Dirent|StatWatcher|FSWatcher)$/.test(
							String(key),
						)
					)
						return value;
					const saved = cache.get(key);
					if (saved && saved.original === value) return saved.wrapped;
					const wrapped = (...args: unknown[]) => {
						if (!fileHandle) {
							if (typeof args[0] === "string") args[0] = this.normalizePath(args[0]);
							if (
								/^(rename|copyFile|cp|link|symlink)(Sync)?$/.test(String(key)) &&
								typeof args[1] === "string"
							)
								args[1] = this.normalizePath(args[1]);
						}
						if (
							!fileHandle &&
							REMOVALS.test(String(key)) &&
							typeof args[0] === "string" &&
							SYSTEM_DIRECTORIES.has(path.resolve("/", args[0]))
						) {
							const error = systemDirectoryError(
								String(key).replace(/Sync$/, ""),
								args[0],
							);
							if (promises) return Promise.reject(error);
							if (String(key).endsWith("Sync")) throw error;
							const callback = args.at(-1);
							if (typeof callback === "function")
								queueMicrotask(() => callback(error));
							return;
						}
						if (
							["readFile", "readFileSync"].includes(String(key)) &&
							(typeof args[0] === "string" || args[0] instanceof URL)
						) {
							const name =
								args[0] instanceof URL
									? decodeURIComponent(args[0].pathname)
									: args[0];
							let archive: Uint8Array | undefined;
							try {
								archive = this.archives.get(Number(this.raw.statSync(name).ino));
							} catch {
								/* Delegate normal fs errors. */
							}
							if (archive) {
								const option = args[1];
								const encoding =
									typeof option === "string"
										? option
										: option && typeof option === "object"
											? Reflect.get(option, "encoding")
											: undefined;
								const data = Buffer.from(archive);
								const value = encoding
									? data.toString(encoding as BufferEncoding)
									: data;
								if (promises) return Promise.resolve(value);
								if (key === "readFileSync") return value;
								const callback = args.at(-1);
								if (typeof callback !== "function")
									throw new TypeError("readFile callback is required");
								queueMicrotask(() => callback(null, value));
								return;
							}
						}
						const mutation =
							MUTATIONS.test(String(key)) ||
							key === "closeSync" ||
							key === "openSync" ||
							key === "open" ||
							key === "close";
						const flushMutation = () =>
							this.flushMutation(
								String(key).replace(/Sync$/, ""),
								fileHandle ? undefined : args[0],
							);
						if (
							promises &&
							!(
								fileHandle &&
								["createReadStream", "createWriteStream", "readLines"].includes(
									String(key),
								)
							)
						) {
							if (mutation) this.pendingWrites++;
							let result: unknown;
							try {
								result = Reflect.apply(value, object, args);
							} catch (error) {
								if (mutation) this.pendingWrites--;
								throw error;
							}
							return Promise.resolve(result)
								.then((result) => {
									if (mutation) flushMutation();
									if (key === "open" && result && typeof result === "object")
										return wrap(result, true, true);
									return result;
								})
								.finally(() => {
									if (mutation) this.pendingWrites--;
								});
						}
						const last = args[args.length - 1];
						const pending = mutation && typeof last === "function";
						let completed = false;
						if (pending) {
							this.pendingWrites++;
							args[args.length - 1] = (...result: unknown[]) => {
								if (!completed) {
									completed = true;
									this.pendingWrites--;
								}
								flushMutation();
								Reflect.apply(last, undefined, result);
							};
						}
						let result: unknown;
						try {
							result = Reflect.apply(value, object, args);
						} catch (error) {
							if (pending && !completed) this.pendingWrites--;
							throw error;
						}
						if (mutation && String(key).endsWith("Sync")) flushMutation();
						if (key === "createWriteStream") this.trackWriteStream(result);
						return result;
					};
					for (const property of Reflect.ownKeys(value)) {
						if (
							["name", "length", "prototype", "arguments", "caller"].includes(
								String(property),
							)
						)
							continue;
						const descriptor = Object.getOwnPropertyDescriptor(value, property);
						if (descriptor) Object.defineProperty(wrapped, property, descriptor);
					}
					cache.set(key, { original: value, wrapped });
					return wrapped;
				},
				getOwnPropertyDescriptor: (object, key): PropertyDescriptor | undefined => {
					const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
					if (!descriptor?.configurable) return descriptor;
					return {
						configurable: true,
						enumerable: descriptor.enumerable,
						writable: true,
						value: Reflect.get(proxy, key),
					};
				},
			});
			return proxy;
		};
		this.fs = wrap(this.raw) as typeof this.raw;
	}
	normalizePath(value: string): string {
		const normalized = value.replaceAll("\\", "/");
		return /^[a-z]:\//i.test(normalized) ? `/${normalized}` : normalized;
	}
	private fileBytes(node: (typeof this.volume._core.inodes)[number]): Uint8Array {
		let cached = this.fileContents.get(node);
		if (!cached || cached.modified !== node.mtime || cached.size !== node.getSize()) {
			cached = {
				modified: node.mtime,
				size: node.getSize(),
				data: new Uint8Array(node.buf.subarray(0, node.getSize())),
			};
			this.fileContents.set(node, cached);
		}
		return cached.data;
	}
	/** Most mutations are a write to one existing regular file (logs, config
	 * and databases). Do not enumerate tens of thousands of immutable assets
	 * for every append. Fall back to the full diff for ambiguous operations. */
	private flushMutation(method: string, target: unknown): void {
		if (
			!this.muted &&
			typeof target === "string" &&
			["appendFile", "writeFile", "truncate", "open"].includes(method)
		) {
			let filename: string, node: (typeof this.volume._core.inodes)[number] | undefined;
			try {
				filename = String(this.raw.realpathSync(target));
				const stat = this.raw.statSync(filename);
				if (stat.isFile() && stat.nlink === 1)
					node = this.volume._core.inodes[Number(stat.ino)];
			} catch {
				this.flush();
				return;
			}
			const parent = path.dirname(filename);
			if (node && (parent === "/" || this.previous[parent]?.kind === "directory")) {
				const old = this.previous[filename],
					data = this.fileBytes(node);
				const mtimeMs = node.mtime.getTime();
				if (old?.kind === "file" && old.data === data && old.mtimeMs === mtimeMs) return;
				const entry = { kind: "file" as const, data, mtimeMs };
				this.previous[filename] = entry;
				const patches = [{ path: filename, entry }];
				this.onChange(patches);
				for (const observer of this.observers) observer(patches);
				return;
			}
		}
		this.flush();
	}
	snapshot(): Snapshot {
		const result: Snapshot = {};
		const walk = (directory: typeof this.volume._core.root, dir: string): void => {
			for (const [name, link] of directory.children) {
				if (!link || name === "." || name === "..") continue;
				const filename = path.join(dir, name);
				const node = link.getNode();
				if (node.isSymlink())
					result[filename] = {
						kind: "symlink",
						target: node.symlink,
					};
				else if (node.isDirectory()) {
					const archive = this.archives.get(node.ino);
					result[filename] = archive
						? { kind: "directory", archive }
						: { kind: "directory" };
					walk(link, filename);
				} else {
					// memfs gives every write a new mtime Date object, even within the
					// same millisecond. Cache by inode identity + that object, not its
					// numeric timestamp, to avoid copying a large app on every log write.
					result[filename] = {
						kind: "file",
						data: this.fileBytes(node),
						mtimeMs: node.mtime.getTime(),
					};
				}
			}
		};
		walk(this.volume._core.root, "/");
		return result;
	}
	flush(): void {
		if (this.muted) return;
		const next = this.snapshot();
		const patches: FilePatch[] = [];
		for (const filename of Object.keys(this.previous).sort((a, b) => b.length - a.length)) {
			if (!next[filename]) patches.push({ path: filename, entry: null });
		}
		for (const [filename, entry] of Object.entries(next)) {
			const old = this.previous[filename];
			if (
				!old ||
				old.kind !== entry.kind ||
				(entry.kind === "symlink" &&
					old.kind === "symlink" &&
					old.target !== entry.target) ||
				(entry.kind === "file" &&
					old.kind === "file" &&
					(old.mtimeMs !== entry.mtimeMs ||
						(old.data !== entry.data &&
							!Buffer.from(
								old.data.buffer,
								old.data.byteOffset,
								old.data.byteLength,
							).equals(
								Buffer.from(
									entry.data.buffer,
									entry.data.byteOffset,
									entry.data.byteLength,
								),
							))))
			) {
				patches.push({ path: filename, entry });
			}
		}
		this.previous = next;
		if (patches.length) {
			this.onChange(patches);
			for (const observer of this.observers) observer(patches);
		}
	}
	/** `origin` identifies the context that produced remote patches, so relays
	 * do not echo them back and roll that context's newer writes back. */
	apply(patches: FilePatch[], publish = false, origin?: unknown): void {
		let rescan = false;
		this.muted = true;
		try {
			for (const { path: filename, entry } of patches) {
				if (!entry) {
					this.raw.rmSync(filename, { force: true, recursive: true });
					if (this.previous[filename]?.kind === "file") delete this.previous[filename];
					else rescan = true;
					continue;
				}
				// A new log, cache file or directory doesn't invalidate thousands of
				// unrelated snapshot entries. Track plain paths under known parents;
				// implicit directories, links and type changes still get a full diff base.
				const parent = path.dirname(filename);
				const old = this.previous[filename];
				if (
					(parent !== "/" && this.previous[parent]?.kind !== "directory") ||
					filename !== path.resolve("/", filename) ||
					(old && old.kind !== entry.kind)
				)
					rescan = true;
				this.raw.mkdirSync(parent, { recursive: true });
				try {
					const stat = this.raw.lstatSync(filename);
					if (
						(entry.kind === "directory" && !stat.isDirectory()) ||
						(entry.kind !== "directory" && stat.isDirectory()) ||
						stat.isSymbolicLink()
					)
						this.raw.rmSync(filename, { recursive: true, force: true });
				} catch {
					/* New entry. */
				}
				if (entry.kind === "directory") {
					this.raw.mkdirSync(filename, { recursive: true });
					if (entry.archive)
						this.archives.set(Number(this.raw.statSync(filename).ino), entry.archive);
					if (!rescan && (!old || entry.archive)) this.previous[filename] = entry;
				} else if (entry.kind === "symlink") {
					this.raw.symlinkSync(entry.target, filename);
					rescan = true;
				} else {
					this.raw.writeFileSync(
						filename,
						Buffer.from(
							entry.data.buffer,
							entry.data.byteOffset,
							entry.data.byteLength,
						),
					);
					const node = this.volume._core.inodes[Number(this.raw.statSync(filename).ino)];
					if (node) {
						if (entry.mtimeMs !== undefined) node.mtime = new Date(entry.mtimeMs);
						this.fileContents.set(node, {
							modified: node.mtime,
							size: node.getSize(),
							data: entry.data,
						});
						if (node.nlink !== 1) rescan = true;
						if (!rescan)
							this.previous[filename] = { ...entry, mtimeMs: node.mtime.getTime() };
					} else rescan = true;
				}
			}
			if (rescan) this.previous = this.snapshot();
		} finally {
			this.muted = false;
		}
		for (const observer of this.observers) observer(patches, origin);
		if (publish) this.onChange(patches);
	}
}
