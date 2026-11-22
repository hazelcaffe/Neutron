import type { FilePatch, InstalledApp, RuntimeSettings, Snapshot } from "../shared/types";
import { type FileGate, requestRuntimeWorker } from "./runtime-worker";

type Directory = FileSystemDirectoryHandle & {
	entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

// A service worker is a separate agent cluster: it cannot receive the
// SharedArrayBuffers used for immutable snapshots in main/renderer workers.
function forServiceWorker(patch: FilePatch): FilePatch {
	const { entry } = patch;
	if (entry?.kind === "file" && !(entry.data.buffer instanceof ArrayBuffer))
		return { path: patch.path, entry: { ...entry, data: new Uint8Array(entry.data) } };
	if (
		entry?.kind === "directory" &&
		entry.archive &&
		!(entry.archive.buffer instanceof ArrayBuffer)
	)
		return { path: patch.path, entry: { ...entry, archive: new Uint8Array(entry.archive) } };
	return patch;
}
async function sendPatches(id: string, patches: FilePatch[], gate: FileGate): Promise<void> {
	return requestRuntimeWorker({
		type: "persist-files",
		id,
		patches: patches.map(forServiceWorker),
		gate,
	});
}
// OPFS has no utimes operation. Keep app-assigned mtimes separately; for
// installations from before this index existed, File.lastModified is the
// best preserved write time, not the time the app is mounted again.
async function readTimes(root: FileSystemDirectoryHandle): Promise<Record<string, number>> {
	try {
		const handle = await root.getFileHandle("mtimes.json");
		return JSON.parse(await (await handle.getFile()).text());
	} catch (error) {
		if (error instanceof DOMException && error.name === "NotFoundError") return {};
		throw error;
	}
}
async function directory(
	root: FileSystemDirectoryHandle,
	parts: string[],
	create = true,
): Promise<FileSystemDirectoryHandle> {
	let current = root;
	for (const part of parts) {
		if (!part || part === "." || part === ".." || part.includes("\\"))
			throw new Error("Invalid OPFS path.");
		current = await current.getDirectoryHandle(part, { create });
	}
	return current;
}
async function write(
	root: FileSystemDirectoryHandle,
	path: string,
	data: Uint8Array | string,
): Promise<void> {
	const parts = path.split("/").filter(Boolean);
	const name = parts.pop();
	if (!name) throw new Error("Cannot write root");
	const parent = await directory(root, parts);
	await writeFile(parent, name, data);
}
async function writeFile(
	parent: FileSystemDirectoryHandle,
	name: string,
	data: Uint8Array | string,
): Promise<void> {
	const file = await parent.getFileHandle(name, { create: true });
	const stream = await file.createWritable();
	try {
		await stream.write(
			typeof data === "string"
				? data
				: data.buffer instanceof ArrayBuffer
					? (data as Uint8Array<ArrayBuffer>)
					: new Uint8Array(data),
		);
		await stream.close();
	} catch (error) {
		await stream.abort();
		throw error;
	}
}

export class AppStorage {
	private root!: FileSystemDirectoryHandle;
	private pending: Promise<void> = Promise.resolve();
	private failure: unknown;
	/** Numbers this page's write announcements (see gateFiles in runtime-worker.ts). */
	private readonly stream = crypto.randomUUID();
	private sequence = 0;
	async init(): Promise<void> {
		if (!navigator.storage?.getDirectory)
			throw new Error(
				"Neutron requires OPFS. Use a current browser over HTTPS or localhost.",
			);
		this.root = await (await navigator.storage.getDirectory()).getDirectoryHandle("neutron", {
			create: true,
		});
	}
	async list(): Promise<InstalledApp[]> {
		const apps: InstalledApp[] = [];
		const root = await directory(this.root, ["apps"]);
		for await (const [, handle] of (root as Directory).entries()) {
			if (handle.kind !== "directory") continue;
			try {
				const file = await (handle as FileSystemDirectoryHandle).getFileHandle(
					"manifest.json",
				);
				apps.push(JSON.parse(await (await file.getFile()).text()));
			} catch {
				/* An interrupted import has no committed manifest. */
			}
		}
		return apps.sort((a, b) => b.installedAt - a.installedAt);
	}
	async install(app: InstalledApp, snapshot: Snapshot, archive?: Uint8Array): Promise<void> {
		const root = await directory(this.root, ["apps", app.id]);
		try {
			if (archive) await write(root, "archive.asar", archive);
			const handles = new Map<string, Promise<FileSystemDirectoryHandle>>([
				["", Promise.resolve(root)],
			]);
			const getDirectory = (value: string): Promise<FileSystemDirectoryHandle> => {
				const cached = handles.get(value);
				if (cached) return cached;
				const parts = value.split("/");
				const name = parts.pop() as string;
				const pending = getDirectory(parts.join("/")).then((parent) =>
					parent.getDirectoryHandle(name, { create: true }),
				);
				handles.set(value, pending);
				return pending;
			};
			const entries = Object.entries(snapshot);
			let cursor = 0;
			let failure: unknown;
			const links: Record<string, string> = {};
			const times: Record<string, number> = {};
			const results = await Promise.allSettled(
				Array.from({ length: 16 }, async () => {
					while (cursor < entries.length && !failure) {
						const item = entries[cursor++];
						if (!item) break;
						const [filename, entry] = item;
						try {
							if (entry.kind === "symlink") {
								links[filename] = entry.target;
								continue;
							}
							const mounted = `fs${filename}`;
							if (entry.kind === "directory") {
								await getDirectory(mounted);
								if (entry.archive)
									await write(root, `archives${filename}`, entry.archive);
							} else {
								if (entry.mtimeMs !== undefined) times[filename] = entry.mtimeMs;
								const index = mounted.lastIndexOf("/");
								await writeFile(
									await getDirectory(mounted.slice(0, index)),
									mounted.slice(index + 1),
									entry.data,
								);
							}
						} catch (error) {
							failure = error;
							throw error;
						}
					}
				}),
			);
			const rejected = results.find((result) => result.status === "rejected");
			if (rejected?.status === "rejected") throw rejected.reason;
			await write(root, "links.json", JSON.stringify(links));
			if (Object.keys(times).length) await write(root, "mtimes.json", JSON.stringify(times));
			await write(root, "manifest.json", JSON.stringify(app));
		} catch (error) {
			await this.remove(app.id);
			throw error;
		}
	}
	async load(
		id: string,
		options: { shared?: boolean; signal?: AbortSignal } = {},
	): Promise<Snapshot> {
		const appRoot = await directory(this.root, ["apps", id]);
		const root = await directory(appRoot, ["fs"]);
		const times = await readTimes(appRoot);
		const snapshot: Snapshot = {};
		const pendingReads = new Set<Promise<void>>();
		const read = async (file: File) => {
			options.signal?.throwIfAborted();
			if (!options.shared || file.size < 64 * 1024)
				return new Uint8Array(await file.arrayBuffer());
			const data = new Uint8Array(new SharedArrayBuffer(file.size));
			// Avoid a second archive-sized allocation just to fill a shared snapshot.
			const chunk = 4 * 1024 * 1024;
			for (let offset = 0; offset < file.size; offset += chunk) {
				options.signal?.throwIfAborted();
				data.set(
					new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer()),
					offset,
				);
			}
			return data;
		};
		let readFailure: unknown;
		const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, handle] of (dir as Directory).entries()) {
				options.signal?.throwIfAborted();
				if (readFailure) throw readFailure;
				const path = `${prefix}/${name}`;
				if (handle.kind === "directory") {
					snapshot[path] = { kind: "directory" };
					await walk(handle as FileSystemDirectoryHandle, path);
				} else {
					const job = (handle as FileSystemFileHandle)
						.getFile()
						.then(async (file) => {
							snapshot[path] = {
								kind: "file",
								data: await read(file),
								mtimeMs: times[path] ?? file.lastModified,
							};
						})
						.catch((error) => {
							readFailure = error;
						})
						.finally(() => pendingReads.delete(job));
					pendingReads.add(job);
					if (pendingReads.size >= 16) await Promise.race(pendingReads);
				}
			}
		};
		try {
			await walk(root, "");
		} finally {
			await Promise.all(pendingReads);
		}
		if (readFailure) throw readFailure;
		try {
			const archives = await directory(this.root, ["apps", id, "archives"], false);
			const restore = async (
				dir: FileSystemDirectoryHandle,
				prefix: string,
			): Promise<void> => {
				for await (const [name, handle] of (dir as Directory).entries()) {
					const path = `${prefix}/${name}`;
					if (handle.kind === "directory")
						await restore(handle as FileSystemDirectoryHandle, path);
					else if (snapshot[path]?.kind === "directory")
						snapshot[path] = {
							kind: "directory",
							archive: await read(await (handle as FileSystemFileHandle).getFile()),
						};
				}
			};
			await restore(archives, "");
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
		}
		try {
			const app = await directory(this.root, ["apps", id]);
			const links = JSON.parse(
				await (await (await app.getFileHandle("links.json")).getFile()).text(),
			) as Record<string, string>;
			for (const [path, target] of Object.entries(links))
				snapshot[path] = { kind: "symlink", target };
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
		}
		return snapshot;
	}
	enqueue(id: string, patches: FilePatch[]): void {
		// Announce mutations immediately, before a renderer can ask the service
		// worker to serve the same path. Sending inside this.pending.then(...)
		// would hide queued mutations from subsequent browser resource loads.
		const persisted = sendPatches(id, patches, { stream: this.stream, seq: ++this.sequence });
		this.pending = Promise.all([
			this.pending,
			persisted.catch((error: unknown) => {
				this.failure = error;
			}),
		]).then(() => {});
	}
	async flush(): Promise<void> {
		await this.pending;
		if (this.failure) {
			const error = this.failure;
			this.failure = undefined;
			throw error;
		}
	}
	async persist(id: string, patches: FilePatch[]): Promise<void> {
		const appRoot = await directory(this.root, ["apps", id], false);
		const times = await readTimes(appRoot);
		let timesChanged = false;
		const root = await directory(appRoot, ["fs"]);
		let links: Record<string, string> = {};
		try {
			links = JSON.parse(
				await (await (await appRoot.getFileHandle("links.json")).getFile()).text(),
			);
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
		}
		for (const { path, entry } of patches) {
			const parts = path.split("/").filter(Boolean);
			const name = parts.pop();
			if (!name) continue;
			const time = entry?.kind === "file" ? entry.mtimeMs : undefined;
			if (time !== times[path]) {
				timesChanged = true;
				if (time === undefined) delete times[path];
				else times[path] = time;
			}
			if (entry && entry.kind !== "symlink") {
				const parent = await directory(root, parts);
				try {
					if (entry.kind === "directory") await parent.getFileHandle(name);
					else await parent.getDirectoryHandle(name);
					await parent.removeEntry(name, { recursive: true });
				} catch (error) {
					if (
						!(
							error instanceof DOMException &&
							["NotFoundError", "TypeMismatchError"].includes(error.name)
						)
					)
						throw error;
				}
			}
			if (links[path]) delete links[path];
			if (!entry || entry.kind === "symlink") {
				try {
					await (await directory(root, parts, false)).removeEntry(name, {
						recursive: true,
					});
				} catch (error) {
					if (!(error instanceof DOMException && error.name === "NotFoundError"))
						throw error;
				}
				if (entry?.kind === "symlink") links[path] = entry.target;
			} else if (entry.kind === "directory") {
				await directory(root, [...parts, name]);
				if (entry.archive) await write(appRoot, `archives${path}`, entry.archive);
			} else {
				await write(root, path, entry.data);
			}
		}
		await write(appRoot, "links.json", JSON.stringify(links));
		if (timesChanged) await write(appRoot, "mtimes.json", JSON.stringify(times));
	}
	async updateManifest(app: InstalledApp): Promise<void> {
		await write(
			await directory(this.root, ["apps", app.id]),
			"manifest.json",
			JSON.stringify(app),
		);
	}
	async remove(id: string): Promise<void> {
		await this.flush();
		await (await directory(this.root, ["apps"])).removeEntry(id, { recursive: true });
	}
	async settings(): Promise<RuntimeSettings> {
		try {
			return JSON.parse(
				await (await (await this.root.getFileHandle("settings.json")).getFile()).text(),
			);
		} catch (error) {
			if (error instanceof DOMException && error.name === "NotFoundError")
				return { wisp: "" };
			throw error;
		}
	}
	async saveSettings(settings: RuntimeSettings): Promise<void> {
		await write(this.root, "settings.json", JSON.stringify(settings));
	}
}
