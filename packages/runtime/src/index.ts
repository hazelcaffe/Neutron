/**
 * @neutron/runtime — runs unmodified Electron apps in the browser.
 *
 * ```ts
 * import { Neutron } from "@neutron/runtime";
 *
 * const neutron = await Neutron.create({ viewport: document.querySelector("#viewport")! });
 * neutron.on("state", (state) => console.log(state));
 * const app = await neutron.importApp({ zip: file });
 * await neutron.start(app, { relay: await Neutron.localRelay() });
 * ```
 */

export { createAsar } from "./core/asar";
export { capabilities, capability } from "./core/compatibility";
export type { AppWindow, ContextMenuData, DeviceRequest, MenuData } from "./core/host";
export {
	type ImportCandidate,
	type ImportChoice,
	type ImportFile,
	type ImportOptions,
	type ImportReview,
	type ImportSource,
	importSourceFromDrop,
	Neutron,
	type NeutronEvents,
	type NeutronOptions,
	type Platform,
	type RuntimeState,
	type StartOptions,
} from "./neutron";
export {
	applicationEntry,
	type Capability,
	errorText,
	type Finding,
	type InstalledApp,
	type LogEntry,
	type RuntimeSettings,
	type Snapshot,
	type Support,
} from "./shared/types";
