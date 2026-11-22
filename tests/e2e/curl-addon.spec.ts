import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("node-libcurl ABI transfers raw headers and bytes over Wisp and propagates cancellation and errors", async ({
	page,
}) => {
	const secret = randomUUID();
	const response = Buffer.concat([Buffer.from([0xff, 0]), Buffer.from(secret)]);
	const hits: {
		method?: string;
		path?: string;
		cookie?: string;
		header?: string | string[];
		body: string;
	}[] = [];
	let canceled = false;
	const fixture = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		hits.push({
			method: req.method,
			path: req.url,
			cookie: req.headers.cookie,
			header: req.headers["x-neutral"],
			body: Buffer.concat(chunks).toString("hex"),
		});
		if (req.url === "/redirect" || req.url === "/to-tls") {
			res.writeHead(302, {
				Location:
					req.url === "/redirect"
						? "/target"
						: `https://${req.headers.host}/never-opened`,
				"Set-Cookie": "probe=value; Path=/",
			});
			res.end("intermediate");
		} else if (req.url === "/cancel" || req.url === "/timeout") {
			res.writeHead(200);
			res.flushHeaders();
			res.once("close", () => {
				if (req.url === "/cancel") canceled = true;
			});
		} else if (req.url === "/incomplete") {
			res.writeHead(200, { "Content-Length": "2000" });
			res.write("partial");
			setTimeout(() => res.destroy(), 60);
		} else {
			res.writeHead(418, "Custom Reason", { "X-Repeat": ["one", "two"] });
			res.end(response);
		}
	});
	await new Promise<void>((ok, fail) =>
		fixture
			.once("error", fail)
			.listen(Number(process.env.NEUTRON_CURL_FIXTURE_PORT || 0), "127.0.0.1", ok),
	);
	try {
		const addr = fixture.address();
		if (!addr || typeof addr === "string") throw Error("Missing fixture port");
		const url = `http://127.0.0.1:${addr.port}`;
		const archive = createAsar({
			"package.json": '{"name":"curl-binding-check","main":"main.cjs","version":"1"}',
			"node_libcurl.node": new Uint8Array([0]),
			"main.cjs": `const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
 const win = new BrowserWindow({webPreferences:{nodeIntegration:true}});
 const fs = require('fs'); let out;
 try {
  const { Easy, Multi, Curl } = require('./node_libcurl.node');
  const set = (h, k, v) => { const code = h.setOpt(k,v); if(code) throw Error(k+': '+code); };
  const h=new Easy(), m=new Multi();
  const run = () => new Promise((resolve,reject) => {m.onMessage(function(err,handle,code){if(handle!==h)return reject(Error('wrong handle')); m.removeHandle(h); resolve([!!err,code])}); if(m.addHandle(h)) reject(Error('addHandle failed'))});
  let headers=[], body=[];
  const url=${JSON.stringify(url)};
  set(h, Curl.option.URL, url+'/bytes'); set(h,'HTTPHEADER',['X-Neutral: test']);
  set(h,'HEADERFUNCTION',function(buf,size,n){if(!Buffer.isBuffer(buf)||this!==h)throw Error('ABI'); headers.push(buf.toString('latin1'));return size*n});
  set(h,'WRITEFUNCTION',(b,s,n)=>{body.push(b);return s*n});
  out={init:Curl.globalInit(3),get:await run(), status:h.getInfo(Curl.info.RESPONSE_CODE),url:h.getInfo('EFFECTIVE_URL'), headers: headers.join(''),body: Buffer.concat(body).toString('hex')};
  set(h,'URL',url+'/post'); set(h,'POSTFIELDS',Buffer.from([0,254,3]));out.post=await run();
  h.reset(); set(h,'URL',url+'/incomplete');set(h,'WRITEFUNCTION',b=>b.length);out.partial=await run();
  set(h,'URL',url+'/short');set(h,'WRITEFUNCTION',()=>0);out.short=await run();
  set(h,'URL',url+'/timeout');set(h,'TIMEOUT_MS',300);out.timeout=await run();
  h.reset(); set(h,'URL',url+'/cancel'); let stray=0; m.onMessage(()=>stray++);
  await new Promise(resolve=>{set(h,'HEADERFUNCTION',b=>{if(h.isInsideMultiHandle){m.removeHandle(h);resolve()}return b.length});m.addHandle(h)});
   await new Promise(resolve=>setTimeout(resolve,80));out.canceled=[stray,m.getCount(),h.isInsideMultiHandle];
   h.reset(); set(h,'SSL_OPTIONS',16);set(h,'FOLLOWLOCATION',true);set(h,'MAXREDIRS',1);set(h,'COOKIEFILE','');set(h,'PROXY','');set(h,'VERBOSE',1);set(h,'URL',url+'/redirect');
   const lines=[],received=[];set(h,'DEBUGFUNCTION',(type,b)=>{if(type===1)lines.push(b.toString('latin1'));if(type===3)received.push(b);return 0});
   out.redirect=await run();out.redirectInfo=[h.getInfo('RESPONSE_CODE').data,h.getInfo('REDIRECT_COUNT').data,h.getInfo('SIZE_DOWNLOAD').data,h.getInfo('TOTAL_TIME').data];
   out.debug=[lines.join(''),Buffer.concat(received).toString('hex')];
   set(h,'MAXREDIRS',0);out.limit=await run();
   set(h,'MAXREDIRS',1);set(h,'URL',url+'/to-tls');out.tls=await run();
   out.unsupported=[h.setOpt('SSL_VERIFYPEER',0),h.setOpt('CAINFO_BLOB','test'),h.setOpt('NOSUCHOPTION',1),h.getInfo('NOSUCHINFO').code,h.perform()];
  h.close();m.close();
 }catch(e){out={error:e.stack||String(e)}}
 fs.writeFileSync('/tmp/report',JSON.stringify(out));await win.loadFile('index.html');
});`,
			"index.html":
				'<pre id="report"></pre><script>document.querySelector("pre").textContent=require("fs").readFileSync("/tmp/report","utf8")</script>',
		});
		await page.goto("/");
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#settings-button").click();
		await page
			.locator("#wisp-url")
			.fill(`${new URL(page.url()).origin.replace(/^http/, "ws")}/wisp/`);
		await page.getByRole("button", { name: "Save settings", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
		await page.locator("#zip-input").setInputFiles({
			name: "resources.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
		});
		const report = page.frameLocator('iframe[data-neutron-id="1"]').locator("#report");
		await expect(report).not.toBeEmpty({ timeout: 30000 });
		const got = JSON.parse((await report.textContent()) || "null");
		expect(got).toMatchObject({
			init: 0,
			get: [false, 0],
			post: [false, 0],
			status: { code: 0, data: 418 },
			url: { code: 0, data: `${url}/bytes` },
			body: response.toString("hex"),
			partial: [true, 18],
			short: [true, 23],
			timeout: [true, 28],
			canceled: [0, 0, false],
			redirect: [false, 0],
			limit: [true, 47],
			tls: [true, 4],
		});
		expect(got.headers).toContain(
			"HTTP/1.1 418 Custom Reason\r\nX-Repeat: one\r\nX-Repeat: two\r\n",
		);
		expect(got.unsupported).not.toContain(0);
		expect(got.redirectInfo.slice(0, 3)).toEqual([418, 1, response.length]);
		expect(got.redirectInfo[3]).toBeGreaterThan(0);
		expect(got.debug[0]).toContain("302 Found");
		expect(got.debug[0]).toContain("418 Custom Reason");
		expect(got.debug[1]).toBe(response.toString("hex"));
		expect(hits.find((hit) => hit.path === "/target")?.cookie).toBe("probe=value");
		expect(hits.map((h) => h.path)).toEqual([
			"/bytes",
			"/post",
			"/incomplete",
			"/short",
			"/timeout",
			"/cancel",
			"/redirect",
			"/target",
			"/redirect",
			"/to-tls",
		]);
		expect(hits[0]).toMatchObject({ method: "GET", header: "test", body: "" });
		expect(hits[1]).toMatchObject({ method: "POST", body: "00fe03" });
		await expect.poll(() => canceled).toBe(true);
	} finally {
		fixture.closeAllConnections();
		await new Promise<void>((ok) => fixture.close(() => ok()));
	}
});
