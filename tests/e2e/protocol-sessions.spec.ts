import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("HTTPS protocol handlers serve documents and POST bodies independently per session offline", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"protocol-contract","main":"main.cjs","version":"1"}',
		"main.cjs": `const {app,BrowserWindow,protocol,session,net}=require('electron');
app.whenReady().then(async()=>{
  const isolated=session.fromPartition('second');
  for(const [name,p] of [['default',protocol],['second',isolated.protocol]]){
    if(p.isProtocolHandled('https')!==false) throw Error('unexpected registration');
    p.handle('https',async request=>{
      if (request.method==='POST') return new Response(name+':'+await request.text());
      return net.fetch('file:///app/page.html',{bypassCustomProtocolHandlers:true});
    });
  }
  const one=new BrowserWindow();await one.loadURL('https://local.invalid/page');
  const two=new BrowserWindow({webPreferences:{partition:'second'}});await two.loadURL('https://local.invalid/page');
});`,
		"page.html": `<html><body><pre id="echo"></pre><script>fetch('./echo',{method:'POST',body:'same body'}).then(r=>r.text()).then(t=>document.querySelector('#echo').textContent=t)</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#settings-button").click();
	await page.getByLabel("Disable external networking").check();
	await page.getByRole("button", { name: "Save settings" }).click();
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator('iframe[data-neutron-id="2"]').locator("#echo")).toHaveText(
		"second:same body",
	);
	await expect(page.frameLocator('iframe[data-neutron-id="1"]').locator("#echo")).toHaveText(
		"default:same body",
	);
});
