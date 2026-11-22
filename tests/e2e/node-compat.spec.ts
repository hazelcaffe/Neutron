import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("browser-backed Node modules expose working paths, streams, events, readline and timers", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"node-compat","main":"main.cjs","version":"1.0.0"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');
app.whenReady().then(async()=>{
const fs=require('fs'), path=require('path'), stream=require('stream'), events=require('events');
const result={}; result.path=path.win32.relative('C:/work/src','C:/work/assets'); result.platform=process.platform;
result.parsed=require('util').parseArgs({args:['--name','Neutron'],options:{name:{type:'string'}}}).values.name;
result.progress = require('node:util').stripVTControlCharacters('\\u001b[32mCloning 100%\\u001b[0m');
result.lookup=await require('dns/promises').lookup('localhost',{family:4});
const emitter=new events();const once=events.once(emitter,'value');emitter.emit('value',42);result.event=(await once)[0];
result.timer=await require('timers/promises').setImmediate('tick');
const lines=[];for await(const line of require('readline').createInterface({input:stream.Readable.from(['a\\r','\\nb\\n'])}))lines.push(line);result.lines=lines;
result.json=await require('stream/consumers').json(stream.Readable.from(['{"value":42}']));
result.web=require('stream/web').ReadableStream===ReadableStream;
const chunks=[]; const output=new WritableStream({write(chunk){chunks.push(Buffer.from(chunk).toString())}});
await require('stream/promises').pipeline(stream.Readable.fromWeb(new Response('via web streams').body), stream.Writable.fromWeb(output));
result.webPipeline=chunks.join('');
result.zlib=require('zlib').constants.Z_SYNC_FLUSH;
const encoded=Buffer.from([251,255]).toString('base64url'); const target=Buffer.alloc(2);target.write(encoded,'base64url');result.base64url=[encoded,Buffer.from(encoded,'base64url').toString('hex'),target.toString('hex'),Buffer.byteLength(encoded,'base64url')];
result.strict=false;try{require('assert/strict').equal(1,'1');}catch{result.strict=true;}
fs.writeFileSync('/tmp/result.json',JSON.stringify(result));const w=new BrowserWindow({webPreferences:{nodeIntegration:true}});await w.loadFile('index.html');
}).catch(console.error);`,
		"index.html":
			'<html><head><title>Node compatibility</title></head><body><pre id="result"></pre><script>document.querySelector("#result").textContent=require("fs").readFileSync("/tmp/result.json","utf8");</script></body></html>',
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const result = page.frameLocator("iframe[name='neutron:1']").locator("#result");
	await expect(result).toContainText('"platform":"linux"');
	expect(JSON.parse((await result.textContent()) || "null")).toEqual({
		path: "..\\assets",
		platform: "linux",
		parsed: "Neutron",
		progress: "Cloning 100%",
		lookup: { address: "127.0.0.1", family: 4 },
		event: 42,
		timer: "tick",
		lines: ["a", "b"],
		json: { value: 42 },
		web: true,
		webPipeline: "via web streams",
		zlib: 2,
		base64url: ["-_8", "fbff", "fbff", 2],
		strict: true,
	});
});

test("renderer SQLite addons initialize synchronously and write persistent database bytes", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"renderer-sqlite","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({webPreferences:{nodeIntegration:true}}).loadFile('index.html'));`,
		"index.html": `<html><body><pre id="result"></pre><script>
const zlib=require('node:zlib');if(zlib.brotliDecompressSync(zlib.brotliCompressSync('renderer')).toString()!=='renderer')throw new Error('Brotli mismatch');
const Database=require('better-sqlite3');const db=new Database('/tmp/renderer.db');
db.exec('CREATE TABLE IF NOT EXISTS entries(value TEXT)');db.prepare('INSERT INTO entries VALUES (?)').run('persistent');
const result=db.prepare('SELECT COUNT(*) count FROM entries').get();db.close();
document.querySelector('#result').textContent=JSON.stringify(result);
</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const frame = page.frameLocator('iframe[data-neutron-id="1"]');
	await expect(frame.locator("#result")).toHaveText('{"count":1}');
	await page.locator("#stop-button").click();
	// Stop resolves after the pending OPFS transaction has committed.
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.reload();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	await expect(frame.locator("#result")).toHaveText('{"count":2}');
});

test("webFrame executes strict declaration scripts in the page world; sync XHR uses the virtual file URL", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"page-world","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}}).loadFile('index.html'));`,
		"preload.cjs": `const {webFrame,contextBridge}=require('electron');contextBridge.exposeInMainWorld('run',async()=>{
await webFrame.executeJavaScript('"use strict"; var sharedValue = 40; const offset = 2;');
return webFrame.executeJavaScript('sharedValue + offset');});`,
		"index.html": `<pre id="result"></pre><script>(async()=>{const out=document.querySelector('#result');try { const xhr = new XMLHttpRequest();xhr.open('GET','message.txt',false);xhr.send();out.textContent=xhr.responseText+await run(); } catch (err) {out.textContent=String(err);}})()</script>`,
		"message.txt": "value=",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator('iframe[data-neutron-id="1"]').locator("#result")).toHaveText(
		"value=42",
	);
});

test("preload globals, async sendSync replies and IPC data work across Scramjet v2 realms", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"preload-realms","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain}=require('electron');ipcMain.handle('data',()=>({location:{value:'copied in renderer'}}));ipcMain.on('config',async event=>{await new Promise(resolve=>setTimeout(resolve,30));event.returnValue={locale:'en'};});app.whenReady().then(()=>new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}}).loadFile('index.html'));`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');window.desktop={value:'private'};const config=ipcRenderer.sendSync('config');const vm=require('vm').runInThisContext('(function(){return typeof process.platform+":"+typeof Buffer})')();contextBridge.exposeInMainWorld('desktop',{value:'public',locale:config.locale,vm,read:()=>ipcRenderer.invoke('data')});window.desktop.value='mutable';window.postMessage({ready:true},'*');`,
		"index.html":
			'<html><head><title>Preload realm</title></head><body><pre id="result"></pre><script>desktop.read().then(data=>document.querySelector("#result").textContent=desktop.value+" "+data.location.value+" "+desktop.locale+" "+desktop.vm);</script></body></html>',
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator("iframe[data-neutron-id='1']").locator("#result")).toHaveText(
		"public copied in renderer en string:function",
	);
});

test("one preload can publish an API in both isolated and shared-window modes", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"preload-modes","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{for(const contextIsolation of [true,false]) await new BrowserWindow({webPreferences:{contextIsolation,preload:'/app/preload.cjs'}}).loadFile('index.html');});`,
		"preload.cjs": `const api={mode:process.contextIsolated?'bridge':'shared',version:()=>42};window.preloadOnly=true;if(process.contextIsolated) require('electron').contextBridge.exposeInMainWorld('api',api);else window.api=api;`,
		"index.html": `<pre id="result"></pre><script>document.querySelector('#result').textContent=[api.mode,api.version(),typeof window.preloadOnly].join(':');</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator('iframe[data-neutron-id="1"]').locator("#result")).toHaveText(
		"bridge:42:undefined",
	);
	await expect(page.frameLocator('iframe[data-neutron-id="2"]').locator("#result")).toHaveText(
		"shared:42:boolean",
	);
});
