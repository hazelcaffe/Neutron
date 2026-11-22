import { createAsar } from "@neutron/runtime/asar";
import { expect, type Page, test } from "@playwright/test";
import { zipSync } from "fflate";

async function launchFixture(page: Page, main: string) {
	const archive = createAsar({
		"package.json": '{"name":"shutdown-contract","version":"1","main":"main.cjs"}',
		"main.cjs": `const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs');
const journal='/tmp/journal', owned='/tmp/owned';
const record=value=>fs.appendFileSync(journal,value+'\\n');
process.on('exit',code=>record('exit '+code));
app.on('quit',(_event,code)=>record('quit '+code));
app.on('before-quit',()=>record('before-quit'));
app.on('will-quit',()=>record('will-quit'));
app.whenReady().then(()=>{
 const win=new BrowserWindow({webPreferences:{preload:'/app/preload.cjs'}});
 win.on('closed',()=>record('closed'));
 ipcMain.on('action',(_event,action)=>{
   if(action==='app.exit')app.exit(7);
   if(action==='process.exit')process.exit(8);
   if(action==='app.quit')app.quit();
 });
 ${main}
 win.loadFile('index.html');
});`,
		"preload.cjs": `const {ipcRenderer,contextBridge}=require('electron');
ipcRenderer.on('prepare-close',()=>setTimeout(()=>ipcRenderer.send('can-close'),25));
contextBridge.exposeInMainWorld('action',value=>ipcRenderer.send('action',value));`,
		"index.html": `<button onclick="action('app.quit')">Quit</button><button onclick="action('app.exit')">Exit app</button><button onclick="action('process.exit')">Exit process</button>`,
	});
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
	});
	await expect(page.frameLocator("iframe[data-neutron-id]").getByText("Quit")).toBeVisible();
}

async function files(page: Page) {
	const id = await page.locator("#application-select").inputValue();
	return page.evaluate(async (id) => {
		let dir = await navigator.storage.getDirectory();
		for (const part of ["neutron", "apps", id, "fs", "tmp"])
			dir = await dir.getDirectoryHandle(part);
		const journal = await (await dir.getFileHandle("journal")).getFile();
		const owned = await dir.getFileHandle("owned").then(
			() => true,
			(error) => {
				if (error.name !== "NotFoundError") throw error;
				return false;
			},
		);
		return { journal: (await journal.text()).trim().split("\n"), owned };
	}, id);
}

test("Stop and Restart wait for a renderer-approved close and durable main-process cleanup", async ({
	page,
}) => {
	await launchFixture(
		page,
		`if(fs.existsSync(owned))throw Error('previous instance still owns file');
 fs.writeFileSync(owned,'live'); record('open');
 const boot=fs.readFileSync(journal,'utf8').split('\\n').filter(value=>value==='open').length;
 win.webContents.once('did-finish-load',()=>win.setTitle('Run '+boot));
 let approved=false;
 win.on('close',event=>{
   if(approved)return;
   record('await renderer');event.preventDefault();win.webContents.send('prepare-close');
 });
 ipcMain.once('can-close',()=>{approved=true;record('approved');app.quit()});
 process.on('exit',()=>fs.unlinkSync(owned));`,
	);
	const stopped = [
		"open",
		"before-quit",
		"await renderer",
		"approved",
		"before-quit",
		"closed",
		"will-quit",
		"quit 0",
		"exit 0",
	];
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	expect(await files(page)).toEqual({ journal: stopped, owned: false });
	await page.reload();
	await page.locator("#launch-button").click();
	const quit = page.frameLocator("iframe[data-neutron-id]").getByText("Quit");
	await expect(quit).toBeVisible();
	await page.locator("#launch-button").click();
	await expect(page.locator("iframe[data-neutron-id]")).toHaveAttribute("title", "Run 3");
	await quit.click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	expect(await files(page)).toEqual({
		journal: [...stopped, ...stopped, ...stopped],
		owned: false,
	});
});

for (const [action, expected] of [
	["Quit", ["before-quit", "close", "closed", "will-quit", "quit 0", "exit 0"]],
	["Exit app", ["closed", "quit 7", "exit 7"]],
	["Exit process", ["exit 8"]],
] as const) {
	test(`${action} after a veto keeps the app's exit semantics`, async ({ page }) => {
		await launchFixture(
			page,
			`record('open'); app.once('before-quit',event=>{event.preventDefault();win.setTitle('Vetoed')});
			win.on('close',()=>record('close'));`,
		);
		const frame = page.frameLocator("iframe[data-neutron-id]");
		await frame.getByText("Quit", { exact: true }).click();
		await expect(page.locator("iframe[data-neutron-id]")).toHaveAttribute("title", "Vetoed");
		await frame.getByText(action, { exact: true }).click();
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		expect((await files(page)).journal).toEqual(["open", "before-quit", ...expected]);
	});
}

test("host Stop can finish even if a close handler always vetoes", async ({ page }) => {
	await launchFixture(page, `record('open'); win.on('close',event=>event.preventDefault());`);
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	expect((await files(page)).journal).toEqual([
		"open",
		"before-quit",
		"closed",
		"quit 0",
		"exit 0",
	]);
});

test("host Stop can terminate a blocked main worker", async ({ page }) => {
	await launchFixture(page, `record('open'); app.on('before-quit',()=>{for (;;) {}});`);
	await page.locator("#stop-button").click();
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	expect((await files(page)).journal).toEqual(["open", "before-quit"]);
});
