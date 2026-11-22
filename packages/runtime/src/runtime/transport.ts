// Preloads run after Scramjet installs page-level proxies. Infrastructure must
// capture the embedding host's native transport instead of proxying the relay.
export function embeddingHost(): Window | undefined {
	try {
		if (typeof window !== "undefined" && window.top?.__neutron) return window.top;
	} catch {
		/* A sandboxed subframe is not allowed to access the shell. */
	}
}
export const hostScope = (embeddingHost() ?? globalThis) as typeof globalThis;
export const hostFetch = hostScope.fetch.bind(hostScope);
export const WebSocket = hostScope.WebSocket;
export const crypto = globalThis.crypto;
export const global_this = globalThis;
export const WebSocketServer = null;
export const net = null;
export const dgram = null;
export const dns = null;
export const http = null;
