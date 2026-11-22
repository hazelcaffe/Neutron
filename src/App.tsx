import { Badge, Button, Menu, NativeSelect, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	type AppWindow,
	type ContextMenuData,
	createAsar,
	errorText,
	type ImportChoice,
	type ImportReview,
	type ImportSource,
	type InstalledApp,
	importSourceFromDrop,
	type MenuData,
	Neutron,
	type RuntimeSettings,
	type RuntimeState,
} from "@neutron/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AppMenuBar,
	ContextMenu,
	Home,
	LogPanel,
	StageNote,
	WindowTabs,
	windowLabel,
} from "./components";
import {
	FilesDialog,
	ImportProgress,
	type ImportTask,
	ReviewDialog,
	SettingsDialog,
} from "./dialogs";
import { exampleFiles } from "./example";

type State = RuntimeState | "unavailable";
const LABELS: Record<State, string> = {
	initializing: "Initializing",
	stopped: "Runtime ready",
	starting: "Starting application",
	running: "Application running",
	failed: "Application error",
	unavailable: "Initialization failed",
};
const COLORS: Record<State, string> = {
	initializing: "yellow",
	stopped: "blue",
	starting: "yellow",
	running: "green",
	failed: "red",
	unavailable: "red",
};

// One runtime per page; it owns the viewport element for the page's lifetime.
let runtime: Promise<Neutron> | undefined;

const firstLine = (error: unknown) => errorText(error).split("\n")[0] || "Unknown error";
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const notify = (message: string, title?: string) => notifications.show({ title, message });

