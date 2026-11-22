import { scramjetPrefix } from "../shared/base";
import {
	type CallbackReply,
	type CallbackRequest,
	LOOPBACK_BYTES,
	LOOPBACK_PROBE,
	LOOPBACK_TIMEOUT,
} from "../shared/loopback";
import type { ProxySession } from "./proxy";

const unavailable = (status: number) =>
	new Response("Loopback callback unavailable", {
		status,
		headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
	});

export interface BrowserCallback {
	owner: string | null;
	caller: boolean | string;
	headers: [string, string][];
	body?: ArrayBuffer;
	signal?: AbortSignal;
}

// Only an origin is probed. The URL path/query and body are sent on the private
// port *after* a live binding claims it. A timeout or expired run fails closed.
export async function browserLoopback(
	session: ProxySession,
	owner: Client | undefined,
	target: URL,
	method: string,
	callback: BrowserCallback,
): Promise<Response | undefined> {
	const { caller, headers, body } = callback;
	if (callback.signal?.aborted) return unavailable(499);
	if (!owner || !session.runId) return unavailable(410);
	// A copied proxy URL in another renderer or shell is not a caller in this
	// browser session. For the first iframe navigation Chromium exposes only
	// the referrer, so require a navigation from the owning shell or session.
	if (
		caller !== true &&
		!(
			typeof caller === "string" &&
			caller &&
			(caller === owner.url.split("#", 1)[0] ||
				caller.startsWith(`${new URL(owner.url).origin}${scramjetPrefix(session.id)}`))
		)
	)
		return unavailable(403);
	const { port1, port2 } = new MessageChannel();
	return new Promise((resolve) => {
		let finished = false;
		const finish = (response?: Response) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			callback.signal?.removeEventListener("abort", abort);
			port1.close();
			resolve(response);
		};
		const cancel = (status: number) => {
			port1.postMessage({ cancel: true });
			finish(unavailable(status));
		};
		const timer = setTimeout(() => cancel(504), LOOPBACK_TIMEOUT);
		const abort = () => cancel(499);
		callback.signal?.addEventListener("abort", abort, { once: true });
		port1.onmessageerror = () => cancel(502);
		port1.onmessage = ({ data }: MessageEvent<CallbackReply>) => {
			try {
				if (data.type === "miss") return finish(); // unrelated outgoing HTTP
				if (data.type === "failed") return finish(unavailable(data.status));
				if (data.type === "response")
					return finish(
						new Response(
							method === "HEAD" || [204, 205, 304].includes(data.status)
								? null
								: data.body,
							{
								status: data.status,
								statusText: data.statusText,
								headers: data.headers,
							},
						),
					);
				if (data.type !== "bound") return cancel(502);
				if (body && body.byteLength > LOOPBACK_BYTES) return cancel(413);
				port1.postMessage(
					{
						method,
						path: target.href.slice(target.origin.length).replace(/#.*$/s, ""),
						headers,
						body,
					} satisfies CallbackRequest,
					body ? [body] : [],
				);
			} catch {
				cancel(502);
			}
		};
		try {
			owner.postMessage(
				{
					type: LOOPBACK_PROBE,
					sessionId: session.id,
					runId: session.runId,
					bootstrap: caller === owner.url.split("#", 1)[0],
					appId: session.appId,
					origin: target.origin,
				},
				[port2],
			);
		} catch {
			port2.close();
			finish(unavailable(410));
		}
	});
}
