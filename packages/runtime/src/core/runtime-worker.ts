import { fileGatePrefix, runtimeBase, runtimePath } from "../shared/base";
import { type FilePatch, HOST_WORKER_PROTOCOL } from "../shared/types";
import type { ProxySession } from "./proxy";

type HostRequest =
	| { type: "proxy-configure"; session: ProxySession }
	| { type: "persist-files"; id: string; patches: FilePatch[]; gate?: FileGate };
/** Identifies a write announcement: one stream per AppStorage, numbered in order. */
export interface FileGate {
	stream: string;
	seq: number;
}
let verified: ServiceWorker | undefined;
const changed = "The runtime service worker changed. Reload Neutron before launching again.";

function controlsPage(worker: ServiceWorker): boolean {
	return worker.state === "activated" && navigator.serviceWorker.controller === worker;
}

function post(
	worker: ServiceWorker,
	message: HostRequest | { type: "runtime-handshake" },
	timeout: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!controlsPage(worker)) throw new Error(changed);
		const channel = new MessageChannel();
		const finish = (error?: Error) => {
			clearTimeout(timer);
			navigator.serviceWorker.removeEventListener("controllerchange", check);
			channel.port1.close();
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (!controlsPage(worker)) finish(new Error(changed));
		};
		const timer = setTimeout(
			() => finish(new Error(`Runtime service worker timed out: ${message.type}`)),
			timeout,
		);
		navigator.serviceWorker.addEventListener("controllerchange", check);
		const invalid = () => finish(new Error(`Invalid service-worker reply: ${message.type}`));
		channel.port1.onmessageerror = invalid;
		channel.port1.onmessage = ({ data }) => {
			if (!controlsPage(worker)) finish(new Error(changed));
			else if (typeof data?.error === "string") finish(new Error(data.error));
			else if (data?.ok !== true) invalid();
			else if (message.type === "runtime-handshake" && data.protocol !== HOST_WORKER_PROTOCOL)
				finish(
					new Error(
						`Incompatible runtime service worker; expected protocol ${HOST_WORKER_PROTOCOL}. Reload Neutron.`,
					),
				);
			else finish();
		};
		try {
			worker.postMessage(message, [channel.port2]);
		} catch (error) {
			channel.port2.close();
			finish(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (message.type === "persist-files" && message.gate) gateFiles(message.id, message.gate);
	});
}

/**
 * A message to the service worker travels through the browser process, so a
 * renderer's request for the file just written can reach the worker first and
 * read the old contents. A synchronous request returns only once the worker
 * holds reads of the app's files until this announcement arrives, so every
 * later request, from any document or worker, sees the write.
 */
function gateFiles(id: string, gate: FileGate): void {
	try {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", `${fileGatePrefix()}${id}/${gate.stream}/${gate.seq}`, false);
		xhr.send();
		if (xhr.status !== 204) throw new Error(`HTTP ${xhr.status}`);
	} catch (error) {
		// Reads then may not wait for this write, as before gates existed.
		console.warn(`Could not order file reads after a write: ${String(error)}`);
	}
}

export async function requestRuntimeWorker(message: HostRequest): Promise<void> {
	if (!verified) throw new Error("Runtime service worker has not been verified");
	// postMessage synchronously: file announcements must precede browser resource reads.
	return post(verified, message, message.type === "persist-files" ? 120_000 : 15_000);
}

async function selectWorker(): Promise<ServiceWorker> {
	const registration = await navigator.serviceWorker.register(runtimePath("sw.js"), {
		scope: runtimeBase(),
		updateViaCache: "none",
	});
	// register() (and ready) can return yesterday's active worker before the
	// browser has even fetched today's script. Join an existing install or check now.
	if (!registration.installing && !registration.waiting && registration.active)
		await registration.update();
	const target = registration.installing || registration.waiting || registration.active;
	if (!target) throw new Error("No runtime service worker after update check");
	return target;
}

export async function initializeRuntimeWorker(): Promise<void> {
	if (!("serviceWorker" in navigator))
		throw new Error("Service workers are required. Open Neutron over HTTPS or localhost.");
	verified = undefined;
	const deadline = performance.now() + 20_000;
	const remaining = () => Math.max(0, deadline - performance.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const worker = await Promise.race([
		selectWorker(),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Runtime service-worker update check timed out")),
				remaining(),
			);
		}),
	]).finally(() => clearTimeout(timer));
	await new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			worker.removeEventListener("statechange", check);
			navigator.serviceWorker.removeEventListener("controllerchange", check);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (controlsPage(worker)) finish();
			else if (worker.state === "redundant")
				finish(new Error("Runtime service-worker update failed"));
		};
		const timeout = setTimeout(
			() =>
				finish(
					new Error(
						"Runtime service worker did not activate and take control. Reload Neutron.",
					),
				),
			remaining(),
		);
		worker.addEventListener("statechange", check);
		navigator.serviceWorker.addEventListener("controllerchange", check);
		check();
	});
	await post(worker, { type: "runtime-handshake" }, Math.min(5_000, remaining()));
	verified = worker;
}
