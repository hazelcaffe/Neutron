/** Private, buffered request/reply between the external-browser SW and a main worker. */
export const LOOPBACK_PROBE = "neutron-loopback-probe";
export const LOOPBACK_BYTES = 1024 * 1024;
export const LOOPBACK_TIMEOUT = 15_000;

export function isLoopbackHTTP(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
		!url.username &&
		!url.password
	);
}

export interface CallbackRequest {
	method: string;
	path: string;
	headers: [string, string][];
	body?: ArrayBuffer;
}
export type CallbackReply =
	| { type: "bound" | "miss" }
	| { type: "failed"; status: number }
	| {
			type: "response";
			status: number;
			statusText: string;
			headers: [string, string][];
			body: ArrayBuffer;
	  };

export function rejectProbe(port: MessagePort, status: number): void {
	port.postMessage({ type: "failed", status } satisfies CallbackReply);
	port.close();
}
