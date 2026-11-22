// navigator.usb.requestDevice, navigator.hid.requestDevice and
// navigator.serial.requestPort in app windows, with Electron's selection.
//
// Electron shows no chooser: the app's session handler picks from the
// matching devices (`select-usb-device`, `select-hid-device`,
// `select-serial-port`), and without a handler the request is cancelled. A
// browser only lists devices the user grants in its own chooser. So the
// browser's chooser runs first, then the app's handler confirms the device the
// user picked; a device the app declines is forgotten again.

export type DeviceKind = "usb" | "hid" | "serial";
/** Asks the main process: whether to proceed, then which device it selects. */
export type DeviceSelect = (
	request:
		| { phase: "check"; kind: DeviceKind }
		| { phase: "select"; kind: DeviceKind; devices: Record<string, unknown>[] },
) => Promise<{ allowed?: boolean; selected?: string }>;

interface Forgettable {
	forget?(): Promise<void>;
}
interface USBDeviceLike extends Forgettable {
	vendorId: number;
	productId: number;
	productName?: string;
	manufacturerName?: string;
	serialNumber?: string;
	usbVersionMajor: number;
	usbVersionMinor: number;
	usbVersionSubminor: number;
	deviceClass: number;
	deviceSubclass: number;
	deviceProtocol: number;
	deviceVersionMajor: number;
	deviceVersionMinor: number;
	deviceVersionSubminor: number;
}
interface HIDDeviceLike extends Forgettable {
	vendorId: number;
	productId: number;
	productName: string;
	collections: unknown[];
}
interface SerialPortLike extends Forgettable {
	getInfo(): { usbVendorId?: number; usbProductId?: number };
}

const notSelected = (what: string) => new DOMException(`No ${what} selected.`, "NotFoundError");
const hex = (value: number | undefined) =>
	value === undefined ? undefined : value.toString(16).padStart(4, "0");

export function installDeviceChoosers(scope: Window, select: DeviceSelect): void {
	const ids = new WeakMap<object, string>();
	let next = 0;
	const idOf = (kind: DeviceKind, item: object) => {
		let id = ids.get(item);
		if (!id) {
			id = `${kind}-${++next}`;
			ids.set(item, id);
		}
		return id;
	};
	const forget = (items: Forgettable[]) =>
		Promise.allSettled(items.map((item) => item.forget?.()));
	const navigator = scope.navigator as Navigator & {
		usb?: { requestDevice(options: unknown): Promise<USBDeviceLike> };
		hid?: { requestDevice(options: unknown): Promise<HIDDeviceLike[]> };
		serial?: { requestPort(options?: unknown): Promise<SerialPortLike> };
	};

	const usb = navigator.usb;
	if (usb) {
		const native = usb.requestDevice.bind(usb);
		usb.requestDevice = async (options: unknown) => {
			if (!(await select({ phase: "check", kind: "usb" })).allowed)
				throw notSelected("device");
			const device = await native(options);
			const deviceId = idOf("usb", device);
			const { selected } = await select({
				phase: "select",
				kind: "usb",
				devices: [
					{
						deviceId,
						vendorId: device.vendorId,
						productId: device.productId,
						productName: device.productName,
						manufacturerName: device.manufacturerName,
						serialNumber: device.serialNumber,
						usbVersionMajor: device.usbVersionMajor,
						usbVersionMinor: device.usbVersionMinor,
						usbVersionSubminor: device.usbVersionSubminor,
						deviceClass: device.deviceClass,
						deviceSubclass: device.deviceSubclass,
						deviceProtocol: device.deviceProtocol,
						deviceVersionMajor: device.deviceVersionMajor,
						deviceVersionMinor: device.deviceVersionMinor,
						deviceVersionSubminor: device.deviceVersionSubminor,
					},
				],
			});
			if (selected === deviceId) return device;
			await forget([device]);
			throw notSelected("device");
		};
	}

	const hid = navigator.hid;
	if (hid) {
		const native = hid.requestDevice.bind(hid);
		// WebHID resolves with an empty list, not an error, when nothing is chosen.
		hid.requestDevice = async (options: unknown) => {
			if (!(await select({ phase: "check", kind: "hid" })).allowed) return [];
			const devices = await native(options);
			if (!devices.length) return devices;
			const { selected } = await select({
				phase: "select",
				kind: "hid",
				devices: devices.map((device) => ({
					deviceId: idOf("hid", device),
					name: device.productName,
					vendorId: device.vendorId,
					productId: device.productId,
					collections: device.collections,
				})),
			});
			const chosen = devices.filter((device) => idOf("hid", device) === selected);
			await forget(devices.filter((device) => !chosen.includes(device)));
			return chosen;
		};
	}

	const serial = navigator.serial;
	if (serial) {
		const native = serial.requestPort.bind(serial);
		serial.requestPort = async (options?: unknown) => {
			if (!(await select({ phase: "check", kind: "serial" })).allowed)
				throw notSelected("port");
			const port = await native(options);
			const info = port.getInfo();
			const portId = idOf("serial", port);
			const { selected } = await select({
				phase: "select",
				kind: "serial",
				devices: [
					{
						portId,
						portName: portId,
						vendorId: hex(info.usbVendorId),
						productId: hex(info.usbProductId),
					},
				],
			});
			if (selected === portId) return port;
			await forget([port]);
			throw notSelected("port");
		};
	}
}
