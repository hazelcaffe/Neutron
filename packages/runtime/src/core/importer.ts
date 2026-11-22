import { unzipSync } from "fflate";
import path from "path-browserify";
import type { AppManifest, InstalledApp, Snapshot } from "../shared/types";
import { parseAsar } from "./asar";
import { scanCompatibility } from "./compatibility";

export interface ResourceFile {
	path: string;
	data: Uint8Array;
}
export interface LaunchCandidate {
	appPath: string;
	manifest: AppManifest;
	declaredMain?: string;
	entryPoint?: string;
	choices: string[];
	issue?: string;
}
export interface PreparedBundle {
	name: string;
	kind: "folder" | "zip" | "example";
	root: string;
	size: number;
	importedFiles: number;
	snapshot: Snapshot;
	archives: string[];
	missing: string[];
	candidates: LaunchCandidate[];
	suggested?: number;
}
export type ImportProgress = (message: string) => void;
const MAX_FILES = 250_000;
const MAX_EXPANDED = 2 * 1024 ** 3;
// Electron resources live next to the executable, not next to the user's home
// directory. Apps use the parent of resourcesPath as their installation root.
const resourcesPath = "/neutron/resources";

export function resourcePath(value: string): string {
	const normalized = value.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:/.test(normalized) ||
		normalized.includes("\0") ||
		normalized.split("/").some((part) => part === "." || part === "..")
	)
		throw new Error(`Invalid resource path: ${value}`);
	return normalized.replace(/\/+$/, "");
}
export function readZip(data: Uint8Array): ResourceFile[] {
	let total = 0;
	let count = 0;
	const names = new Set<string>();
	const entries = unzipSync(data, {
		filter: (entry) => {
			const name = resourcePath(entry.name);
			if (name.startsWith("__MACOSX/") || name.endsWith("/.DS_Store") || name === ".DS_Store")
				return false;
			if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
			names.add(name);
			count++;
			total += entry.originalSize;
			if (count > MAX_FILES || total > MAX_EXPANDED)
				throw new Error(
					"The extracted ZIP exceeds the runtime's 2 GiB / 250,000-entry import limit.",
				);
			return !entry.name.endsWith("/");
		},
	});
	return Object.entries(entries).map(([filename, data]) => ({
		path: resourcePath(filename),
		data,
	}));
}

function resourceRoot(files: ResourceFile[], kind: PreparedBundle["kind"]): string {
	const paths = files.map((file) => file.path);
	if (paths.some((name) => ["app.asar", "app/package.json", "package.json"].includes(name)))
		return "";
	const roots = new Set<string>();
	for (const filename of paths) {
		const parts = filename.split("/");
		for (let index = 0; index < parts.length - 1; index++) {
			if (parts[index]?.toLowerCase() === "resources")
				roots.add(`${parts.slice(0, index + 1).join("/")}/`);
		}
	}
	const usable = [...roots].filter((root) =>
		paths.some((filename) => {
			const relative = filename.slice(root.length);
			return (
				filename.startsWith(root) &&
				(/^[^/]+\.asar$/.test(relative) ||
					relative === "app/package.json" ||
					relative === "package.json")
			);
		}),
	);
	const outer = usable.filter(
		(root) => !usable.some((parent) => parent !== root && root.startsWith(parent)),
	);
	if (outer.length > 1)
		throw new Error(
			"This import contains more than one application's resources folder. Zip or select one resources folder at a time.",
		);
	if (outer[0]) return outer[0];
	if (kind === "folder") {
		const first = paths[0]?.split("/")[0];
		return first && paths.every((name) => name.startsWith(`${first}/`)) ? `${first}/` : "";
	}
	// Accept the contents of resources, or a ZIP with one enclosing directory.
	let prefix = "";
	while (true) {
		const first = paths[0]?.slice(prefix.length).split("/")[0];
		if (!first || !paths.every((name) => name.startsWith(`${prefix}${first}/`))) break;
		prefix += `${first}/`;
	}
	// A sole app/ directory is part of Electron's resources layout, not an enclosing wrapper.
	if (prefix.endsWith("app/")) prefix = prefix.slice(0, -4);
	return prefix;
}

