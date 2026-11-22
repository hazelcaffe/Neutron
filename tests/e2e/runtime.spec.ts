import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { downloadFile, saveSettings, showLogs } from "./shell";

function resourcesZip(archive: Uint8Array, extra: Record<string, Uint8Array> = {}) {
	return {
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive, ...extra })),
	};
}

test.afterEach(async ({ page }, info) => {
	if (info.status !== info.expectedStatus) {
		await page.locator("dialog[open]").evaluateAll((dialogs) => {
			for (const dialog of dialogs) (dialog as HTMLDialogElement).close();
		});
		console.log(await showLogs(page));
		for (const frame of page.frames())
			if (frame !== page.mainFrame())
				console.log(
					"FRAME",
					frame.url(),
					(await frame.content().catch(() => "unavailable")).slice(0, 6000),
				);
		console.log(
			"IFRAMES",
			await page
				.locator("iframe")
				.evaluateAll((frames) => frames.map((frame) => frame.outerHTML)),
		);
	}
});

test("JavaScript workers/forks, native images, safeStorage, and BrowserView", async ({ page }) => {
	const archive = createAsar({
		"package.json": '{"name":"advanced","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app, BrowserWindow, BrowserView, safeStorage, nativeImage, utilityProcess, dialog, MessageChannelMain} = require('electron');
const {Worker} = require('worker_threads'); const {fork} = require('child_process'); const fs = require('fs');
const firstMessage = child => new Promise((resolve, reject) => { child.once('message', value => { child.kill ? child.kill() : child.terminate(); resolve(value); }); child.once('error', reject); });
app.whenReady().then(async () => {
const result = {};
result.dialog = dialog.showMessageBoxSync({title:'Synchronous dialog',message:'Worker to browser dialog',buttons:['Continue']});
result.worker = await firstMessage(new Worker('/app/worker.cjs', {workerData: 21}));
result.evalWorker = await firstMessage(new Worker(\`const vm=require('node:vm');require('node:worker_threads').parentPort.postMessage(vm.runInThisContext("[require('./answer.cjs'), module.id, __filename, __dirname, exports === module.exports, require.main === undefined, this === globalThis]"));\`, {eval:true}));
result.fork = await firstMessage(fork('/app/fork.cjs'));
result.utility = await firstMessage(utilityProcess.fork('/app/utility.cjs'));
result.utilityPort = await new Promise((resolve,reject)=>{const child=utilityProcess.fork('/app/utility-port.cjs'); const {port1,port2}=new MessageChannelMain();port1.on('message',event=>{resolve(event.data);port1.close();child.kill();});port1.start();child.once('spawn',()=>child.postMessage('connect',[port2]));child.on('error',reject);});
result.encrypted = safeStorage.decryptString(safeStorage.encryptString('round trip'));
const image = nativeImage.createFromBitmap(Buffer.from([0,0,255,255]), {width:1,height:1}).resize({width:3,height:2});
result.image = nativeImage.createFromBuffer(image.toPNG()).getSize();
const handle = await fs.promises.open('/tmp/handle.txt', 'w'); await handle.writeFile('file handle persisted'); await handle.close();
result.file = fs.readFileSync('/tmp/from-worker.txt', 'utf8');
const window = new BrowserWindow({width:700,height:500}); const view = new BrowserView({webPreferences:{nodeIntegration:true}}); window.setBrowserView(view); view.setBounds({x:0,y:34,width:690,height:450});
fs.writeFileSync('/tmp/result.json', JSON.stringify(result)); await view.webContents.loadFile('index.html');
}).catch(console.error);`,
		"worker.cjs": `const {parentPort, workerData} = require('worker_threads'); require('fs').writeFileSync('/tmp/from-worker.txt','worker filesystem'); parentPort.postMessage(workerData*2);`,
		"fork.cjs": `process.send('fork works');`,
		"answer.cjs": "module.exports = 42;",
		"utility.cjs": `process.parentPort.postMessage('utility works');`,
		"utility-port.cjs": `process.parentPort.on('message',event=>{const port=event.ports[0];port.start();port.postMessage(42);});`,
		"index.html": `<html><head><title>Advanced</title></head><body><pre id="result"></pre><script>document.getElementById('result').textContent = require('fs').readFileSync('/tmp/result.json','utf8');</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles(resourcesZip(archive));
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	const frame = page.frameLocator("iframe[name='neutron:2']");
	await expect(frame.locator("#result")).toContainText('"worker":42', { timeout: 20_000 });
	const result = JSON.parse((await frame.locator("#result").textContent()) || "null");
	expect(result).toEqual({
		dialog: 0,
		worker: 42,
		evalWorker: [42, "[worker eval]", "[worker eval]", ".", true, true, true],
		fork: "fork works",
		utility: "utility works",
		utilityPort: 42,
		encrypted: "round trip",
		image: { width: 3, height: 2 },
		file: "worker filesystem",
	});
	expect((await downloadFile(page, "handle.txt")).toString()).toBe("file handle persisted");
});

test("libcurl/wisp networking, session interception/cookies, Scramjet and nested frames", async ({
	page,
}) => {
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning")
			console.log("BROWSER", message.text());
	});
	page.on("pageerror", (error) => console.log("PAGE ERROR", error.stack));
	const archive = createAsar({
		"package.json": '{"name":"network-test","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app, BrowserWindow, session} = require('electron');
app.whenReady().then(async () => {
const ses = session.fromPartition('persist:network');
ses.webRequest.onBeforeSendHeaders({urls:['http://127.0.0.1:4175/*']}, (details, callback) => callback({requestHeaders:{...details.requestHeaders,'x-neutron-test':'intercepted'}}));
await ses.fetch('http://127.0.0.1:4175/api');
const data = await (await ses.fetch('http://127.0.0.1:4175/api')).json(); console.log('NETWORK_RESULT', JSON.stringify(data));
const tcp = await new Promise((resolve, reject) => { const socket = require('net').connect(4191,'127.0.0.1',()=>socket.write('tcp echo')); socket.once('data', data=>{socket.destroy();resolve(data.toString());}); socket.on('error',reject); });
const udp = await new Promise((resolve, reject) => { const socket = require('dgram').createSocket('udp4'); socket.on('message', data=>{socket.close();resolve(data.toString());});socket.on('error',reject);socket.send(Buffer.from('udp echo'),4176,'127.0.0.1'); }); console.log('SOCKET_RESULT',tcp,udp);
const window = new BrowserWindow({width:800,height:600,webPreferences:{preload:'/app/preload.cjs'}}); await window.loadURL('http://127.0.0.1:4175/page');
const local = new BrowserWindow({width:400,height:300}); await local.loadFile('local.html');
}).catch(console.error);`,
		"preload.cjs": `require('electron').contextBridge.exposeInMainWorld('neutronPreload', {value:'remote preload works'});
require('https').get('http://127.0.0.1:4175/api', response => {const parts=[];response.on('data',part=>parts.push(part));response.on('end',()=>{document.documentElement.dataset.nodeFetch=JSON.parse(Buffer.concat(parts).toString()).message;});}).on('error',console.error);`,
		"local.html": `<html><head><title>Local network</title></head><body><script>
fetch('http://127.0.0.1:4175/api').then(r=>r.json()).then(data=>document.body.dataset.fetch=data.message);
const ws = new WebSocket('ws://127.0.0.1:4177/'); ws.onopen=()=>ws.send('websocket echo'); ws.onmessage=event=>{document.body.dataset.ws=event.data;ws.close();};
const xhr=new XMLHttpRequest();xhr.open('GET','http://127.0.0.1:4175/api');xhr.onload=()=>document.body.dataset.xhr=JSON.parse(xhr.responseText).message;xhr.send();
</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#settings-button").click();
	await page.locator("#wisp-url").fill("ws://127.0.0.1:4174/wisp/");
	await page.getByRole("button", { name: "Save settings" }).click();
	await page.locator("#zip-input").setInputFiles(resourcesZip(archive));
	const remote = page.frameLocator("iframe[data-neutron-id='1']");
	await expect(remote.locator("#remote-result")).toHaveText("Scramjet over libcurl over Wisp", {
		timeout: 25_000,
	});
	await expect(remote.frameLocator("iframe").locator("#nested-result")).toHaveText(
		"Nested remote content",
	);
	await expect(remote.locator("body")).toHaveAttribute("data-network", "through-wisp");
	await expect(remote.locator("body")).toHaveAttribute("data-preload", "remote preload works");
	await expect(remote.locator("html")).toHaveAttribute("data-node-fetch", "through-wisp");
	const local = page.frameLocator("iframe[data-neutron-id='2']");
	await expect(local.locator("body")).toHaveAttribute("data-fetch", "through-wisp");
	await expect(local.locator("body")).toHaveAttribute("data-ws", "websocket echo");
	await expect(local.locator("body")).toHaveAttribute("data-xhr", "through-wisp");
	await page.locator("#logs-button").click();
	await expect(page.locator("#console-output")).toContainText('"cookie":"fixture=remembered"');
	await expect(page.locator("#console-output")).toContainText('"custom":"intercepted"');
	await expect(page.locator("#console-output")).toContainText("SOCKET_RESULT tcp echo udp echo");
});

test("ESM entry, custom protocol subresources, capturePage and PDF export", async ({ page }) => {
	const archive = createAsar({
		"package.json":
			'{"name":"esm-protocol","version":"1.0.0","main":"main.mjs","type":"module"}',
		"main.mjs": `import {app, BrowserWindow, protocol} from 'electron'; import fs from 'node:fs';
await app.whenReady(); const {default: value} = await import('./value.mjs');
protocol.registerFileProtocol('app', (request, callback) => callback({path:'/app' + new URL(request.url).pathname}));
protocol.handle('echo', async request => new Response(request.method + ':' + await request.text(), {headers:{'content-type':'text/plain'}}));
const window = new BrowserWindow({width:500,height:400}); await window.loadURL('app://bundle/index.html');
await window.webContents.executeJavaScript('document.body.dataset.answer = ' + value);
const image = await window.webContents.capturePage(); fs.writeFileSync('/tmp/capture.png', image.toPNG());
const pdf = await window.webContents.printToPDF(); fs.writeFileSync('/tmp/capture.pdf', pdf);
await window.webContents.executeJavaScript('document.body.dataset.captured = "' + pdf.toString('ascii',0,4) + '"');`,
		"value.mjs": "export default await Promise.resolve(42);",
		"index.html":
			'<!doctype html><html><head><title>Protocol test</title><link rel="stylesheet" href="./style.css"></head><body><h1 id="protocol-result">Custom protocol works</h1><script src="./render.js"></script></body></html>',
		"style.css": "body { background: white; color: rgb(22, 44, 66); font-family: sans-serif; }",
		"render.js": `fetch('./data.json').then(response => response.json()).then(data => document.body.dataset.resource = data.value);
const target = 'app://bundle/browser.mjs'; import(target).then(value=>document.body.dataset.module=value.answer);
fetch('echo://test/body', {method:'POST',body:'preserved'}).then(response=>response.text()).then(text=>document.body.dataset.protocolPost=text);`,
		"browser.mjs":
			"import {answer} from 'app://bundle/answer.mjs'; export {answer}; export const url = import.meta.url;",
		"answer.mjs": "export const answer = 42;",
		"data.json": '{"value":"relative resource"}',
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles(resourcesZip(archive));
	const app = page.frameLocator("iframe[name='neutron:1']");
	await expect(app.locator("#protocol-result")).toHaveText("Custom protocol works");
	await expect(app.locator("body")).toHaveCSS("color", "rgb(22, 44, 66)");
	await expect(app.locator("body")).toHaveAttribute("data-resource", "relative resource");
	await expect(app.locator("body")).toHaveAttribute("data-answer", "42");
	await expect(app.locator("body")).toHaveAttribute("data-module", "42");
	await expect(app.locator("body")).toHaveAttribute("data-protocol-post", "POST:preserved");
	await expect(app.locator("body")).toHaveAttribute("data-captured", "%PDF");
});

test("real demo ASAR: preload, invoke, OPFS persistence, windows, and page reload", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 20_000 });
	await page.getByRole("button", { name: "Try the example app" }).click();
	await expect(page.locator("#runtime-state")).toHaveText("Application running");
	const app = page.frameLocator("iframe[name='neutron:1']");
	await expect(app.locator("#status")).toContainText("Loaded from your virtual filesystem");
	await app
		.getByRole("textbox", { name: "Note", exact: true })
		.fill("Persisted through Electron IPC and OPFS.");
	await app.getByRole("button", { name: "Save note" }).click();
	await expect(app.locator("#status")).toContainText("Saved at");
	await page.locator("#settings-button").click();
	await page.getByLabel("Show application menu bar").check();
	await saveSettings(page);
	await page.locator("#application-menu button").filter({ hasText: "File" }).click();
	await page.getByRole("menuitem", { name: "New window", exact: true }).click();
	await expect(page.locator(".runtime-window")).toHaveCount(2);
	await expect(page.frameLocator("iframe[name='neutron:2']").locator("#note")).toHaveValue(
		"Persisted through Electron IPC and OPFS.",
	);
	await page.getByRole("button", { name: "Stop", exact: false }).click();
	await expect(page.locator(".runtime-window")).toHaveCount(0);
	await page.reload();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#launch-button").click();
	await expect(page.frameLocator("iframe[name='neutron:1']").locator("#note")).toHaveValue(
		"Persisted through Electron IPC and OPFS.",
	);
	expect((await downloadFile(page, "note.txt")).toString()).toBe(
		"Persisted through Electron IPC and OPFS.",
	);
	expect(errors).toEqual([]);
});

test("uploaded ASAR executes CommonJS Node-enabled renderer and reports unsupported APIs", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": JSON.stringify({
			name: "uploaded-test",
			version: "1.0.0",
			main: "main.js",
		}),
		"main.js": `const {app, BrowserWindow, ipcMain} = require('electron'); ipcMain.on('ping', event => event.reply('pong', 'reply works')); ipcMain.on('sync', (event, value) => event.returnValue = new Map([['answer',value * 2]])); app.whenReady().then(() => { const w = new BrowserWindow({webPreferences:{nodeIntegration:true}}); w.loadURL('file:///app/index.html?sessionId=test&logPath=%2Ftmp%2Fpostman%20logs#request'); });`,
		"index.html": `<!doctype html><html><head><title>Uploaded test</title></head><body><p id="result"></p><script>const fs = require('fs'); const {ipcRenderer} = require('electron'); fs.writeFileSync('/tmp/binary', Buffer.from([0,255,10])); document.querySelector('#result').textContent = fs.readFileSync('/tmp/binary').toString('hex'); ipcRenderer.on('pong', (_event, value) => document.body.dataset.reply = value); ipcRenderer.send('ping'); document.body.dataset.sync = ipcRenderer.sendSync('sync',21).get('answer');document.body.dataset.query=new URL(location.href).searchParams.get('logPath')+'|'+location.hash;WebAssembly.compileStreaming(fetch('file://'+__dirname+'/empty.wasm')).then(()=>document.body.dataset.wasm='ready');</script></body></html>`,
		"empty.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
		"native.node": "binary placeholder",
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles(resourcesZip(archive));
	const app = page.frameLocator("iframe[name='neutron:1']");
	await expect(app.locator("#result")).toHaveText("00ff0a");
	await expect(app.locator("body")).toHaveAttribute("data-reply", "reply works");
	await expect(app.locator("body")).toHaveAttribute("data-sync", "42");
	await expect(app.locator("body")).toHaveAttribute("data-query", "/tmp/postman logs|#request");
	await expect(app.locator("body")).toHaveAttribute("data-wasm", "ready");
	// The import summary names APIs that only have fallbacks.
	await page.locator("#logs-button").click();
	await expect(page.locator("#console-output")).toContainText(
		/without a browser implementation.*native-addon/,
	);
});

test("transferable MessagePorts travel in both directions across main/renderer IPC", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"message-ports","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain,MessageChannelMain}=require('electron');
ipcMain.on('renderer-port',event=>{const port=event.ports[0];port.on('message',event=>port.postMessage(event.data*2));port.start();});
ipcMain.on('request-port',event=>{const channel=new MessageChannelMain();channel.port1.on('message',event=>channel.port1.postMessage(event.data+' main'));channel.port1.start();event.sender.postMessage('main-port',null,[channel.port2]);});
app.whenReady().then(()=>new BrowserWindow({webPreferences:{nodeIntegration:true}}).loadFile('index.html'));`,
		"index.html": `<html><head><title>Message ports</title></head><body><script>
const {ipcRenderer}=require('electron');const channel=new MessageChannel();channel.port1.onmessage=event=>document.body.dataset.rendererPort=String(event.data);ipcRenderer.postMessage('renderer-port',null,[channel.port2]);channel.port1.postMessage(21);
ipcRenderer.on('main-port',event=>{const port=event.ports[0];port.onmessage=event=>document.body.dataset.mainPort=event.data;port.start();port.postMessage('hello');});ipcRenderer.send('request-port');
</script></body></html>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles(resourcesZip(archive));
	const app = page.frameLocator("iframe[name='neutron:1']");
	await expect(app.locator("body")).toHaveAttribute("data-renderer-port", "42");
	await expect(app.locator("body")).toHaveAttribute("data-main-port", "hello main");
});
