import { Buffer } from "buffer";
import {
	type ConfigDescriptor,
	deviceDescriptor,
	LIBUSB,
	libusbErrorName,
	parseConfigDescriptor,
	parseSetup,
	synthesizeConfigDescriptor,
	type UsbDeviceInfo,
	type UsbRawDescriptors,
} from "../shared/usb";

// node-usb's native binding (usb_bindings.node: libusb) over WebUSB. The
// devices live in the Neutron page (core/usb.ts), which alone can show the
// browser's chooser; this side calls it synchronously where libusb is
// synchronous (open, claim) and asynchronously for transfers. node-usb's own
// JavaScript (Device, Interface, Endpoint, its WebUSB class) runs unchanged.

export interface UsbBridge {
	/** A host request that blocks until it completes. */
	sync<T>(method: string, args: unknown[]): T;
	call<T>(method: string, args: unknown[]): Promise<T>;
	/** Host events: a device was connected (or granted) or disconnected. */
	listen(listener: (event: "connect" | "disconnect", device: UsbDeviceInfo) => void): void;
}

/** node-usb's prebuilt (prebuilds/<platform>/node.napi*.node) or source-built addon. */
export const isNodeUsbAddon = (filename: string) =>
	/\/node_modules\/usb\/(?:prebuilds\/[^/]+\/node\.napi[^/]*\.node|build\/(?:Release|Debug)\/usb_bindings\.node)$/.test(
		filename,
	);

interface Outcome {
	status: "ok" | "stall" | "babble";
	data?: Uint8Array;
	length: number;
}

const libusbError = (errno: number) => Object.assign(new Error(libusbErrorName(errno)), { errno });

/** The libusb error for a host failure (a DOMException name in the message). */
function errnoOf(error: unknown): number {
	const text = String(error instanceof Error ? error.message : error);
	if (/NotFoundError/.test(text)) return LIBUSB.LIBUSB_ERROR_NO_DEVICE;
	if (/SecurityError|NotAllowedError/.test(text)) return LIBUSB.LIBUSB_ERROR_ACCESS;
	if (/NotSupportedError/.test(text)) return LIBUSB.LIBUSB_ERROR_NOT_SUPPORTED;
	if (/AbortError/.test(text)) return LIBUSB.LIBUSB_ERROR_INTERRUPTED;
	if (/DataError|TypeError|RangeError/.test(text)) return LIBUSB.LIBUSB_ERROR_INVALID_PARAM;
	if (/InvalidStateError|NetworkError/.test(text)) return LIBUSB.LIBUSB_ERROR_IO;
	return LIBUSB.LIBUSB_ERROR_OTHER;
}
/** The transfer status for a host failure. */
function transferStatus(error: unknown): number {
	const errno = errnoOf(error);
	return errno === LIBUSB.LIBUSB_ERROR_NO_DEVICE
		? LIBUSB.LIBUSB_TRANSFER_NO_DEVICE
		: errno === LIBUSB.LIBUSB_ERROR_INTERRUPTED
			? LIBUSB.LIBUSB_TRANSFER_CANCELLED
			: LIBUSB.LIBUSB_TRANSFER_ERROR;
}

/** Descriptors with node-usb's Buffer `extra` fields. */
function withBuffers(config: ConfigDescriptor) {
	return {
		...config,
		extra: Buffer.from(config.extra),
		interfaces: config.interfaces.map((alternates) =>
			alternates.map((item) => ({
				...item,
				extra: Buffer.from(item.extra),
				endpoints: item.endpoints.map((endpoint) => ({
					...endpoint,
					extra: Buffer.from(endpoint.extra),
				})),
			})),
		),
	};
}

