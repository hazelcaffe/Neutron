import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { patchScramjet } from "../scripts/assets.mjs";

type Rewriter = typeof import("@mercuryworkshop/scramjet") & {
	rewriteUrl(url: string, context: object, meta: object): string;
	unrewriteUrl(url: string, context: object): string;
	rewriteHtml(html: string, context: object, meta: object, htmlcontext: object): string;
};

async function load(patched: boolean): Promise<Rewriter> {
	const require = createRequire(import.meta.url);
	const file = require
		.resolve("@mercuryworkshop/scramjet/bundled-wasm")
		.replace(/scramjet_bundled\.mjs$/, "scramjet_bundled.js");
	const source = await readFile(file, "utf8");
	// Like the service worker: a classic script that publishes self.$scramjet.
	Reflect.set(globalThis, "self", globalThis);
	runInThisContext(patched ? patchScramjet(source) : source);
	return Reflect.get(globalThis, "$scramjet") as Rewriter;
}

describe("Scramjet fragment references", () => {
	const document = new URL("https://vendor.example/login?next=%2Ffiles");
	const meta = { origin: document, base: document, referrerPolicy: "origin-when-cross-origin" };
	const context = (scramjet: Rewriter) => ({
		config: scramjet.defaultConfig,
		prefix: new URL("http://127.0.0.1:4340/__scramjet__/session/"),
		cookieJar: new scramjet.CookieJar(),
		interface: { codecEncode: encodeURIComponent, codecDecode: decodeURIComponent },
	});

	it("reproduces the upstream reload for href='#'", async () => {
		const scramjet = await load(false);
		const rewritten = scramjet.rewriteUrl("#", context(scramjet), meta);
		// No fragment at all: following this link is a cross-document navigation.
		expect(rewritten).not.toContain("#");
	});

	it("keeps fragment-only references same-document", async () => {
		const scramjet = await load(true);
		const ctx = context(scramjet);
		expect(scramjet.rewriteUrl("#", ctx, meta)).toBe("#");
		expect(scramjet.rewriteUrl("#section-2", ctx, meta)).toBe("#section-2");
		// Resolved against the proxied document URL, as a browser would.
		const real = `${ctx.prefix.href}${encodeURIComponent(document.href)}?%24rfp=x`;
		expect(new URL(scramjet.rewriteUrl("#", ctx, meta), real).href).toBe(`${real}#`);

		// Absolute and path references are still fully rewritten; an empty
		// fragment is preserved instead of turning into "no fragment".
		const other = scramjet.rewriteUrl("/files#", ctx, meta);
		expect(other.startsWith(ctx.prefix.href)).toBe(true);
		expect(other.endsWith("#")).toBe(true);
		expect(scramjet.unrewriteUrl(other, ctx)).toBe("https://vendor.example/files#");
		const named = scramjet.rewriteUrl("https://vendor.example/files#top", ctx, meta);
		expect(named.endsWith("#top")).toBe(true);
		expect(scramjet.unrewriteUrl(named, ctx)).toBe("https://vendor.example/files#top");
		expect(
			scramjet.unrewriteUrl(`${ctx.prefix.href}${encodeURIComponent(document.href)}`, ctx),
		).toBe(document.href);
	});
});

describe("Scramjet script injection", () => {
	const document = new URL("https://accounts.vendor.example/signin");
	const meta = { origin: document, base: document };
	const rewrite = (scramjet: Rewriter, html: string) =>
		scramjet.rewriteHtml(
			html,
			{
				config: scramjet.defaultConfig,
				prefix: new URL("http://127.0.0.1:4340/__scramjet__/session/"),
				cookieJar: new scramjet.CookieJar(),
				hooks: { rewriter: { html: scramjet.Tap.create() } },
				interface: {
					codecEncode: encodeURIComponent,
					codecDecode: decodeURIComponent,
					getInjectScripts: (
						_meta: unknown,
						_dom: unknown,
						_html: unknown,
						script: (src: string) => unknown,
					) => [script("http://127.0.0.1:4340/runtime/proxy-client.js")],
				},
			},
			meta,
			{ loadScripts: true, source: document.href, apisource: "test" },
		);
	// Documents whose <html> has content before <head>, or no <html> at all.
	const quirky = [
		"<!DOCTYPE html>",
		"<!doctype html><title>t</title><html><body>x</body></html>",
		"<!-- served by vendor --><!DOCTYPE html><html><p>early</p><head></head><body></body></html>",
	];

	it("reproduces upstream's script before <!DOCTYPE> (quirks mode)", async () => {
		const scramjet = await load(false);
		expect(rewrite(scramjet, quirky[0] as string)).toMatch(/^<script[^>]*proxy-client/);
	});

	it("keeps the doctype first so the page stays in standards mode", async () => {
		const scramjet = await load(true);
		for (const html of quirky) {
			const output = rewrite(scramjet, html);
			const doctype = output.search(/<!doctype html>/i);
			expect(doctype).toBeGreaterThanOrEqual(0);
			expect(output.slice(0, doctype)).not.toMatch(/<script/);
			expect(output.indexOf("proxy-client.js")).toBeGreaterThan(doctype);
		}
		// Without a doctype it is still injected before any page script.
		expect(rewrite(scramjet, "<p>x</p><script>1</script>")).toMatch(
			/^<script[^>]*proxy-client/,
		);
	});
});
