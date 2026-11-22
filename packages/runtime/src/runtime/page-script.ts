import { parse } from "acorn";

/** A declaration-only classic script has no expression result beyond its
 * directives. Unlike indirect eval, a real script preserves global lexicals
 * and strict-mode var/function bindings for the next execution. */
function declarations(source: string): { completion?: string } | undefined {
	if (!/\b(var|const|let|class|function)\b/.test(source)) return;
	try {
		const program = parse(source, { ecmaVersion: "latest" });
		let found = false,
			completion: string | undefined;
		for (const item of program.body) {
			if (item.type === "ExpressionStatement" && "directive" in item)
				completion = String(item.directive);
			else if (
				["VariableDeclaration", "ClassDeclaration", "FunctionDeclaration"].includes(
					item.type,
				)
			)
				found = true;
			else if (item.type !== "EmptyStatement") return;
		}
		return found ? { completion } : undefined;
	} catch {
		return;
	}
}

export async function executePageScript(code: string): Promise<unknown> {
	const script = declarations(code);
	if (!script) {
		// biome-ignore lint/security/noGlobalEval: Electron's API explicitly evaluates code in the renderer.
		return window.eval(code);
	}
	const element = document.createElement("script");
	let failed = false,
		error: unknown;
	const onError = (event: ErrorEvent) => {
		failed = true;
		error = event.error || new Error(event.message);
	};
	window.addEventListener("error", onError);
	try {
		// Use the same Scramjet DOM hooks as an app-created classic script. No
		// application source is edited to manufacture a global or capture a value.
		element.textContent = code;
		(document.head || document.documentElement).append(element);
		if (failed) throw error;
		return script.completion;
	} finally {
		element.remove();
		window.removeEventListener("error", onError);
	}
}
