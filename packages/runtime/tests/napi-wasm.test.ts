import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import { TcpHost } from "../src/runtime/napi-wasm";
import type { Network } from "../src/runtime/network";
import { setRuntimeBase } from "../src/shared/base";
import { isWasmAddonCandidate, wasmAddonFor } from "../src/shared/wasm-addons";

describe("wasm addon resolution", () => {
	const unpacked =
		"/neutron/resources/app.asar.unpacked/node_modules/@signalapp/libsignal-client/prebuilds/linux-x64/@signalapp+libsignal-client.node";
	const required = unpacked.replace("app.asar.unpacked", "app.asar");
	const files = (version: string) => (path: string) =>
		path === "/neutron/resources/app.asar/node_modules/@signalapp/libsignal-client/package.json"
			? JSON.stringify({ name: "@signalapp/libsignal-client", version })
			: undefined;

	it("finds the build for the shipped version through either path", () => {
		setRuntimeBase("/Neutron/");
		expect(isWasmAddonCandidate(unpacked)).toBe(true);
		const expected = {
			packageName: "@signalapp/libsignal-client",
			version: "0.106.2",
			url: "/Neutron/vendor/libsignal/libsignal-client-0.106.2.wasm",
		};
		// package.json stays in app.asar when the addon is unpacked.
		expect(wasmAddonFor(unpacked, files("0.106.2"))).toEqual(expected);
		expect(wasmAddonFor(required, files("0.106.2"))).toEqual(expected);
		setRuntimeBase("/");
	});

	it("has no build for other versions or other addons", () => {
		expect(wasmAddonFor(required, files("0.106.3"))).toBeUndefined();
		expect(wasmAddonFor(required, () => undefined)).toBeUndefined();
		expect(wasmAddonFor(required, () => "{not json")).toBeUndefined();
		expect(isWasmAddonCandidate("/app/node_modules/x/build/Release/x.node")).toBe(false);
	});
});

class FakeSocket extends EventEmitter {
	written: string[] = [];
	destroyed = false;
	write(data: Uint8Array): boolean {
		this.written.push(new TextDecoder().decode(data));
		return true;
	}
	destroy(): void {
		this.destroyed = true;
	}
}

function host() {
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
	const sockets: FakeSocket[] = [];
	const calls: string[] = [];
	const network = {
		sockets: () => ({
			connect: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
		}),
	} as unknown as Network;
	const exports = {
		neutron_tcp_ring_capacity: () => 64,
		neutron_tcp_wake: (shared: number) => calls.push(`wake ${shared}`),
		neutron_tcp_release: (shared: number) => calls.push(`release ${shared}`),
	};
	return { tcp: new TcpHost(network, memory, () => exports), memory, sockets, calls };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("TcpHost", () => {
	it("applies a connection's calls in the order Rust made them", () => {
		const { tcp, sockets, calls } = host();
		// Threads forward calls over a channel, which can reorder them.
		tcp.receive({ op: "write", shared: 128, seq: 2, data: bytes("second") });
		tcp.receive({ op: "close", shared: 128, seq: 3 });
		tcp.receive({ op: "write", shared: 128, seq: 1, data: bytes("first") });
		expect(sockets).toHaveLength(0);
		tcp.receive({ op: "connect", shared: 128, seq: 0, host: "203.0.113.7", port: 443 });
		expect(sockets[0]?.written).toEqual(["first", "second"]);
		expect(sockets[0]?.destroyed).toBe(true);
		expect(calls).toEqual(["release 128"]);
		// A new connection may reuse a released block's address.
		tcp.receive({ op: "connect", shared: 128, seq: 0, host: "203.0.113.7", port: 443 });
		expect(sockets).toHaveLength(2);
	});

	it("moves received bytes into the ring and reports open, data and end", () => {
		const { tcp, memory, sockets } = host();
		const words = new Int32Array(memory.buffer);
		const shared = 256;
		tcp.receive({ op: "connect", shared, seq: 0, host: "203.0.113.7", port: 443 });
		const socket = sockets[0] as FakeSocket;
		socket.emit("connect");
		expect(Atomics.load(words, shared / 4)).toBe(1);
		socket.emit("data", bytes("hello"));
		expect(Atomics.load(words, shared / 4 + 1)).toBe(5);
		expect(
			new TextDecoder().decode(new Uint8Array(memory.buffer).slice(shared + 16, shared + 21)),
		).toBe("hello");
		socket.emit("end");
		expect(Atomics.load(words, shared / 4)).toBe(3);
	});

	it("holds bytes beyond the ring until Rust frees space", () => {
		const { tcp, memory, sockets } = host();
		const words = new Int32Array(memory.buffer);
		const shared = 512;
		tcp.receive({ op: "connect", shared, seq: 0, host: "203.0.113.7", port: 443 });
		const socket = sockets[0] as FakeSocket;
		socket.emit("connect");
		socket.emit("data", new Uint8Array(100).fill(7));
		expect(Atomics.load(words, shared / 4 + 1)).toBe(64);
		// Rust consumed 40 bytes (tail) and says so.
		Atomics.store(words, shared / 4 + 2, 40);
		tcp.receive({ op: "consumed", shared, seq: 1 });
		expect(Atomics.load(words, shared / 4 + 1)).toBe(100);
		socket.emit("end");
		expect(Atomics.load(words, shared / 4)).toBe(3);
	});

	it("fails a connection that closes before opening", () => {
		const { tcp, memory, sockets } = host();
		tcp.receive({ op: "connect", shared: 64, seq: 0, host: "203.0.113.7", port: 443 });
		sockets[0]?.emit("close");
		expect(Atomics.load(new Int32Array(memory.buffer), 16)).toBe(2);
	});
});