export function nodeUsbAddon(bridge: UsbBridge): object {
	const devices = new Map<number, Device>();
	let hotplug = false;
	let initError = 0;
	try {
		if (!bridge.sync<boolean>("usb.available", []))
			initError = LIBUSB.LIBUSB_ERROR_NOT_SUPPORTED;
	} catch {
		initError = LIBUSB.LIBUSB_ERROR_OTHER;
	}
	// Only the user can grant a device; let the page offer its chooser.
	const wanted = () => void bridge.call("usb.wanted", []).catch(() => {});
	const callback =
		(done: (error?: Error) => void) => (promise: Promise<unknown>, after?: () => void) =>
			promise.then(
				() => {
					after?.();
					done();
				},
				(error: unknown) => done(libusbError(errnoOf(error))),
			);

	class Device {
		readonly busNumber = 1;
		readonly deviceAddress: number;
		readonly portNumbers: number[] = [];
		#info: UsbDeviceInfo;
		#raw?: UsbRawDescriptors;
		#opened = false;
		constructor(info: UsbDeviceInfo) {
			this.#info = info;
			this.deviceAddress = info.id;
		}
		get deviceDescriptor() {
			return deviceDescriptor(this.#info, this.#raw?.device);
		}
		get __id(): number {
			return this.#info.id;
		}
		__update(info: UsbDeviceInfo): void {
			this.#info = info;
		}
		__open(): void {
			if (this.#opened) return;
			const opened = sync<UsbRawDescriptors & { info: UsbDeviceInfo }>("usb.open", [
				this.__id,
			]);
			this.#info = opened.info;
			this.#raw = { device: opened.device, configurations: opened.configurations };
			this.#opened = true;
		}
		__close(): void {
			if (!this.#opened) return;
			this.#opened = false;
			sync("usb.close", [this.__id]);
		}
		__getParent(): null {
			// WebUSB doesn't report the bus topology.
			return null;
		}
		#configurations(): ConfigDescriptor[] {
			const raw = this.#raw?.configurations ?? [];
			if (raw.length) return raw.map(parseConfigDescriptor);
			return this.#info.configurations.map(synthesizeConfigDescriptor);
		}
		__getConfigDescriptor() {
			const value = this.#info.configurationValue;
			const active = this.#configurations().find(
				(config) => config.bConfigurationValue === value,
			);
			if (!active) throw libusbError(LIBUSB.LIBUSB_ERROR_NOT_FOUND);
			return withBuffers(active);
		}
		__getAllConfigDescriptors() {
			return this.#configurations().map(withBuffers);
		}
		__setConfiguration(value: number, done: (error?: Error) => void): void {
			callback(done)(
				bridge
					.call<UsbDeviceInfo>("usb.selectConfiguration", [this.__id, value])
					.then((info) => this.__update(info)),
			);
		}
		__clearHalt(address: number, done: (error?: Error) => void): void {
			callback(done)(bridge.call("usb.clearHalt", [this.__id, address]));
		}
		__setInterface(number: number, alternate: number, done: (error?: Error) => void): void {
			callback(done)(
				bridge.call("usb.selectAlternateInterface", [this.__id, number, alternate]),
			);
		}
		__claimInterface(number: number): void {
			sync("usb.claimInterface", [this.__id, number]);
		}
		__releaseInterface(number: number, done: (error?: Error) => void): void {
			callback(done)(bridge.call("usb.releaseInterface", [this.__id, number]));
		}
		// The browser binds and unbinds kernel drivers itself.
		__detachKernelDriver(): void {}
		__attachKernelDriver(): void {}
		__isKernelDriverActive(): boolean {
			return false;
		}
		__setAutoDetachKernelDriver(): void {}
		reset(done: (error?: Error) => void): void {
			callback(done)(bridge.call("usb.reset", [this.__id]));
		}
	}

	type TransferCallback = (error: Error | undefined, buffer: Buffer, actual: number) => void;
	class Transfer {
		#pending?: { finish(status: number, actual: number): void };
		constructor(
			private readonly device: Device,
			private readonly endpoint: number,
			private readonly type: number,
			private readonly timeout: number,
			private callback: TransferCallback,
		) {}
		submit(buffer: Buffer, callback?: TransferCallback): this {
			if (this.#pending) throw libusbError(LIBUSB.LIBUSB_ERROR_BUSY);
			if (callback) this.callback = callback;
			const done = this.callback;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const pending = {
				finish: (status: number, actual: number) => {
					if (this.#pending !== pending) return;
					this.#pending = undefined;
					clearTimeout(timer);
					done.call(
						this,
						status === LIBUSB.LIBUSB_TRANSFER_COMPLETED
							? undefined
							: libusbError(status),
						buffer,
						actual,
					);
				},
			};
			this.#pending = pending;
			// WebUSB can't abandon a transfer: a late result is dropped.
			if (this.timeout > 0)
				timer = setTimeout(
					() => pending.finish(LIBUSB.LIBUSB_TRANSFER_TIMED_OUT, 0),
					this.timeout,
				);
			let offset = 0;
			let request: Promise<Outcome>;
			if (this.type === LIBUSB.LIBUSB_TRANSFER_TYPE_CONTROL) {
				const setup = new Uint8Array(buffer.subarray(0, LIBUSB.LIBUSB_CONTROL_SETUP_SIZE));
				const { in: input, length } = parseSetup(setup);
				offset = LIBUSB.LIBUSB_CONTROL_SETUP_SIZE;
				request = bridge.call("usb.control", [
					this.device.__id,
					setup,
					input ? length : new Uint8Array(buffer.subarray(offset, offset + length)),
				]);
			} else if (this.type === LIBUSB.LIBUSB_TRANSFER_TYPE_ISOCHRONOUS)
				request = Promise.reject(new Error("NotSupportedError: isochronous transfers"));
			else
				request = bridge.call("usb.transfer", [
					this.device.__id,
					this.endpoint,
					this.endpoint & LIBUSB.LIBUSB_ENDPOINT_IN
						? buffer.length
						: new Uint8Array(buffer),
				]);
			request.then(
				(outcome) => {
					let actual = outcome.length;
					if (outcome.data) {
						actual = Math.min(outcome.data.length, buffer.length - offset);
						buffer.set(outcome.data.subarray(0, actual), offset);
					}
					pending.finish(
						outcome.status === "stall"
							? LIBUSB.LIBUSB_TRANSFER_STALL
							: outcome.status === "babble" ||
									(outcome.data && outcome.data.length > buffer.length - offset)
								? LIBUSB.LIBUSB_TRANSFER_OVERFLOW
								: LIBUSB.LIBUSB_TRANSFER_COMPLETED,
						actual,
					);
				},
				(error: unknown) => pending.finish(transferStatus(error), 0),
			);
			return this;
		}
		/** libusb reports a cancelled transfer through its callback, later. */
		cancel(): boolean {
			const pending = this.#pending;
			if (!pending) return false;
			setTimeout(() => pending.finish(LIBUSB.LIBUSB_TRANSFER_CANCELLED, 0));
			return true;
		}
	}

	function sync<T>(method: string, args: unknown[]): T {
		try {
			return bridge.sync<T>(method, args);
		} catch (error) {
			throw libusbError(errnoOf(error));
		}
	}
	const device = (info: UsbDeviceInfo) => {
		let existing = devices.get(info.id);
		if (existing) existing.__update(info);
		else {
			existing = new Device(info);
			devices.set(info.id, existing);
		}
		return existing;
	};

	const binding: Record<string, unknown> = {
		...LIBUSB,
		INIT_ERROR: initError,
		Device,
		Transfer,
		getDeviceList(): Device[] {
			if (initError) return [];
			const infos = sync<UsbDeviceInfo[]>("usb.devices", []);
			if (!infos.length) wanted();
			return infos.map(device);
		},
		_supportedHotplugEvents: () => !initError,
		_enableHotplugEvents() {
			hotplug = true;
			wanted();
		},
		_disableHotplugEvents() {
			hotplug = false;
		},
		refHotplugEvents() {},
		unrefHotplugEvents() {},
		setDebugLevel() {},
		useUsbDkBackend() {},
		_getLibusbCapability: (capability: number) =>
			capability === LIBUSB.LIBUSB_CAP_HAS_CAPABILITY ||
			capability === LIBUSB.LIBUSB_CAP_HAS_HOTPLUG
				? 1
				: 0,
	};
	const emit = (...args: unknown[]) =>
		(binding as { emit?: (...values: unknown[]) => boolean }).emit?.(...args);
	bridge.listen((event, info) => {
		if (event === "connect") {
			const known = devices.has(info.id);
			const attached = device(info);
			if (hotplug && !known) {
				emit("attach", attached);
				emit("attachIds", { idVendor: info.vendorId, idProduct: info.productId });
			}
			return;
		}
		const detached = devices.get(info.id);
		if (!detached) return;
		devices.delete(info.id);
		if (hotplug) {
			emit("detach", detached);
			emit("detachIds", { idVendor: info.vendorId, idProduct: info.productId });
		}
	});
	return binding;
}
