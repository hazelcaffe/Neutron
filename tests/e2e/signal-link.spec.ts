import {
	createCipheriv,
	createHmac,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, type Frame, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { test } from "./package-profile";

const resources = process.env.NEUTRON_SIGNAL_RESOURCES;
test.skip(!resources, "Set NEUTRON_SIGNAL_RESOURCES to an official extracted resources directory.");

/** Signal's own logs, from its virtual filesystem in OPFS. */
async function signalLogs(page: Page): Promise<string> {
	return page
		.evaluate(async () => {
			const found: string[] = [];
			const walk = async (directory: FileSystemDirectoryHandle, path: string) => {
				for await (const [name, handle] of directory as unknown as AsyncIterable<
					[string, FileSystemHandle]
				>) {
					const full = `${path}/${name}`;
					if (handle instanceof FileSystemDirectoryHandle) await walk(handle, full);
					else if (/\/Signal\/logs\/[^/]+\.log$/.test(full))
						found.push(
							`== ${full}\n${await (await (handle as FileSystemFileHandle).getFile()).text()}`,
						);
				}
			};
			await walk(await navigator.storage.getDirectory(), "");
			return found.join("\n");
		})
		.catch((error: unknown) => String(error));
}

test.afterEach(async ({ page }, testInfo) => {
	if (testInfo.status === testInfo.expectedStatus) return;
	await page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => {});
	const path = testInfo.outputPath("signal-logs.txt");
	await writeFile(path, await signalLogs(page));
	await testInfo.attach("signal-logs", { path, contentType: "text/plain" });
});

// Protobuf, as Signal's ProvisionEnvelope and ProvisionMessage use it.
const varint = (value: number) => {
	const out: number[] = [];
	let rest = value;
	do {
		let byte = rest & 0x7f;
		rest = Math.floor(rest / 128);
		if (rest) byte |= 0x80;
		out.push(byte);
	} while (rest);
	return out;
};
const bytesField = (no: number, value: Uint8Array | string) => {
	const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
	return [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
};
const varintField = (no: number, value: number) => [...varint(no << 3), ...varint(value)];
const uuidBytes = (uuid: string) => Buffer.from(uuid.replaceAll("-", ""), "hex");
const clamped = () => {
	const key = randomBytes(32);
	key[0] = (key[0] as number) & 248;
	key[31] = ((key[31] as number) & 127) | 64;
	return key;
};

/** What a primary device sends a new linked device (Signal's ProvisioningCipher format). */
function provisionEnvelope(desktopKey: Buffer): Buffer {
	const aci = randomUUID();
	const pni = randomUUID();
	const message = Buffer.from([
		...bytesField(2, clamped()), // aciIdentityKeyPrivate
		...bytesField(12, clamped()), // pniIdentityKeyPrivate
		...bytesField(3, "+15555550123"), // number
		...bytesField(4, "000000"), // provisioningCode (not one the server issued)
		...bytesField(5, "OWA"), // userAgent
		...bytesField(6, randomBytes(32)), // profileKey
		...varintField(7, 1), // readReceipts
		...varintField(9, 1), // provisioningVersion
		...bytesField(14, randomBytes(32)), // ephemeralBackupKey: "Transfer message history"
		...bytesField(15, randomBytes(32).toString("hex")), // accountEntropyPool
		...bytesField(16, randomBytes(32)), // mediaRootBackupKey
		...bytesField(17, uuidBytes(aci)), // aciBinary
		...bytesField(18, uuidBytes(pni)), // pniBinary
	]);
	// X25519 with the key in the QR code (0x05 || 32 bytes).
	const desktop = createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: desktopKey.subarray(1).toString("base64url") },
		format: "jwk",
	});
	const ephemeral = generateKeyPairSync("x25519");
	const agreement = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: desktop });
	const keys = Buffer.from(
		hkdfSync("sha256", agreement, Buffer.alloc(32), "TextSecure Provisioning Message", 64),
	);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", keys.subarray(0, 32), iv);
	const signed = Buffer.concat([Buffer.of(1), iv, cipher.update(message), cipher.final()]);
	const mac = createHmac("sha256", keys.subarray(32)).update(signed).digest();
	const ephemeralPublic = Buffer.concat([
		Buffer.of(5),
		Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x as string, "base64url"),
	]);
	return Buffer.from([
		...bytesField(1, ephemeralPublic),
		...bytesField(2, Buffer.concat([signed, mac])),
	]);
}

