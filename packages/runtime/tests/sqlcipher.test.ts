import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { initializeSQLCipher, signalSQLCipherAddon, signalTokens } from "../src/runtime/sqlcipher";

const require = createRequire(import.meta.url);
const KEY = `x'${"a1".repeat(32)}'`;
type Method =
	| "databaseOpen"
	| "databaseInitTokenizer"
	| "databaseClose"
	| "databaseExec"
	| "databaseCreateFunction"
	| "statementNew"
	| "statementClose"
	| "statementRun"
	| "statementStep"
	| "signalTokenize";
type Addon = Record<Method, (...args: unknown[]) => unknown>;

beforeAll(() =>
	initializeSQLCipher(async () => {
		const file = require.resolve("@journeyapps/wa-sqlite/dist/mc-wa-sqlite.mjs");
		return {
			factory: (await import(file)).default,
			wasm: new Uint8Array(readFileSync(file.replace(/\.mjs$/, ".wasm"))),
		};
	}),
);

/** Mirrors @signalapp/sqlcipher's JavaScript wrapper calls into its addon. */
function client(addon: Addon, filename: string) {
	const db = addon.databaseOpen(filename);
	const query = (
		sql: string,
		params?: unknown[],
		options: { persistent?: boolean; pluck?: boolean; bigint?: boolean } = {},
	) => {
		const names: unknown[] = [];
		const statement = addon.statementNew(
			db,
			sql,
			options.persistent === true,
			options.pluck === true,
			options.bigint === true,
			names,
		);
		const rows: unknown[] = [];
		let cache: unknown;
		let bound: unknown = params;
		try {
			while (true) {
				const row = addon.statementStep(statement, bound, cache, false);
				bound = null;
				if (row === undefined) break;
				if (options.persistent && !options.pluck) {
					cache = row;
					const values = row as unknown[];
					const half = values.length / 2;
					rows.push(
						Object.fromEntries(
							values
								.slice(0, half)
								.map((name, index) => [name, values[half + index]]),
						),
					);
				} else rows.push(row);
			}
		} finally {
			addon.statementClose(statement);
		}
		return { rows, names };
	};
	const run = (sql: string, params?: unknown[]) => {
		const names: unknown[] = [];
		const statement = addon.statementNew(db, sql, false, false, false, names);
		const result = [0, 0];
		try {
			addon.statementRun(statement, params, result);
		} finally {
			addon.statementClose(statement);
		}
		return result;
	};
	return {
		db,
		query,
		run,
		exec: (sql: string) => addon.databaseExec(db, sql),
		close: () => addon.databaseClose(db),
	};
}
function errorOf(fn: () => unknown): { message: string; code?: unknown } | undefined {
	try {
		fn();
	} catch (error) {
		return { message: (error as Error).message, code: (error as { code?: unknown }).code };
	}
	return undefined;
}

