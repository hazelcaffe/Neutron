import type { ScramjetAPI } from "../shared/proxy-context";
import { matchesURLPattern } from "../shared/urls";
import type { ProxySession } from "./proxy";

// Electron applies `session.webRequest.onHeadersReceived` to every response
// of the session, including the renderer's documents and subresources. Those
// load through the Scramjet proxy in this worker, so the proxy asks the main
// process for the change before Scramjet interprets the response (its
// Content-Type selects the HTML/JS/CSS rewriter).
type RawHeaders = [string, string][];
interface BareResponseLike {
	body: ReadableStream<Uint8Array> | null;
	status: number;
	statusText: string;
	rawHeaders: RawHeaders;
	url: string;
	redirected: boolean;
}
export interface HeaderChange {
	cancel?: boolean;
	responseHeaders?: Record<string, string | string[]>;
	statusLine?: string;
}

const RESOURCE_TYPES: Record<string, string> = {
	style: "stylesheet",
	script: "script",
	image: "image",
	font: "font",
	object: "object",
	embed: "object",
	audio: "media",
	video: "media",
	track: "media",
	"": "xhr",
	empty: "xhr",
	report: "cspReport",
};
export function resourceType(destination: string, isIframe = false): string {
	if (destination === "document" || destination === "iframe" || destination === "frame")
		return isIframe ? "subFrame" : "mainFrame";
	return RESOURCE_TYPES[destination] ?? "other";
}
/** Electron reports response headers as name → values, in the received case. */
export function headerRecord(raw: RawHeaders): Record<string, string[]> {
	const record: Record<string, string[]> = {};
	const names = new Map<string, string>();
	for (const [name, value] of raw) {
		const key = names.get(name.toLowerCase()) ?? name;
		names.set(name.toLowerCase(), key);
		record[key] = [...(record[key] ?? []), value];
	}
	return record;
}
export function rawHeaders(record: Record<string, string | string[]>): RawHeaders {
	return Object.entries(record).flatMap(([name, value]) =>
		(Array.isArray(value) ? value : [value]).map((part): [string, string] => [
			name,
			String(part),
		]),
	);
}

export class BlockedByClient extends Error {
	constructor() {
		super("net::ERR_BLOCKED_BY_CLIENT");
	}
}

function askMain(session: ProxySession, received: object): Promise<HeaderChange> {
	const nonce = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const channel = new BroadcastChannel(`neutron-protocol:${session.runId ?? session.id}`);
		const finish = () => {
			clearTimeout(timer);
			channel.close();
		};
		// A filter that never answers leaves the response as received.
		const timer = setTimeout(() => {
			finish();
			console.warn("webRequest.onHeadersReceived did not answer within 15 s");
			resolve({});
		}, 15_000);
		channel.onmessage = (
			event: MessageEvent<{ nonce: string; error?: string; change?: HeaderChange }>,
		) => {
			if (event.data.nonce !== nonce) return;
			finish();
			if (event.data.error) reject(new Error(event.data.error));
			else resolve(event.data.change ?? {});
		};
		channel.postMessage({ nonce, partition: session.partition, received });
	});
}

/** Scramjet `fetch.preresponse` tap for a session with an onHeadersReceived filter. */
export async function applyHeaderFilter(
	api: ScramjetAPI,
	session: ProxySession,
	input: unknown,
	output: unknown,
): Promise<void> {
	const { parsed, request } = input as {
		parsed: { url: URL; destination: string; isIframe?: boolean };
		request: { method: string };
	};
	const state = output as { response: BareResponseLike };
	const url = parsed.url.href;
	if (
		!/^https?:$/.test(parsed.url.protocol) ||
		!session.headerFilters?.some((pattern) => matchesURLPattern(pattern, url))
	)
		return;
	const response = state.response;
	const change = await askMain(session, {
		url,
		method: request.method,
		resourceType: resourceType(parsed.destination, parsed.isIframe),
		referrer: "",
		timestamp: Date.now(),
		statusLine: `HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd(),
		statusCode: response.status,
		responseHeaders: headerRecord(response.rawHeaders),
		fromCache: false,
	});
	if (change.cancel) throw new BlockedByClient();
	if (!change.responseHeaders && typeof change.statusLine !== "string") return;
	const raw = change.responseHeaders ? rawHeaders(change.responseHeaders) : response.rawHeaders;
	let { status, statusText } = response;
	const line =
		typeof change.statusLine === "string"
			? /^\S+\s+(\d{3})(?:\s+(.*))?$/.exec(change.statusLine)
			: null;
	if (line) {
		status = Number(line[1]);
		statusText = line[2] ?? "";
	}
	// The native Headers drive Scramjet's body handling; the raw list (with
	// Set-Cookie, which a Response cannot hold) drives its header rewriting.
	const next = new api.BareResponse(
		[101, 204, 205, 304].includes(status) ? null : response.body,
		{
			status,
			statusText,
			headers: raw.filter(([name]) => !/^set-cookie2?$/i.test(name)),
		},
	) as unknown as BareResponseLike;
	Object.assign(next, { url: response.url, redirected: response.redirected, rawHeaders: raw });
	state.response = next;
}
