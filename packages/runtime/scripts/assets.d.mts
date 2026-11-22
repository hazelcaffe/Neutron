export declare const defaultAssetsDir: string;
/** Builds /sw.js, /runtime/* and /vendor/* into `out` and resolves to that directory. */
export declare function buildAssets(out?: string): Promise<string>;
