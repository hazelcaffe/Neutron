import { parse } from "acorn";
import { simple } from "acorn-walk";

/**
 * Scramjet v2's JavaScript rewriter deletes `debugger` statements. In a
 * single-statement position (`if (dev) debugger`, common in minified code) the
 * deletion leaves invalid JavaScript. Before Scramjet rewrites a source, this
 * replaces each statement with a same-length no-op so its output stays valid
 * and source maps keep their offsets. It changes nothing else; all browser
 * content rewriting is still performed by Scramjet. Installed through the
 * checked hook added by scripts/assets.mjs.
 */
export function neutralizeDebugger<T extends string | Uint8Array>(source: T, module: boolean): T {
	const text =
		typeof source === "string"
			? source
			: indexOfBytes(source, "debugger") < 0
				? undefined
				: new TextDecoder().decode(source);
	if (!text?.includes("debugger")) return source;
	const statements: { start: number; end: number }[] = [];
	try {
		simple(
			parse(text, {
				ecmaVersion: "latest",
				sourceType: module ? "module" : "script",
				allowHashBang: true,
				allowReturnOutsideFunction: true,
				allowAwaitOutsideFunction: true,
				allowImportExportEverywhere: true,
			}),
			{
				DebuggerStatement(node) {
					statements.push(node);
				},
			},
		);
	} catch {
		return source;
	}
	if (!statements.length) return source;
	let output = "";
	let cursor = 0;
	for (const { start, end } of statements.sort((a, b) => a.start - b.start)) {
		// `debugger;` keeps its own semicolon, so an expression consumes it (this
		// is also valid as a do-while body). Otherwise use an empty statement,
		// which is safe before `}` and automatic semicolon insertion.
		const replacement = text[end - 1] === ";" ? "void 0  " : ";       ";
		output += text.slice(cursor, start) + replacement;
		cursor = start + 8;
	}
	output += text.slice(cursor);
	return (typeof source === "string" ? output : new TextEncoder().encode(output)) as T;
}
function indexOfBytes(bytes: Uint8Array, value: string): number {
	const first = value.charCodeAt(0);
	for (let index = bytes.indexOf(first); index >= 0; index = bytes.indexOf(first, index + 1)) {
		let match = true;
		for (let offset = 1; offset < value.length && match; offset++)
			match = bytes[index + offset] === value.charCodeAt(offset);
		if (match) return index;
	}
	return -1;
}
export function installScramjetFixes(scope: typeof globalThis): void {
	// Scramjet has already tokenized url(...). Interpret CSS string escapes
	// on that operand before the existing URL rewriter receives it; don't
	// parse the stylesheet again or rewrite DOM setters outside Scramjet.
	Object.defineProperty(scope, "__neutronCSSURL", { configurable: true, value: decodeCSSURL });
	Object.defineProperty(scope, "__neutronBeforeRewriteJs", {
		configurable: true,
		value: neutralizeDebugger,
	});
}

export function decodeCSSURL(value: string): string {
	if (!value.includes("\\")) return value;
	return value.replace(
		/\\(?:\r\n|[\n\r\f]|([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|([\s\S]))/gi,
		(_matched, hex: string | undefined, single: string | undefined) => {
			if (!hex) return single ?? "";
			const code = Number.parseInt(hex, 16);
			return String.fromCodePoint(
				!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code,
			);
		},
	);
}
