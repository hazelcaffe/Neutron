import { Buffer } from "buffer";
import browserCrypto from "crypto-browserify";
import path from "path-browserify";
import type { VirtualFileSystem } from "./filesystem";

const crypto = browserCrypto as unknown as typeof import("node:crypto");

// The keytar native addon's binding (getPassword, setPassword, ...). The OS
// credential store becomes an AES-GCM encrypted file in the app's private
// browser storage, like this runtime's safeStorage. Every call re-reads the
// file so the main process, renderers and workers share one keychain.
const DIR = "/home/user/.local/share/keyrings";
const STORE = path.join(DIR, "neutron-keytar.bin");
const KEY = path.join(DIR, ".neutron-keytar-key");
const MAGIC = "NKT1";

type Entries = Record<string, Record<string, string>>;

function invalid(name: string): never {
	throw new Error(`${name} is required.`);
}

export function keytarAddon(vfs: VirtualFileSystem) {
	const key = (): Buffer => {
		if (!vfs.fs.existsSync(KEY)) {
			vfs.fs.mkdirSync(DIR, { recursive: true });
			vfs.fs.writeFileSync(KEY, crypto.randomBytes(32));
		}
		return Buffer.from(vfs.fs.readFileSync(KEY) as Uint8Array);
	};
	const read = (): Entries => {
		if (!vfs.fs.existsSync(STORE)) return {};
		const data = Buffer.from(vfs.fs.readFileSync(STORE) as Uint8Array);
		if (data.toString("ascii", 0, 4) !== MAGIC) throw new Error("Unreadable credential store");
		const decipher = crypto.createDecipheriv("aes-256-gcm", key(), data.subarray(4, 16));
		decipher.setAuthTag(data.subarray(16, 32));
		const json = Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
		return JSON.parse(json.toString("utf8")) as Entries;
	};
	const write = (entries: Entries) => {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
		const body = Buffer.concat([
			cipher.update(JSON.stringify(entries), "utf8"),
			cipher.final(),
		]);
		vfs.fs.mkdirSync(DIR, { recursive: true });
		vfs.fs.writeFileSync(
			STORE,
			Buffer.concat([Buffer.from(MAGIC), iv, cipher.getAuthTag(), body]),
		);
	};
	const check = (service: unknown, account?: unknown, accountRequired = true) => {
		if (typeof service !== "string" || !service) invalid("Service");
		if (accountRequired && (typeof account !== "string" || !account)) invalid("Account");
	};
	// The native binding settles asynchronously on its own thread.
	const run = <T>(work: () => T) =>
		new Promise<T>((resolve, reject) =>
			queueMicrotask(() => {
				try {
					resolve(work());
				} catch (error) {
					reject(error);
				}
			}),
		);
	return {
		getPassword: (service: string, account: string) =>
			run(() => {
				check(service, account);
				return read()[service]?.[account] ?? null;
			}),
		setPassword: (service: string, account: string, password: string) =>
			run(() => {
				check(service, account);
				if (typeof password !== "string" || !password) invalid("Password");
				const entries = read();
				entries[service] = { ...entries[service], [account]: password };
				write(entries);
			}),
		deletePassword: (service: string, account: string) =>
			run(() => {
				check(service, account);
				const entries = read();
				if (!entries[service] || !(account in entries[service])) return false;
				delete entries[service][account];
				if (!Object.keys(entries[service]).length) delete entries[service];
				write(entries);
				return true;
			}),
		findPassword: (service: string) =>
			run(() => {
				check(service, undefined, false);
				return Object.values(read()[service] ?? {})[0] ?? null;
			}),
		findCredentials: (service: string) =>
			run(() => {
				check(service, undefined, false);
				return Object.entries(read()[service] ?? {}).map(([account, password]) => ({
					account,
					password,
				}));
			}),
	};
}
