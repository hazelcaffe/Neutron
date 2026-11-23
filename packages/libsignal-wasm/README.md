# libsignal for WebAssembly

Signal Desktop does its cryptography and its connections to Signal's servers in
[libsignal](https://github.com/signalapp/libsignal), a Rust library loaded as the
native addon `@signalapp+libsignal-client.node`. A browser can't load a native
addon, so this package builds the same addon from libsignal's source for
`wasm32-wasip1-threads`. Neutron loads it with [emnapi](https://github.com/toyobayashi/emnapi),
a Node-API implementation for WebAssembly.

The result is libsignal's own code with its own JavaScript bindings, at the exact
version Signal ships (0.106.2 for Signal Desktop 8.36). It is not a reimplementation
or a stub. Certificate pinning and every protocol check are unchanged.

## How Neutron uses it

- `packages/runtime/src/shared/wasm-addons.ts` maps the addon file and its
  package version to a bundled build. Other versions get Neutron's usual
  native-addon fallback.
- `packages/runtime/src/runtime/napi-wasm.ts` instantiates the module.
  - Workers instantiate it on first `require()`.
  - A page's main thread can't instantiate a module this size synchronously. A
    renderer prepares it asynchronously before its preload runs, and the service
    worker holds the page's own scripts until then.
  - Each wasm thread runs in `runtime/napi-thread.js`.
  - Every thread reads the same monotonic clock (`performance.timeOrigin +
    performance.now()`). Each worker's own `performance.now()` counts from that
    worker's start, so timers set on one thread fired early or late on another.
- libsignal's networking (chat and provisioning connections) uses a TCP transport
  that Neutron provides over its Wisp relay. TLS still runs inside libsignal
  (BoringSSL).

## Patches

`patches/libsignal.patch` (against tag `v0.106.2`):

- `rust/net/infra/src/wasi_tcp.rs`: TCP streams whose sockets the embedder owns.
  It uses imports `neutron.tcp_connect/write/consumed/close`, exports
  `neutron_tcp_wake/release`, and a receive ring in shared memory.
- `tcp_ssl.rs` uses that stream on WASI. `interface_monitor.rs` reports no local
  interface, as a browser exposes none.
- `certs.rs` gives the platform verifier a crypto provider on WASI, as it does on
  Linux. On WebAssembly that verifier checks the bundled Mozilla roots with
  webpki; without a provider it rejected every certificate. Only the
  DNS-over-HTTPS lookups use it. Signal's own servers stay pinned to Signal's roots.
- `dns/custom_resolver.rs` waits for both the IPv4 and the IPv6 answer on WASI.
  There is no system resolver there to leave out IPv6 on hosts without it, and
  the relay may have no IPv6. An IPv6-only answer, taken when the IPv4 one came
  more than 100 ms later, left no working route.
- `bridge/shared/types/src/net/tokio.rs` builds the runtime without tokio's
  I/O driver on WASI. mio can't wake a thread blocked in `poll_oneoff`, so a
  worker parked there ignored wake-ups from other threads until its next timer.
  Sockets come from the transport above, which wakes tasks itself.
- `Cargo.toml` and `Cargo.lock` point the crates below at their patched copies.

`patches/crates/*.patch` (against the crates.io releases):

- **neon 1.1.1**
  - Imports Node-API from the wasm module `napi` and registers through
    `napi_register_wasm_v1`.
  - `_initialize` sets up wasi-libc's main thread, then runs static constructors once.
  - Buffers are ordinary JS buffers. Bytes Rust writes are copied back with
    `emnapi_sync_memory` before control returns to JavaScript.
- **linkme 0.3.36**: wasm linkers have no section start/stop symbols, so
  distributed slices register their elements from `.init_array` constructors.
- **tokio 1.54.1**: parks idle workers on a condvar on WASI. Stable rustc doesn't
  report `target_feature = "atomics"` even on wasm32-wasip1-threads, so tokio
  assumed it had no threads and slept for the full timeout. Every cancellation,
  JavaScript callback and network wake-up then waited for the next timer, up to
  90 seconds.
- **tokio-socks 0.5.3, tokio-tungstenite 0.29.0**: their connect-by-address
  helpers return `Unsupported` on WASI. libsignal never calls them; it connects
  through its own transport.

`wasm-waits/` rewrites the output's `memory.atomic.wait` instructions as calls to
`neutron.wait32/wait64`. Browsers trap on the instruction in a page's main thread,
so Neutron blocks there by polling and uses `Atomics.wait` elsewhere.

## Building

```sh
WASI_SDK=/path/to/wasi-sdk-34.0 ./build.sh   # writes dist/libsignal-client-0.106.2.wasm
```

`build.sh` lists the tools it needs. It compiles release builds like upstream's
(fat LTO, one codegen unit).

`pnpm build` and `pnpm dev` use `dist/` when it exists. Otherwise `fetch.mjs`
downloads the published build named in `release.json` and verifies its SHA-256.
Set `NEUTRON_SKIP_LIBSIGNAL_WASM=1` to skip the download; Signal then falls back
as before.

## License

AGPL-3.0-only, the same as libsignal and Neutron. The patches and `wasm-waits`
are offered under the same license.
