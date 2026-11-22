import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";
import { Network } from "./network";

/** Scramjet v2's ProxyTransport, using Neutron's libcurl + wisp-js stack. */
export function proxyTransport(wisp: string): ProxyTransport {
	const network = new Network(wisp, () => {});
	return {
		ready: true,
		init: async () => {},
		async request(url, method, body, headers, signal): Promise<TransferrableResponse> {
			const response = await network.fetch(url.href, {
				method,
				body,
				// libcurl.js accepts a Headers object or dictionary; its request
				// serializer treats an array of raw header pairs as numeric keys.
				headers: new Headers(headers),
				// Scramjet supplies the virtual site's Cookie header and consumes
				// raw Set-Cookie lines. Don't consult a second libcurl cookie jar.
				credentials: "omit",
				signal,
				redirect: "manual",
			});
			return {
				body: response.body || "",
				status: response.status,
				statusText: response.statusText,
				headers: (Reflect.get(response, "raw_headers") as RawHeaders | undefined) || [
					...response.headers,
				],
			};
		},
		connect(url, protocols, _headers, onopen, onmessage, onclose, onerror) {
			const Socket = network.webSocketClass();
			const socket = new Socket(url.href, protocols);
			socket.onopen = () => onopen(socket.protocol, socket.extensions);
			socket.onmessage = (event) => onmessage(event.data);
			socket.onclose = (event) => onclose(event.code, event.reason);
			socket.onerror = (event) => onerror(String(event));
			return [(data) => socket.send(data), (code, reason) => socket.close(code, reason)];
		},
	};
}
