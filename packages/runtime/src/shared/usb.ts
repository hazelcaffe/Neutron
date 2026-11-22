// USB devices for apps, over WebUSB: the libusb descriptor shapes node-usb
// exposes, built from raw descriptors when the device is open and from
// WebUSB's parsed view before that.

/** libusb constants, as node-usb exports them. */
export const LIBUSB = {
	LIBUSB_CLASS_PER_INTERFACE: 0,
	LIBUSB_CLASS_AUDIO: 1,
	LIBUSB_CLASS_COMM: 2,
	LIBUSB_CLASS_HID: 3,
	LIBUSB_CLASS_PRINTER: 7,
	LIBUSB_CLASS_PTP: 6,
	LIBUSB_CLASS_MASS_STORAGE: 8,
	LIBUSB_CLASS_HUB: 9,
	LIBUSB_CLASS_DATA: 10,
	LIBUSB_CLASS_WIRELESS: 0xe0,
	LIBUSB_CLASS_APPLICATION: 0xfe,
	LIBUSB_CLASS_VENDOR_SPEC: 0xff,
	LIBUSB_REQUEST_GET_STATUS: 0,
	LIBUSB_REQUEST_CLEAR_FEATURE: 1,
	LIBUSB_REQUEST_SET_FEATURE: 3,
	LIBUSB_REQUEST_GET_DESCRIPTOR: 6,
	LIBUSB_REQUEST_SET_DESCRIPTOR: 7,
	LIBUSB_REQUEST_GET_CONFIGURATION: 8,
	LIBUSB_REQUEST_GET_INTERFACE: 10,
	LIBUSB_REQUEST_SET_INTERFACE: 11,
	LIBUSB_REQUEST_SYNCH_FRAME: 12,
	LIBUSB_DT_DEVICE: 1,
	LIBUSB_DT_CONFIG: 2,
	LIBUSB_DT_STRING: 3,
	LIBUSB_DT_BOS: 0x0f,
	LIBUSB_DT_INTERFACE: 4,
	LIBUSB_DT_ENDPOINT: 5,
	LIBUSB_DT_HID: 0x21,
	LIBUSB_DT_REPORT: 0x22,
	LIBUSB_DT_PHYSICAL: 0x23,
	LIBUSB_DT_HUB: 0x29,
	LIBUSB_ENDPOINT_IN: 0x80,
	LIBUSB_ENDPOINT_OUT: 0,
	LIBUSB_TRANSFER_TYPE_CONTROL: 0,
	LIBUSB_TRANSFER_TYPE_ISOCHRONOUS: 1,
	LIBUSB_TRANSFER_TYPE_BULK: 2,
	LIBUSB_TRANSFER_TYPE_INTERRUPT: 3,
	LIBUSB_ISO_SYNC_TYPE_NONE: 0,
	LIBUSB_ISO_SYNC_TYPE_ASYNC: 1,
	LIBUSB_ISO_SYNC_TYPE_ADAPTIVE: 2,
	LIBUSB_ISO_SYNC_TYPE_SYNC: 3,
	LIBUSB_ISO_USAGE_TYPE_DATA: 0,
	LIBUSB_ISO_USAGE_TYPE_FEEDBACK: 1,
	LIBUSB_ISO_USAGE_TYPE_IMPLICIT: 2,
	LIBUSB_TRANSFER_COMPLETED: 0,
	LIBUSB_TRANSFER_ERROR: 1,
	LIBUSB_TRANSFER_TIMED_OUT: 2,
	LIBUSB_TRANSFER_CANCELLED: 3,
	LIBUSB_TRANSFER_STALL: 4,
	LIBUSB_TRANSFER_NO_DEVICE: 5,
	LIBUSB_TRANSFER_OVERFLOW: 6,
	LIBUSB_TRANSFER_SHORT_NOT_OK: 1,
	LIBUSB_TRANSFER_FREE_BUFFER: 2,
	LIBUSB_TRANSFER_FREE_TRANSFER: 4,
	LIBUSB_REQUEST_TYPE_STANDARD: 0x00,
	LIBUSB_REQUEST_TYPE_CLASS: 0x20,
	LIBUSB_REQUEST_TYPE_VENDOR: 0x40,
	LIBUSB_REQUEST_TYPE_RESERVED: 0x60,
	LIBUSB_RECIPIENT_DEVICE: 0,
	LIBUSB_RECIPIENT_INTERFACE: 1,
	LIBUSB_RECIPIENT_ENDPOINT: 2,
	LIBUSB_RECIPIENT_OTHER: 3,
	LIBUSB_CONTROL_SETUP_SIZE: 8,
	LIBUSB_DT_BOS_SIZE: 5,
	LIBUSB_CAP_HAS_CAPABILITY: 0x0000,
	LIBUSB_CAP_HAS_HOTPLUG: 0x0001,
	LIBUSB_CAP_HAS_HID_ACCESS: 0x0100,
	LIBUSB_CAP_SUPPORTS_DETACH_KERNEL_DRIVER: 0x0101,
	LIBUSB_ERROR_IO: -1,
	LIBUSB_ERROR_INVALID_PARAM: -2,
	LIBUSB_ERROR_ACCESS: -3,
	LIBUSB_ERROR_NO_DEVICE: -4,
	LIBUSB_ERROR_NOT_FOUND: -5,
	LIBUSB_ERROR_BUSY: -6,
	LIBUSB_ERROR_TIMEOUT: -7,
	LIBUSB_ERROR_OVERFLOW: -8,
	LIBUSB_ERROR_PIPE: -9,
	LIBUSB_ERROR_INTERRUPTED: -10,
	LIBUSB_ERROR_NO_MEM: -11,
	LIBUSB_ERROR_NOT_SUPPORTED: -12,
	LIBUSB_ERROR_OTHER: -99,
} as const;

