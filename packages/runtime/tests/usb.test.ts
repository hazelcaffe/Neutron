import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { installDeviceChoosers } from "../src/runtime/device-chooser";
import { nodeUsbAddon, type UsbBridge } from "../src/runtime/node-usb";
import {
	deviceDescriptor,
	LIBUSB,
	libusbErrorName,
	parseConfigDescriptor,
	parseSetup,
	synthesizeConfigDescriptor,
	type UsbDeviceInfo,
} from "../src/shared/usb";

const info: UsbDeviceInfo = {
	id: 7,
	usbVersion: [2, 1, 0],
	deviceClass: 0xef,
	deviceSubclass: 2,
	deviceProtocol: 1,
	vendorId: 0x1209,
	productId: 0x0001,
	deviceVersion: [1, 2, 3],
	productName: "Device",
	serialNumber: "S",
	configurationValue: 1,
	configurations: [
		{
			configurationValue: 1,
			interfaces: [
				{
					interfaceNumber: 0,
					alternates: [
						{
							alternateSetting: 0,
							interfaceClass: 0xff,
							interfaceSubclass: 1,
							interfaceProtocol: 2,
							endpoints: [
								{
									endpointNumber: 1,
									direction: "in",
									type: "bulk",
									packetSize: 512,
								},
							],
						},
					],
				},
			],
		},
	],
};

describe("USB descriptors", () => {
	it("parses configurations like libusb: alternates grouped, unknown descriptors as extra", () => {
		const iad = [8, 0x0b, 0, 2, 0x0e, 3, 0, 0];
		const config = Uint8Array.of(
			...[9, 2, 0, 0, 2, 1, 4, 0xa0, 250],
			...iad,
			...[9, 4, 0, 0, 1, 0x0e, 1, 0, 5],
			...[7, 0x24, 1, 2, 3, 4, 5],
			...[7, 5, 0x83, 3, 0x10, 0, 4],
			...[9, 4, 1, 0, 0, 0x0e, 2, 0, 0],
			...[9, 4, 1, 1, 1, 0x0e, 2, 0, 0],
			// Audio-class endpoint: 9 bytes with bRefresh and bSynchAddress.
			...[9, 5, 0x81, 5, 0x00, 0x02, 1, 3, 0x02],
			...[6, 0x30, 0, 0, 0, 0],
		);
		config[2] = config.length;
		const parsed = parseConfigDescriptor(config);
		expect(parsed).toMatchObject({
			wTotalLength: config.length,
			bNumInterfaces: 2,
			bConfigurationValue: 1,
			iConfiguration: 4,
			bmAttributes: 0xa0,
			bMaxPower: 250,
			extra: Uint8Array.from(iad),
		});
		expect(parsed.interfaces.map((alternates) => alternates.length)).toEqual([1, 2]);
		const [first] = parsed.interfaces[0] ?? [];
		expect(first?.iInterface).toBe(5);
		expect(first?.extra).toEqual(Uint8Array.of(7, 0x24, 1, 2, 3, 4, 5));
		expect(first?.endpoints[0]).toMatchObject({
			bEndpointAddress: 0x83,
			bmAttributes: 3,
			wMaxPacketSize: 16,
			bInterval: 4,
		});
		expect(parsed.interfaces[1]?.[1]?.endpoints[0]).toMatchObject({
			bLength: 9,
			wMaxPacketSize: 512,
			bRefresh: 3,
			bSynchAddress: 2,
			extra: Uint8Array.of(6, 0x30, 0, 0, 0, 0),
		});
		// A truncated descriptor ends parsing instead of reading past it.
		expect(parseConfigDescriptor(config.slice(0, 20)).interfaces).toEqual([]);
		expect(() => parseConfigDescriptor(Uint8Array.of(9, 4))).toThrow();
	});

	it("builds descriptors from WebUSB's view until the device's own are read", () => {
		expect(deviceDescriptor(info)).toMatchObject({
			bcdUSB: 0x0210,
			bcdDevice: 0x0123,
			bDeviceClass: 0xef,
			iManufacturer: 0,
			iProduct: 2,
			iSerialNumber: 3,
			bNumConfigurations: 1,
		});
		const raw = Uint8Array.of(18, 1, 0, 2, 0, 0, 0, 8, 0x09, 0x12, 1, 0, 0, 1, 4, 5, 6, 1);
		expect(deviceDescriptor(info, raw)).toMatchObject({
			bcdUSB: 0x0200,
			bMaxPacketSize0: 8,
			iManufacturer: 4,
			iProduct: 5,
			iSerialNumber: 6,
		});
		const config = synthesizeConfigDescriptor(
			info.configurations[0] as UsbDeviceInfo["configurations"][number],
		);
		expect(config).toMatchObject({ wTotalLength: 9 + 9 + 7, bNumInterfaces: 1 });
		expect(config.interfaces[0]?.[0]?.endpoints[0]).toMatchObject({
			bEndpointAddress: 0x81,
			bmAttributes: 2,
			wMaxPacketSize: 512,
		});
	});

	it("maps setup packets to WebUSB and names libusb errors", () => {
		expect(parseSetup(Uint8Array.of(0xc1, 9, 0x34, 0x12, 2, 0, 16, 0))).toEqual({
			in: true,
			setup: {
				requestType: "vendor",
				recipient: "interface",
				request: 9,
				value: 0x1234,
				index: 2,
			},
			length: 16,
		});
		expect(parseSetup(Uint8Array.of(0x23, 1, 0, 0, 0, 0, 0, 0)).setup).toMatchObject({
			requestType: "class",
			recipient: "other",
		});
		expect(parseSetup(Uint8Array.of(0x7f, 0, 0, 0, 0, 0, 0, 0)).setup.requestType).toBe(
			"reserved",
		);
		expect(libusbErrorName(LIBUSB.LIBUSB_ERROR_NO_DEVICE)).toBe("LIBUSB_ERROR_NO_DEVICE");
		expect(libusbErrorName(LIBUSB.LIBUSB_TRANSFER_STALL)).toBe("LIBUSB_TRANSFER_STALL");
		expect(libusbErrorName(LIBUSB.LIBUSB_TRANSFER_TIMED_OUT)).toBe("LIBUSB_TRANSFER_TIMED_OUT");
	});
});

