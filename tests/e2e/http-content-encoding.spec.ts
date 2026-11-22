import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("http responses decoded in transit are delivered as identity, so clients don't decode twice", async ({
	page,
}) => {
	const body = JSON.stringify({ message: "compressed in transit" });
	const server = createServer((_request, response) => {
		const encoded = gzipSync(body);
		response.writeHead(200, {
			"Content-Type": "application/json",
			"Content-Encoding": "gzip",
			"Content-Length": encoded.length,
		});
		response.end(encoded);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const archive = createAsar({
			"package.json": '{"name":"content-encoding","main":"main.cjs","version":"1.0.0"}',
			// Decodes only when the response says it's encoded, like got or axios.
			"main.cjs": `const {app,BrowserWindow}=require('electron');const http=require('http'),zlib=require('zlib'),fs=require('fs');
app.whenReady().then(async()=>{const result=await new Promise((resolve)=>http.get('http://127.0.0.1:${port}/',{headers:{'accept-encoding':'gzip'}},(response)=>{const chunks=[];response.on('data',(chunk)=>chunks.push(chunk));response.on('end',()=>{let data=Buffer.concat(chunks);try{if(response.headers['content-encoding']==='gzip')data=zlib.gunzipSync(data);resolve({encoding:response.headers['content-encoding']??null,length:response.headers['content-length']??null,body:JSON.parse(data.toString())});}catch(error){resolve({error:error.message});}});}).on('error',(error)=>resolve({error:error.message})));
fs.writeFileSync('/tmp/result.json',JSON.stringify(result));const w=new BrowserWindow({webPreferences:{nodeIntegration:true,contextIsolation:false}});await w.loadFile('index.html');});`,
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
		await expect(output).not.toBeEmpty({ timeout: 60_000 });
		expect(JSON.parse((await output.textContent()) || "{}")).toEqual({
			encoding: null,
			length: null,
			body: { message: "compressed in transit" },
		});
	} finally {
		server.close();
	}
});
