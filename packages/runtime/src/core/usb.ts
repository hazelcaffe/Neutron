import { parseSetup, type UsbDeviceInfo, type UsbRawDescriptors } from "../shared/usb";

// The parts of WebUSB (https://wicg.github.io/webusb/) used here; TypeScript's
// DOM library doesn't declare it.
interface USBEndpoint {
	endpointNumber: number;
	direction: "in" | "out";
	type: "bulk" | "interrupt" | "isochronous";
	packetSize: number;
}
interface USBAlternateInterface {
	alternateSetting: number;
	interfaceClass: number;
	interfaceSubclass: number;
	interfaceProtocol: number;
	endpoints: USBEndpoint[];
}
interface USBConfiguration {
	configurationValue: number;
	interfaces: { interfaceNumber: number; alternates: USBAlternateInterface[] }[];
}
interface USBTransferResult {
	status: "ok" | "stall" | "babble";
	data?: DataView;
	bytesWritten?: number;
}
interface USBControlSetup {
	requestType: "standard" | "class" | "vendor";
	recipient: "device" | "interface" | "endpoint" | "other";
	request: number;
	value: number;
	index: number;
}
export interface USBDevice {
	usbVersionMajor: number;
	usbVersionMinor: number;
	usbVersionSubminor: number;
	deviceClass: number;
	deviceSubclass: number;
	deviceProtocol: number;
	vendorId: number;
	productId: number;
	deviceVersionMajor: number;
	deviceVersionMinor: number;
	deviceVersionSubminor: number;
	manufacturerName?: string;
	productName?: string;
	serialNumber?: string;
	configuration: USBConfiguration | null;
	configurations: USBConfiguration[];
	opened: boolean;
	open(): Promise<void>;
	close(): Promise<void>;
	selectConfiguration(value: number): Promise<void>;
	claimInterface(number: number): Promise<void>;
	releaseInterface(number: number): Promise<void>;
	selectAlternateInterface(number: number, alternate: number): Promise<void>;
	controlTransferIn(setup: USBControlSetup, length: number): Promise<USBTransferResult>;
	controlTransferOut(setup: USBControlSetup, data?: BufferSource): Promise<USBTransferResult>;
	transferIn(endpoint: number, length: number): Promise<USBTransferResult>;
	transferOut(endpoint: number, data: BufferSource): Promise<USBTransferResult>;
	clearHalt(direction: "in" | "out", endpoint: number): Promise<void>;
	reset(): Promise<void>;
}
export interface USBDeviceFilter {
	vendorId?: number;
	productId?: number;
	classCode?: number;
	subclassCode?: number;
	protocolCode?: number;
	serialNumber?: string;
}
interface USB extends EventTarget {
	getDevices(): Promise<USBDevice[]>;
	requestDevice(options: { filters: USBDeviceFilter[] }): Promise<USBDevice>;
}
export const webUSB = () => (navigator as Navigator & { usb?: USB }).usb;

/** A transfer's outcome, in libusb's terms (see runtime/node-usb.ts). */
export interface UsbTransferOutcome {
	status: "ok" | "stall" | "babble";
	/** Received bytes (IN) or the count written (OUT). */
	data?: Uint8Array;
	length: number;
}

/**
 * The Neutron page's WebUSB devices, for apps' main processes. Only a page
 * can show the browser's device chooser (on a click), and devices it grants
 * are visible to every Neutron app, like any permission of this origin.
 * Worker code reaches these methods through the host's request() switch.
 */
