import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("renderer workers load classic and module graphs from the virtual filesystem", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"worker-graph","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow().loadFile('index.html'));`,
		"index.html": `<pre id="classic"></pre><pre id="module"></pre><script>
for(const type of ['classic','module']){
  const worker=new Worker('./'+type+'.js',{type});
  const show=value=>document.getElementById(type).textContent=value;
  worker.onmessage=e=>{show(e.data);worker.terminate()};
  worker.onerror=e=>show(e.message+' '+e.filename);
}</script>`,
		"classic.js": `importScripts('./value.js');postMessage('classic:'+globalThis.value);`,
		"value.js": `globalThis.value=41;`,
		"module.js": `import {value} from './dep.mjs';const {increment}=await import('./inc.mjs');postMessage('module:'+increment(value));`,
		"dep.mjs": `export const value=41;`,
		"inc.mjs": `export const increment=x=>x+1;`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(frame.locator("#classic")).toHaveText("classic:41");
	await expect(frame.locator("#module")).toHaveText("module:42");
});

test("a module Blob worker uses module imports and a classic Blob worker keeps importScripts", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"blob-worker-mode","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,net,protocol}=require('electron');app.whenReady().then(()=>{
protocol.handle('https',r=>net.fetch('file:///app'+new URL(r.url).pathname));
new BrowserWindow().loadURL('https://worker.invalid/index.html');});`,
		"index.html": `<!doctype html><pre id="classic"></pre><pre id="module"></pre><script>
for (const [type,source] of [['classic',"importScripts('https://worker.invalid/value.js');postMessage(value)"],['module',"import {value} from 'https://worker.invalid/dep.mjs';postMessage(value)"]]) {
 const url=URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
 const w=new Worker(url,{type});w.onmessage=e=>{document.getElementById(type).textContent=e.data;w.terminate();URL.revokeObjectURL(url)};
 w.onerror=e=>{document.getElementById(type).textContent=e.message||'worker failed'};
}</script>`,
		"value.js": "self.value='classic ready';",
		"dep.mjs": "export const value='module ready';",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(frame.locator("#classic")).toHaveText("classic ready");
	await expect(frame.locator("#module")).toHaveText("module ready");
});
