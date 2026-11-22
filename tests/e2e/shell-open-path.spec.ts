import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

// "Open settings folder" style actions: shell.openPath resolves with an error
// string instead of rejecting, and a folder opens in Neutron's file manager.
test("shell.openPath shows a folder in Files and reports failures as a string", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"open-path","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,shell}=require('electron');const fs=require('fs');
app.whenReady().then(async()=>{
  fs.mkdirSync('/home/user/Documents/settings-folder',{recursive:true});
  fs.writeFileSync('/home/user/Documents/settings-folder/settings.json','{}');
  const results=[];
  for(const target of ['/home/user/Documents/settings-folder','/home/user/Documents/missing'])
    results.push(await shell.openPath(target).then(value=>({value}),error=>({rejected:String(error)})));
  new BrowserWindow().loadFile('index.html',{query:{results:JSON.stringify(results)}});
});`,
		"index.html": `<!doctype html><pre id="results"></pre><script>
document.querySelector('#results').textContent=new URLSearchParams(location.search).get('results');</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const results = page.frameLocator('iframe[data-neutron-id="1"]').locator("#results");
	await expect(results).not.toBeEmpty({ timeout: 20_000 });
	const [folder, missing] = JSON.parse((await results.textContent()) ?? "[]");
	expect(folder).toEqual({ value: "" });
	expect(missing.value).toMatch(/ENOENT/);
	await expect(page.locator("#file-search")).toHaveValue("/home/user/Documents/settings-folder");
	await expect(
		page.locator(".file-entry").filter({ hasText: "settings-folder/settings.json" }),
	).toBeVisible();
});