// libsignal holds its provisioning listener (receivedAddress/receivedEnvelope)
// by WeakRef. Keeping a reference lets the test play the server's part: the
// phone's envelope arrives as PUT /v1/message on the connection whose address
// the QR code shows.
const captureListeners = () => {
	const listeners: { address?: string }[] = [];
	Object.defineProperty(globalThis, "__provisioningListeners", { value: listeners });
	const NativeWeakRef = WeakRef;
	globalThis.WeakRef = class<T extends WeakKey> extends NativeWeakRef<T> {
		constructor(target: T) {
			super(target);
			const listener = target as unknown as {
				address?: string;
				receivedAddress?: (address: string, ack: unknown) => void;
				receivedEnvelope?: unknown;
			};
			const received = listener.receivedAddress;
			if (typeof listener.receivedEnvelope !== "function" || typeof received !== "function")
				return;
			listener.receivedAddress = (address, ack) => {
				listener.address = address;
				return received.call(listener, address, ack);
			};
			listeners.push(listener);
		}
	} as WeakRefConstructor;
};

async function deliverEnvelope(page: Page, address: string, envelope: Buffer) {
	for (const frame of page.frames() as Frame[]) {
		const result = await frame
			.evaluate(
				({ address, envelope }) => {
					const listeners = (
						globalThis as unknown as {
							__provisioningListeners?: {
								address?: string;
								receivedEnvelope(envelope: Uint8Array, ack: unknown): void;
							}[];
						}
					).__provisioningListeners;
					const listener = listeners?.find((item) => item.address === address);
					if (!listener) return undefined;
					// The server's ack handle; Signal acknowledges after handling the envelope.
					const ack = {};
					try {
						listener.receivedEnvelope(Uint8Array.from(envelope), ack);
						return "delivered";
					} catch (error) {
						return `threw: ${error instanceof Error ? error.stack || error.message : String(error)}`;
					}
				},
				{ address, envelope: [...envelope] },
			)
			.catch(() => undefined);
		if (result) return result;
	}
	return "no listener for that address";
}

// After scanning, the phone encrypts the new device's account keys to the QR
// code's public key and the server delivers them over the provisioning
// connection. This plays the server's part for that one message, then checks
// that Signal decrypts it and registers the linked device with Signal's real
// server, which rejects the made-up provisioning code.
test("official Signal Desktop handles the provisioning envelope a phone sends after scanning", async ({
	page,
}, testInfo) => {
	test.setTimeout(420_000);
	await page.addInitScript(captureListeners);
	await page.goto("/");
	await expect(page.locator("#runtime-state")).toHaveText("Runtime ready", { timeout: 60_000 });
	await page.locator("#folder-input").setInputFiles(resources as string);
	const readQR = async () => {
		try {
			const image = PNG.sync.read(await page.screenshot());
			return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data ?? "";
		} catch {
			return "";
		}
	};
	let link = "";
	await expect
		.poll(async () => (link = await readQR()), { timeout: 180_000, intervals: [2000] })
		.toMatch(/^sgnl:\/\/linkdevice\?uuid=/);
	const params = new URL(link).searchParams;
	const desktopKey = Buffer.from(params.get("pub_key") as string, "base64");
	expect(desktopKey.length).toBe(33);
	const delivered = await deliverEnvelope(
		page,
		params.get("uuid") as string,
		provisionEnvelope(desktopKey),
	);
	// Signal acknowledges only after handling the envelope; the test's
	// stand-in for the server's ack handle is not a native one.
	expect(delivered).toMatch(/^(delivered|threw: .*ServerMessageAck)/s);
	let logs = "";
	await expect
		.poll(async () => (logs = await signalLogs(page)), { timeout: 60_000, intervals: [2000] })
		.toMatch(/PUT \(WS\) https:\/\/chat\.signal\.org\/v1\/devices\/link 4\d\d/);
	expect(logs).toContain("createAccount: Number is");
	expect(logs).not.toMatch(/Bad MAC|ProvisioningCipher|onReceivedEnvelope: duplicate/);
	await writeFile(testInfo.outputPath("signal-logs.txt"), logs);
});