/** The binding against a scripted host. */
function binding(transfer: (args: unknown[]) => Promise<unknown>) {
	const listeners: Parameters<UsbBridge["listen"]>[0][] = [];
	const calls: string[] = [];
	const addon = nodeUsbAddon({
		sync: <T>(method: string) =>
			(method === "usb.available"
				? true
				: method === "usb.devices"
					? [info]
					: undefined) as T,
		call: async <T>(method: string, args: unknown[]) => {
			calls.push(method);
			return (
				method === "usb.transfer" || method === "usb.control" ? transfer(args) : undefined
			) as T;
		},
		listen: (listener) => listeners.push(listener),
	}) as Record<string, unknown> & { getDeviceList(): object[] };
	Object.setPrototypeOf(addon, EventEmitter.prototype);
	const Transfer = addon.Transfer as new (
		...args: unknown[]
	) => { submit(buffer: Uint8Array, cb?: unknown): unknown; cancel(): boolean };
	const device = addon.getDeviceList()[0];
	return { addon, Transfer, device, listeners, calls };
}

describe("node-usb binding", () => {
	it("completes, times out and cancels transfers like libusb", async () => {
		const { Transfer, device } = binding(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ status: "ok", data: Uint8Array.of(1, 2, 3), length: 3 }),
						30,
					),
				),
		);
		const result = (
			timeout: number,
			act?: (transfer: { cancel(): boolean; submit(b: Uint8Array): unknown }) => void,
		) =>
			new Promise<[number | undefined, number]>((resolve) => {
				const transfer = new Transfer(
					device,
					0x81,
					LIBUSB.LIBUSB_TRANSFER_TYPE_BULK,
					timeout,
					(error: { errno?: number } | undefined, _buffer: Uint8Array, actual: number) =>
						resolve([error?.errno, actual]),
				);
				transfer.submit(Buffer.alloc(8));
				act?.(transfer);
			});
		expect(await result(0)).toEqual([undefined, 3]);
		expect(await result(5)).toEqual([LIBUSB.LIBUSB_TRANSFER_TIMED_OUT, 0]);
		expect(await result(0, (transfer) => expect(transfer.cancel()).toBe(true))).toEqual([
			LIBUSB.LIBUSB_TRANSFER_CANCELLED,
			0,
		]);
		const busy = new Transfer(device, 0x81, LIBUSB.LIBUSB_TRANSFER_TYPE_BULK, 0, () => {});
		busy.submit(Buffer.alloc(8));
		expect(() => busy.submit(Buffer.alloc(8))).toThrow(
			expect.objectContaining({ errno: LIBUSB.LIBUSB_ERROR_BUSY }),
		);
		expect(
			new Transfer(device, 0x81, LIBUSB.LIBUSB_TRANSFER_TYPE_BULK, 0, () => {}).cancel(),
		).toBe(false);
	});

	it("reports overflow, disconnection and hotplug", async () => {
		const { addon, Transfer, device, listeners } = binding(async (args) => {
			if (args[1] === 0x82) throw new Error("NotFoundError: The device was disconnected.");
			return { status: "ok", data: Uint8Array.of(1, 2, 3, 4), length: 4 };
		});
		const errno = (endpoint: number, size: number) =>
			new Promise<number | undefined>((resolve) =>
				new Transfer(
					device,
					endpoint,
					LIBUSB.LIBUSB_TRANSFER_TYPE_BULK,
					0,
					(error: { errno?: number } | undefined) => resolve(error?.errno),
				).submit(Buffer.alloc(size)),
			);
		expect(await errno(0x81, 2)).toBe(LIBUSB.LIBUSB_TRANSFER_OVERFLOW);
		expect(await errno(0x82, 8)).toBe(LIBUSB.LIBUSB_TRANSFER_NO_DEVICE);
		const emit = vi.fn();
		const events = addon as unknown as EventEmitter;
		events.on("attach", emit);
		(addon._enableHotplugEvents as () => void)();
		for (const listener of listeners) listener("connect", { ...info, id: 8 });
		for (const listener of listeners) listener("disconnect", info);
		events.on("detach", emit);
		for (const listener of listeners) listener("disconnect", { ...info, id: 8 });
		expect(
			emit.mock.calls.map(([item]) => (item as { deviceAddress: number }).deviceAddress),
		).toEqual([8, 8]);
	});
});

