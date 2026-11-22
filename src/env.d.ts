/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Default Wisp relay for builds without a local development relay. */
	readonly VITE_NEUTRON_RELAY?: string;
}
