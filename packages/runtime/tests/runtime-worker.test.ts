import { afterEach, expect, it, vi } from "vitest";
import { initializeRuntimeWorker, requestRuntimeWorker } from "../src/core/runtime-worker";
import { HOST_WORKER_PROTOCOL } from "../src/shared/types";

const mutation = { type: "persist-files" as const, id: "test", patches: [] };
function serviceWorker(reply: (type: string) => unknown) {
	const worker = Object.assign(new EventTarget(), {
		state: "activated",
		postMessage: vi.fn(({ type }: { type: string }, [port]: [MessagePort]) => {
			const data = reply(type);
			if (data !== undefined) port.postMessage(data);
			port.close();
		}),
	});
	const registration = { active: worker, update: vi.fn(async () => {}) };
	const container = Object.assign(new EventTarget(), {
		controller: worker,
		register: async () => registration,
	});
	vi.stubGlobal("navigator", { serviceWorker: container });
	return { worker, container, registration };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("fails initialization within the deadline when the update check never finishes", async () => {
	vi.useFakeTimers();
	const { worker, registration } = serviceWorker(() => ({ ok: true }));
	registration.update.mockReturnValue(new Promise(() => {}));
	const failed = expect(initializeRuntimeWorker()).rejects.toThrow("update check timed out");
	await vi.advanceTimersByTimeAsync(20_001);
	await failed;
	expect(worker.postMessage).not.toHaveBeenCalled();
});

it("does not send writes to an active worker that ignores the handshake", async () => {
	vi.useFakeTimers();
	const { worker } = serviceWorker(() => undefined);
	const failed = expect(initializeRuntimeWorker()).rejects.toThrow(
		/timed out: runtime-handshake/,
	);
	await vi.advanceTimersByTimeAsync(5_001);
	await failed;
	await expect(requestRuntimeWorker(mutation)).rejects.toThrow(/not been verified/);
	expect(worker.postMessage).toHaveBeenCalledTimes(1);
});

it("refuses a different version even when the handshake was acknowledged", async () => {
	serviceWorker(() => ({ ok: true, protocol: HOST_WORKER_PROTOCOL + 1 }));
	await expect(initializeRuntimeWorker()).rejects.toThrow("Incompatible runtime service worker");
});

it("does not mistake a malformed reply for a successful disk write", async () => {
	serviceWorker((type) =>
		type === "runtime-handshake" ? { ok: true, protocol: HOST_WORKER_PROTOCOL } : {},
	);
	await initializeRuntimeWorker();
	await expect(requestRuntimeWorker(mutation)).rejects.toThrow(
		/Invalid service-worker reply: persist-files/,
	);
});

it("fails an in-flight write on controller replacement without replaying it", async () => {
	const { container, worker } = serviceWorker((type) =>
		type === "runtime-handshake" ? { ok: true, protocol: HOST_WORKER_PROTOCOL } : undefined,
	);
	await initializeRuntimeWorker();
	const failed = expect(requestRuntimeWorker(mutation)).rejects.toThrow(/service worker changed/);
	expect(worker.postMessage).toHaveBeenCalledTimes(2);
	const replacement = { ...worker, postMessage: vi.fn() };
	Object.assign(container, { controller: replacement });
	container.dispatchEvent(new Event("controllerchange"));
	await failed;
	await expect(requestRuntimeWorker(mutation)).rejects.toThrow(/service worker changed/);
	expect(replacement.postMessage).not.toHaveBeenCalled();
});
