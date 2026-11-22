import path from "path-browserify";
import { configGet, homeDir, type Repo } from "./git-repo";

// .gitignore and .gitattributes pattern semantics (gitignore(5)). Patterns are
// compiled to linear regular expressions: `*`, `?`, `**` and bracket classes.

function compile(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const before = i === 0 || glob[i - 1] === "/";
				const after = glob[i + 2] === "/" || i + 2 === glob.length;
				if (before && after) {
					i++;
					if (glob[i + 1] === "/") {
						i++;
						out += "(?:.*/)?";
					} else out += ".*";
					continue;
				}
			}
			out += "[^/]*";
		} else if (c === "?") out += "[^/]";
		else if (c === "[") {
			const end = glob.indexOf("]", i + 2);
			if (end < 0) out += "\\[";
			else {
				let body = glob.slice(i + 1, end);
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				out += `[${body.replace(/\\/g, "\\\\")}]`;
				i = end;
			}
		} else if (c === "\\" && i + 1 < glob.length) {
			i++;
			out += (glob[i] as string).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		} else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

interface Pattern {
	base: string;
	regex: RegExp;
	basename: boolean;
	directory: boolean;
}

function pattern(raw: string, base: string): Pattern | undefined {
	let text = raw;
	const directory = text.endsWith("/") && !text.endsWith("\\/");
	if (directory) text = text.slice(0, -1);
	if (!text) return;
	const anchored = text.includes("/");
	if (text.startsWith("/")) text = text.slice(1);
	return { base, regex: compile(text), basename: !anchored, directory };
}

function matches(p: Pattern, file: string, isDirectory: boolean): boolean {
	if (p.directory && !isDirectory) return false;
	if (p.base && !file.startsWith(`${p.base}/`)) return false;
	const relative = p.base ? file.slice(p.base.length + 1) : file;
	return p.regex.test(p.basename ? path.basename(relative) : relative);
}

const readText = (repo: Repo, file: string): string | undefined => {
	try {
		return String(repo.fs.readFileSync(file, "utf8"));
	} catch {
		return;
	}
};

/** Lazily loads ignore rules per directory, like git's exclude stack. */
export class IgnoreRules {
	private perDir = new Map<string, { pattern: Pattern; negate: boolean }[]>();
	private global: { pattern: Pattern; negate: boolean }[] = [];
	private constructor(private repo: Repo) {}
	static async load(repo: Repo): Promise<IgnoreRules> {
		const rules = new IgnoreRules(repo);
		const excludes =
			(await configGet(repo.ctx, repo, "core.excludesFile")) ??
			path.join(homeDir(repo.ctx), ".config/git/ignore");
		for (const file of [
			repo.ctx.vfs.normalizePath(excludes.replace(/^~(?=\/)/, homeDir(repo.ctx))),
			path.join(repo.gitdir, "info/exclude"),
		])
			rules.global.push(...rules.parse(readText(repo, file), ""));
		return rules;
	}
	private parse(text: string | undefined, base: string) {
		const result: { pattern: Pattern; negate: boolean }[] = [];
		for (let line of (text || "").split(/\r?\n/)) {
			if (!line || line.startsWith("#")) continue;
			line = line.replace(/(?<!\\)\s+$/, "");
			const negate = line.startsWith("!");
			if (negate) line = line.slice(1);
			else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
			const compiled = pattern(line, base);
			if (compiled) result.push({ pattern: compiled, negate });
		}
		return result;
	}
	private rules(dir: string) {
		let rules = this.perDir.get(dir);
		if (!rules) {
			rules = this.parse(
				readText(this.repo, path.join(this.repo.dir, dir, ".gitignore")),
				dir === "." ? "" : dir,
			);
			this.perDir.set(dir, rules);
		}
		return rules;
	}
	/** Callers walk top-down and never descend into ignored directories. */
	ignored(file: string, isDirectory: boolean): boolean {
		let result = false;
		const all = [...this.global];
		const parts = file.split("/");
		for (let i = 0; i < parts.length; i++)
			all.push(...this.rules(parts.slice(0, i).join("/") || "."));
		for (const { pattern: p, negate } of all)
			if (matches(p, file, isDirectory)) result = !negate;
		return result;
	}
}

export type AttributeValue = true | false | string;

const MACROS: Record<string, [string, AttributeValue][]> = {
	binary: [
		["diff", false],
		["merge", false],
		["text", false],
	],
};

/** .gitattributes lookup: deeper files and later lines override earlier ones. */
export class Attributes {
	private perDir = new Map<
		string,
		{ pattern: Pattern; attrs: [string, AttributeValue | null][] }[]
	>();
	private info: { pattern: Pattern; attrs: [string, AttributeValue | null][] }[];
	constructor(
		private repo: Repo,
		/** Optional reader for attribute files from a tree instead of the worktree. */
		private source?: (file: string) => string | undefined,
	) {
		this.info = this.parse(readText(repo, path.join(repo.gitdir, "info/attributes")), "");
	}
	private parse(text: string | undefined, base: string) {
		const result: { pattern: Pattern; attrs: [string, AttributeValue | null][] }[] = [];
		for (const raw of (text || "").split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const [glob = "", ...words] = line.split(/\s+/);
			if (glob.startsWith("!")) continue;
			const compiled = pattern(glob, base);
			if (!compiled) continue;
			const attrs: [string, AttributeValue | null][] = [];
			for (const word of words) {
				if (word.startsWith("-")) attrs.push([word.slice(1), false]);
				else if (word.startsWith("!")) attrs.push([word.slice(1), null]);
				else if (word.includes("=")) {
					const eq = word.indexOf("=");
					attrs.push([word.slice(0, eq), word.slice(eq + 1)]);
				} else {
					attrs.push([word, true]);
					for (const expanded of MACROS[word] || []) attrs.push(expanded);
				}
			}
			result.push({ pattern: compiled, attrs });
		}
		return result;
	}
	private rules(dir: string) {
		let rules = this.perDir.get(dir);
		if (!rules) {
			const file = dir === "." ? ".gitattributes" : `${dir}/.gitattributes`;
			const text = this.source
				? this.source(file)
				: readText(this.repo, path.join(this.repo.dir, file));
			rules = this.parse(text, dir === "." ? "" : dir);
			this.perDir.set(dir, rules);
		}
		return rules;
	}
	get(file: string): Map<string, AttributeValue> {
		const values = new Map<string, AttributeValue>();
		const parts = file.split("/");
		const layers = [];
		for (let i = 0; i < parts.length; i++)
			layers.push(this.rules(parts.slice(0, i).join("/") || "."));
		layers.push(this.info);
		for (const rules of layers)
			for (const { pattern: p, attrs } of rules)
				if (matches(p, file, false))
					for (const [name, value] of attrs) {
						if (value === null) values.delete(name);
						else values.set(name, value);
					}
		return values;
	}
	/** Patterns with `filter=<name>` in the top-level attributes file. */
	patterns(filter: string): { pattern: string; source: string }[] {
		const text = this.source
			? this.source(".gitattributes")
			: readText(this.repo, path.join(this.repo.dir, ".gitattributes"));
		const result: { pattern: string; source: string }[] = [];
		for (const raw of (text || "").split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const [glob = "", ...words] = line.split(/\s+/);
			if (words.includes(`filter=${filter}`))
				result.push({ pattern: glob, source: ".gitattributes" });
		}
		return result;
	}
}