describe("Signal SQLCipher WebAssembly addon", () => {
	it("encrypts with a raw key, rejects the wrong key and reopens from the virtual filesystem", () => {
		const patches: string[] = [];
		const vfs = new VirtualFileSystem({ "/data": { kind: "directory" } }, (changes) =>
			patches.push(...changes.map((patch) => patch.path)),
		);
		const addon = signalSQLCipherAddon(vfs) as Addon;
		const db = client(addon, "/data/db.sqlite");
		db.query(`PRAGMA key = "${KEY}"`);
		expect(db.query("PRAGMA journal_mode = WAL").rows).toEqual([{ journal_mode: "delete" }]);
		db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT, data BLOB, count INTEGER)");
		expect(
			db.run("INSERT INTO messages VALUES (?, ?, ?, ?)", [
				"a",
				"secret body",
				Buffer.from([0, 1, 2]),
				2n ** 40n,
			]),
		).toEqual([1, 1]);
		db.close();
		const bytes = vfs.raw.readFileSync("/data/db.sqlite") as Uint8Array;
		expect(Buffer.from(bytes).includes("secret body")).toBe(false);
		expect(Buffer.from(bytes.subarray(0, 15)).toString()).not.toBe("SQLite format 3");
		expect(patches).toContain("/data/db.sqlite");
		expect(vfs.raw.existsSync("/data/db.sqlite-journal")).toBe(false);

		const reopened = new VirtualFileSystem(vfs.snapshot(), () => {});
		const second = signalSQLCipherAddon(reopened) as Addon;
		const wrong = client(second, "/data/db.sqlite");
		wrong.query(`PRAGMA key = "x'${"b2".repeat(32)}'"`);
		expect(errorOf(() => wrong.query("SELECT * FROM messages"))).toEqual({
			message: "sqlite error(SQLITE_NOTADB): file is not a database",
			code: "SQLITE_NOTADB",
		});
		wrong.close();
		const right = client(second, "/data/db.sqlite");
		right.query(`PRAGMA key = "${KEY}"`);
		expect(
			right.query("SELECT body, data, count FROM messages", undefined, { persistent: true })
				.rows,
		).toEqual([{ body: "secret body", data: Buffer.from([0, 1, 2]), count: 2 ** 40 }]);
		expect(
			right.query("SELECT count FROM messages", undefined, { pluck: true, bigint: true })
				.rows,
		).toEqual([2n ** 40n]);
		right.close();
	});

	it("matches native addon semantics for params, errors, functions and transactions", () => {
		const vfs = new VirtualFileSystem({ "/data": { kind: "directory" } }, () => {});
		const addon = signalSQLCipherAddon(vfs) as Addon;
		const db = client(addon, "/data/api.sqlite");
		db.exec("CREATE TABLE t (a, b)");
		expect(db.query("SELECT $first AS x, ? AS y", ["one", 2]).names).toEqual(["first", null]);
		expect(errorOf(() => db.query("SELECT ?", []))?.message).toBe(
			"Expected 1 parameters, got 0",
		);
		expect(errorOf(() => db.query("SELECT ?", [true]))?.message).toBe(
			"Failed to bind param 1, error unexpected type `boolean`",
		);
		expect(errorOf(() => db.query("SELECT 1; SELECT 2"))?.message).toBe(
			"Can't prepare more than one statement",
		);
		expect(db.query("SELECT 1 AS one; -- trailing comment").rows).toEqual([{ one: 1 }]);
		expect(errorOf(() => db.exec("SELECT nope"))).toEqual({
			message: "sqlite error(SQLITE_ERROR): no such column: nope, offset: 7",
			code: "SQLITE_ERROR",
		});
		db.exec("CREATE UNIQUE INDEX unique_a ON t(a)");
		db.run("INSERT INTO t VALUES (1, 1)");
		expect(errorOf(() => db.run("INSERT INTO t VALUES (1, 2)"))?.code).toBe(
			"SQLITE_CONSTRAINT_UNIQUE",
		);
		expect(errorOf(() => db.query("SELECT 1, 2", undefined, { pluck: true }))?.message).toBe(
			"Invalid column count for pluck",
		);
		const calls: unknown[][] = [];
		addon.databaseCreateFunction(
			db.db,
			"observe",
			(...args: unknown[]) => {
				calls.push(args);
			},
			false,
		);
		expect(db.query("SELECT observe(1, 'two', x'03', NULL, 2.5) AS value").rows).toEqual([
			{ value: null },
		]);
		expect(calls).toEqual([[1, "two", Buffer.from([3]), null, 2.5]]);
		addon.databaseCreateFunction(db.db, "returns", () => 1, false);
		expect(errorOf(() => db.query("SELECT returns()"))?.message).toContain(
			"Function must not return a value",
		);
		db.exec(
			"BEGIN; INSERT INTO t VALUES (2, 2); SAVEPOINT nested; INSERT INTO t VALUES (3, 3); ROLLBACK TO nested; RELEASE nested; COMMIT",
		);
		expect(db.query("SELECT a FROM t ORDER BY a", undefined, { pluck: true }).rows).toEqual([
			1, 2,
		]);
		expect(db.run("UPDATE t SET b = 0 WHERE a = 99")[0]).toBe(0);
		// Signal's native build enables SQLITE_ENABLE_UPDATE_DELETE_LIMIT.
		db.exec("CREATE TABLE queue (id INTEGER PRIMARY KEY, at INTEGER)");
		db.exec("INSERT INTO queue (at) VALUES (30), (10), (20), (40)");
		expect(
			(
				db.query("DELETE FROM queue RETURNING id ORDER BY at ASC LIMIT $size;", [2], {
					pluck: true,
				}).rows as number[]
			).sort(),
		).toEqual([2, 3]);
		expect(db.run("DELETE FROM queue WHERE at > ? LIMIT ?", [0, 1])[0]).toBe(1);
		expect(db.query("SELECT count(*) FROM queue", undefined, { pluck: true }).rows).toEqual([
			1,
		]);
		expect(errorOf(() => db.query("DELETE FROM missing LIMIT 1"))?.message).toBe(
			"sqlite error(SQLITE_ERROR): no such table: missing",
		);
		db.close();
		expect(errorOf(() => addon.databaseExec(db.db, "SELECT 1"))?.message).toBe(
			"Database closed",
		);
	});

	it("registers signal_tokenizer for FTS5 and tokenizes like Signal's extension", () => {
		expect(
			signalTokens("Hello DïācRîtįcs world! 知识? https://www.youtube.com/watch?v=test").map(
				(token) => token.value,
			),
		).toEqual([
			"hello",
			"diacritics",
			"world",
			"知",
			"识",
			"https",
			"www.youtube.com",
			"youtube.com",
			"watch",
			"v",
			"test",
		]);
		expect(signalTokens("www.example.com", 1).map((token) => token.value)).toEqual([
			"www.example.com",
		]);
		expect(signalTokens("https://a:b@example.com:1234/").map((token) => token.value)).toEqual([
			"https",
			"a:b",
			"example.com",
			"1234",
		]);
		expect(signalTokens("youtube.com.").map((token) => token.value)).toEqual(["youtube.com"]);
		expect(
			signalTokens("hello world! 知识? 안녕 세상").map(({ value, start, end }) => [
				value,
				start,
				end,
			]),
		).toEqual([
			["hello", 0, 5],
			["world", 6, 11],
			["知", 13, 16],
			["识", 16, 19],
			// Like Signal's extension, NFD folding decomposes Hangul syllables.
			["안녕".normalize("NFD"), 21, 27],
			["세상".normalize("NFD"), 28, 34],
		]);
		const vfs = new VirtualFileSystem({ "/data": { kind: "directory" } }, () => {});
		const addon = signalSQLCipherAddon(vfs) as Addon;
		const db = client(addon, "/data/fts.sqlite");
		addon.databaseInitTokenizer(db.db);
		db.exec(
			"CREATE VIRTUAL TABLE messages_fts USING fts5(body, tokenize = 'signal_tokenizer')",
		);
		db.run("INSERT INTO messages_fts (rowid, body) VALUES (1, ?)", [
			"Café meeting at https://www.example.com/agenda",
		]);
		db.run("INSERT INTO messages_fts (rowid, body) VALUES (2, ?)", ["Unrelated note"]);
		const search = (term: string) =>
			db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", [term], {
				pluck: true,
			}).rows;
		expect(search('"cafe"*')).toEqual([1]);
		expect(search('"example.com"')).toEqual([1]);
		expect(search('"agenda"')).toEqual([1]);
		expect(search('"note"')).toEqual([2]);
		expect(addon.signalTokenize("Ünïcödé")).toEqual(["unicode"]);
		db.close();
	});

	const native = process.env.NEUTRON_SIGNAL_SQLCIPHER_ADDON;
	it.skipIf(!native)("interoperates with Signal's native SQLCipher addon", () => {
		const loaded = { exports: {} as Addon };
		process.dlopen(loaded, native as string);
		const real = loaded.exports;
		const directory = mkdtempSync(join(tmpdir(), "neutron-sqlcipher-"));
		try {
			const vfs = new VirtualFileSystem({ "/data": { kind: "directory" } }, () => {});
			const addon = signalSQLCipherAddon(vfs) as Addon;
			const created = client(addon, "/data/shared.sqlite");
			created.query(`PRAGMA key = "${KEY}"`);
			created.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('from wasm')");
			created.close();
			writeFileSync(
				join(directory, "shared.sqlite"),
				vfs.raw.readFileSync("/data/shared.sqlite") as Uint8Array,
			);
			const opened = client(real, join(directory, "shared.sqlite"));
			opened.query(`PRAGMA key = "${KEY}"`);
			expect(opened.query("SELECT body FROM notes", undefined, { pluck: true }).rows).toEqual(
				["from wasm"],
			);
			opened.exec("INSERT INTO notes VALUES ('from native')");
			for (const sql of ["SELECT nope", "SELECT 1; SELECT 2"])
				expect(errorOf(() => opened.query(sql))).toEqual(
					errorOf(() => client(addon, "/data/compare.sqlite").query(sql)),
				);
			opened.close();
			const roundTrip = new VirtualFileSystem({ "/data": { kind: "directory" } }, () => {});
			roundTrip.raw.writeFileSync(
				"/data/shared.sqlite",
				readFileSync(join(directory, "shared.sqlite")),
			);
			const back = client(signalSQLCipherAddon(roundTrip) as Addon, "/data/shared.sqlite");
			back.query(`PRAGMA key = "${KEY}"`);
			expect(back.query("SELECT body FROM notes", undefined, { pluck: true }).rows).toEqual([
				"from wasm",
				"from native",
			]);
			back.close();
			for (const sample of [
				"Hello DïācRîtįcs world! 知识? https://www.youtube.com/watch?v=test email@a.b.c.com git+ssh://example.com/ amazon.co.uk",
				"안녕 세상 こんにちは 世界 カタカナ ﬁle Straße İstanbul ΣΑΣ ÅNGSTRÖM",
				"don't foo_bar 3.14 a:b e-mail me@x.org http://x.org/a_b emoji 😀 #tag @user",
				"x.y blog.google 1.2.3.4 user@example.com:80/path (see example.org/x). youtube.com.",
			])
				expect(addon.signalTokenize(sample)).toEqual(real.signalTokenize(sample));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
