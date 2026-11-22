// Exercise child_process from an ordinary imported JS application, over Wisp.
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";
import {
	contents,
	first,
	head,
	repoURL,
	startFixture,
} from "../../packages/runtime/tests/git-smart-fixture.ts";

const root = resolve(".cache/compat-apps/git-ui");
await mkdir(root, { recursive: true });
const out = await mkdtemp(join(root, "neutral-"));
console.log(out);
const build = resolve(process.env.NEUTRON_GIT_BUILD || "dist");
await cp(build, join(out, "dist"), { recursive: true });
const pkg = join(out, "resources/app");
await mkdir(pkg, { recursive: true });
await writeFile(
	join(pkg, "package.json"),
	JSON.stringify({ name: "git-reader", version: "1.0.0", main: "main.js" }),
);
await writeFile(
	join(pkg, "main.js"),
	`
const fs=require('fs'),cp=require('child_process');
async function run(args,cwd='/home/user') {
 return new Promise(resolve=>cp.execFile('git',args,{cwd},(e,out,err)=>resolve({code:e ? e.code : 0,out,err})));
}
(async()=>{
 const result={};
 try {
  result.clone=await run(['clone','--progress','--',${JSON.stringify(repoURL)},'copy']);
  if(result.clone.code===0){
   result.history=await run(['log','--format=%H'],'/home/user/copy');
   result.files=await run(['ls-files','-z'],'/home/user/copy');
   result.contents=fs.readFileSync('/home/user/copy/hello.txt','utf8');
  }
 } catch(e){result.error=String(e);}
 fs.writeFileSync('/home/user/neutral.json',JSON.stringify(result));
})();`,
);
const result = { build, hits: [] };
const fixture = await startFixture(result.hits);
const server = await preview({
	build: { outDir: join(out, "dist") },
	preview: { host: "127.0.0.1", port: 4260, strictPort: true },
});
let context;
try {
	context = await chromium.launchPersistentContext(join(out, "profile"), {
		headless: true,
		args: ["--disable-dev-shm-usage"],
	});
	const page = context.pages()[0];
	await page.goto("http://127.0.0.1:4260/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 30000 });
	await page.locator("#settings-button").click();
	await page.locator("#wisp-url").fill("ws://127.0.0.1:4260/wisp/");
	await page.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
	await page.locator("#folder-input").setInputFiles(join(out, "resources"));
	const read = () =>
		page.evaluate(async () => {
			const id = document.querySelector("#application-select").value;
			let dir = await navigator.storage.getDirectory();
			for (const p of ["neutron", "apps", id, "fs", "home", "user"])
				dir = await dir.getDirectoryHandle(p);
			return JSON.parse(
				await (await (await dir.getFileHandle("neutral.json")).getFile()).text(),
			);
		});
	await expect.poll(() => read().catch(() => null), { timeout: 30000 }).not.toBeNull();
	result.guest = await read();
	expect(result.guest).toMatchObject({
		clone: { code: 0 },
		history: { code: 0, out: `${head}\n${first}\n` },
		files: { code: 0, out: "hello.txt\0" },
		contents,
	});
	expect(result.hits.map((h) => h.method)).toEqual(["GET", "POST"]);
} catch (e) {
	result.error = String(e);
	console.error(result.error);
	process.exitCode = 1;
} finally {
	await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
	await context?.close();
	await server.close();
	await new Promise((ok) => fixture.close(ok));
}
