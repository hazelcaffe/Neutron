import {
	Button,
	Checkbox,
	Divider,
	Group,
	Modal,
	NativeSelect,
	Progress,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import type {
	ImportChoice,
	ImportReview,
	InstalledApp,
	Platform,
	RuntimeSettings,
	Snapshot,
} from "@neutron/runtime";
import { type FormEvent, useEffect, useMemo, useState } from "react";

const PLATFORMS: { value: Platform; label: string }[] = [
	{ value: "linux", label: "Linux" },
	{ value: "win32", label: "Windows" },
	{ value: "darwin", label: "macOS" },
];
const size = (bytes: number) =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 ** 2
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function relayURL(value: string): string {
	const text = value.trim();
	if (!text) return "";
	const url = URL.parse(text);
	if (!url || !["ws:", "wss:"].includes(url.protocol))
		throw new Error("Enter a ws:// or wss:// URL.");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Remove credentials, query and fragment from the URL.");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.href;
}

export function SettingsDialog(props: {
	opened: boolean;
	settings: RuntimeSettings;
	localRelay: string;
	app?: InstalledApp;
	onClose(): void;
	onSave(settings: RuntimeSettings): void;
	onRemove(app: InstalledApp): void;
}) {
	const [draft, setDraft] = useState(props.settings);
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	useEffect(() => {
		if (!props.opened) return;
		setDraft(props.settings);
		setError(undefined);
		setConfirming(false);
	}, [props.opened, props.settings]);
	const set = (patch: Partial<RuntimeSettings>) => setDraft((value) => ({ ...value, ...patch }));
	const submit = (event: FormEvent) => {
		event.preventDefault();
		try {
			props.onSave({ ...draft, wisp: relayURL(draft.wisp) });
		} catch (problem) {
			setError((problem as Error).message);
		}
	};
	const { app } = props;
	return (
		<Modal opened={props.opened} onClose={props.onClose} title="Settings" size="md">
			<form id="settings-form" onSubmit={submit}>
				<Stack gap="md">
					<TextInput
						id="wisp-url"
						label="Wisp relay URL"
						placeholder={props.localRelay ? "Built-in relay" : "wss://relay.example/"}
						description={
							props.localRelay
								? `Leave empty to use the built-in relay at ${props.localRelay}`
								: "This host has no built-in relay. Without one, apps run offline."
						}
						value={draft.wisp}
						error={error}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => set({ wisp: event.currentTarget.value })}
					/>
					<Checkbox
						id="offline-network"
						label="Disable external networking"
						checked={draft.offline === true}
						onChange={(event) => set({ offline: event.currentTarget.checked })}
					/>
					<NativeSelect
						id="compat-platform"
						label="Platform"
						description="Report the platform of the package you imported."
						data={PLATFORMS}
						value={draft.platform || "linux"}
						onChange={(event) =>
							set({ platform: event.currentTarget.value as Platform })
						}
					/>
					<Checkbox
						id="strict-apis"
						label="Throw on unsupported APIs"
						description="Off by default: missing APIs use fallbacks and log a warning."
						checked={draft.strict === true}
						onChange={(event) => set({ strict: event.currentTarget.checked })}
					/>
					<Checkbox
						id="show-app-menu"
						label="Show application menu bar"
						checked={draft.showAppMenu === true}
						onChange={(event) => set({ showAppMenu: event.currentTarget.checked })}
					/>
					<Text size="xs" c="dimmed">
						Network, platform and API settings apply the next time an app starts.
					</Text>
					{app && (
						<>
							<Divider />
							<Group justify="space-between" wrap="nowrap" align="flex-start">
								<div>
									<Text size="sm" fw={500}>
										{app.manifest.name} {app.manifest.version}
									</Text>
									<Text size="xs" c="dimmed">
										{app.fileCount.toLocaleString()} files · {size(app.size)}
									</Text>
								</div>
								{confirming ? (
									<Group gap="xs" wrap="nowrap">
										<Button
											size="xs"
											variant="default"
											onClick={() => setConfirming(false)}
										>
											Keep
										</Button>
										<Button
											id="confirm-remove"
											size="xs"
											color="red"
											onClick={() => props.onRemove(app)}
										>
											Remove app and its files
										</Button>
									</Group>
								) : (
									<Button
										id="remove-app"
										size="xs"
										color="red"
										variant="light"
										onClick={() => setConfirming(true)}
									>
										Remove app
									</Button>
								)}
							</Group>
						</>
					)}
					<Group justify="flex-end" mt="xs">
						<Button variant="default" onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit">Save settings</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
}

function download(bytes: Uint8Array, filename: string): void {
	const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Lets the user download what an app saved in its browser-backed filesystem. */
export function FilesDialog(props: {
	opened: boolean;
	app?: InstalledApp;
	query: string;
	load(): Promise<Snapshot>;
	onClose(): void;
}) {
	const [snapshot, setSnapshot] = useState<Snapshot>();
	const [error, setError] = useState<string>();
	const [filter, setFilter] = useState("");
	const { opened, load, query } = props;
	useEffect(() => {
		if (!opened) return;
		let live = true;
		setSnapshot(undefined);
		setError(undefined);
		setFilter(query);
		load().then(
			(value) => live && setSnapshot(value),
			(problem: unknown) => live && setError(String(problem)),
		);
		return () => {
			live = false;
		};
	}, [opened, load, query]);
	const files = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return Object.entries(snapshot || {})
			.flatMap(([path, entry]) => {
				const bytes =
					entry.kind === "file"
						? entry.data
						: entry.kind === "directory"
							? entry.archive
							: undefined;
				return bytes && path.toLowerCase().includes(needle) ? [{ path, bytes }] : [];
			})
			.sort((a, b) => a.path.localeCompare(b.path));
	}, [snapshot, filter]);
	return (
		<Modal
			opened={opened}
			onClose={props.onClose}
			title={props.app ? `Files · ${props.app.manifest.name}` : "Files"}
			size="xl"
		>
			<Stack gap="sm">
				<TextInput
					id="file-search"
					placeholder="Filter by path, e.g. .config or .json"
					aria-label="Filter files"
					value={filter}
					onChange={(event) => setFilter(event.currentTarget.value)}
					data-autofocus
				/>
				<Text size="xs" c="dimmed">
					{error ||
						(snapshot
							? `${files.length.toLocaleString()} files${files.length > 500 ? " · showing the first 500" : ""} · Click one to download it.`
							: "Loading…")}
				</Text>
				<ScrollArea.Autosize mah="55vh" type="auto">
					<div className="file-list">
						{files.slice(0, 500).map((file) => (
							<UnstyledButton
								key={file.path}
								className="file-entry"
								data-path={file.path}
								title={`Download ${file.path}`}
								onClick={() =>
									download(file.bytes, file.path.split("/").at(-1) || "file")
								}
							>
								<span className="file-path">{file.path}</span>
								<span className="file-size">{size(file.bytes.length)}</span>
							</UnstyledButton>
						))}
					</div>
				</ScrollArea.Autosize>
			</Stack>
		</Modal>
	);
}

