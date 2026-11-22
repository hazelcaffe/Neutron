import {
	finalizeBundle,
	type PreparedBundle,
	prepareResources,
	type ResourceFile,
	readZip,
} from "./importer";

let prepared: PreparedBundle | undefined;
self.onmessage = async (
	event: MessageEvent<{
		type: "prepare" | "finalize";
		files?: { file: File; path: string }[];
		zip?: File;
		name?: string;
		kind?: PreparedBundle["kind"];
		candidate?: number;
		entry?: string;
	}>,
) => {
	try {
		const request = event.data;
		const progress = (message: string) => self.postMessage({ type: "progress", message });
		if (request.type === "prepare") {
			let resources: ResourceFile[];
			if (request.zip) {
				progress(`Opening ${request.zip.name}…`);
				resources = readZip(new Uint8Array(await request.zip.arrayBuffer()));
			} else {
				resources = [];
				const files = request.files || [];
				for (let index = 0; index < files.length; index++) {
					const item = files[index];
					if (!item) continue;
					if (index % 25 === 0)
						progress(`Reading resources · ${index + 1} / ${files.length} files`);
					resources.push({
						path: item.path,
						data: new Uint8Array(await item.file.arrayBuffer()),
					});
				}
			}
			prepared = prepareResources(
				resources,
				request.name || request.zip?.name || "resources",
				request.kind || (request.zip ? "zip" : "folder"),
				progress,
			);
			const { snapshot: _snapshot, ...review } = prepared;
			self.postMessage({ type: "prepared", review });
		} else {
			if (!prepared) throw new Error("Import session expired; choose the resources again.");
			progress("Scanning APIs and preparing persistent storage…");
			const result = finalizeBundle(prepared, request.candidate ?? 0, request.entry);
			const buffers = new Set<ArrayBuffer>();
			for (const entry of Object.values(result.snapshot)) {
				const bytes =
					entry.kind === "file"
						? entry.data
						: entry.kind === "directory"
							? entry.archive
							: undefined;
				if (bytes?.buffer instanceof ArrayBuffer) buffers.add(bytes.buffer);
			}
			self.postMessage({ type: "complete", ...result }, { transfer: [...buffers] });
			prepared = undefined;
		}
	} catch (error) {
		self.postMessage({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}
};
