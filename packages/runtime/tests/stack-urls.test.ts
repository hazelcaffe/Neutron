import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { installStackURLs } from "../src/runtime/stack-urls";

const prefix = "http://host.invalid/__scramjet__/session/";
const proxied = (url: string) =>
	`${prefix}${encodeURIComponent(url)}?%24io=https%3A%2F%2Fexample.com`;
const unmap = (url: string) =>
	decodeURIComponent(new URL(url).pathname.slice("/__scramjet__/session/".length));

describe("proxied Error.stack URLs", () => {
	it("formats V8 stacks with original script URLs and keeps assigned formatters", () => {
		const context = vm.createContext({});
		installStackURLs(vm.runInContext("globalThis", context), prefix, unmap);
		const run = (code: string, url: string) =>
			vm.runInContext(code, context, { filename: proxied(url) });
		run(
			"function capture(){return new Error('probe')}",
			"https://example.com/assets/bundle.js",
		);
		const stack = run("capture().stack", "https://example.com/assets/main.js") as string;
		expect(stack).toMatch(
			/^Error: probe\n {4}at capture \(https:\/\/example\.com\/assets\/bundle\.js:1:\d+\)\n {4}at https:\/\/example\.com\/assets\/main\.js:1:1/,
		);
		expect(stack).not.toContain("__scramjet__");
		expect(
			run("(()=>{try{null.x}catch(e){return e.stack}})()", "https://example.com/a.js"),
		).toMatch(/^TypeError: .*\n {4}at https:\/\/example\.com\/a\.js:1:\d+/);
		const result = run(
			`const previous = Error.prepareStackTrace;
			Error.prepareStackTrace = (_error, sites) => sites;
			const sites = new Error('x').stack;
			const assigned = Error.prepareStackTrace;
			Error.prepareStackTrace = previous;
			({ isArray: Array.isArray(sites), file: sites[0].getFileName(), assigned: typeof assigned,
			   restored: capture().stack.split('\\n')[1], header: new (class extends Error { name = 'Custom' })('m').stack.split('\\n')[0] })`,
			"https://example.com/b.js",
		);
		// A page's own formatter receives the call sites unchanged.
		expect(result).toMatchObject({
			isArray: true,
			file: proxied("https://example.com/b.js"),
			assigned: "function",
			restored: expect.stringMatching(
				/^ {4}at capture \(https:\/\/example\.com\/assets\/bundle\.js:1:\d+\)$/,
			),
			header: "Custom: m",
		});
	});
});
