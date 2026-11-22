import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

test("webContents reports the committed document, same-document navigation and title changes", async ({
	page,
}) => {
	const archive = createAsar({
		"package.json": '{"name":"navigation-contract","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
app.whenReady().then(async()=>{
  protocol.handle('https', request => new URL(request.url).pathname==='/start' ? Response.redirect('https://nav.invalid/final?from=start',302) : net.fetch('file:///app/page.html',{bypassCustomProtocolHandlers:true}));
  const w=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}}),wc=w.webContents,events=[];
  for(const name of ['did-start-navigation','did-navigate','did-navigate-in-page','dom-ready','did-finish-load','did-stop-loading']) wc.on(name,(event,url)=>events.push([name,url,wc.getURL()]));
  w.on('page-title-updated',(event,title)=>{if(title==='ignored')event.preventDefault();});
  ipcMain.handle('report',()=>({url:wc.getURL(),senderURL:wc.mainFrame.url,title:wc.getTitle(),windowTitle:w.getTitle(),loading:wc.isLoadingMainFrame(),events}));
  await w.loadURL('https://nav.invalid/start');
});`,
		"preload.cjs": `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('report',()=>ipcRenderer.invoke('report'));`,
		"page.html": `<!doctype html><title>First title</title><button id="change" onclick="history.pushState({},'', '/next?value=2#anchor');document.title='Second title'">Next</button><button onclick="document.title='ignored'">Ignore title</button><button id="state">Update state only</button><output id="states"></output><script>
document.querySelector('#state').onclick=()=>{const values=[];const record=()=>values.push([location.href,history.state]);
history.replaceState('omitted','');record();history.pushState('undefined','',undefined);record();history.replaceState('null','',null);record();history.pushState('empty','','');record();
document.querySelector('#states').textContent=JSON.stringify(values);};</script>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	const app = page.frameLocator('iframe[data-neutron-id="1"]');
	const next = app.locator("#change");
	const report = () => next.evaluate(() => Reflect.get(window, "report")());
	await expect.poll(report).toMatchObject({
		url: "https://nav.invalid/final?from=start",
		senderURL: "https://nav.invalid/final?from=start",
		title: "First title",
		windowTitle: "First title",
		loading: false,
	});
	const events = (await report()).events as [string, string | null, string][];
	expect(events.map(([name]) => name)).toEqual([
		"did-start-navigation",
		"did-navigate",
		"dom-ready",
		"did-finish-load",
		"did-stop-loading",
	]);
	expect(events[1]?.slice(1)).toEqual([
		"https://nav.invalid/final?from=start",
		"https://nav.invalid/final?from=start",
	]);
	await next.click();
	await expect.poll(report).toMatchObject({
		url: "https://nav.invalid/next?value=2#anchor",
		title: "Second title",
		windowTitle: "Second title",
		loading: false,
	});
	expect((await report()).events.at(-1)[0]).toBe("did-navigate-in-page");
	await app.getByText("Update state only").click();
	await expect(app.locator("#states")).toHaveText(
		JSON.stringify(
			["omitted", "undefined", "null", "empty"].map((state) => [
				"https://nav.invalid/next?value=2#anchor",
				state,
			]),
		),
	);
	await app.getByText("Ignore title").click();
	await expect.poll(report).toMatchObject({ title: "ignored", windowTitle: "Second title" });
});