const STATUS_NAMES = [
	"COMPLETED",
	"ERROR",
	"TIMED_OUT",
	"CANCELLED",
	"STALL",
	"NO_DEVICE",
	"OVERFLOW",
];
const ERROR_NAMES: Record<number, string> = {
	[-1]: "IO",
	[-2]: "INVALID_PARAM",
	[-3]: "ACCESS",
	[-4]: "NO_DEVICE",
	[-5]: "NOT_FOUND",
	[-6]: "BUSY",
	[-7]: "TIMEOUT",
	[-8]: "OVERFLOW",
	[-9]: "PIPE",
	[-10]: "INTERRUPTED",
	[-11]: "NO_MEM",
	[-12]: "NOT_SUPPORTED",
	[-99]: "OTHER",
};
/** libusb_error_name for an error code (negative) or a transfer status. */
export function libusbErrorName(code: number): string {
	const name = code >= 0 ? STATUS_NAMES[code] : ERROR_NAMES[code];
	return name ? `LIBUSB_${code >= 0 ? "TRANSFER" : "ERROR"}_${name}` : "**UNKNOWN**";
}

/** A serializable snapshot of a WebUSB USBDevice. */
export interface UsbDeviceInfo {
	id: number;
	usbVersion: [number, number, number];
	deviceClass: number;
	deviceSubclass: number;
	deviceProtocol: number;
	vendorId: number;
	productId: number;
	deviceVersion: [number, number, number];
	manufacturerName?: string;
	productName?: string;
	serialNumber?: string;
	configurationValue: number | null;
	configurations: {
		configurationValue: number;
		interfaces: {
			interfaceNumber: number;
			alternates: {
				alternateSetting: number;
				interfaceClass: number;
				interfaceSubclass: number;
				interfaceProtocol: number;
				endpoints: {
					endpointNumber: number;
					direction: "in" | "out";
					type: "bulk" | "interrupt" | "isochronous";
					packetSize: number;
				}[];
			}[];
		}[];
	}[];
}

/** Raw descriptors read from an opened device (GET_DESCRIPTOR). */
export interface UsbRawDescriptors {
	device?: Uint8Array;
	configurations: Uint8Array[];
}

export interface DeviceDescriptor {
	bLength: number;
	bDescriptorType: number;
	bcdUSB: number;
	bDeviceClass: number;
	bDeviceSubClass: number;
	bDeviceProtocol: number;
	bMaxPacketSize0: number;
	idVendor: number;
	idProduct: number;
	bcdDevice: number;
	iManufacturer: number;
	iProduct: number;
	iSerialNumber: number;
	bNumConfigurations: number;
}
export interface EndpointDescriptor {
	bLength: number;
	bDescriptorType: number;
	bEndpointAddress: number;
	bmAttributes: number;
	wMaxPacketSize: number;
	bInterval: number;
	bRefresh: number;
	bSynchAddress: number;
	extra: Uint8Array;
}
export interface InterfaceDescriptor {
	bLength: number;
	bDescriptorType: number;
	bInterfaceNumber: number;
	bAlternateSetting: number;
	bNumEndpoints: number;
	bInterfaceClass: number;
	bInterfaceSubClass: number;
	bInterfaceProtocol: number;
	iInterface: number;
	extra: Uint8Array;
	endpoints: EndpointDescriptor[];
}
export interface ConfigDescriptor {
	bLength: number;
	bDescriptorType: number;
	wTotalLength: number;
	bNumInterfaces: number;
	bConfigurationValue: number;
	iConfiguration: number;
	bmAttributes: number;
	bMaxPower: number;
	extra: Uint8Array;
	/** Alternate settings, grouped by interface. */
	interfaces: InterfaceDescriptor[][];
}

