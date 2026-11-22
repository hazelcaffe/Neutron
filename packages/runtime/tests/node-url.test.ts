import * as native from "node:url";
import { describe, expect, it } from "vitest";
import * as shim from "../src/runtime/node-url";

function outcome(run: () => string) {
	try {
		return { value: run() };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return { name: error.name, code: Reflect.get(error, "code") };
	}
}

describe("node:url file conversions", () => {
	it("preserves the named exports used by the host browser bundles", () => {
		expect(shim.URL).toBe(globalThis.URL);
		expect(shim.URLSearchParams).toBe(globalThis.URLSearchParams);
		const url = shim.pathToFileURL("asset%2Fname");
		expect(url).toBeInstanceOf(shim.URL);
		expect(url.href).toBe(native.pathToFileURL("/asset%2Fname", { windows: false }).href);
		expect(shim.fileURLToPath(url)).toBe("/asset%2Fname");
	});

	it.each([
		{
			windows: false,
			paths: [
				"/",
				"/tmp/a%2Fb#c?d e",
				"/tmp/雪/🙂/a\\b",
				"/a/.//b/../c/",
				"//server/share/",
				"/a/%2E%2E/../%2e%2e",
				"/case/\u0000\t\r\n\ud800",
				"/punctuation/!\"$%&'()*+,-.:;<=>?@[\\]^_`{|}~",
			],
		},
		{
			windows: true,
			paths: [
				"C:\\",
				"c:/app/雪/🙂/a%2Fb#c?d e",
				"D:\\sub\\.\\dir\\..\\c/",
				"C:\\dir\\literal%5Cname",
				"\\\\Files\\share\\name%#?",
				"\\\\münchen.example\\Bücher\\",
				"//Files/share/dir",
				"\\\\?\\UNC\\server\\share\\name",
				"\\\\?\\C:\\dir\\name",
			],
		},
	])("matches native path encoding and round-trips (windows: $windows)", ({ windows, paths }) => {
		const api = shim.fileURLModule(process.platform, () => "/virtual");
		for (const path of paths) {
			const expected = native.pathToFileURL(path, { windows });
			const actual = api.pathToFileURL(path, { windows });
			expect(actual.href, path).toBe(expected.href);
			expect(api.fileURLToPath(actual, { windows }), path).toBe(
				native.fileURLToPath(expected, { windows }),
			);
		}
	});

	it.each([false, true])(
		"matches native URL decoding and error codes (windows: %s)",
		(windows) => {
			const api = shim.fileURLModule(windows ? "win32" : "linux", () => "/virtual");
			for (const value of [
				"file:///C:/dir/雪%23%3F%25?q=%2F#%5C",
				new URL("file://localhost/C:/a%252F%255C"),
				"file:///C:/with%5Cseparator",
				"file:///C:/with%5cseparator",
				"file:///C:/with%2Fseparator",
				"file:///C:/with%2fseparator",
				"file://xn--mnchen-3ya.example/share/%E9%9B%AA",
				"file://server/share%2fname",
				"file:///folder/not-a-drive",
				"file:///%43%3a/folder",
				"file:///C:/bad%FF",
				"file:///C:/bad%",
				"https://example.invalid/file",
				new URL("data:text/plain,file"),
				"relative/name",
			]) {
				expect(
					outcome(() => api.fileURLToPath(value)),
					String(value),
				).toEqual(outcome(() => native.fileURLToPath(value, { windows })));
			}
		},
	);

	it("resolves relative names against the current guest cwd and honors platform overrides", () => {
		let cwd = "/virtual/first";
		const posix = shim.fileURLModule("darwin", () => cwd);
		const win32 = shim.fileURLModule("win32", () => cwd);
		const name = "sub\\name%#?";
		expect(posix.pathToFileURL(name).href).toBe(
			native.pathToFileURL(`/virtual/first/${name}`, { windows: false }).href,
		);
		cwd = "/C:/virtual/second";
		const expected = native.pathToFileURL(`C:\\virtual\\second\\${name}`, { windows: true });
		expect(win32.pathToFileURL(name).href).toBe(expected.href);
		expect(posix.pathToFileURL(name, { windows: true }).href).toBe(expected.href);
		expect(win32.pathToFileURL(name, { windows: false }).href).toBe(
			native.pathToFileURL(`/virtual/second/${name}`, { windows: false }).href,
		);
		expect(win32.fileURLToPath(expected, { windows: false })).toBe(
			native.fileURLToPath(expected, { windows: false }),
		);
		expect(win32.pathToFileURL("c:relative").href).toBe(
			native.pathToFileURL("c:\\virtual\\second\\relative", { windows: true }).href,
		);
		expect(win32.pathToFileURL("D:relative").href).toBe(
			native.pathToFileURL("D:\\relative", { windows: true }).href,
		);
	});

	it("rejects invalid UNC authorities and non-path inputs like Node", () => {
		for (const path of ["\\\\server", "\\\\\\share", "\\\\bad host\\share", "\\\\a:\\share"]) {
			expect(
				outcome(() => shim.pathToFileURL(path, { windows: true }).href),
				path,
			).toEqual(outcome(() => native.pathToFileURL(path, { windows: true }).href));
		}
		for (const input of [undefined, null, 123, { href: "file:///x" }, new URL("file:///x")]) {
			const path = input as unknown as string;
			expect(outcome(() => shim.pathToFileURL(path).href)).toEqual(
				outcome(() => native.pathToFileURL(path).href),
			);
			expect(outcome(() => shim.fileURLToPath(path))).toEqual(
				outcome(() => native.fileURLToPath(path, { windows: false })),
			);
		}
	});
});
