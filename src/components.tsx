import { Alert, Button, CloseButton, Group, Loader, Menu, Stack, Text, Title } from "@mantine/core";
import type { AppWindow, LogEntry, MenuData, Neutron } from "@neutron/runtime";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

export function Home(props: {
	ready: boolean;
	failure?: string;
	hasApps: boolean;
	onFolder(): void;
	onZip(): void;
	onExample(): void;
}) {
	return (
		<div className="overlay" id="dropzone">
			<Stack gap="lg" maw={520}>
				<Stack gap={6}>
					<Title order={2}>Run an Electron app</Title>
					<Text c="dimmed">
						Import an installed app’s <code>resources</code> folder, or a ZIP of it. The
						app runs in this tab and its files stay in this browser.
					</Text>
				</Stack>
				{props.failure ? (
					<Alert color="red" title="The runtime couldn’t start">
						<Text size="sm" className="pre">
							{props.failure}
						</Text>
					</Alert>
				) : (
					<Group gap="sm">
						<Button id="empty-folder" disabled={!props.ready} onClick={props.onFolder}>
							Open resources folder
						</Button>
						<Button
							id="empty-zip"
							variant="default"
							disabled={!props.ready}
							onClick={props.onZip}
						>
							Open ZIP
						</Button>
						<Button
							id="demo-button"
							variant="subtle"
							disabled={!props.ready}
							onClick={props.onExample}
						>
							Try the example app
						</Button>
					</Group>
				)}
				<Text size="xs" c="dimmed" className="where">
					{props.hasApps
						? "Pick an imported app at the top and press Run, or drop another folder or ZIP here."
						: "You can also drop the folder or ZIP here."}
					<br />
					Windows: <code>%LOCALAPPDATA%\Programs\&lt;App&gt;\resources</code>
					<br />
					macOS: <code>/Applications/&lt;App&gt;.app/Contents/Resources</code>
					<br />
					Linux: <code>/opt/&lt;App&gt;/resources</code>
				</Text>
			</Stack>
		</div>
	);
}

/** Shown over the viewport while the running app has nothing on screen. */
export function StageNote(props: {
	id?: string;
	busy?: boolean;
	title: string;
	detail?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="overlay" id={props.id} aria-live="polite">
			<Stack align="center" gap="xs" maw={520} ta="center">
				{props.busy && <Loader size="sm" />}
				<Text fw={600}>{props.title}</Text>
				{props.detail && (
					<Text size="sm" c="dimmed" className="pre">
						{props.detail}
					</Text>
				)}
				{props.children && <Group mt="xs">{props.children}</Group>}
			</Stack>
		</div>
	);
}

export function windowLabel(item: AppWindow, all: readonly AppWindow[]): string {
	return all.some((other) => other.id !== item.id && other.title === item.title)
		? `${item.title} (${item.id})`
		: item.title;
}
function windowState(item: AppWindow): string {
	if (item.loading === "failed") return "failed";
	if (item.loading === "loading" || item.loading === "dom-ready") return "loading";
	if (item.active) return "active";
	return item.visible ? "background" : "hidden";
}

export function WindowTabs(props: {
	windows: readonly AppWindow[];
	onShow(id: number): void;
	onClose(id: number): void;
}) {
	const { windows } = props;
	const active = windows.find((item) => item.active);
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")];
		const index = tabs.indexOf(event.target as HTMLButtonElement);
		if (index < 0) return;
		const next = {
			ArrowRight: (index + 1) % tabs.length,
			ArrowLeft: (index - 1 + tabs.length) % tabs.length,
			Home: 0,
			End: tabs.length - 1,
		}[event.key];
		if (event.key === "Delete") {
			const id = Number(
				tabs[index]?.closest<HTMLElement>("[data-window-id]")?.dataset.windowId,
			);
			if (id) props.onClose(id);
		}
		if (next === undefined) return;
		event.preventDefault();
		tabs[next]?.focus();
	};
	return (
		<nav id="window-tabs" className="tabs" aria-label="App windows">
			<div id="window-tablist" role="tablist" aria-label="App windows" onKeyDown={keys}>
				{windows.map((item) => {
					const label = windowLabel(item, windows);
					return (
						<div
							key={item.id}
							className="window-tab"
							role="presentation"
							data-window-id={item.id}
							data-state={windowState(item)}
						>
							<button
								type="button"
								role="tab"
								className="window-tab-select"
								aria-selected={item.active}
								tabIndex={item.active || (!active && item === windows[0]) ? 0 : -1}
								aria-label={`${label}${item.visible ? "" : ", hidden"}`}
								title={`${label}\n${item.url}${item.error ? `\n${item.error}` : ""}`}
								onClick={() => props.onShow(item.id)}
								onAuxClick={(event) => event.button === 1 && props.onClose(item.id)}
							>
								<span className="window-tab-title">{label}</span>
								{!item.visible && <span className="window-tab-badge">hidden</span>}
							</button>
							<CloseButton
								className="window-tab-close"
								size="sm"
								tabIndex={-1}
								aria-label={`Close ${label}`}
								title="Close window"
								onClick={() => props.onClose(item.id)}
							/>
						</div>
					);
				})}
			</div>
		</nav>
	);
}

