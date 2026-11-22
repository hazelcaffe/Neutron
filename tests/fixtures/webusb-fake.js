// A WebUSB device for tests (no hardware). Injected into pages with
// Playwright's addInitScript; replaces navigator.usb in the frame it runs in.
//
// Device 1209:0001 "Neutron Test Device" by "Neutron", serial "NT-0001":
// - real device, configuration (with a class-specific descriptor) and string
//   descriptors, served by GET_DESCRIPTOR;
// - vendor IN request 0x01 answers "pong:<wValue>", vendor OUT 0x02 stores data;
// - interface 0: bulk OUT 0x01 stores data, bulk IN 0x81 echoes it reversed,
//   interrupt IN 0x82 counts up.
// Nothing is granted until requestDevice() runs with user activation, like a
// browser. globalThis.__fakeUsb.disconnect() unplugs it.
(() => {
	const DEVICE = Uint8Array.of(
		18,
		1,
		0x10,
		0x02,
		0xff,
		0x00,
		0x00,
		64,
		0x09,
		0x12,
		0x01,
		0x00,
		0x00,
		0x01,
		1,
		2,
		3,
		1,
	);
	const CLASS_DESCRIPTOR = [5, 0x24, 0x01, 0xab, 0xcd];
	const CONFIG = Uint8Array.of(
		...[9, 2, 0, 0, 1, 1, 0, 0x80, 50],
		...[9, 4, 0, 0, 3, 0xff, 0x00, 0x00, 0],
		...CLASS_DESCRIPTOR,
		...[7, 5, 0x01, 2, 64, 0, 0],
		...[7, 5, 0x81, 2, 64, 0, 0],
		...[7, 5, 0x82, 3, 8, 0, 10],
	);
	CONFIG[2] = CONFIG.length;
	const string = (text) => {
		const bytes = new Uint8Array(2 + text.length * 2);
		bytes[0] = bytes.length;
		bytes[1] = 3;
		for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i);
		return bytes;
	};
	const STRINGS = [
		Uint8Array.of(4, 3, 0x09, 0x04),
		string("Neutron"),
		string("Neutron Test Device"),
		string("NT-0001"),
	];
	const error = (name, message) => new DOMException(message, name);
	const view = (bytes) =>
		new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

	let granted = false;
	let connected = true;
	let stored = new Uint8Array();
	let counter = 0;
	const usb = new EventTarget();
	const configuration = {
		configurationValue: 1,
		configurationName: undefined,
		interfaces: [
			{
				interfaceNumber: 0,
				claimed: false,
				alternate: null,
				alternates: [
					{
						alternateSetting: 0,
						interfaceClass: 0xff,
						interfaceSubclass: 0,
						interfaceProtocol: 0,
						interfaceName: undefined,
						endpoints: [
							{ endpointNumber: 1, direction: "out", type: "bulk", packetSize: 64 },
							{ endpointNumber: 1, direction: "in", type: "bulk", packetSize: 64 },
							{
								endpointNumber: 2,
								direction: "in",
								type: "interrupt",
								packetSize: 8,
							},
						],
					},
				],
			},
		],
	};
	configuration.interfaces[0].alternate = configuration.interfaces[0].alternates[0];
	const device = {
		usbVersionMajor: 2,
		usbVersionMinor: 1,
		usbVersionSubminor: 0,
		deviceClass: 0xff,
		deviceSubclass: 0,
		deviceProtocol: 0,
		vendorId: 0x1209,
		productId: 0x0001,
		deviceVersionMajor: 1,
		deviceVersionMinor: 0,
		deviceVersionSubminor: 0,
		manufacturerName: "Neutron",
		productName: "Neutron Test Device",
		serialNumber: "NT-0001",
		configuration,
		configurations: [configuration],
		opened: false,
		claimed: new Set(),
		async open() {
			if (!connected) throw error("NotFoundError", "The device was disconnected.");
			this.opened = true;
		},
		async close() {
			this.opened = false;
			this.claimed.clear();
		},
		async forget() {
			granted = false;
		},
		async selectConfiguration(value) {
			this.check();
			if (value !== 1)
				throw error(
					"NotFoundError",
					"The configuration value provided is not supported by the device.",
				);
		},
		async claimInterface(number) {
			this.check();
			if (number !== 0)
				throw error(
					"NotFoundError",
					"The interface number provided is not supported by the device in its current configuration.",
				);
			this.claimed.add(number);
		},
		async releaseInterface(number) {
			this.check();
			this.claimed.delete(number);
		},
		async selectAlternateInterface(number, alternate) {
			this.check();
			if (number !== 0 || alternate !== 0)
				throw error(
					"NotFoundError",
					"The alternate setting provided is not supported by the device in its current configuration.",
				);
		},
		async clearHalt() {
			this.check();
		},
		async reset() {
			this.check();
		},
		check() {
			if (!connected) throw error("NotFoundError", "The device was disconnected.");
			if (!this.opened) throw error("InvalidStateError", "The device must be opened first.");
		},
		async controlTransferIn(setup, length) {
			this.check();
			if (setup.requestType === "standard" && setup.request === 6) {
				const type = setup.value >> 8;
				const index = setup.value & 0xff;
				const bytes =
					type === 1
						? DEVICE
						: type === 2 && index === 0
							? CONFIG
							: type === 3
								? STRINGS[index]
								: undefined;
				if (!bytes) return { status: "stall" };
				return { status: "ok", data: view(bytes.slice(0, length)) };
			}
			if (setup.requestType === "vendor" && setup.request === 1)
				return {
					status: "ok",
					data: view(new TextEncoder().encode(`pong:${setup.value}`).slice(0, length)),
				};
			return { status: "stall" };
		},
		async controlTransferOut(setup, data) {
			this.check();
			if (setup.requestType === "vendor" && setup.request === 2) {
				stored = new Uint8Array(data ?? []);
				return { status: "ok", bytesWritten: stored.length };
			}
			return { status: "stall", bytesWritten: 0 };
		},
		async transferOut(endpoint, data) {
			this.check();
			if (!this.claimed.has(0))
				throw error(
					"InvalidStateError",
					"The specified endpoint is not part of a claimed and selected alternate interface.",
				);
			if (endpoint !== 1)
				throw error(
					"NotFoundError",
					"The specified endpoint number is not part of the interface.",
				);
			stored = new Uint8Array(data);
			return { status: "ok", bytesWritten: stored.length };
		},
		async transferIn(endpoint, length) {
			this.check();
			if (!this.claimed.has(0))
				throw error(
					"InvalidStateError",
					"The specified endpoint is not part of a claimed and selected alternate interface.",
				);
			if (endpoint === 1)
				return { status: "ok", data: view(stored.slice().reverse().slice(0, length)) };
			if (endpoint === 2) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { status: "ok", data: view(Uint8Array.of(++counter)) };
			}
			throw error(
				"NotFoundError",
				"The specified endpoint number is not part of the interface.",
			);
		},
	};
	Object.assign(usb, {
		async getDevices() {
			return granted && connected ? [device] : [];
		},
		async requestDevice(options) {
			if (!navigator.userActivation?.isActive)
				throw error(
					"SecurityError",
					"Must be handling a user gesture to show a permission request.",
				);
			const matches = (options?.filters ?? []).every(
				(filter) =>
					(filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
					(filter.productId === undefined || filter.productId === device.productId),
			);
			if (!connected || !matches) throw error("NotFoundError", "No device selected.");
			granted = true;
			return device;
		},
	});
	Object.defineProperty(Navigator.prototype, "usb", { configurable: true, get: () => usb });
	globalThis.__fakeUsb = {
		disconnect() {
			connected = false;
			device.opened = false;
			usb.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
		},
	};
})();
