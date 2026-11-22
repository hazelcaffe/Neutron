import { createAsar, parseAsar } from "@neutron/runtime/asar";
import { expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { keytarAddon } from "../src/runtime/keytar";
import { ModuleLoader } from "../src/runtime/loader";

it("stores keytar credentials encrypted and shares them across addon instances", async () => {
	const vfs = new VirtualFileSystem({}, () => {});
	const first = keytarAddon(vfs);
	expect(await first.getPassword("GitHub - https://api.github.com", "octocat")).toBeNull();
	await first.setPassword("GitHub - https://api.github.com", "octocat", "gho_secretvalue");
	await first.setPassword("GitHub - https://api.github.com", "hubot", "second");
	// Another process (renderer, main, worker) sees the same keychain.
	const second = keytarAddon(vfs);
	expect(await second.getPassword("GitHub - https://api.github.com", "octocat")).toBe(
		"gho_secretvalue",
	);
	expect(await second.findCredentials("GitHub - https://api.github.com")).toEqual([
		{ account: "octocat", password: "gho_secretvalue" },
		{ account: "hubot", password: "second" },
	]);
	expect(await second.deletePassword("GitHub - https://api.github.com", "hubot")).toBe(true);
	expect(await second.deletePassword("GitHub - https://api.github.com", "hubot")).toBe(false);
	expect(await second.findPassword("GitHub - https://api.github.com")).toBe("gho_secretvalue");
	await expect(second.setPassword("", "a", "b")).rejects.toThrow("Service is required.");
	const stored = Buffer.from(
		vfs.fs.readFileSync("/home/user/.local/share/keyrings/neutron-keytar.bin") as Uint8Array,
	);
	expect(stored.includes("gho_secretvalue")).toBe(false);
	expect(stored.includes("octocat")).toBe(false);
});

it("routes process.dlopen through the same native addon implementations as require()", async () => {
	// webpack's node-loader calls process.dlopen(module, path.join(__dirname, x.node)).
	const { snapshot } = parseAsar(
		createAsar({
			"keytar.node": "\u007fELF native binary",
			"main.cjs": `const m = { exports: {} }; process.dlopen(m, "\\\\app\\\\keytar.node"); module.exports = m.exports.setPassword("svc", "acct", "pw").then(() => m.exports.getPassword("svc", "acct"));`,
		}),
	);
	const vfs = new VirtualFileSystem(snapshot, () => {});
	const process = {} as Record<string, unknown>;
	const loader = new ModuleLoader(vfs, {}, { process });
	expect(typeof process.dlopen).toBe("function");
	expect(await loader.run("/app/main.cjs")).toBe("pw");
	expect(await keytarAddon(vfs).getPassword("svc", "acct")).toBe("pw");
});