const bcd = ([major, minor, subminor]: [number, number, number]) =>
	(major << 8) | ((minor & 0xf) << 4) | (subminor & 0xf);
const word = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

/** The device descriptor: the device's own when read, else built from WebUSB. */
export function deviceDescriptor(info: UsbDeviceInfo, raw?: Uint8Array): DeviceDescriptor {
	if (raw && raw.length >= 18 && raw[1] === LIBUSB.LIBUSB_DT_DEVICE)
		return {
			bLength: raw[0] as number,
			bDescriptorType: raw[1] as number,
			bcdUSB: word(raw, 2),
			bDeviceClass: raw[4] as number,
			bDeviceSubClass: raw[5] as number,
			bDeviceProtocol: raw[6] as number,
			bMaxPacketSize0: raw[7] as number,
			idVendor: word(raw, 8),
			idProduct: word(raw, 10),
			bcdDevice: word(raw, 12),
			iManufacturer: raw[14] as number,
			iProduct: raw[15] as number,
			iSerialNumber: raw[16] as number,
			bNumConfigurations: raw[17] as number,
		};
	// WebUSB exposes the strings but not their indexes; these are the
	// conventional ones until the device is opened and its descriptor read.
	return {
		bLength: 18,
		bDescriptorType: LIBUSB.LIBUSB_DT_DEVICE,
		bcdUSB: bcd(info.usbVersion),
		bDeviceClass: info.deviceClass,
		bDeviceSubClass: info.deviceSubclass,
		bDeviceProtocol: info.deviceProtocol,
		bMaxPacketSize0: 64,
		idVendor: info.vendorId,
		idProduct: info.productId,
		bcdDevice: bcd(info.deviceVersion),
		iManufacturer: info.manufacturerName ? 1 : 0,
		iProduct: info.productName ? 2 : 0,
		iSerialNumber: info.serialNumber ? 3 : 0,
		bNumConfigurations: info.configurations.length,
	};
}

/** Parses a full configuration descriptor as libusb does: unknown
 * descriptors become the `extra` bytes of the entity they follow. */
export function parseConfigDescriptor(bytes: Uint8Array): ConfigDescriptor {
	if (bytes.length < 9 || bytes[1] !== LIBUSB.LIBUSB_DT_CONFIG)
		throw new Error("Invalid configuration descriptor");
	const config: ConfigDescriptor = {
		bLength: bytes[0] as number,
		bDescriptorType: bytes[1] as number,
		wTotalLength: word(bytes, 2),
		bNumInterfaces: bytes[4] as number,
		bConfigurationValue: bytes[5] as number,
		iConfiguration: bytes[6] as number,
		bmAttributes: bytes[7] as number,
		bMaxPower: bytes[8] as number,
		extra: new Uint8Array(),
		interfaces: [],
	};
	const end = Math.min(bytes.length, config.wTotalLength || bytes.length);
	let owner: { extra: Uint8Array } = config;
	let current: InterfaceDescriptor | undefined;
	const append = (target: { extra: Uint8Array }, chunk: Uint8Array) => {
		const joined = new Uint8Array(target.extra.length + chunk.length);
		joined.set(target.extra);
		joined.set(chunk, target.extra.length);
		target.extra = joined;
	};
	for (let at = config.bLength; at + 2 <= end; ) {
		const length = bytes[at] as number;
		const type = bytes[at + 1] as number;
		if (length < 2 || at + length > end) break;
		const chunk = bytes.subarray(at, at + length);
		if (type === LIBUSB.LIBUSB_DT_INTERFACE && length >= 9) {
			current = {
				bLength: length,
				bDescriptorType: type,
				bInterfaceNumber: chunk[2] as number,
				bAlternateSetting: chunk[3] as number,
				bNumEndpoints: chunk[4] as number,
				bInterfaceClass: chunk[5] as number,
				bInterfaceSubClass: chunk[6] as number,
				bInterfaceProtocol: chunk[7] as number,
				iInterface: chunk[8] as number,
				extra: new Uint8Array(),
				endpoints: [],
			};
			const group = config.interfaces.find(
				(alternates) => alternates[0]?.bInterfaceNumber === current?.bInterfaceNumber,
			);
			if (group) group.push(current);
			else config.interfaces.push([current]);
			owner = current;
		} else if (type === LIBUSB.LIBUSB_DT_ENDPOINT && length >= 7 && current) {
			const endpoint: EndpointDescriptor = {
				bLength: length,
				bDescriptorType: type,
				bEndpointAddress: chunk[2] as number,
				bmAttributes: chunk[3] as number,
				wMaxPacketSize: word(chunk, 4),
				bInterval: chunk[6] as number,
				bRefresh: length >= 9 ? (chunk[7] as number) : 0,
				bSynchAddress: length >= 9 ? (chunk[8] as number) : 0,
				extra: new Uint8Array(),
			};
			current.endpoints.push(endpoint);
			owner = endpoint;
		} else append(owner, chunk.slice());
		at += length;
	}
	return config;
}

