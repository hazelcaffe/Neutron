# libcurl.js (Neutron build)

[libcurl.js](https://github.com/ading2210/libcurl.js) 0.7.5, rebuilt with one addition:
a request can replace the default trusted roots, like Node's `ca` option.

Neutron implements Node's `https` and `tls` with libcurl.js. Apps such as Signal
Desktop pass their own certificate authority for their servers
(`https.request({ ca })`, `new https.Agent({ ca })`, `tls.connect({ ca })`). Upstream
libcurl.js always verifies against its built-in Mozilla bundle, so those requests
failed with curl error 60.

## The change

[`patches/request-cainfo.patch`](patches/request-cainfo.patch):

- `request_set_cainfo(handle, pem)` sets `CURLOPT_CAINFO_BLOB` (copied) on one request.
  Certificate verification stays on; only the trusted roots change, as in Node.
- `HTTPSession.fetch` accepts `_libcurl_cainfo: "<PEM>"` in its options.
- `new TLSSocket(host, port, { cainfo: "<PEM>" })`.

Everything else matches the published 0.7.5 (same sources, dependencies and
`wisp_client` revision). The CA bundle is downloaded from curl.se at build time.

## Rebuilding

```sh
emsdk install 3.1.6 && emsdk activate 3.1.6 && source emsdk_env.sh
./build.sh   # writes libcurl.js, libcurl.mjs and libcurl.wasm here
```

See `build.sh` for the required tools.

## License

LGPL-3.0-or-later, the same as upstream (see [LICENSE](LICENSE)). The patch is
offered under the same license.
