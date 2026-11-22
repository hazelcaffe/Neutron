import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/tls/${name}`, import.meta.url));

test("https and tls honor a request's own trusted roots (Node's ca option)", async ({ page }) => {
	const server = createServer(
		{ key: fixture("server-key.pem"), cert: fixture("server.pem") },
		(request, response) => response.end(request.url === "/tls" ? "tls" : "secure"),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const archive = createAsar({
			"package.json": '{"name":"https-ca","main":"main.cjs","version":"1.0.0"}',
			"ca.pem": fixture("ca.pem"),
			"other-ca.pem": fixture("other-ca.pem"),
			"main.cjs": `const {app,BrowserWindow}=require('electron');const https=require('https'),tls=require('tls'),fs=require('fs'),path=require('path');
const ca=fs.readFileSync(path.join(__dirname,'ca.pem'));const other=fs.readFileSync(path.join(__dirname,'other-ca.pem'),'utf8');
const get=(options)=>new Promise((resolve)=>{const request=https.request({host:'127.0.0.1',port:${port},path:'/',...options},(response)=>{let body='';response.on('data',(data)=>body+=data);response.on('end',()=>resolve(response.statusCode+' '+body));});request.on('error',(error)=>resolve('error: '+error.message));request.end();});
const viaTLS=()=>new Promise((resolve)=>{const socket=tls.connect({host:'127.0.0.1',port:${port},ca:[ca]},()=>socket.write('GET /tls HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n'));let data='';socket.on('data',(chunk)=>data+=chunk);socket.on('end',()=>resolve(data.split('\\r\\n')[0]+' '+data.split('\\r\\n\\r\\n')[1]));socket.on('error',(error)=>resolve('error: '+error.message));});
app.whenReady().then(async()=>{
const result={option:await get({ca}),agent:await get({agent:new https.Agent({ca:ca.toString()})}),array:await get({ca:[other,ca.toString()]}),tls:await viaTLS(),unrelated:await get({ca:other}),bundle:await get({})};
fs.writeFileSync('/tmp/result.json',JSON.stringify(result));const w=new BrowserWindow({webPreferences:{nodeIntegration:true,contextIsolation:false}});await w.loadFile('index.html');
}).catch(console.error);`,
			"index.html":
				'<html><body><pre id="result"></pre><script>document.querySelector("#result").textContent=require("fs").readFileSync("/tmp/result.json","utf8");</script></body></html>',
		});
		await page.goto("/");
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#zip-input").setInputFiles({
			name: "resources.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
		});
		const output = page.frameLocator("iframe[name='neutron:1']").locator("#result");
		await expect(output).toContainText('"bundle"', { timeout: 60_000 });
		const result = JSON.parse((await output.textContent()) || "{}");
		expect(result).toMatchObject({
			option: "200 secure",
			agent: "200 secure",
			array: "200 secure",
			tls: "HTTP/1.1 200 OK tls",
		});
		// Verification stays on: a root that didn't sign the server's
		// certificate, or the default public bundle, is rejected.
		expect(result.unrelated).toMatch(/^error: .*\b60\b/);
		expect(result.bundle).toMatch(/^error: .*\b60\b/);
	} finally {
		server.close();
	}
});