export class UsbHost {
	private readonly ids = new WeakMap<USBDevice, number>();
	private readonly devices = new Map<number, USBDevice>();
	private readonly opened = new Set<number>();
	private next = 1;
	constructor(
		private readonly notify: (event: "connect" | "disconnect", info: UsbDeviceInfo) => void,
	) {
		const usb = webUSB();
		usb?.addEventListener("connect", (event) => {
			const device = (event as Event & { device: USBDevice }).device;
			this.notify("connect", this.info(device));
		});
		usb?.addEventListener("disconnect", (event) => {
			const device = (event as Event & { device: USBDevice }).device;
			const id = this.ids.get(device);
			if (id !== undefined) {
				this.notify("disconnect", this.info(device));
				this.devices.delete(id);
			}
		});
	}
	get available(): boolean {
		return Boolean(webUSB());
	}
	private info(device: USBDevice): UsbDeviceInfo {
		let id = this.ids.get(device);
		if (id === undefined) {
			id = this.next++;
			this.ids.set(device, id);
		}
		this.devices.set(id, device);
		return {
			id,
			usbVersion: [device.usbVersionMajor, device.usbVersionMinor, device.usbVersionSubminor],
			deviceClass: device.deviceClass,
			deviceSubclass: device.deviceSubclass,
			deviceProtocol: device.deviceProtocol,
			vendorId: device.vendorId,
			productId: device.productId,
			deviceVersion: [
				device.deviceVersionMajor,
				device.deviceVersionMinor,
				device.deviceVersionSubminor,
			],
			...(device.manufacturerName && { manufacturerName: device.manufacturerName }),
			...(device.productName && { productName: device.productName }),
			...(device.serialNumber && { serialNumber: device.serialNumber }),
			configurationValue: device.configuration?.configurationValue ?? null,
			configurations: device.configurations.map((configuration) => ({
				configurationValue: configuration.configurationValue,
				interfaces: configuration.interfaces.map((item) => ({
					interfaceNumber: item.interfaceNumber,
					alternates: item.alternates.map((alternate) => ({
						alternateSetting: alternate.alternateSetting,
						interfaceClass: alternate.interfaceClass,
						interfaceSubclass: alternate.interfaceSubclass,
						interfaceProtocol: alternate.interfaceProtocol,
						endpoints: alternate.endpoints.map((endpoint) => ({
							endpointNumber: endpoint.endpointNumber,
							direction: endpoint.direction,
							type: endpoint.type,
							packetSize: endpoint.packetSize,
						})),
					})),
				})),
			})),
		};
	}
	private device(id: number): USBDevice {
		const device = this.devices.get(Number(id));
		if (!device) throw new Error("NotFoundError: The device was disconnected.");
		return device;
	}
	/** Devices this origin may use. */
	async list(): Promise<UsbDeviceInfo[]> {
		const usb = webUSB();
		return usb ? (await usb.getDevices()).map((device) => this.info(device)) : [];
	}
	/** Shows the browser's chooser; call it while handling a click. */
	async request(filters: USBDeviceFilter[] = []): Promise<UsbDeviceInfo | undefined> {
		const usb = webUSB();
		if (!usb) throw new Error("NotSupportedError: This browser has no WebUSB.");
		try {
			const info = this.info(await usb.requestDevice({ filters }));
			// The device was already connected; it's new to the app.
			this.notify("connect", info);
			return info;
		} catch (error) {
			if (error instanceof DOMException && error.name === "NotFoundError") return; // No device chosen.
			throw error;
		}
	}
	/** Opens the device and reads its raw descriptors. */
	async open(id: number): Promise<UsbRawDescriptors & { info: UsbDeviceInfo }> {
		const device = this.device(id);
		await rethrow(device.open());
		this.opened.add(id);
		const read = async (type: number, index: number, length: number) => {
			const result = await device.controlTransferIn(
				{
					requestType: "standard",
					recipient: "device",
					request: 6, // GET_DESCRIPTOR
					value: (type << 8) | index,
					index: 0,
				},
				length,
			);
			return result.status === "ok" && result.data
				? new Uint8Array(
						result.data.buffer,
						result.data.byteOffset,
						result.data.byteLength,
					).slice()
				: undefined;
		};
		const raw: UsbRawDescriptors = { configurations: [] };
		try {
			raw.device = await read(1, 0, 18);
			for (let index = 0; index < device.configurations.length; index++) {
				const header = await read(2, index, 9);
				const total = (header?.[2] ?? 0) | ((header?.[3] ?? 0) << 8);
				const full = total ? await read(2, index, total) : undefined;
				if (full) raw.configurations.push(full);
			}
		} catch {
			// Descriptors then come from WebUSB's parsed view.
		}
		return { ...raw, info: this.info(device) };
	}
	async close(id: number): Promise<void> {
		this.opened.delete(id);
		await rethrow(this.device(id).close());
	}
	/** Closes every device the app opened. */
	async closeAll(): Promise<void> {
		const ids = [...this.opened];
		this.opened.clear();
		await Promise.allSettled(ids.map((id) => this.devices.get(id)?.close()));
	}
	async selectConfiguration(id: number, value: number): Promise<UsbDeviceInfo> {
		const device = this.device(id);
		await rethrow(device.selectConfiguration(value));
		return this.info(device);
	}
	async claimInterface(id: number, number: number): Promise<void> {
		await rethrow(this.device(id).claimInterface(number));
	}
	async releaseInterface(id: number, number: number): Promise<void> {
		await rethrow(this.device(id).releaseInterface(number));
	}
	async selectAlternateInterface(id: number, number: number, alternate: number): Promise<void> {
		await rethrow(this.device(id).selectAlternateInterface(number, alternate));
	}
	async clearHalt(id: number, address: number): Promise<void> {
		await rethrow(this.device(id).clearHalt(address & 0x80 ? "in" : "out", address & 0x0f));
	}
	async reset(id: number): Promise<void> {
		await rethrow(this.device(id).reset());
	}
	/** A control transfer from its setup packet; `data` is OUT data or the IN length. */
	async control(
		id: number,
		packet: Uint8Array,
		data: Uint8Array | number,
	): Promise<UsbTransferOutcome> {
		const { in: input, setup } = parseSetup(packet);
		if (setup.requestType === "reserved")
			throw new Error("NotSupportedError: Reserved request types are not supported.");
		const request = { ...setup, requestType: setup.requestType };
		const device = this.device(id);
		return outcome(
			await rethrow(
				input
					? device.controlTransferIn(request, Number(data))
					: device.controlTransferOut(
							request,
							data instanceof Uint8Array ? new Uint8Array(data) : undefined,
						),
			),
		);
	}
	/** A bulk or interrupt transfer; `data` is OUT data or the IN length. */
	async transfer(
		id: number,
		address: number,
		data: Uint8Array | number,
	): Promise<UsbTransferOutcome> {
		const device = this.device(id);
		const endpoint = address & 0x0f;
		return outcome(
			await rethrow(
				address & 0x80
					? device.transferIn(endpoint, Number(data))
					: device.transferOut(
							endpoint,
							data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(),
						),
			),
		);
	}
}

function outcome(result: USBTransferResult): UsbTransferOutcome {
	if (result.data)
		return {
			status: result.status,
			data: new Uint8Array(
				result.data.buffer,
				result.data.byteOffset,
				result.data.byteLength,
			).slice(),
			length: result.data.byteLength,
		};
	return { status: result.status, length: result.bytesWritten ?? 0 };
}

/** Keeps the DOMException's name in the message, which crosses to workers. */
async function rethrow<T>(promise: Promise<T>): Promise<T> {
	try {
		return await promise;
	} catch (error) {
		if (error instanceof DOMException) throw new Error(`${error.name}: ${error.message}`);
		throw error;
	}
}
