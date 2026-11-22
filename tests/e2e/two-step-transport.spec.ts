import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { json } from "node:stream/consumers";
import { createAsar } from "@neutron/runtime/asar";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";

// Neither endpoint receives user input. The fixture returns only statuses and a synthetic ticket.
const guest = (
	peer: string,
) => `<!doctype html><title>Two step transport</title><output></output><script>
(async () => {
  const statuses = [];
  const xhr = (path, body) => new Promise((resolve, reject) => {
    const r = new XMLHttpRequest(); r.open(body ? 'POST' : 'GET', path); r.withCredentials = true;
    r.setRequestHeader('X-Fixture-Step', 'round-trip');
    if (body) r.setRequestHeader('Content-Type', 'application/json');
    r.onload = () => resolve(r.status); r.onerror = () => reject(Error('xhr failed'));
    r.send(body && JSON.stringify(body));
  });
  const start = await fetch('begin', {method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json', 'X-Fixture-Step':'round-trip'}, body:JSON.stringify({step:'begin'})});
  statuses.push(start.status);
  const {ticket} = await start.json();
  statuses.push(await xhr('check', {ticket, code:1234}));
  statuses.push(await xhr('check', {ticket, code:'001234'}));
  const headers = {'X-Fixture-Step':'round-trip'};
  statuses.push((await fetch('result', {credentials:'include', headers})).status);
  statuses.push((await fetch('result', {credentials:'same-origin', headers})).status);
  statuses.push((await fetch('without-cookie', {credentials:'omit'})).status);
  statuses.push((await fetch(${JSON.stringify(peer)}, {credentials:'same-origin'})).status);
  statuses.push(await xhr('result'));
  document.querySelector('output').textContent = statuses.join(',');
})().catch(error => document.querySelector('output').textContent = error.name);
</script>`;

function withoutCookie(req: IncomingMessage, res: ServerResponse) {
	res.writeHead(req.headers.cookie ? 409 : 200, {
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
		"Set-Cookie": "stage=unused; Path=/flow; HttpOnly",
	});
	res.end();
}

test("proxied two-step JSON, statuses and cookies survive credentialed fetch and XHR", async ({
	page,
}) => {
	const ticket = `sample/+%=é:${crypto.randomUUID()}`;
	// Same cookie domain, different virtual origin. The default credentials mode
	// must still exclude its cookies, even though both URLs rewrite to the shell.
	const peer = createServer(withoutCookie);
	const upstream = createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (req.url === "/flow/page") {
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			return res.end(
				guest(
					`http://127.0.0.1:${(peer.address() as AddressInfo).port}/flow/without-cookie`,
				),
			);
		}
		const cookie = req.headers.cookie?.split(/;\s*/).sort().join(";");
		if (req.url === "/flow/without-cookie") return withoutCookie(req, res);
		if (req.url === "/flow/result" && req.method === "GET") {
			res.statusCode =
				req.headers["x-fixture-step"] !== "round-trip"
					? 412
					: cookie === "marker=kept;stage=complete"
						? 200
						: 409;
			return res.end();
		}
		if (req.method !== "POST" || !["/flow/begin", "/flow/check"].includes(req.url || "")) {
			res.statusCode = 404;
			return res.end();
		}
		try {
			const body = (await json(req)) as { step?: unknown; ticket?: unknown; code?: unknown };
			if (req.headers["content-type"] !== "application/json") res.statusCode = 415;
			else if (req.url === "/flow/begin" && body.step === "begin") {
				res.writeHead(202, {
					"Content-Type": "application/json",
					"Set-Cookie": [
						"stage=started; Path=/flow; HttpOnly",
						"marker=kept; Path=/flow; HttpOnly",
					],
				});
				return res.end(JSON.stringify({ ticket }));
			} else if (body.ticket !== ticket || cookie !== "marker=kept;stage=started")
				res.statusCode = 409;
			else if (body.code !== "001234") res.statusCode = 422;
			else {
				res.setHeader("Set-Cookie", "stage=complete; Path=/flow; HttpOnly");
				res.statusCode = 204;
			}
		} catch {
			res.statusCode = 400;
		}
		res.end();
	});
	const port = Number(process.env.NEUTRON_TWO_STEP_PORT) || 0;
	upstream.listen(port, "127.0.0.1");
	peer.listen(port ? port + 1 : 0, "127.0.0.1");
	try {
		await Promise.all([once(upstream, "listening"), once(peer, "listening")]);
		const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/flow/page`;
		const archive = createAsar({
			"package.json": '{"name":"two-step-fixture","version":"1","main":"main.cjs"}',
			"main.cjs": `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow().loadURL(${JSON.stringify(url)}));`,
		});
		await page.goto("/");
		await expect(page.locator("#runtime-state")).toHaveText("Runtime ready");
		await page.locator("#zip-input").setInputFiles({
			name: "resources.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zipSync({ "resources/app.asar": archive })),
		});
		const output = page.frameLocator("iframe[data-neutron-id='1']").locator("output");
		await expect(output).toHaveText(/\S/, { timeout: 20_000 });
		expect(
			page
				.frames()
				.some((frame) => new URL(frame.url()).pathname.startsWith("/__scramjet__/")),
		).toBe(true);
		expect(await output.textContent()).toBe("202,422,204,200,200,200,200,200");
	} finally {
		await Promise.all(
			[upstream, peer].map(
				(server) =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
						server.closeAllConnections();
					}),
			),
		);
	}
});