export function App() {
	const viewport = useRef<HTMLElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const zipInput = useRef<HTMLInputElement>(null);
	const [neutron, setNeutron] = useState<Neutron>();
	const [failure, setFailure] = useState<string>();
	const [state, setState] = useState<State>("initializing");
	const [running, setRunning] = useState<InstalledApp>();
	const [apps, setApps] = useState<InstalledApp[]>([]);
	const [selected, setSelected] = useState("");
	const [windows, setWindows] = useState<readonly AppWindow[]>([]);
	const [menu, setMenu] = useState<readonly MenuData[]>([]);
	const [contextMenu, setContextMenu] = useState<ContextMenuData | null>(null);
	const [settings, setSettings] = useState<RuntimeSettings>({ wisp: "" });
	const [localRelay, setLocalRelay] = useState("");
	const [errors, setErrors] = useState(0);
	const [logsOpen, setLogsOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [filesQuery, setFilesQuery] = useState<string>();
	const [task, setTask] = useState<ImportTask>();
	const [review, setReview] = useState<{
		review: ImportReview;
		resolve(choice: ImportChoice | null): void;
	}>();
	const [dragging, setDragging] = useState(false);
	// Read at launch time: an import can finish long after the render that started it.
	const config = useRef({ settings, localRelay });
	config.current = { settings, localRelay };
	const importing = useRef(false);

	const report = (error: unknown, title = "Something went wrong") => {
		notifications.show({ color: "red", title, message: firstLine(error) });
		setLogsOpen(true);
	};

	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		let live = true;
		const stop: (() => void)[] = [];
		runtime ??= Neutron.create({ viewport: element });
		runtime
			.then(async (instance) => {
				const [saved, relay, list] = await Promise.all([
					instance.loadSettings(),
					Neutron.localRelay(),
					instance.listApps(),
				]);
				if (!live) return;
				stop.push(
					instance.on("state", (next) => {
						setState(next);
						setRunning(instance.app);
						if (next === "failed") {
							const latest = instance.logs.findLast(
								(entry) => entry.level === "error",
							);
							notifications.show({
								color: "red",
								title: `${instance.app?.manifest.name ?? "The app"} stopped with an error`,
								message:
									latest?.message.split("\n")[0] || "See the logs for details.",
							});
							setLogsOpen(true);
						}
					}),
					instance.on("windows", setWindows),
					instance.on("menu", setMenu),
					instance.on("contextMenu", setContextMenu),
					instance.on("log", (entry) => {
						if (entry.level === "error") setErrors((count) => count + 1);
					}),
					instance.on("notification", (message) => notify(message)),
					instance.on("devtools", setLogsOpen),
					instance.on("reveal", (path) => {
						setSelected(instance.app?.id ?? "");
						setFilesQuery(path);
					}),
				);
				setSettings(saved);
				setLocalRelay(relay);
				setApps(list);
				setSelected(list[0]?.id ?? "");
				setErrors(instance.logs.filter((entry) => entry.level === "error").length);
				setState(instance.state);
				setNeutron(instance);
			})
			.catch((error: unknown) => {
				if (!live) return;
				setState("unavailable");
				setFailure(firstLine(error));
			});
		return () => {
			live = false;
			for (const off of stop) off();
		};
	}, []);

	const refresh = async (prefer?: string) => {
		if (!neutron) return;
		const list = await neutron.listApps();
		setApps(list);
		setSelected(
			(current) =>
				[prefer, current].find((id) => id && list.some((app) => app.id === id)) ??
				list[0]?.id ??
				"",
		);
	};
	const launch = async (app: InstalledApp | string) => {
		if (!neutron) return;
		try {
			const { settings, localRelay } = config.current;
			await neutron.start(app, {
				relay: settings.offline ? "" : settings.wisp || localRelay,
				strict: settings.strict,
				platform: settings.platform,
			});
		} catch (error) {
			report(error, "The app couldn’t start");
		}
	};
	const importApp = async (source: ImportSource | Promise<ImportSource>) => {
		if (!neutron) return notify("Wait for the runtime to finish initializing.");
		if (importing.current) return notify("An import is already in progress.");
		importing.current = true;
		const controller = new AbortController();
		setTask({
			message: "Reading resources…",
			installing: false,
			cancel: () => controller.abort(),
		});
		try {
			const app = await neutron.importApp(await source, {
				signal: controller.signal,
				onProgress: (message) =>
					setTask(
						(value) =>
							value && {
								...value,
								message,
								installing: message.startsWith("Saving"),
							},
					),
				chooseEntry: (value) =>
					new Promise((resolve) => setReview({ review: value, resolve })),
			});
			setTask(undefined);
			await refresh(app.id);
			await launch(app);
		} catch (error) {
			if (!isAbort(error)) report(error, "Import failed");
		} finally {
			importing.current = false;
			setTask(undefined);
			setReview(undefined);
		}
	};
	const importExample = () =>
		importApp({
			files: [new File([new Uint8Array(createAsar(exampleFiles))], "app.asar")],
			name: "Neutron Notes example",
			kind: "example",
		});
	const saveSettings = async (next: RuntimeSettings) => {
		if (!neutron) return;
		config.current = { ...config.current, settings: next };
		setSettings(next);
		try {
			await neutron.saveSettings(next);
			setSettingsOpen(false);
			notify("They apply the next time an app starts.", "Settings saved");
		} catch (error) {
			report(error, "Couldn’t save settings");
		}
	};
	const removeApp = async (app: InstalledApp) => {
		if (!neutron) return;
		try {
			await neutron.removeApp(app.id);
			await refresh();
			setSettingsOpen(false);
			notify(`${app.manifest.name} and its files were removed.`);
		} catch (error) {
			report(error, "Couldn’t remove the app");
		}
	};

	// Shortcuts and drag-and-drop import anywhere on the page.
	const latest = useRef({ importApp, setLogsOpen });
	latest.current = { importApp, setLogsOpen };
	useEffect(() => {
		let depth = 0;
		const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
		const keydown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "`") {
				event.preventDefault();
				latest.current.setLogsOpen((open) => !open);
			}
		};
		const enter = (event: DragEvent) => {
			if (!files(event)) return;
			event.preventDefault();
			depth++;
			setDragging(true);
		};
		const over = (event: DragEvent) => {
			if (files(event)) event.preventDefault();
		};
		const leave = () => {
			if (--depth <= 0) {
				depth = 0;
				setDragging(false);
			}
		};
		const drop = (event: DragEvent) => {
			event.preventDefault();
			depth = 0;
			setDragging(false);
			if (event.dataTransfer)
				void latest.current.importApp(importSourceFromDrop(event.dataTransfer));
		};
		const events = { keydown, dragenter: enter, dragover: over, dragleave: leave, drop };
		for (const [name, listener] of Object.entries(events))
			document.addEventListener(name, listener as EventListener);
		return () => {
			for (const [name, listener] of Object.entries(events))
				document.removeEventListener(name, listener as EventListener);
		};
	}, []);

	const ready = Boolean(neutron) && state !== "initializing";
	const app = apps.find((item) => item.id === selected);
	const loadFiles = useCallback(
		() => (neutron && selected ? neutron.files(selected) : Promise.resolve({})),
		[neutron, selected],
	);
	const live = state === "starting" || state === "running" || state === "failed";
	const visible = windows.find((item) => item.active);
	const hidden = windows.filter((item) => !item.visible);
	const showTabs = windows.length > 1 || (windows.length === 1 && !visible);
	const name = running?.manifest.name ?? "The app";

	return (
		<div className="shell">
			<header className="bar">
				<Text fw={700} className="brand">
					neutron
				</Text>
				<NativeSelect
					id="application-select"
					aria-label="Application"
					size="xs"
					className="app-select"
					disabled={!apps.length}
					value={selected}
					onChange={(event) => setSelected(event.currentTarget.value)}
					data={
						apps.length
							? apps.map((item) => ({
									value: item.id,
									label: `${item.manifest.name} ${item.manifest.version}`,
								}))
							: [{ value: "", label: "No apps imported" }]
					}
				/>
				<Button
					id="launch-button"
					size="xs"
					disabled={!ready || !app || state === "starting" || Boolean(task)}
					onClick={() => app && void launch(app)}
				>
					Run
				</Button>
				<Button
					id="stop-button"
					size="xs"
					variant="default"
					disabled={!running}
					onClick={() => neutron?.stop().catch((error: unknown) => report(error))}
				>
					Stop
				</Button>
				<Badge
					id="runtime-state"
					role="status"
					data-state={state}
					variant="dot"
					color={COLORS[state]}
					tt="none"
					size="lg"
					radius="sm"
				>
					{LABELS[state]}
				</Badge>
				<div className="grow" />
				<Menu id="import-button" position="bottom-end" shadow="md" width={240}>
					<Menu.Target>
						<Button size="xs" variant="default" disabled={!ready}>
							Import
						</Button>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item id="folder-button" onClick={() => folderInput.current?.click()}>
							Resources folder…
						</Menu.Item>
						<Menu.Item id="zip-button" onClick={() => zipInput.current?.click()}>
							ZIP of the resources folder…
						</Menu.Item>
						<Menu.Divider />
						<Menu.Item onClick={() => void importExample()}>Example app</Menu.Item>
					</Menu.Dropdown>
				</Menu>
				<Button
					id="logs-button"
					size="xs"
					variant={logsOpen ? "light" : "subtle"}
					color={logsOpen ? undefined : "gray"}
					aria-pressed={logsOpen}
					title="Logs (Ctrl+`)"
					onClick={() => setLogsOpen((open) => !open)}
					rightSection={
						errors > 0 && (
							<Badge id="error-count" size="xs" color="red" circle>
								{errors > 99 ? "99+" : errors}
							</Badge>
						)
					}
				>
					Logs
				</Button>
				<Button
					id="files-button"
					size="xs"
					variant="subtle"
					color="gray"
					disabled={!neutron || !app}
					onClick={() => setFilesQuery("")}
				>
					Files
				</Button>
				<Button
					id="settings-button"
					size="xs"
					variant="subtle"
					color="gray"
					disabled={!neutron}
					onClick={() => setSettingsOpen(true)}
				>
					Settings
				</Button>
			</header>
			{showTabs && neutron && (
				<WindowTabs
					windows={windows}
					onShow={(id) => neutron.showWindow(id)}
					onClose={(id) => neutron.closeWindow(id)}
				/>
			)}
			{settings.showAppMenu && menu.length > 0 && neutron && (
				<AppMenuBar items={menu} onClick={(id) => neutron.clickMenu(id)} />
			)}
			{contextMenu && neutron && (
				<ContextMenu menu={contextMenu} onClick={(id) => neutron.clickContextMenu(id)} />
			)}
			<div className="stage">
				<main id="desktop" ref={viewport} aria-label="Application viewport" />
				{!live && (
					<Home
						ready={ready}
						failure={failure}
						hasApps={apps.length > 0}
						onFolder={() => folderInput.current?.click()}
						onZip={() => zipInput.current?.click()}
						onExample={() => void importExample()}
					/>
				)}
				{live && !windows.length && state !== "failed" && (
					<StageNote
						busy
						title={
							state === "starting"
								? `Starting ${name}…`
								: `Waiting for ${name} to open a window…`
						}
					/>
				)}
				{state === "failed" && !windows.length && (
					<StageNote
						id="launch-notice"
						title={`${name} couldn’t start`}
						detail="The logs have the details."
					>
						<Button size="xs" variant="default" onClick={() => setLogsOpen(true)}>
							Show logs
						</Button>
						<Button size="xs" variant="default" onClick={() => void neutron?.stop()}>
							Close app
						</Button>
					</StageNote>
				)}
				{live && windows.length > 0 && !visible && (
					<StageNote
						id="no-window"
						title="No visible window"
						detail={
							hidden.length > 1
								? `${hidden.length} windows are open but hidden. Some apps keep their window hidden while they start.`
								: "The app’s window is open but hidden. Some apps keep their window hidden while they start."
						}
					>
						{hidden.at(-1) && (
							<Button
								id="no-window-show"
								size="xs"
								onClick={() => neutron?.showWindow(hidden.at(-1)?.id ?? 0)}
							>
								Show {windowLabel(hidden.at(-1) as AppWindow, windows)}
							</Button>
						)}
					</StageNote>
				)}
			</div>
			{logsOpen && neutron && (
				<LogPanel
					neutron={neutron}
					onClose={() => setLogsOpen(false)}
					onClear={() => setErrors(0)}
				/>
			)}
			<input
				ref={folderInput}
				id="folder-input"
				type="file"
				multiple
				hidden
				{...{ webkitdirectory: "" }}
				onChange={(event) => {
					const input = event.currentTarget;
					const files = [...(input.files || [])];
					input.value = "";
					if (files.length) void importApp({ files });
				}}
			/>
			<input
				ref={zipInput}
				id="zip-input"
				type="file"
				accept=".zip,application/zip"
				hidden
				onChange={(event) => {
					const input = event.currentTarget;
					const zip = input.files?.[0];
					input.value = "";
					if (zip) void importApp({ zip });
				}}
			/>
			<ImportProgress task={review ? undefined : task} />
			<ReviewDialog
				review={review?.review}
				onChoose={(choice) => {
					review?.resolve(choice);
					if (choice) setReview(undefined);
				}}
			/>
			<FilesDialog
				opened={filesQuery !== undefined && Boolean(app)}
				app={app}
				query={filesQuery ?? ""}
				load={loadFiles}
				onClose={() => setFilesQuery(undefined)}
			/>
			<SettingsDialog
				opened={settingsOpen}
				settings={settings}
				localRelay={localRelay}
				app={app}
				onClose={() => setSettingsOpen(false)}
				onSave={(next) => void saveSettings(next)}
				onRemove={(item) => void removeApp(item)}
			/>
			{dragging && (
				<div id="drop-overlay">
					<Text fw={600} size="lg">
						Drop to import
					</Text>
					<Text size="sm" c="dimmed">
						A resources folder, or a ZIP of it
					</Text>
				</div>
			)}
		</div>
	);
}
