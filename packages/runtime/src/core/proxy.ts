import { runtimePath, scramjetPrefix } from "../shared/base";
import type { InstalledApp } from "../shared/types";
import { requestRuntimeWorker } from "./runtime-worker";

export interface ProxySession {
	id: string;
	runId?: string;
	partition?: string;
	schemes?: string[];
	/** URL patterns of the partition's `webRequest.onHeadersReceived` listener. */
	headerFilters?: string[];
	browser?: boolean;
	appId: string;
	wisp: string;
}
export class PageProxy {
	private session?: ProxySession;
	private browser?: { session: ProxySession; ready: Promise<void> };
	private partitions = new Map<string, { session: ProxySession; ready: Promise<void> }>();
	private xhr?: Worker;
	close(): void {
		this.xhr?.terminate();
		this.xhr = undefined;
		this.session = undefined;
		this.browser = undefined;
		this.partitions.clear();
	}
	syncXHR(request: { url: string }): void {
		const url = new URL(request.url);
		if (
			!this.xhr ||
			!this.session ||
			url.origin !== location.origin ||
			![...this.partitions.values(), ...(this.browser ? [this.browser] : [])].some((entry) =>
				url.pathname.startsWith(scramjetPrefix(entry.session.id)),
			)
		)
			throw new Error("Invalid or expired sync XHR session");
		this.xhr.postMessage(request);
	}
	private publish(session: ProxySession): Promise<void> {
		return requestRuntimeWorker({ type: "proxy-configure", session });
	}
	private partition(partition: string) {
		if (!this.session) throw new Error("No running application proxy session");
		let entry = this.partitions.get(partition);
		if (!entry) {
			const session: ProxySession = {
				...this.session,
				partition,
				runId: this.session.id,
				id: partition === "default" ? this.session.id : crypto.randomUUID(),
				schemes: [],
			};
			entry = { session, ready: this.publish(session) };
			this.partitions.set(partition, entry);
		}
		return entry;
	}
	setSchemes(partition: string, schemes: string[]): Promise<void> {
		return this.update(partition, { schemes: [...schemes] });
	}
	setHeaderFilters(partition: string, patterns: string[]): Promise<void> {
		return this.update(partition, { headerFilters: [...patterns] });
	}
	private update(partition: string, change: Partial<ProxySession>): Promise<void> {
		const entry = this.partition(partition);
		entry.session = { ...entry.session, ...change };
		const session = entry.session;
		entry.ready = entry.ready.then(() => this.publish(session));
		return entry.ready;
	}
	async ready(partition: string): Promise<ProxySession> {
		const entry = this.partition(partition);
		await entry.ready;
		return entry.session;
	}
	async configure(wisp: string, instanceId?: string, app?: InstalledApp): Promise<void> {
		if (!instanceId || !app) return;
		this.session = { id: instanceId, appId: app.id, wisp };
		await this.ready("default");
		if (crossOriginIsolated) {
			const worker = new Worker(runtimePath("runtime/xhr-worker.js"), {
				name: "neutron-sync-xhr",
			});
			this.xhr = worker;
			await new Promise<void>((resolve, reject) => {
				const finish = (error?: Error) => {
					clearTimeout(timer);
					worker.onmessage = null;
					worker.onerror = null;
					if (error) {
						worker.terminate();
						reject(error);
					} else resolve();
				};
				const timer = setTimeout(
					() => finish(new Error("Sync XHR transport did not start")),
					10000,
				);
				worker.onmessage = () => finish();
				worker.onerror = (event) => finish(new Error(event.message));
			});
		}
	}
	/** System-browser links get a web-only session, not the calling app's
	 * protocol handlers, preload scripts, Node globals or Electron user agent. */
	async browserSession(): Promise<ProxySession> {
		if (!this.session) throw new Error("No running application");
		if (!this.browser) {
			const session = {
				...this.session,
				id: crypto.randomUUID(),
				runId: this.session.id,
				browser: true,
			};
			this.browser = { session, ready: this.publish(session) };
		}
		const entry = this.browser;
		try {
			await entry.ready;
		} catch (error) {
			if (this.browser === entry) this.browser = undefined;
			throw error;
		}
		if (this.browser !== entry) throw new Error("Application stopped");
		return entry.session;
	}
	encode(url: string, partition = "default"): string {
		if (!this.session) throw new Error("No running application proxy session");
		return encodeProxyURL(this.partition(partition).session, url);
	}
}
export function encodeProxyURL(session: ProxySession, value: string): string {
	const target = new URL(value),
		hash = target.hash;
	target.hash = "";
	return `${scramjetPrefix(session.id)}${encodeURIComponent(target.href)}${hash}`;
}