function realPath(snapshot: Snapshot, filename: string): string {
	let resolved = path.resolve("/", filename);
	for (let depth = 0; depth < 40; depth++) {
		const segments = resolved.split("/").filter(Boolean);
		let changed = false;
		for (let index = 0; index < segments.length; index++) {
			const prefix = `/${segments.slice(0, index + 1).join("/")}`;
			const entry = snapshot[prefix];
			if (entry?.kind !== "symlink") continue;
			resolved = path.resolve(
				path.dirname(prefix),
				entry.target,
				...segments.slice(index + 1),
			);
			changed = true;
			break;
		}
		if (!changed) return resolved;
	}
	throw new Error(`Too many symbolic links while resolving ${filename}`);
}
export function resolveEntry(
	snapshot: Snapshot,
	filename: string,
	visited = new Set<string>(),
): string | undefined {
	const logical = path.join(realPath(snapshot, path.dirname(filename)), path.basename(filename));
	const resolved = realPath(snapshot, logical);
	if (visited.has(resolved)) return;
	visited.add(resolved);
	for (const suffix of ["", ".js", ".cjs", ".mjs", ".json"]) {
		const candidate = realPath(snapshot, resolved + suffix);
		if (snapshot[candidate]?.kind === "file") {
			const archive = /^(.+\.asar)\/(.+)$/.exec(logical + suffix);
			return archive && candidate === `${archive[1]}.unpacked/${archive[2]}`
				? logical + suffix
				: candidate;
		}
	}
	const pkg = snapshot[`${resolved}/package.json`];
	if (pkg?.kind === "file") {
		const manifest = JSON.parse(new TextDecoder().decode(pkg.data)) as { main?: unknown };
		if (typeof manifest.main === "string") {
			const result = resolveEntry(snapshot, path.resolve(resolved, manifest.main), visited);
			if (result) return result;
		}
	}
	for (const name of ["index.js", "index.cjs", "index.mjs"]) {
		const candidate = realPath(snapshot, `${resolved}/${name}`);
		if (snapshot[candidate]?.kind === "file") return candidate;
	}
}

function launchCandidate(snapshot: Snapshot, appPath: string): LaunchCandidate | undefined {
	const entry = snapshot[`${appPath}/package.json`];
	if (entry?.kind !== "file") return;
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(new TextDecoder().decode(entry.data));
	} catch {
		return;
	}
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return;
	const declaredMain = typeof pkg.main === "string" ? pkg.main : undefined;
	const requested = path.resolve(appPath, declaredMain || "index.js");
	const entryPoint = resolveEntry(snapshot, requested);
	const choices = Object.keys(snapshot)
		.filter(
			(filename) =>
				filename.startsWith(`${appPath}/`) &&
				!filename.includes("/node_modules/") &&
				/\.[cm]?js$/.test(filename) &&
				snapshot[filename]?.kind === "file",
		)
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	const manifest: AppManifest = {
		name:
			typeof pkg.productName === "string"
				? pkg.productName
				: typeof pkg.name === "string"
					? pkg.name
					: path.basename(appPath),
		version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
		main: declaredMain || "index.js",
		description: typeof pkg.description === "string" ? pkg.description : undefined,
		type: typeof pkg.type === "string" ? pkg.type : undefined,
	};
	return {
		appPath,
		manifest,
		declaredMain,
		entryPoint,
		choices,
		issue: entryPoint
			? undefined
			: declaredMain
				? `package.json declares “${declaredMain}”, but ${requested} is missing. Import the complete installation resources, or select the correct main-process file.`
				: `This package does not declare a main entry, and ${requested} does not exist. It may be a renderer/update archive rather than the Electron bootstrap. Import the full resources folder or choose its main-process entry explicitly.`,
	};
}

