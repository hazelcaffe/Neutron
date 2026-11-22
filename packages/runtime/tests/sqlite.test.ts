import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { initializeSQLite, sqliteModules } from "../src/runtime/sqlite";

beforeAll(() => initializeSQLite(() => initSqlJs()));
describe("SQLite WASM compatibility", () => {
	it("executes bound queries and nested transactions, persists real SQLite bytes, and reopens", () => {
		const vfs = new VirtualFileSystem({ "/tmp": { kind: "directory" } }, () => {});
		const { better: Database } = sqliteModules(vfs);
		const db = new Database("/tmp/state.db");
		db.exec(
			"CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE, bytes BLOB); PRAGMA user_version=3;",
		);
		const insert = db.prepare("INSERT INTO items (name,bytes) VALUES (@name,@bytes)");
		expect(insert.run({ name: "first", bytes: Buffer.from([0, 255]) })).toEqual({
			changes: 1,
			lastInsertRowid: 1,
		});
		const nested = db.transaction(() => {
			insert.run({ name: "rolled back", bytes: null });
			throw new Error("cancel");
		});
		db.transaction(() => {
			expect(() => nested()).toThrow("cancel");
			insert.run({ name: "second", bytes: null });
		})();
		expect(db.inTransaction).toBe(false);
		expect(db.prepare("SELECT name FROM items ORDER BY id").pluck().all()).toEqual([
			"first",
			"second",
		]);
		expect(db.pragma("user_version", { simple: true })).toBe(3);
		db.function("twice", (value) => Number(value) * 2);
		expect(db.prepare("SELECT twice(21)").pluck().get()).toBe(42);
		db.close();
		expect(
			Buffer.from(vfs.fs.readFileSync("/tmp/state.db") as Uint8Array)
				.subarray(0, 16)
				.toString(),
		).toBe("SQLite format 3\0");
		const restored = new VirtualFileSystem(vfs.snapshot(), () => {});
		const reopened = new (sqliteModules(restored).better)("/tmp/state.db");
		expect(reopened.prepare("SELECT bytes FROM items WHERE name=?").get("first")).toEqual({
			bytes: Buffer.from([0, 255]),
		});
		reopened.close();
	});
	it("preserves callback ordering, statement event methods and run callback metadata", async () => {
		const vfs = new VirtualFileSystem({ "/tmp": { kind: "directory" } }, () => {});
		const { Database } = sqliteModules(vfs).sqlite3;
		await new Promise<void>((resolve, reject) => {
			const db = new Database("/tmp/callback.db");
			db.on("error", reject);
			db.serialize(() => {
				db.run("CREATE TABLE test (value TEXT)");
				const stmt = db.prepare("INSERT INTO test VALUES (?)");
				stmt.on("error", reject);
				stmt.run(
					"persisted",
					function (this: { changes: number; lastID: number }, error: Error | null) {
						if (error) {
							reject(error);
							return;
						}
						expect(this.changes).toBe(1);
						expect(this.lastID).toBe(1);
					},
				);
				stmt.finalize();
				db.get("SELECT value FROM test", (error: Error | null, row: unknown) => {
					if (error) {
						reject(error);
						return;
					}
					expect(row).toEqual({ value: "persisted" });
					db.close((error) => (error ? reject(error) : resolve()));
				});
			});
		});
	});
	it("rejects incompatible encrypted files and does not pretend to load native extensions", () => {
		const vfs = new VirtualFileSystem({ "/tmp": { kind: "directory" } }, () => {});
		vfs.fs.writeFileSync("/tmp/encrypted", new Uint8Array(256).fill(8));
		const { better: Database } = sqliteModules(vfs);
		expect(() => new Database("/tmp/encrypted")).toThrow("encrypted or invalid");
		const db = new Database();
		expect(() => db.loadExtension()).toThrow("native extensions");
		db.close();
	});
});
