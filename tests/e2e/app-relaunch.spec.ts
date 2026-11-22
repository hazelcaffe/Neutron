import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

// Settings screens commonly apply a change with app.relaunch() + app.exit().
// Electron starts a new instance when the current one exits; a host Stop ends it.
test("app.relaunch starts a new instance with its arguments after the app exits", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"relaunch-contract","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');const fs=require('fs');
const file=app.getPath('userData')+'/launches.txt';
const count=(fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0)+1;
fs.writeFileSync(file,String(count));
app.whenReady().then(()=>{
  if(count===1){app.relaunch({args:['--relaunched','value with space']});app.exit(0);return;}
  new BrowserWindow().loadFile('index.html',{query:{text:count+' '+JSON.stringify(process.argv.slice(1))}});
  // Pending, but the user's Stop must still end the app.
  app.relaunch();
});`,
		"index.html": `<!doctype html><h1 id="launch"></h1><script>
document.querySelector('#launch').textContent=new URLSearchParams(location.search).get('text');</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator("iframe[data-neutron-id]").first();
	await expect(frame.locator("#launch")).toHaveText('2 ["--relaunched","value with space"]', {
		timeout: 30_000,
	});
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.waitForTimeout(2000);
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await expect(page.locator(".runtime-window")).toHaveCount(0);
});
