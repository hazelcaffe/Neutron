import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { createAsar } from "@neutron/runtime/asar";
import { expect, type Page, test } from "@playwright/test";
import { zipSync } from "fflate";

const require = createRequire(import.meta.url);
const fake = new URL("../fixtures/webusb-fake.js", import.meta.url).pathname;

/** A package's files (without source maps and typings), as an app ships them. */
function packageFiles(root: string, into: string, files: Record<string, Uint8Array>) {
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (name === "node_modules" || name === "libusb" || name === "src") continue;
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(js|json)$/.test(name) && !name.endsWith(".map"))
				files[`${into}/${relative(root, path)}`] = readFileSync(path);
		}
	};
	walk(root);
}

async function run(page: Page, files: Record<string, string | Uint8Array>) {
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
	await page.locator("#zip-input").setInputFiles({
		name: "resources.zip",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({ "resources/app.asar": createAsar(files) })),
	});
	return page.frameLocator("iframe[name='neutron:1']");
}

test("node-usb in the main process uses a WebUSB device the user chooses", async ({ page }) => {
	await page.addInitScript({ path: fake });
	const usbRoot = dirname(require.resolve("usb/package.json"));
	const gypBuild = dirname(
		createRequire(join(usbRoot, "package.json")).resolve("node-gyp-build/package.json"),
	);
	const files: Record<string, string | Uint8Array> = {
		"package.json": '{"name":"usb-main","version":"1.0.0","main":"main.cjs"}',
		"index.html": "<html><body><p>USB</p></body></html>",
		// The prebuilt addon node-gyp-build selects; Neutron replaces it.
		"node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node": new Uint8Array(4),
		"main.cjs": `const { app, BrowserWindow } = require("electron");
const { usb, getDeviceList, WebUSB } = require("usb");
const call = (fn) => new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
app.whenReady().then(async () => {
	const window = new BrowserWindow();
	await window.loadFile("index.html");
	const report = (result) => window.webContents.executeJavaScript("document.body.dataset.result=" + JSON.stringify(JSON.stringify(result)));
	usb.on("attach", async (device) => {
		try {
			const result = { listed: getDeviceList().length };
			device.open();
			const d = device.deviceDescriptor;
			result.ids = [d.idVendor, d.idProduct, d.bcdUSB, d.bMaxPacketSize0, d.iProduct];
			result.product = await call((cb) => device.getStringDescriptor(d.iProduct, cb));
			result.serial = await call((cb) => device.getStringDescriptor(d.iSerialNumber, cb));
			const alternate = device.configDescriptor.interfaces[0][0];
			result.extra = [...alternate.extra];
			result.endpoints = alternate.endpoints.map((e) => [e.bEndpointAddress, e.bmAttributes, e.bInterval]);
			result.pong = (await call((cb) => device.controlTransfer(0xc0, 0x01, 7, 0, 16, cb))).toString();
			result.stall = await call((cb) => device.controlTransfer(0xc0, 0x09, 0, 0, 4, cb)).then(
				() => "completed",
				(error) => (error.errno === usb.LIBUSB_TRANSFER_STALL ? error.message : "other " + error.message),
			);
			const iface = device.interface(0);
			iface.claim();
			const [out, input, interrupt] = iface.endpoints;
			await call((cb) => out.transfer(Buffer.from("hello usb"), cb));
			result.echo = (await call((cb) => input.transfer(64, cb))).toString();
			result.polled = await new Promise((resolve) => {
				const seen = [];
				interrupt.on("data", (data) => {
					seen.push(data[0]);
					if (seen.length === 3) interrupt.stopPoll(() => resolve(seen));
				});
				interrupt.startPoll(1, 8);
			});
			await call((cb) => iface.release(cb));
			device.close();
			const webusb = await new WebUSB({ allowAllDevices: true }).getDevices();
			result.webusb = webusb.map((item) => item.productName);
			report(result);
		} catch (error) {
			report({ error: error.message, errno: error.errno, stack: error.stack });
		}
	});
	// Nothing is granted yet: the page offers its chooser.
	window.webContents.executeJavaScript("document.body.dataset.initial=" + getDeviceList().length);
});`,
	};
	packageFiles(usbRoot, "node_modules/usb", files as Record<string, Uint8Array>);
	packageFiles(gypBuild, "node_modules/node-gyp-build", files as Record<string, Uint8Array>);
	const app = await run(page, files);
	await expect(app.locator("body")).toHaveAttribute("data-initial", "0");
	await expect(page.locator("#device-request")).toContainText("looking for a USB device");
	await page.locator("#choose-usb-device").click();
	await expect(page.locator("#device-request")).toBeHidden();
	await expect(app.locator("body")).toHaveAttribute("data-result", /.+/, { timeout: 30_000 });
	const result = JSON.parse((await app.locator("body").getAttribute("data-result")) || "{}");
	expect(result).toEqual({
		listed: 1,
		ids: [0x1209, 0x0001, 0x0210, 64, 2],
		product: "Neutron Test Device",
		serial: "NT-0001",
		extra: [5, 0x24, 0x01, 0xab, 0xcd],
		endpoints: [
			[0x01, 2, 0],
			[0x81, 2, 0],
			[0x82, 3, 10],
		],
		pong: "pong:7",
		stall: "LIBUSB_TRANSFER_STALL",
		echo: "bsu olleh",
		polled: [1, 2, 3],
		webusb: ["Neutron Test Device"],
	});
});