export interface ImportTask {
	message: string;
	installing: boolean;
	cancel(): void;
}

export function ImportProgress(props: { task?: ImportTask }) {
	const [last, setLast] = useState(props.task);
	useEffect(() => {
		if (props.task) setLast(props.task);
	}, [props.task]);
	const task = props.task || last;
	return (
		<Modal
			opened={Boolean(props.task)}
			onClose={() => {}}
			withCloseButton={false}
			closeOnClickOutside={false}
			closeOnEscape={false}
			centered
			title="Importing app"
		>
			<div id="import-progress">
				<Text id="busy-text" role="status" size="sm">
					{task?.message}
				</Text>
				<Progress value={100} animated striped size="sm" mt="md" />
				<Group justify="flex-end" mt="lg">
					<Button
						id="cancel-import"
						variant="default"
						disabled={!task || task.installing}
						onClick={() => task?.cancel()}
					>
						Cancel
					</Button>
				</Group>
			</div>
		</Modal>
	);
}

export function ReviewDialog(props: {
	review?: ImportReview;
	onChoose(choice: ImportChoice | null): void;
}) {
	const { review } = props;
	const [candidate, setCandidate] = useState(0);
	const [entry, setEntry] = useState("");
	useEffect(() => {
		if (!review) return;
		const index = review.suggested ?? 0;
		setCandidate(index);
		setEntry(review.candidates[index]?.entryPoint || "");
	}, [review]);
	const current = review?.candidates[candidate];
	return (
		<Modal
			opened={Boolean(review)}
			onClose={() => props.onChoose(null)}
			title="Choose the app’s startup file"
			size="lg"
			centered
		>
			{review && current && (
				<Stack id="import-review" gap="md">
					<Text id="import-issue" size="sm">
						{current.issue ||
							"More than one application package was found. Choose which one to launch."}
					</Text>
					<NativeSelect
						id="package-select"
						label="Application package"
						data={review.candidates.map((item, index) => ({
							value: String(index),
							label: `${item.name} — ${item.appPath}`,
						}))}
						value={String(candidate)}
						onChange={(event) => {
							const index = Number(event.currentTarget.value);
							setCandidate(index);
							setEntry(review.candidates[index]?.entryPoint || "");
						}}
					/>
					<NativeSelect
						id="entry-select"
						label="Main-process entry"
						description="The Electron main-process script, not a renderer bundle."
						data={[
							{ value: "", label: "Select the main-process file" },
							...current.choices.map((value) => ({ value, label: value })),
						]}
						value={entry}
						onChange={(event) => setEntry(event.currentTarget.value)}
					/>
					<Text size="xs" c="dimmed">
						{review.importedFiles.toLocaleString()}{" "}
						{review.importedFiles === 1 ? "file" : "files"} · {review.archives.length}{" "}
						{review.archives.length === 1 ? "archive" : "archives"}
					</Text>
					<Group justify="flex-end">
						<Button
							id="cancel-review"
							variant="default"
							onClick={() => props.onChoose(null)}
						>
							Cancel
						</Button>
						<Button
							id="finish-import"
							disabled={!entry}
							onClick={() => props.onChoose({ candidate, entry })}
						>
							Import and run
						</Button>
					</Group>
				</Stack>
			)}
		</Modal>
	);
}
