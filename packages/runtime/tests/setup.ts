// The runtime bundles inject a `process` with the guest's identity (uid and
// gid 1000; see polyfills.js in scripts/assets.mjs). memfs checks some
// permissions against that global, so tests use the same identity rather
// than the account running them.
Object.assign(process, { getuid: () => 1000, getgid: () => 1000 });
