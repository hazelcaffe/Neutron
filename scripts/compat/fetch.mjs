import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createBrotliDecompress, gunzipSync } from "node:zlib";
import { extractFile } from "@electron/asar";
import { catalog } from "./catalog.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const seven = require("7zip-bin").path7za;
const cache = resolve(process.env.NEUTRON_APP_CACHE || ".cache/compat-apps");
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const selected = requested.length ? catalog.filter((app) => requested.includes(app.id)) : catalog;
if (requested.some((id) => !catalog.some((app) => app.id === id)))
	throw new Error("Unknown app ID. See scripts/compat/catalog.mjs.");
await mkdir(cache, { recursive: true });
await chmod(seven, 0o755);

async function get(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`${response.status} ${url}`);
	return response;
}
async function resolveDownload(app) {
	if (app.url) return { url: app.url };
	if (app.resolver === "github-release") {
		const releases = await (
			await get(`https://api.github.com/repos/${app.repo}/releases?per_page=30`)
		).json();
		const pattern = new RegExp(app.asset);
		const release = releases.find(
			(release) =>
				!release.prerelease &&
				!release.draft &&
				release.assets.some((asset) => pattern.test(asset.name)),
		);
		const asset = release?.assets.find((asset) => pattern.test(asset.name));
		if (!asset) throw new Error(`No matching stable vendor asset for ${app.repo}`);
		return {
			url: asset.browser_download_url,
			version: release.tag_name,
			sha256: asset.digest?.replace(/^sha256:/, ""),
		};
	}
	if (app.resolver === "discord") {
		const manifest = await (
			await get(
				"https://updates.discord.com/distributions/app/manifests/latest?channel=stable&platform=linux&arch=x64",
			)
		).json();
		return {
			url: manifest.full.url,
			sha256: manifest.full.package_sha256,
			version: manifest.full.host_version.join("."),
			discordManifest: manifest,
		};
	}
	if (app.resolver === "notion") {
		const base = "https://desktop-release.notion-static.com/";
		const text = await (await get(`${base}latest.yml`)).text();
		const file = /^path:\s*(.+)$/m.exec(text)?.[1];
		if (!file) throw new Error("No installer in Notion update manifest");
		return {
			url: new URL(file, base).href,
			version: /^version:\s*(.+)$/m.exec(text)?.[1],
			sha512: /^sha512:\s*(.+)$/m.exec(text)?.[1],
		};
	}
	if (app.resolver === "signal") {
		const base = "https://updates.signal.org/desktop/apt/";
		const data = new Uint8Array(
			await (await get(`${base}dists/xenial/main/binary-amd64/Packages.gz`)).arrayBuffer(),
		);
		const entries = gunzipSync(data)
			.toString()
			.split("\n\n")
			.filter((entry) => entry.startsWith("Package: signal-desktop\n"))
			.map((entry) =>
				Object.fromEntries(
					entry.split("\n").map((line) => {
						const colon = line.indexOf(":");
						return [line.slice(0, colon), line.slice(colon + 1).trim()];
					}),
				),
			);
		entries.sort((a, b) => b.Version.localeCompare(a.Version, undefined, { numeric: true }));
		const entry = entries[0];
		if (!entry) throw new Error("No Signal amd64 package");
		return {
			url: new URL(entry.Filename, base).href,
			version: entry.Version,
			sha256: entry.SHA256,
		};
	}
	if (app.resolver === "slack") {
		const html = await (
			await get("https://slack.com/downloads/instructions/linux?ddl=1&build=deb")
		).text();
		const url = html.match(/https:\/\/downloads\.slack-edge\.com\/[^\s"<>]+\.deb/)?.[0];
		if (!url) throw new Error("No DEB link on Slack's download instructions");
		return { url };
	}
	if (app.resolver === "obsidian") {
		const release = await (
			await get("https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest")
		).json();
		const asset = release.assets.find((asset) => /^obsidian-[\d.]+\.tar\.gz$/.test(asset.name));
		if (!asset) throw new Error("No Obsidian Linux tarball");
		return {
			url: asset.browser_download_url,
			version: release.tag_name,
			sha256: asset.digest?.replace(/^sha256:/, ""),
		};
	}
	throw new Error(`No resolver: ${app.id}`);
}
async function fingerprint(filename, algorithm = "sha256", encoding = "hex") {
	const hash = createHash(algorithm);
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest(encoding);
}
async function findResources(root, depth = 0) {
	if (depth > 9) return [];
	const entries = await readdir(root, { withFileTypes: true });
	if (
		/^[Rr]esources$/.test(basename(root)) &&
		entries.some((entry) => entry.name === "app.asar" || entry.name === "app")
	)
		return [root];
	const found = [];
	for (const entry of entries)
		if (
			entry.isDirectory() &&
			!entry.name.startsWith("node_modules") &&
			!entry.name.startsWith("locales")
		)
			found.push(...(await findResources(join(root, entry.name), depth + 1)));
	return found;
}
async function nestedArchives(root, depth = 0) {
	if (depth > 4) return [];
	const found = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) found.push(...(await nestedArchives(path, depth + 1)));
		else if (/\.nupkg$|^app.*\.(7z|zip)$/i.test(entry.name)) found.push(path);
	}
	return found;
}
async function unpack(app, artifact, output) {
	await mkdir(output, { recursive: true });
	if (app.format === "distro") {
		const tar = `${artifact}.tar`;
		await pipeline(
			createReadStream(artifact),
			createBrotliDecompress(),
			createWriteStream(tar),
		);
		await execute("tar", ["-xf", tar, "-C", output], {
			timeout: 180_000,
			maxBuffer: 1024 * 1024,
		});
	} else if (app.format === "deb")
		await execute("dpkg-deb", ["-x", artifact, output], {
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
		});
	else if (app.format === "tar.gz")
		await execute("tar", ["-xzf", artifact, "-C", output], {
			timeout: 180_000,
			maxBuffer: 1024 * 1024,
		});
	else
		await execute(seven, ["x", artifact, `-o${output}`, "-y", "-bso0", "-bsp0"], {
			timeout: 180_000,
			maxBuffer: 1024 * 1024,
		});
	const roots = await findResources(output);
	if (!roots.length) {
		for (const [index, archive] of (await nestedArchives(output)).entries()) {
			const destination = join(output, `nested-${index}`);
			await execute(seven, ["x", archive, `-o${destination}`, "-y", "-bso0", "-bsp0"], {
				timeout: 180_000,
				maxBuffer: 1024 * 1024,
			});
			roots.push(...(await findResources(destination)));
		}
	}
	return roots;
}
async function obtain(app) {
	const dir = join(cache, app.id);
	await mkdir(dir, { recursive: true });
	const manifest = join(dir, "manifest.json");
	let existing;
	try {
		existing = JSON.parse(await readFile(manifest, "utf8"));
		if (
			!process.argv.includes("--refresh") &&
			!process.argv.includes("--reextract") &&
			(existing.resources ||
				existing.status === "unavailable" ||
				existing.status === "not-electron-resources")
		) {
			console.log(`${app.id}: cached ${existing.package?.version || existing.status}`);
			return existing;
		}
	} catch {}
	const record = {
		id: app.id,
		name: app.name,
		source: app.source,
		checkedAt: new Date().toISOString(),
	};
	try {
		if (app.unavailable) {
			Object.assign(record, {
				status: "unavailable",
				reason: app.unavailable,
				attempted: app.attempted,
			});
		} else {
			const resolved =
				process.argv.includes("--reextract") && existing?.sha256
					? {
							url: existing.requestedURL,
							sha256: existing.sha256,
							version: existing.version,
							...(app.id === "discord"
								? {
										discordManifest: JSON.parse(
											await readFile(join(dir, "distribution.json"), "utf8"),
										),
									}
								: {}),
						}
					: await resolveDownload(app);
			const artifact = join(dir, `download.${app.format}`);
			let present = false;
			try {
				present = (await stat(artifact)).size > 0;
			} catch {}
			if (!present || process.argv.includes("--refresh")) {
				console.log(`${app.id}: downloading ${resolved.url}`);
				const response = await fetch(resolved.url, {
					signal: AbortSignal.timeout(240_000),
				});
				if (!response.ok || !response.body)
					throw new Error(`Download HTTP ${response.status}`);
				if (response.headers.get("content-type")?.includes("text/html"))
					throw new Error("Download returned an HTML page");
				await pipeline(
					Readable.fromWeb(response.body),
					createWriteStream(`${artifact}.partial`),
				);
				await rename(`${artifact}.partial`, artifact);
				record.downloadURL = response.url;
			}
			const sha256 = await fingerprint(artifact);
			if (resolved.sha256 && sha256 !== resolved.sha256)
				throw new Error("SHA-256 mismatch against vendor metadata");
			if (
				resolved.sha512 &&
				(await fingerprint(artifact, "sha512", "base64")) !== resolved.sha512
			)
				throw new Error("SHA-512 mismatch against vendor metadata");
			Object.assign(record, {
				requestedURL: resolved.url,
				sha256,
				bytes: (await stat(artifact)).size,
				version: resolved.version,
			});
			if (resolved.discordManifest)
				await writeFile(
					join(dir, "distribution.json"),
					JSON.stringify(resolved.discordManifest, null, 2),
				);
			console.log(`${app.id}: extracting resources`);
			const roots = await unpack(app, artifact, join(dir, "unpacked"));
			const resources = roots.find((root) => !root.includes("arm64")) || roots[0];
			if (!resources)
				Object.assign(record, {
					status: "not-electron-resources",
					reason: "The downloaded distribution contains no resources/app.asar or resources/app directory.",
					topLevel: await readdir(join(dir, "unpacked")),
				});
			else {
				let pkg;
				try {
					pkg = JSON.parse(
						extractFile(join(resources, "app.asar"), "package.json").toString(),
					);
				} catch (error) {
					// Inventory metadata without rejecting a vendor-specific sentinel elsewhere
					// in the archive; Neutron's real parser is exercised by the browser sweep.
					try {
						const bytes = await readFile(join(resources, "app.asar"));
						const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)));
						const node = header.files["package.json"];
						const start = 8 + bytes.readUInt32LE(4) + Number(node.offset);
						pkg = JSON.parse(bytes.subarray(start, start + node.size));
						record.metadataWarning = String(error);
					} catch {
						pkg = JSON.parse(
							await readFile(join(resources, "app", "package.json"), "utf8"),
						);
					}
				}
				Object.assign(record, {
					status: "ready",
					resources,
					package: {
						name: pkg.name,
						version: pkg.version,
						main: pkg.main || "index.js",
						type: pkg.type,
					},
				});
				if (resolved.discordManifest) {
					const modules = [];
					for (const name of Object.keys(resolved.discordManifest.modules).sort()) {
						const part = resolved.discordManifest.modules[name]?.full;
						if (!part) continue;
						const downloaded = join(dir, `${name}.distro`);
						try {
							if ((await fingerprint(downloaded)) !== part.package_sha256)
								throw new Error("stale");
						} catch {
							console.log(`discord: downloading ${name}`);
							const response = await get(part.url);
							await pipeline(
								Readable.fromWeb(response.body),
								createWriteStream(downloaded),
							);
						}
						if ((await fingerprint(downloaded)) !== part.package_sha256)
							throw new Error(`Checksum mismatch: ${name}`);
						const moduleRoot = join(dir, "modules", name);
						await unpack({ format: "distro" }, downloaded, moduleRoot);
						await cp(join(moduleRoot, "files"), join(resources, "node_modules", name), {
							recursive: true,
						});
						modules.push({
							name,
							version: part.module_version,
							url: part.url,
							sha256: part.package_sha256,
						});
					}
					record.modules = modules;
					record.resourceFingerprint = createHash("sha256")
						.update(sha256 + modules.map((module) => module.sha256).join(""))
						.digest("hex");
				}
			}
		}
	} catch (error) {
		Object.assign(record, { status: "download-or-extraction-failed", error: String(error) });
	}
	await writeFile(manifest, JSON.stringify(record, null, 2));
	console.log(
		`${app.id}: ${record.status} ${record.package?.version || record.error || record.reason || ""}`,
	);
	return record;
}
const queue = [...selected];
await Promise.all(
	Array.from({ length: 2 }, async () => {
		while (queue.length) {
			const app = queue.shift();
			if (app) await obtain(app);
		}
	}),
);
