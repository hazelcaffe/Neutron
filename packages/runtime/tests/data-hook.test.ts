import { expect, it } from "vitest";
import { VirtualFileSystem } from "../src/runtime/filesystem";
import { ModuleLoader } from "../src/runtime/loader";

it("requires a generated data: module from a synchronous resolver and shares it with import", async () => {
	const url = `data:text/javascript;base64,${Buffer.from("export const uri=import.meta.url; export const answer=42;").toString("base64")}`;
	const fs = new VirtualFileSystem({}, () => {});
	const builtins: Record<string, unknown> = {};
	const loader = new ModuleLoader(fs, builtins, {});
	builtins.module = loader.moduleBuiltin("/app/main.cjs");
	fs.fs.mkdirSync("/app");
	fs.fs.writeFileSync(
		"/app/main.cjs",
		`require('node:module').registerHooks({ resolve(id, context, next) {
			return id === 'generated-api' ? {url:${JSON.stringify(url)}, shortCircuit:true} : next(id, context);
		} }); module.exports=require('generated-api');`,
	);
	const api = loader.run("/app/main.cjs");
	expect(api).toMatchObject({ answer: 42, uri: url });
	expect(await loader.runAsync(url)).toBe(api);
	expect(() => loader.resolve("./relative.mjs", url)).toThrow("ERR_UNSUPPORTED_RESOLVE_REQUEST");
});
