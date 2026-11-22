import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { WebSocketServer } from "ws";

logging.set_level(logging.ERROR);
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;
const server = http.createServer((request, response) => {
	if (request.url === "/health") return response.end("ready");
	if (request.url === "/api") {
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Set-Cookie", "fixture=remembered; Path=/; HttpOnly");
		return response.end(
			JSON.stringify({
				message: "through-wisp",
				cookie: request.headers.cookie || "",
				custom: request.headers["x-neutron-test"] || "",
			}),
		);
	}
	// Mislabelled resources (like a CDN's raw files) for webRequest header filters.
	if (request.url === "/plain-page") {
		response.setHeader("Content-Type", "text/plain");
		return response.end(
			"<!doctype html><title>Filtered page</title><link rel='stylesheet' href='/plain.css'><h1 id='filtered'>Rendered as HTML</h1><script>fetch('/blocked').then(()=>'loaded',()=>'blocked').then(result=>document.body.dataset.blocked=result)</script>",
		);
	}
	if (request.url === "/plain.css") {
		response.setHeader("Content-Type", "text/plain");
		return response.end("#filtered { color: rgb(1, 2, 3); }");
	}
	response.setHeader("Content-Type", "text/html");
	response.setHeader("X-Frame-Options", "DENY");
	if (request.url === "/nested")
		return response.end("<!doctype html><h2 id='nested-result'>Nested remote content</h2>");
	response.end(
		"<!doctype html><html><head><title>Proxied fixture</title></head><body><h1 id='remote-result'>Scramjet over libcurl over Wisp</h1><iframe src='/nested'></iframe><script>document.body.dataset.preload = window.neutronPreload?.value || 'missing'; fetch('/api').then(r=>r.json()).then(data=>document.body.dataset.network=data.message)</script></body></html>",
	);
});
server.listen(4175, "127.0.0.1");
const relay = http.createServer((_request, response) => response.end("ready"));
relay.on("upgrade", (request, socket, head) => wisp.routeRequest(request, socket, head));
relay.listen(4174, "127.0.0.1");
const websocket = new WebSocketServer({ port: 4177, host: "127.0.0.1" });
websocket.on("connection", (socket) =>
	socket.on("message", (data, binary) => socket.send(data, { binary })),
);
const tcp = net.createServer((socket) => socket.pipe(socket));
tcp.listen(4191, "127.0.0.1");
const udp = dgram.createSocket("udp4");
udp.on("message", (message, source) => udp.send(message, source.port, source.address));
udp.bind(4176, "127.0.0.1");