test("navigator.usb.requestDevice in a window asks the session's select-usb-device handler", async ({
	page,
}) => {
	await page.addInitScript({ path: fake });
	const app = await run(page, {
		"package.json": '{"name":"usb-renderer","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const { app, BrowserWindow, session, ipcMain } = require("electron");
const seen = [];
const select = (event, details, callback) => {
	event.preventDefault();
	seen.push(details.deviceList.map((device) => device.productName + ":" + device.vendorId));
	callback(details.deviceList.find((device) => device.vendorId === 0x1209)?.deviceId);
};
app.whenReady().then(async () => {
	session.defaultSession.on("select-usb-device", select);
	ipcMain.handle("seen", () => seen);
	ipcMain.handle("drop-handler", () => {
		session.defaultSession.removeListener("select-usb-device", select);
	});
	const window = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
	await window.loadFile("index.html");
});`,
		"index.html": `<html><body><button id="connect">Connect</button><button id="again">Again</button><pre id="out"></pre><script>
const { ipcRenderer } = require("electron");
const out = document.querySelector("#out");
document.querySelector("#connect").onclick = async () => {
	try {
		const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x1209 }] });
		await device.open();
		const reply = await device.controlTransferIn({ requestType: "vendor", recipient: "device", request: 1, value: 42, index: 0 }, 16);
		out.dataset.first = [new TextDecoder().decode(reply.data), JSON.stringify(await ipcRenderer.invoke("seen")), (await navigator.usb.getDevices()).length].join("|");
	} catch (error) {
		out.dataset.first = "error " + error.name + " " + error.message;
	}
};
document.querySelector("#again").onclick = async () => {
	await ipcRenderer.invoke("drop-handler");
	out.dataset.second = await navigator.usb.requestDevice({ filters: [] }).then(() => "resolved", (error) => error.name);
};
</script></body></html>`,
	});
	await app.locator("#connect").click();
	await expect(app.locator("#out")).toHaveAttribute(
		"data-first",
		'pong:42|[["Neutron Test Device:4617"]]|1',
	);
	// Without a handler Electron cancels the request; so does Neutron.
	await app.locator("#again").click();
	await expect(app.locator("#out")).toHaveAttribute("data-second", "NotFoundError");
});

test("app windows may use device APIs; web pages in Browser tabs may not", async ({ page }) => {
	const app = await run(page, {
		"package.json": '{"name":"usb-policy","version":"1.0.0","main":"main.cjs"}',
		"main.cjs": `const { app, BrowserWindow, shell } = require("electron");
app.whenReady().then(async () => {
	const window = new BrowserWindow();
	await window.loadFile("index.html");
	await shell.openExternal("http://127.0.0.1:4175/nested");
});`,
		"index.html": `<html><body><script>
const probe = (api) => api ? (api.getDevices ? api.getDevices() : api.getPorts()).then(() => "allowed", (error) => error.name) : Promise.resolve("missing");
Promise.all([probe(navigator.usb), probe(navigator.hid), probe(navigator.serial)]).then((result) => { document.body.dataset.result = result.join(","); });
</script></body></html>`,
	});
	await expect(app.locator("body")).toHaveAttribute("data-result", "allowed,allowed,allowed");
	const tab = page.frameLocator("iframe[data-neutron-browser]");
	await expect(tab.locator("#nested-result")).toBeVisible();
	const frame = page.frames().find((item) => item.name().startsWith("neutron-browser:"));
	expect(
		await frame?.evaluate(() =>
			Promise.all(
				[
					(
						navigator as Navigator & { usb?: { getDevices(): Promise<unknown> } }
					).usb?.getDevices(),
					(
						navigator as Navigator & { hid?: { getDevices(): Promise<unknown> } }
					).hid?.getDevices(),
					(
						navigator as Navigator & { serial?: { getPorts(): Promise<unknown> } }
					).serial?.getPorts(),
				].map((request) =>
					request?.then(
						() => "allowed",
						(error: Error) => error.name,
					),
				),
			),
		),
	).toEqual(["SecurityError", "SecurityError", "SecurityError"]);
});
