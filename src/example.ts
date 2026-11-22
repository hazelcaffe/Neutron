export const exampleFiles: Record<string, string> = {
	"package.json": JSON.stringify(
		{
			name: "neutron-notes",
			version: "1.0.0",
			main: "main.cjs",
			description:
				"A real Electron app. Preload, IPC and persistent files, all in your browser.",
		},
		null,
		2,
	),
	"main.cjs": `const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const note = path.join(app.getPath("userData"), "note.txt");
ipcMain.handle("note:read", () => fs.existsSync(note) ? fs.readFileSync(note, "utf8") : "Hello from an Electron app.\\n\\nThis window was created by an unmodified main process. Your text travels through contextBridge → ipcRenderer.invoke → ipcMain → fs → OPFS.\\n\\nTry editing this note, saving, stopping the app, and launching it again.");
ipcMain.handle("note:save", (_event, text) => { fs.writeFileSync(note, text, "utf8"); console.log("Note saved to", note); return new Date().toLocaleTimeString(); });
ipcMain.handle("runtime:info", () => ({ app: app.getName(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, path: note }));
function createWindow() { const window = new BrowserWindow({ width: 740, height: 560, title: "Neutron Notes", backgroundColor: "#faf9f5", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true } }); window.loadFile("index.html"); }
app.whenReady().then(() => { createWindow(); Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "File", submenu: [{ label: "New window", click: createWindow }, { type: "separator" }, { role: "quit" }] }, { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools", label: "Runtime console" }] }])); console.log("Application ready", app.getVersion()); });
app.on("window-all-closed", () => app.quit());`,
	"preload.cjs": `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("notes", { read: () => ipcRenderer.invoke("note:read"), save: (text) => ipcRenderer.invoke("note:save", text), info: () => ipcRenderer.invoke("runtime:info") });`,
	"index.html": `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Neutron Notes</title><link rel="stylesheet" href="style.css"></head><body><main><header><div><span class="eyebrow">THE HELLO-WORLD, WITH A FILESYSTEM</span><h1>A little space to think.</h1></div><span class="badge">Electron app</span></header><textarea id="note" aria-label="Note" spellcheck="false" placeholder="Loading your note…"></textarea><footer><span id="status" role="status">Connecting to main process…</span><button id="save">Save note <span>↗</span></button></footer><details><summary>Under the hood</summary><pre id="info"></pre></details></main><script src="renderer.js"></script></body></html>`,
	"renderer.js": `const note = document.getElementById("note"); const status = document.getElementById("status");
window.notes.read().then(text => { note.value = text; status.textContent = "Loaded from your virtual filesystem"; }).catch(error => status.textContent = error.message);
window.notes.info().then(info => document.getElementById("info").textContent = JSON.stringify(info, null, 2));
document.getElementById("save").addEventListener("click", async () => { try { const time = await window.notes.save(note.value); status.textContent = "Saved at " + time; } catch(error) { status.textContent = error.message; } });
note.addEventListener("input", () => status.textContent = "Unsaved changes");`,
	"style.css": `*{box-sizing:border-box}body{margin:0;background:#faf9f5;color:#273b36;font-family:system-ui,sans-serif}main{padding:32px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}.eyebrow{font-size:9px;letter-spacing:1.8px;color:#7b8b82;font-weight:700}h1{font-family:Georgia,serif;font-size:30px;font-weight:400;margin:10px 0}.badge{font-size:10px;padding:7px 10px;border:1px solid #dae3db;border-radius:20px;color:#687d70}textarea{display:block;width:100%;height:250px;resize:vertical;border:1px solid #dfe3da;border-radius:8px;background:#fffefa;outline:none;padding:20px;color:#46544a;font:14px/1.8 ui-monospace,monospace}textarea:focus{border-color:#75a18a;box-shadow:0 0 0 3px #75a18a15}footer{display:flex;justify-content:space-between;align-items:center;margin:16px 0}#status{font-size:11px;color:#7c897e}button{background:#315744;border:0;padding:11px 18px;color:white;border-radius:6px;cursor:pointer;font-weight:600}button span{margin-left:24px}details{font-size:11px;color:#8b958b;margin-top:28px}pre{font-size:10px;line-height:1.7;white-space:pre-wrap}`,
};
