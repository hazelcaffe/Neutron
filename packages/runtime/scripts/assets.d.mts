export declare const defaultAssetsDir: string;
/** Applies Neutron's checked integration patches to the pinned Scramjet v2 bundle. */
export declare function patchScramjet(source: string): string;
/** Builds /sw.js, /runtime/* and /vendor/* into `out` and resolves to that directory. */
export declare function buildAssets(out?: string): Promise<string>;
