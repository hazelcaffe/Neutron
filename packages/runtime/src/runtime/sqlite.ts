import { Buffer } from "buffer";
import { EventEmitter } from "events";
import path from "path-browserify";
import type { BindParams, Database as SQLDatabase, SqlJsStatic, SqlValue, Statement } from "sql.js";
import { runtimePath } from "../shared/base";
import { noteStub } from "./fallback";
import type { VirtualFileSystem } from "./filesystem";

declare global {
	var __neutronSQLite: SqlJsStatic | undefined;
}

let engine: SqlJsStatic | undefined;
let initializing: Promise<void> | undefined;
/** The parser-blocking bootstrap initializes WASM before app scripts execute. */
function initializeRendererSQLite(): void {
	engine ??= globalThis.__neutronSQLite;
}
export function initializeSQLite(factory?: () => Promise<SqlJsStatic>): Promise<void> {
	initializing ??= (async () => {
		if (factory) engine = await factory();
		else {
			importScripts(runtimePath("vendor/sqlite/sql-wasm.js"));
			engine = await Reflect.get(
				globalThis,
				"initSqlJs",
			)({ locateFile: () => runtimePath("vendor/sqlite/sql-wasm.wasm") });
		}
	})();
	return initializing;
}
function sqliteError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return Object.assign(new Error(message), {
		name: "SqliteError",
		code: /UNIQUE constraint/.test(message)
			? "SQLITE_CONSTRAINT_UNIQUE"
			: /constraint/i.test(message)
				? "SQLITE_CONSTRAINT"
				: "SQLITE_ERROR",
		errno: 1,
	});
}
function parameters(args: unknown[]): BindParams {
	if (args.length === 1 && Array.isArray(args[0])) return parameters(args[0]);
	const convert = (value: unknown): SqlValue => {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			value instanceof Uint8Array
		)
			return value;
		if (typeof value === "bigint") {
			const number = Number(value);
			if (!Number.isSafeInteger(number))
				throw new RangeError("SQLite integer exceeds the safe JavaScript range");
			return number;
		}
		throw new TypeError("SQLite parameters must be numbers, strings, bigints, buffers or null");
	};
	if (
		args.length === 1 &&
		args[0] &&
		typeof args[0] === "object" &&
		!(args[0] instanceof Uint8Array)
	) {
		const result: Record<string, SqlValue> = {};
		for (const [name, value] of Object.entries(args[0]))
			for (const key of /^[::$@]/.test(name)
				? [name]
				: [name, `:${name}`, `$${name}`, `@${name}`])
				result[key] = convert(value);
		return result;
	}
	return args.map(convert);
}
function createSQLiteModules(vfs: VirtualFileSystem) {
	const connections = new Map<
		string,
		{ db: SQLDatabase; refs: number; dirty: boolean; transaction: number }
	>();
	class Database {
		readonly name: string;
		readonly memory: boolean;
		readonly readonly: boolean;
		open = true;
		private safe = false;
		private connection: { db: SQLDatabase; refs: number; dirty: boolean; transaction: number };
		private filename: string;
		constructor(
			filename: string | Uint8Array = ":memory:",
			options: {
				readonly?: boolean;
				fileMustExist?: boolean;
				verbose?: (sql: string) => void;
			} = {},
		) {
			initializeRendererSQLite();
			if (!engine)
				throw new Error("SQLite WASM is not initialized in this execution context");
			this.name = typeof filename === "string" ? filename : ":memory:";
			this.memory = !this.name || this.name === ":memory:";
			this.readonly = options.readonly === true;
			this.filename = path.resolve(vfs.cwd, vfs.normalizePath(this.name));
			const existing = !this.memory && connections.get(this.filename);
			if (existing) {
				this.connection = existing;
				existing.refs++;
			} else {
				const present = !this.memory && vfs.fs.existsSync(this.filename);
				if (!present && !this.memory && (this.readonly || options.fileMustExist))
					throw Object.assign(new Error(`Cannot open database: ${this.filename}`), {
						code: "SQLITE_CANTOPEN",
					});
				const bytes =
					filename instanceof Uint8Array
						? filename
						: present
							? (vfs.fs.readFileSync(this.filename) as Uint8Array)
							: undefined;
				if (
					bytes?.length &&
					new TextDecoder().decode(bytes.subarray(0, 16)) !== "SQLite format 3\0"
				)
					throw new Error(
						"Unsupported encrypted or invalid SQLite database; SQLCipher files require an encrypted database backend",
					);
				this.connection = {
					db: new engine.Database(bytes?.length ? bytes : undefined),
					refs: 1,
					dirty: !this.readonly,
					transaction: 0,
				};
				if (!this.memory) connections.set(this.filename, this.connection);
				this.persist();
			}
		}
		get inTransaction(): boolean {
			return this.connection.transaction > 0;
		}
		private check(): void {
			if (!this.open) throw new TypeError("The database connection is not open");
		}
		private persist(): void {
			if (!this.memory && this.connection.dirty && !this.inTransaction) {
				// sql.js 1.16 exports through SQLite's backup API, preserving live
				// connection pragmas and registered functions.
				vfs.fs.writeFileSync(this.filename, this.connection.db.export());
				this.connection.dirty = false;
			}
		}
		private done(sql: string, persist = true): void {
			const statement = sql.trim().replace(/^--[^\n]*\n/g, "");
			if (/^(BEGIN|SAVEPOINT)\b/i.test(statement)) this.connection.transaction++;
			else if (/^(COMMIT|END|ROLLBACK(?!\s+TO))\b/i.test(statement))
				this.connection.transaction = 0;
			else if (/^RELEASE\b/i.test(statement))
				this.connection.transaction = Math.max(0, this.connection.transaction - 1);
			if (!/^\s*(SELECT|EXPLAIN)\b/i.test(statement)) this.connection.dirty = true;
			if (persist) this.persist();
		}
		exec(sql: string): this {
			this.check();
			if (this.readonly && !/^\s*(SELECT|PRAGMA)\b/i.test(sql))
				throw Object.assign(new Error("attempt to write a readonly database"), {
					code: "SQLITE_READONLY",
				});
			try {
				for (const statement of this.connection.db.iterateStatements(sql)) {
					const source = statement.getSQL();
					while (statement.step()) {
						/* Execute every statement, including rows from PRAGMA. */
					}
					this.done(source, false);
				}
				this.persist();
				return this;
			} catch (error) {
				throw sqliteError(error);
			}
		}
		prepare(sql: string) {
			this.check();
			let binding: BindParams | undefined;
			let raw = false;
			let pluck = false;
			let safe = this.safe;
			const inspection = this.connection.db.prepare(sql);
			const names = inspection.getColumnNames();
			inspection.free();
			const reader = names.length > 0;
			const run = (args: unknown[], kind: "run" | "get" | "all") => {
				this.check();
				if (this.readonly && !/^\s*(SELECT|EXPLAIN|PRAGMA)\b/i.test(sql))
					throw Object.assign(new Error("attempt to write a readonly database"), {
						code: "SQLITE_READONLY",
					});
				let stmt: Statement | undefined;
				try {
					stmt = this.connection.db.prepare(sql);
					stmt.bind(binding || parameters(args));
					const rows: unknown[] = [];
					while (stmt.step()) {
						const values = stmt
							.get()
							.map((value) =>
								value instanceof Uint8Array
									? Buffer.from(value)
									: safe && typeof value === "number" && Number.isInteger(value)
										? BigInt(value)
										: value,
							);
						rows.push(
							pluck
								? values[0]
								: raw
									? values
									: Object.fromEntries(
											stmt
												.getColumnNames()
												.map((name, index) => [name, values[index]]),
										),
						);
						if (kind === "get") break;
					}
					stmt.free();
					stmt = undefined;
					const changes = this.connection.db.getRowsModified();
					const id =
						this.connection.db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ||
						0;
					this.done(sql);
					return kind === "run"
						? { changes, lastInsertRowid: safe ? BigInt(id as number) : id }
						: kind === "get"
							? rows[0]
							: rows;
				} catch (error) {
					throw sqliteError(error);
				} finally {
					stmt?.free();
				}
			};
			const result = {
				source: sql,
				database: this,
				reader,
				readonly: /^\s*(SELECT|EXPLAIN)\b/i.test(sql),
				busy: false,
				run: (...args: unknown[]) =>
					run(args, "run") as { changes: number; lastInsertRowid: number | bigint },
				get: (...args: unknown[]) => run(args, "get"),
				all: (...args: unknown[]) => run(args, "all") as unknown[],
				iterate: function* (...args: unknown[]) {
					yield* result.all(...args);
				},
				bind: (...args: unknown[]) => {
					binding = parameters(args);
					return result;
				},
				raw: (value = true) => {
					raw = value;
					return result;
				},
				pluck: (value = true) => {
					pluck = value;
					return result;
				},
				safeIntegers: (value = true) => {
					safe = value;
					return result;
				},
				columns: () =>
					names.map((name) => ({
						name,
						column: name,
						table: null,
						database: null,
						type: null,
					})),
			};
			return result;
		}
		pragma(source: string, options?: { simple?: boolean }): unknown {
			const stmt = this.prepare(`PRAGMA ${source}`);
			return options?.simple ? stmt.pluck().get() : stmt.all();
		}
		transaction<T extends (...args: unknown[]) => unknown>(fn: T) {
			const db = this;
			const wrap = (mode: string) =>
				function (this: unknown, ...args: unknown[]) {
					const nested = db.inTransaction;
					const savepoint = `neutron_${crypto.randomUUID().replaceAll("-", "")}`;
					db.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
					try {
						const value = fn.apply(this, args);
						if (value && typeof Reflect.get(Object(value), "then") === "function")
							throw new TypeError("Transaction functions must be synchronous");
						db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
						return value;
					} catch (error) {
						db.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
						if (nested) db.exec(`RELEASE ${savepoint}`);
						throw error;
					}
				};
			const transaction = wrap("");
			return Object.assign(transaction, {
				default: transaction,
				deferred: wrap("DEFERRED"),
				immediate: wrap("IMMEDIATE"),
				exclusive: wrap("EXCLUSIVE"),
				database: this,
			});
		}
		defaultSafeIntegers(value = true): this {
			this.safe = value;
			return this;
		}
		unsafeMode(): this {
			return this;
		}
		function(
			name: string,
			options:
				| { deterministic?: boolean; varargs?: boolean }
				| ((...args: SqlValue[]) => SqlValue),
			fn?: (...args: SqlValue[]) => SqlValue,
		): this {
			this.connection.db.create_function(
				name,
				typeof options === "function" ? options : (fn as (...args: SqlValue[]) => SqlValue),
			);
			return this;
		}
		serialize(): Buffer {
			this.check();
			if (this.inTransaction) throw new Error("Cannot serialize an active transaction");
			return Buffer.from(this.connection.db.export());
		}
		async backup(filename: string): Promise<object> {
			vfs.fs.writeFileSync(filename, this.serialize());
			return { totalPages: 0, remainingPages: 0 };
		}
		loadExtension(): never {
			throw new Error("SQLite native extensions cannot be loaded in WebAssembly");
		}
		close(): this {
			if (!this.open) return this;
			this.persist();
			this.open = false;
			if (--this.connection.refs === 0) {
				this.connection.db.close();
				if (!this.memory) connections.delete(this.filename);
			}
			return this;
		}
	}
	const BetterDatabase = new Proxy(Database, {
		apply: (target, _this, args) => Reflect.construct(target, args),
	});
	type Callback = (this: object, error: Error | null, value?: unknown) => void;
	class CallbackDatabase extends EventEmitter {
		open = false;
		private db?: Database;
		private queue = Promise.resolve();
		constructor(filename: string, mode?: number | Callback, callback?: Callback) {
			super();
			this.enqueue(
				() => {
					this.db = new Database(filename, {
						readonly: typeof mode === "number" && (mode & 1) !== 0,
						fileMustExist: typeof mode === "number" && (mode & 4) === 0,
					});
					this.open = true;
					this.emit("open");
				},
				typeof mode === "function" ? mode : callback,
			);
		}
		enqueue(work: () => unknown, callback?: Callback, receiver: object = this): this {
			this.queue = this.queue.then(() => {
				try {
					const value = work();
					callback?.call(receiver, null, value);
				} catch (error) {
					if (callback) callback.call(receiver, sqliteError(error));
					else this.emit("error", sqliteError(error));
				}
			});
			return this;
		}
		execute(
			kind: "run" | "get" | "all",
			sql: string,
			args: unknown[],
			receiver: object = this,
		): this {
			const callback =
				typeof args.at(-1) === "function" ? (args.pop() as Callback) : undefined;
			return this.enqueue(
				() => {
					if (!this.db) throw new Error("Database is not open");
					const value = this.db.prepare(sql)[kind](...args);
					if (kind === "run")
						Object.assign(receiver, {
							changes: (value as { changes: number }).changes,
							lastID: (value as { lastInsertRowid: number }).lastInsertRowid,
						});
					return value;
				},
				callback,
				receiver,
			);
		}
		run(sql: string, ...args: unknown[]): this {
			return this.execute("run", sql, args);
		}
		get(sql: string, ...args: unknown[]): this {
			return this.execute("get", sql, args);
		}
		all(sql: string, ...args: unknown[]): this {
			return this.execute("all", sql, args);
		}
		exec(sql: string, callback?: Callback): this {
			return this.enqueue(() => this.db?.exec(sql), callback);
		}
		close(callback?: Callback): this {
			return this.enqueue(() => {
				this.db?.close();
				this.open = false;
				this.emit("close");
			}, callback);
		}
		serialize(fn?: () => void): this {
			fn?.();
			return this;
		}
		parallelize(fn?: () => void): this {
			fn?.();
			return this;
		}
		configure(): void {}
		backupFile(filename: string, save: boolean): void {
			if (!this.db?.open) throw new Error("Database is not open");
			if (!save) throw new Error("Restoring into a live SQLite connection is not supported");
			vfs.fs.writeFileSync(filename, this.db.serialize());
		}
		prepare(sql: string, ...bound: unknown[]) {
			const callback =
				typeof bound.at(-1) === "function" ? (bound.pop() as Callback) : undefined;
			const stmt = new CallbackStatement(this, sql, callback);
			if (bound.length) stmt.bind(...bound);
			return stmt;
		}
	}
	class CallbackStatement extends EventEmitter {
		private bound: unknown[] = [];
		constructor(
			private db: CallbackDatabase,
			readonly sql: string,
			callback?: Callback,
		) {
			super();
			if (callback) db.enqueue(() => undefined, callback, this);
		}
		bind(...args: unknown[]): this {
			const callback =
				typeof args.at(-1) === "function" ? (args.pop() as Callback) : undefined;
			this.bound = args;
			this.db.enqueue(() => undefined, callback, this);
			return this;
		}
		run(...args: unknown[]): this {
			this.db.execute("run", this.sql, [...this.bound, ...args], this);
			return this;
		}
		get(...args: unknown[]): this {
			this.db.execute("get", this.sql, [...this.bound, ...args], this);
			return this;
		}
		all(...args: unknown[]): this {
			this.db.execute("all", this.sql, [...this.bound, ...args], this);
			return this;
		}
		finalize(callback?: Callback): this {
			this.db.enqueue(() => undefined, callback, this);
			return this;
		}
		reset(callback?: Callback): this {
			this.db.enqueue(() => undefined, callback, this);
			return this;
		}
	}
	class NativeDatabase extends Database {
		constructor(
			filename: string,
			_given: string,
			_anonymous: boolean,
			readonly: boolean,
			fileMustExist: boolean,
			_timeout: number,
			_verbose: unknown,
			bytes?: Uint8Array,
		) {
			super(bytes || filename, { readonly, fileMustExist });
		}
	}
	class Backup extends EventEmitter {
		completed = false;
		failed = false;
		idle = true;
		remaining = -1;
		pageCount = -1;
		constructor(
			private db: CallbackDatabase,
			private filename: string,
			private dest: string,
			private source: string,
			private save: boolean,
			callback?: Callback,
		) {
			super();
			this.db.enqueue(() => undefined, callback, this);
		}
		step(pages: number, callback?: Callback): this {
			this.db.enqueue(
				() => {
					try {
						if (this.dest !== "main" || this.source !== "main" || pages !== -1)
							throw new Error("Only whole-database SQLite backups are available");
						this.db.backupFile(this.filename, this.save);
						this.completed = true;
						this.remaining = 0;
					} catch (error) {
						this.failed = true;
						throw error;
					}
				},
				callback,
				this,
			);
			return this;
		}
		finish(callback?: Callback): this {
			this.db.enqueue(() => undefined, callback, this);
			return this;
		}
	}
	const sqlite3 = {
		Backup,
		Database: CallbackDatabase,
		Statement: CallbackStatement,
		OPEN_READONLY: 1,
		OPEN_READWRITE: 2,
		OPEN_CREATE: 4,
		OPEN_FULLMUTEX: 0x10000,
		verbose: () => sqlite3,
	};
	return {
		better: BetterDatabase,
		nativeBetter: {
			Database: NativeDatabase,
			initialize: () => {},
			isInitialized: true,
			setErrorConstructor: () => {},
		},
		sqlite3,
		flush: () => {
			for (const [filename, connection] of connections)
				if (connection.dirty && !connection.transaction) {
					vfs.fs.writeFileSync(filename, connection.db.export());
					connection.dirty = false;
				}
		},
		unsupportedCipher: () => noteStub("SQLCipher encryption (unavailable in SQLite WASM)"),
	};
}
const modules = new WeakMap<VirtualFileSystem, ReturnType<typeof createSQLiteModules>>();
export function sqliteModules(vfs: VirtualFileSystem): ReturnType<typeof createSQLiteModules> {
	let result = modules.get(vfs);
	if (!result) {
		result = createSQLiteModules(vfs);
		modules.set(vfs, result);
	}
	return result;
}
export function sqliteNativeAddon(filename: string, vfs: VirtualFileSystem): unknown {
	if (/(?:^|\/)(?:vscode-|node_)?sqlite3\.node$/.test(filename))
		return sqliteModules(vfs).sqlite3;
	if (/(?:^|\/)better_sqlite3\.node$/.test(filename)) return sqliteModules(vfs).nativeBetter;
}
