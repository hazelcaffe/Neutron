import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { neutralizeDebugger } from "../src/shared/scramjet-debugger";

describe("Scramjet debugger-statement workaround", () => {
	it("keeps Scramjet output valid for single-statement debugger positions", async () => {
		Reflect.set(globalThis, "self", globalThis);
		const scramjet = await import("@mercuryworkshop/scramjet/bundled-wasm");
		const url = new URL("file:///resources/app.asar/bundle.js");
		const rewrite = (code: string) => {
			const output = scramjet.rewriteJs(
				code,
				null,
				{
					config: scramjet.defaultConfig,
					prefix: new URL("https://host.invalid/__scramjet__/"),
					cookieJar: new scramjet.CookieJar(),
					interface: { codecEncode: encodeURIComponent, codecDecode: decodeURIComponent },
				},
				{ origin: url, base: url },
				false,
			);
			return typeof output === "string" ? output : new TextDecoder().decode(output);
		};
		const valid = (code: string) =>
			parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
		expect(() => valid(rewrite("function f(a){if(a)debugger}"))).toThrow();
		for (const source of [
			"function f(a){if(a)debugger}",
			"debugger;run()",
			"do debugger; while(false)",
			"label: debugger\n(run)()",
			"if (a) debugger /* note */ ; else run()",
			"const text = 'debugger'; // debugger\nrun(text)",
		]) {
			const fixed = neutralizeDebugger(source, false);
			expect(fixed).toHaveLength(source.length);
			expect(fixed).not.toMatch(/^debugger|[^'/ ]debugger/);
			expect(() => valid(fixed)).not.toThrow();
			expect(() => valid(rewrite(fixed))).not.toThrow();
		}
		expect(neutralizeDebugger("const text = 'debugger'", false)).toBe(
			"const text = 'debugger'",
		);
		const bytes = new TextEncoder().encode("if(x)debugger");
		expect(new TextDecoder().decode(neutralizeDebugger(bytes, false))).toBe("if(x);       ");
	});
});
