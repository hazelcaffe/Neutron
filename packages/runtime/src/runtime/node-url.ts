import posix from "path-browserify";
import win32 from "path-win32";
import { toUnicode } from "punycode/";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

interface FileURLOptions {
	windows?: boolean;
}

function urlError(code: string, message: string, input?: string | URL) {
	return Object.assign(new TypeError(message), { code }, input === undefined ? {} : { input });
}

function parseURL(value: string): URL {
	try {
		return new URL(value);
	} catch {
		throw urlError("ERR_INVALID_URL", "Invalid URL", value);
	}
}

function resolveWindows(cwd: string, value: string): string {
	// The VFS stores drive-qualified working directories under /C:/, and can also
	// have drive-less roots like /app. Never fall back to process.cwd() or =C:.
	const directory = cwd.replace(/^\/(?=[a-z]:[\\/])/i, "").replaceAll("\\", "/");
	const path = value.replaceAll("\\", "/");
	const device = /^(?:[a-z]:|\/\/[^/]+\/+[^/]+)/i;
	const root = device.exec(path)?.[0] ?? device.exec(directory)?.[0];
	return root
		? win32.resolve(`${root}/`, directory, path)
		: posix.resolve("/", directory, path).replaceAll("/", "\\");
}

function fromUNC(path: string): URL {
	const start = path.startsWith("\\\\?\\UNC\\") ? 8 : 2;
	const end = path.indexOf("\\", start);
	if (end < 0 || end === start)
		throw urlError(
			"ERR_INVALID_ARG_VALUE",
			end < 0 ? "Missing UNC resource path" : "Empty UNC servername",
		);
	const host = path.slice(start, end);
	const url = parseURL(`file://${host}/`);
	// A drive in a file URL's authority is parsed as a local path, not a host.
	if (/^\/[a-z]:/i.test(url.pathname)) throw urlError("ERR_INVALID_URL", "Invalid URL", host);
	url.search = "";
	url.hash = "";
	url.pathname = encodePath(path.slice(end).replaceAll("\\", "/"));
	return url;
}

function encodePath(path: string): string {
	// encodeURI keeps '/' and ':' and escapes literal percent signs and controls.
	// Node also encodes these three characters, unlike encodeURI.
	return encodeURI(path.toWellFormed()).replace(/[?#~]/g, (c) =>
		c === "?" ? "%3F" : c === "#" ? "%23" : "%7E",
	);
}

export function fileURLModule(platform: string, cwd: () => string) {
	const isWindows = platform === "win32";
	return {
		URL,
		URLSearchParams,
		pathToFileURL(path: string, options?: FileURLOptions): URL {
			if (typeof path !== "string")
				throw urlError("ERR_INVALID_ARG_TYPE", 'The "path" argument must be a string');
			const windows = options?.windows ?? isWindows;
			if (windows && path.startsWith("\\\\")) return fromUNC(path);
			let directory = cwd();
			if (isWindows && !windows)
				// Node's path.posix on Windows uses the cwd without the drive prefix.
				directory = directory.replaceAll("\\", "/").replace(/^\/?[a-z]:(?=\/)/i, "");
			let resolved = windows
				? resolveWindows(directory, path)
				: posix.resolve("/", directory, path);
			if (windows && resolved.startsWith("\\\\")) return fromUNC(resolved);
			// Node checks path.sep (the process platform) even with an explicit windows option.
			if (
				(path.endsWith("/") || (windows && path.endsWith("\\"))) &&
				!resolved.endsWith(isWindows ? "\\" : "/")
			)
				resolved += "/";
			const url = new URL("file:///");
			url.pathname = encodePath(windows ? resolved.replaceAll("\\", "/") : resolved);
			return url;
		},
		fileURLToPath(value: string | URL, options?: FileURLOptions): string {
			const url = typeof value === "string" ? parseURL(value) : value;
			// Accept WHATWG URLs from other realms, as node:url does; not legacy url.parse().
			if (!url?.href || !url.protocol || "auth" in url || "path" in url)
				throw urlError(
					"ERR_INVALID_ARG_TYPE",
					'The "path" argument must be a string or URL',
				);
			if (url.protocol !== "file:")
				throw urlError("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
			const windows = options?.windows ?? isWindows;
			if (!windows && url.hostname)
				throw urlError(
					"ERR_INVALID_FILE_URL_HOST",
					`File URL host must be "localhost" or empty on ${platform}`,
				);
			if ((windows ? /%(?:2f|5c)/i : /%2f/i).test(url.pathname))
				throw urlError(
					"ERR_INVALID_FILE_URL_PATH",
					`File URL path must not include encoded ${windows ? "\\ or /" : "/"} characters`,
					url,
				);
			const path = decodeURIComponent(url.pathname);
			if (!windows) return path;
			const local = path.replaceAll("/", "\\");
			if (url.hostname) return `\\\\${toUnicode(url.hostname)}${local}`;
			if (!/^\\[a-z]:/i.test(local))
				throw urlError("ERR_INVALID_FILE_URL_PATH", "File URL path must be absolute", url);
			return local.slice(1);
		},
	};
}

// Host bundles alias node:url here (notably memfs). They have no guest process.
export const { fileURLToPath, pathToFileURL } = fileURLModule("linux", () => "/");
