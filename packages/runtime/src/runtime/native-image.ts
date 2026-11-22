import { Buffer } from "buffer";
import jpeg from "jpeg-js";
import { PNG } from "pngjs/browser.js";
import type { VirtualFileSystem } from "./filesystem";

interface Pixels {
	width: number;
	height: number;
	data: Uint8Array;
}
export class NativeImage {
	private pixels?: Pixels;
	private template = false;
	constructor(private bytes = Buffer.alloc(0)) {}
	static fromPixels(pixels: Pixels): NativeImage {
		const image = new NativeImage();
		image.pixels = pixels;
		return image;
	}
	private decode(): Pixels {
		if (this.pixels) return this.pixels;
		if (!this.bytes.length) return { width: 0, height: 0, data: new Uint8Array() };
		if (this.bytes[0] === 0xff && this.bytes[1] === 0xd8)
			this.pixels = jpeg.decode(this.bytes, { useTArray: true });
		else this.pixels = PNG.sync.read(this.bytes);
		return this.pixels;
	}
	isEmpty(): boolean {
		return !this.bytes.length && !this.pixels?.data.length;
	}
	getSize(): { width: number; height: number } {
		const { width, height } = this.decode();
		return { width, height };
	}
	getAspectRatio(): number {
		const { width, height } = this.getSize();
		return height ? width / height : 1;
	}
	getScaleFactors(): number[] {
		return [1];
	}
	setTemplateImage(value: boolean): void {
		this.template = value;
	}
	isTemplateImage(): boolean {
		return this.template;
	}
	toPNG(): Buffer {
		if (this.isEmpty()) return Buffer.alloc(0);
		return PNG.sync.write({ ...this.decode(), data: Buffer.from(this.decode().data) } as PNG);
	}
	toJPEG(quality = 90): Buffer {
		if (this.isEmpty()) return Buffer.alloc(0);
		return Buffer.from(
			jpeg.encode({ ...this.decode(), data: Buffer.from(this.decode().data) }, quality).data,
		);
	}
	toDataURL(): string {
		return `data:image/png;base64,${this.toPNG().toString("base64")}`;
	}
	toBitmap(): Buffer {
		const result = Buffer.from(this.decode().data);
		for (let i = 0; i < result.length; i += 4) {
			const red = result[i] || 0;
			result[i] = result[i + 2] || 0;
			result[i + 2] = red;
		}
		return result;
	}
	getBitmap(): Buffer {
		return this.toBitmap();
	}
	resize(options: { width?: number; height?: number; quality?: string }): NativeImage {
		const source = this.decode();
		if (!source.width || !source.height) return new NativeImage();
		const width = Math.max(
			1,
			Math.round(
				options.width || ((options.height || source.height) * source.width) / source.height,
			),
		);
		const height = Math.max(
			1,
			Math.round(options.height || (width * source.height) / source.width),
		);
		if (width * height > 64_000_000)
			throw new Error("Image dimensions exceed the browser pixel budget");
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const from =
					(Math.min(source.height - 1, Math.floor((y * source.height) / height)) *
						source.width +
						Math.min(source.width - 1, Math.floor((x * source.width) / width))) *
					4;
				data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
			}
		return NativeImage.fromPixels({ width, height, data });
	}
	crop(rect: { x: number; y: number; width: number; height: number }): NativeImage {
		const source = this.decode();
		if (
			![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
			rect.x < 0 ||
			rect.y < 0 ||
			rect.width < 1 ||
			rect.height < 1 ||
			rect.x + rect.width > source.width ||
			rect.y + rect.height > source.height
		)
			throw new Error("Invalid image crop rectangle");
		const data = new Uint8Array(rect.width * rect.height * 4);
		for (let y = 0; y < rect.height; y++) {
			const offset = ((rect.y + y) * source.width + rect.x) * 4;
			data.set(source.data.subarray(offset, offset + rect.width * 4), y * rect.width * 4);
		}
		return NativeImage.fromPixels({ width: rect.width, height: rect.height, data });
	}
}
export function imageModule(vfs: VirtualFileSystem) {
	return {
		createEmpty: () => new NativeImage(),
		createFromBuffer: (data: Uint8Array) => new NativeImage(Buffer.from(data)),
		createFromDataURL: (value: string) =>
			new NativeImage(Buffer.from(value.split(",")[1] || "", "base64")),
		createFromPath: (filename: string) => {
			try {
				return new NativeImage(Buffer.from(vfs.fs.readFileSync(filename) as Uint8Array));
			} catch {
				return new NativeImage();
			}
		},
		createFromBitmap: (data: Uint8Array, options: { width: number; height: number }) => {
			if (data.length !== options.width * options.height * 4)
				throw new Error("Bitmap dimensions do not match buffer length");
			const rgba = new Uint8Array(data);
			for (let i = 0; i < rgba.length; i += 4) {
				const blue = rgba[i] || 0;
				rgba[i] = rgba[i + 2] || 0;
				rgba[i + 2] = blue;
			}
			return NativeImage.fromPixels({ ...options, data: rgba });
		},
		createThumbnailFromPath: async (
			filename: string,
			size: { width: number; height: number },
		) => new NativeImage(Buffer.from(vfs.fs.readFileSync(filename) as Uint8Array)).resize(size),
	};
}
