import { parse, stringify } from "@ungap/structured-clone/json";

export { parse, stringify };
export interface SyncRequest {
	nonce: string;
	method: string;
	args: unknown[];
}
export interface SyncResult {
	nonce: string;
	result?: unknown;
	error?: string;
}

/** SW waits on an independent worker/host channel; no SharedArrayBuffer requirement. */
export function syncCall<T>(
	instanceId: string,
	target: "main" | "host",
	method: string,
	args: unknown[],
): T {
	const xhr = new XMLHttpRequest();
	xhr.open("POST", `/__neutron_sync__/${encodeURIComponent(instanceId)}/${target}`, false);
	xhr.setRequestHeader("Content-Type", "application/json");
	xhr.send(stringify({ nonce: crypto.randomUUID(), method, args } satisfies SyncRequest));
	if (!xhr.responseText)
		throw new Error(
			`Synchronous bridge returned an empty response: HTTP ${xhr.status} ${xhr.statusText}, readyState ${xhr.readyState}`,
		);
	const result = parse(xhr.responseText) as SyncResult;
	if (result.error) throw new Error(result.error);
	if (xhr.status !== 200) throw new Error(`Synchronous runtime request failed (${xhr.status})`);
	return result.result as T;
}
