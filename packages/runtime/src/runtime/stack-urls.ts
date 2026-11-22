// Chromium names a frame's script by the URL it was loaded from. Scramjet
// loads proxied scripts from `/__scramjet__/<session>/<encoded URL>`, so
// without this every `Error.stack` frame names the proxy URL instead. Code
// that inspects stacks (crash reporters, webpack instance detection by
// bundle file name) then misidentifies the script. V8 formats a stack
// lazily through `Error.prepareStackTrace`; the default formatter here
// produces V8's own format and only maps the frame URLs back. A function the
// page assigns still receives the unmodified call sites.
type CallSites = { toString(): string }[];
type PrepareStackTrace = (error: unknown, sites: CallSites) => unknown;

function errorString(error: unknown): string {
	const name = Reflect.get(Object(error), "name");
	const message = Reflect.get(Object(error), "message");
	const label = name === undefined ? "Error" : String(name);
	const text = message === undefined ? "" : String(message);
	return !label ? text : !text ? label : `${label}: ${text}`;
}
function header(error: unknown): string {
	try {
		return errorString(error);
	} catch (thrown) {
		try {
			return errorString(thrown);
		} catch {
			return "<error>";
		}
	}
}

export function installStackURLs(
	scope: typeof globalThis,
	prefix: string,
	unmap: (url: string) => string,
): void {
	const ErrorConstructor = scope.Error;
	const existing = Object.getOwnPropertyDescriptor(ErrorConstructor, "prepareStackTrace");
	if (existing && !existing.configurable) return;
	const escaped = prefix.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
	// A frame location is `url:line:column`, possibly inside an eval origin.
	const location = new RegExp(`${escaped}[^\\s()]*`, "g");
	const original = (value: string) => {
		const [, url = value, position = ""] = /^(.*?)((?::\d+){1,2})?$/.exec(value) ?? [];
		try {
			return unmap(url) + position;
		} catch {
			return value;
		}
	};
	const frame = (site: { toString(): string }) => {
		try {
			return String(site).replace(location, original);
		} catch {
			return "<error>";
		}
	};
	const format = function prepareStackTrace(error: unknown, sites: CallSites): string {
		let stack = header(error);
		for (const site of sites) stack += `\n    at ${frame(site)}`;
		return stack;
	};
	let assigned: unknown = existing && "value" in existing ? existing.value : undefined;
	Object.defineProperty(ErrorConstructor, "prepareStackTrace", {
		configurable: true,
		enumerable: false,
		get: (): PrepareStackTrace =>
			typeof assigned === "function" ? (assigned as PrepareStackTrace) : format,
		// Restoring a previously read value (this formatter) restores the default.
		set: (value: unknown) => {
			assigned = value === format ? undefined : value;
		},
	});
}