describe("device choosers", () => {
	const scope = (navigator: object) => ({ navigator }) as unknown as Window;

	it("lets the app's handler pick among HID devices the user chose, and forgets the rest", async () => {
		const forgotten: string[] = [];
		const device = (name: string) => ({
			productName: name,
			vendorId: 1,
			productId: 2,
			collections: [],
			forget: async () => void forgotten.push(name),
		});
		const devices = [device("keyboard"), device("consumer control")];
		const hid = { requestDevice: async () => devices };
		const requests: unknown[] = [];
		installDeviceChoosers(scope({ hid }), async (request) => {
			requests.push(request);
			if (request.phase === "check") return { allowed: true };
			return {
				selected: request.devices.find((item) => item.name === "keyboard")
					?.deviceId as string,
			};
		});
		const chosen = await hid.requestDevice();
		expect(chosen.map((item) => item.productName)).toEqual(["keyboard"]);
		expect(forgotten).toEqual(["consumer control"]);
		expect(requests).toHaveLength(2);
	});

	it("cancels without asking the browser when the app has no handler", async () => {
		const requestPort = vi.fn();
		const serial = { requestPort };
		installDeviceChoosers(scope({ serial }), async () => ({ allowed: false }));
		await expect(serial.requestPort()).rejects.toMatchObject({ name: "NotFoundError" });
		expect(requestPort).not.toHaveBeenCalled();
	});
});
