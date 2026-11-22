import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("renderer file writes are visible to browser image and fetch requests on their first attempt", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"live-resource","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({webPreferences:{nodeIntegration:true}}).loadFile('index.html'));`,
		"index.html": `<!doctype html><output id="result"></output><script>(async()=>{
const fs=require('fs'), {pathToFileURL}=require('url');
// Logs must not cause a newly written document resource to return 404.
for(let i=0;i<20;i++) fs.appendFileSync('/tmp/log','record '+i+'\\n');
const imageFile='/tmp/test image.svg';fs.writeFileSync(imageFile,'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7"/>');
const img=new Image();img.src=pathToFileURL(imageFile).href;await img.decode();
const dataFile='/tmp/result.txt';fs.writeFileSync(dataFile,'first');const read=async()=>{const r=await fetch(pathToFileURL(dataFile));return r.ok?await r.text():String(r.status)};
const first=await read();fs.writeFileSync(dataFile,'second');const second=await read();
fs.writeFileSync(dataFile,'synchronous');const xhr=new XMLHttpRequest();xhr.open('GET',pathToFileURL(dataFile).href,false);xhr.send();
fs.unlinkSync(dataFile);const deleted=await read();return [img.naturalWidth,img.naturalHeight,first,second,xhr.responseText,deleted].join(',');
})().then(result=>document.querySelector('#result').textContent=result,error=>document.querySelector('#result').textContent=String(error))</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator('iframe[data-neutron-id="1"]').locator("#result")).toHaveText(
		"13,7,first,second,synchronous,404",
	);
});