export function prepareResources(
	files: ResourceFile[],
	name: string,
	kind: PreparedBundle["kind"],
	progress: ImportProgress = () => {},
): PreparedBundle {
	if (!files.length) throw new Error("The selected resources folder or ZIP is empty.");
	if (files.length > MAX_FILES) throw new Error("Too many resource files.");
	const normalized = files.map((file) => ({ ...file, path: resourcePath(file.path) }));
	const root = resourceRoot(normalized, kind);
	const snapshot: Snapshot = { [resourcesPath]: { kind: "directory" } };
	const names = new Set<string>();
	let size = 0;
	let expanded = 0;
	for (const file of normalized) {
		if (!file.path.startsWith(root)) continue;
		const relative = file.path.slice(root.length);
		if (!relative || relative.startsWith("__MACOSX/") || relative.endsWith(".DS_Store"))
			continue;
		const filename = `${resourcesPath}/${relative}`;
		if (names.has(filename)) throw new Error(`Duplicate resource path: ${relative}`);
		names.add(filename);
		size += file.data.byteLength;
		if (size > MAX_EXPANDED)
			throw new Error("The resources exceed the 2 GiB in-memory import limit.");
		snapshot[filename] = { kind: "file", data: file.data };
	}
	const archives: string[] = [];
	const missing: string[] = [];
	const queue = Object.keys(snapshot).filter((filename) => filename.endsWith(".asar"));
	while (queue.length) {
		const filename = queue.shift();
		if (!filename) continue;
		const entry = snapshot[filename];
		if (entry?.kind !== "file") continue;
		progress(`Mounting ${filename.slice(resourcesPath.length + 1)}…`);
		let parsed: ReturnType<typeof parseAsar>;
		try {
			parsed = parseAsar(entry.data, filename);
		} catch (error) {
			throw new Error(`Cannot read ${filename}: ${String(error)}`);
		}
		expanded += Object.values(parsed.snapshot).reduce(
			(size, entry) => size + (entry.kind === "file" ? entry.data.length : 0),
			0,
		);
		if (
			expanded + size > MAX_EXPANDED ||
			Object.keys(snapshot).length + parsed.fileCount > MAX_FILES
		)
			throw new Error("Expanded ASAR resources exceed the runtime's import limit.");
		archives.push(filename);
		Object.assign(snapshot, parsed.snapshot);
		snapshot[filename] = { kind: "directory", archive: entry.data };
		for (const unpacked of parsed.unpacked) {
			const external = `${filename}.unpacked${unpacked.slice(filename.length)}`;
			if (snapshot[external]?.kind === "file")
				snapshot[unpacked] = { kind: "symlink", target: external };
			else missing.push(external);
		}
		for (const [child, data] of Object.entries(parsed.snapshot))
			if (child !== filename && child.endsWith(".asar") && data.kind === "file")
				queue.push(child);
	}
	// Complete directory entries before installing, including loose resources and unpacked trees.
	for (const filename of Object.keys(snapshot)) {
		let parent = path.dirname(filename);
		while (parent !== "/") {
			const existing = snapshot[parent];
			if (existing && existing.kind !== "directory")
				throw new Error(`A resource file conflicts with a directory: ${parent}`);
			snapshot[parent] ??= { kind: "directory" };
			parent = path.dirname(parent);
		}
	}
	const primaryRoots = [`${resourcesPath}/app.asar`, `${resourcesPath}/app`];
	const candidates = [...primaryRoots, resourcesPath, ...archives]
		.filter((value, index, values) => values.indexOf(value) === index)
		.map((root) => launchCandidate(snapshot, root))
		.filter((item): item is LaunchCandidate => Boolean(item));
	if (!candidates.length)
		throw new Error(
			"No Electron application package was found. Choose the installed app’s resources folder (containing app.asar or app/package.json), or a ZIP of that folder. A renderer-only update archive is not a complete application.",
		);
	const primary = candidates.filter((candidate) => primaryRoots.includes(candidate.appPath));
	const preferred =
		primary.length === 1
			? primary[0]
			: primary.length === 0 && candidates.length === 1
				? candidates[0]
				: undefined;
	progress("Validating launch entry and companion files…");
	return {
		name,
		kind,
		root: root.replace(/\/$/, "") || "resources",
		size,
		importedFiles: names.size,
		snapshot,
		archives,
		missing,
		candidates,
		suggested: preferred ? candidates.indexOf(preferred) : undefined,
	};
}

export function finalizeBundle(
	bundle: PreparedBundle,
	candidateIndex: number,
	override?: string,
): { app: InstalledApp; snapshot: Snapshot } {
	const candidate = bundle.candidates[candidateIndex];
	if (!candidate) throw new Error("Select an application package.");
	const entryPoint = override
		? resolveEntry(bundle.snapshot, path.resolve(candidate.appPath, override))
		: candidate.entryPoint;
	if (!entryPoint || !/\.[cm]?js$/.test(entryPoint))
		throw new Error(candidate.issue || "Select an existing JavaScript main-process entry.");
	const snapshot: Snapshot = {
		...bundle.snapshot,
		"/app": { kind: "symlink", target: candidate.appPath },
		"/resources": { kind: "symlink", target: resourcesPath },
	};
	const findings = scanCompatibility(snapshot);
	for (const filename of bundle.missing)
		findings.push({
			api: "asar.unpacked",
			status: "unsupported",
			file: filename,
			notes: "Referenced companion file is absent from the imported resources folder.",
		});
	const manifest = { ...candidate.manifest, main: path.relative(candidate.appPath, entryPoint) };
	const app: InstalledApp = {
		id: crypto.randomUUID(),
		manifest,
		appPath: candidate.appPath,
		entryPoint,
		resourcesPath,
		filename: bundle.name,
		size: bundle.size,
		fileCount: Object.values(snapshot).filter((entry) => entry.kind === "file").length,
		installedAt: Date.now(),
		findings,
		bundle: {
			kind: bundle.kind,
			root: bundle.root,
			archives: bundle.archives,
			missing: bundle.missing,
			importedFiles: bundle.importedFiles,
		},
	};
	return { app, snapshot };
}