const TRANSFER_TYPES = { isochronous: 1, bulk: 2, interrupt: 3 } as const;

/** A configuration descriptor built from WebUSB's parsed view. Fields WebUSB
 * doesn't report (bmAttributes, bMaxPower, bInterval, string indexes, class
 * descriptors) take neutral values until the device is opened. */
export function synthesizeConfigDescriptor(
	configuration: UsbDeviceInfo["configurations"][number],
): ConfigDescriptor {
	let total = 9;
	const interfaces = configuration.interfaces.map((item) =>
		item.alternates.map((alternate): InterfaceDescriptor => {
			total += 9 + 7 * alternate.endpoints.length;
			return {
				bLength: 9,
				bDescriptorType: LIBUSB.LIBUSB_DT_INTERFACE,
				bInterfaceNumber: item.interfaceNumber,
				bAlternateSetting: alternate.alternateSetting,
				bNumEndpoints: alternate.endpoints.length,
				bInterfaceClass: alternate.interfaceClass,
				bInterfaceSubClass: alternate.interfaceSubclass,
				bInterfaceProtocol: alternate.interfaceProtocol,
				iInterface: 0,
				extra: new Uint8Array(),
				endpoints: alternate.endpoints.map((endpoint) => ({
					bLength: 7,
					bDescriptorType: LIBUSB.LIBUSB_DT_ENDPOINT,
					bEndpointAddress:
						endpoint.endpointNumber | (endpoint.direction === "in" ? 0x80 : 0),
					bmAttributes: TRANSFER_TYPES[endpoint.type],
					wMaxPacketSize: endpoint.packetSize,
					bInterval: 0,
					bRefresh: 0,
					bSynchAddress: 0,
					extra: new Uint8Array(),
				})),
			};
		}),
	);
	return {
		bLength: 9,
		bDescriptorType: LIBUSB.LIBUSB_DT_CONFIG,
		wTotalLength: total,
		bNumInterfaces: configuration.interfaces.length,
		bConfigurationValue: configuration.configurationValue,
		iConfiguration: 0,
		bmAttributes: 0x80,
		bMaxPower: 0,
		extra: new Uint8Array(),
		interfaces,
	};
}

/** A control transfer's 8-byte setup packet, in WebUSB's terms. */
export function parseSetup(setup: Uint8Array): {
	in: boolean;
	setup: {
		requestType: "standard" | "class" | "vendor" | "reserved";
		recipient: "device" | "interface" | "endpoint" | "other";
		request: number;
		value: number;
		index: number;
	};
	length: number;
} {
	const requestType = setup[0] ?? 0;
	return {
		in: (requestType & 0x80) !== 0,
		setup: {
			requestType:
				(["standard", "class", "vendor"] as const)[(requestType >> 5) & 3] ?? "reserved",
			// Values above 3 are reserved; WebUSB calls them "other".
			recipient:
				(["device", "interface", "endpoint"] as const)[requestType & 0x1f] ?? "other",
			request: setup[1] ?? 0,
			value: word(setup, 2),
			index: word(setup, 4),
		},
		length: word(setup, 6),
	};
}