const menuLabel = (label: string) =>
	label.replace(/&(&|(?=\S))/g, (_match, escaped: string) => (escaped === "&" ? "&" : ""));

function MenuItems(props: { items: MenuData[]; onClick(id: string): void }) {
	return props.items
		.filter((item) => item.visible)
		.map((item, index) => {
			const key = `${item.id}:${index}`;
			if (item.type === "separator") return <Menu.Divider key={key} />;
			if (item.submenu)
				return (
					<Menu.Sub key={key}>
						<Menu.Sub.Target>
							<Menu.Sub.Item disabled={!item.enabled}>
								{menuLabel(item.label)}
							</Menu.Sub.Item>
						</Menu.Sub.Target>
						<Menu.Sub.Dropdown>
							<MenuItems items={item.submenu} onClick={props.onClick} />
						</Menu.Sub.Dropdown>
					</Menu.Sub>
				);
			return (
				<Menu.Item
					key={key}
					disabled={!item.enabled}
					leftSection={<span className="check">{item.checked ? "✓" : ""}</span>}
					onClick={() => props.onClick(item.id)}
				>
					{menuLabel(item.label)}
				</Menu.Item>
			);
		});
}

/** The app's own Electron menu bar, shown only when enabled in Settings. */
export function AppMenuBar(props: { items: readonly MenuData[]; onClick(id: string): void }) {
	const [open, setOpen] = useState<string | null>(null);
	useEffect(() => {
		// Clicks inside an app iframe never reach this document; they blur it.
		const close = () => setOpen(null);
		addEventListener("blur", close);
		return () => removeEventListener("blur", close);
	}, []);
	return (
		<nav id="application-menu" className="menu-row" aria-label="Application menu">
			{props.items
				.filter((item) => item.visible)
				.map((item, index) => {
					const key = `${item.id}:${index}`;
					if (!item.submenu)
						return (
							<Button
								key={key}
								variant="subtle"
								color="gray"
								size="compact-sm"
								disabled={!item.enabled}
								onClick={() => props.onClick(item.id)}
							>
								{menuLabel(item.label)}
							</Button>
						);
					return (
						<Menu
							key={key}
							opened={open === key}
							onChange={(opened) => setOpen(opened ? key : null)}
							position="bottom-start"
							offset={2}
							shadow="md"
							width={240}
						>
							<Menu.Target>
								<Button variant="subtle" color="gray" size="compact-sm">
									{menuLabel(item.label)}
								</Button>
							</Menu.Target>
							<Menu.Dropdown>
								<MenuItems
									items={item.submenu}
									onClick={(id) => {
										setOpen(null);
										props.onClick(id);
									}}
								/>
							</Menu.Dropdown>
						</Menu>
					);
				})}
		</nav>
	);
}

const time = (value: number) => new Date(value).toLocaleTimeString([], { hour12: false });

export function LogPanel(props: { neutron: Neutron; onClose(): void; onClear(): void }) {
	const { neutron } = props;
	const [entries, setEntries] = useState<readonly LogEntry[]>(() => neutron.logs);
	const output = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	useEffect(() => {
		let frame = 0;
		setEntries(neutron.logs);
		const off = neutron.on("log", () => {
			frame ||= requestAnimationFrame(() => {
				frame = 0;
				setEntries(neutron.logs);
			});
		});
		return () => {
			off();
			cancelAnimationFrame(frame);
		};
	}, [neutron]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Scroll after each new batch of entries.
	useLayoutEffect(() => {
		if (output.current && follow.current)
			output.current.scrollTop = output.current.scrollHeight;
	}, [entries]);
	return (
		<section className="logs" aria-label="Logs">
			<Group className="logs-head" gap="xs">
				<Text size="sm" fw={600}>
					Logs
				</Text>
				<Text size="xs" c="dimmed">
					{entries.length.toLocaleString()} entries
				</Text>
				<div className="grow" />
				<Button
					size="compact-xs"
					variant="subtle"
					color="gray"
					onClick={() => {
						neutron.clearLogs();
						setEntries([]);
						props.onClear();
					}}
				>
					Clear
				</Button>
				<CloseButton size="sm" aria-label="Close logs" onClick={props.onClose} />
			</Group>
			<div
				id="console-output"
				role="log"
				aria-label="Runtime output"
				ref={output}
				onScroll={(event) => {
					const element = event.currentTarget;
					follow.current =
						element.scrollHeight - element.scrollTop - element.clientHeight < 40;
				}}
			>
				{entries.length ? (
					entries.map((entry, index) => (
						// Entries are append-only between clears; the index is stable enough.
						// biome-ignore lint/suspicious/noArrayIndexKey: See above.
						<div key={index} className={`log ${entry.level}`}>
							<time>{time(entry.time)}</time>
							<span className="source">{entry.source}</span>
							<pre>{entry.message}</pre>
						</div>
					))
				) : (
					<Text size="sm" c="dimmed" p="sm">
						Output from the runtime and the app appears here.
					</Text>
				)}
			</div>
		</section>
	);
}
