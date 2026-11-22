#!/usr/bin/env bash
# Rebuilds libcurl.js, libcurl.mjs and libcurl.wasm in this directory from
# upstream libcurl.js 0.7.5 plus patches/*.patch.
#
# Needs: emsdk with emscripten 3.1.6 activated (upstream's JS patches target
# that output), git, make, cmake, autoconf, automake, libtool, pkg-config,
# python3 with jinja2 (mbedtls code generation), jq and wget.
set -euo pipefail

UPSTREAM=https://github.com/ading2210/libcurl.js
COMMIT=ce8db2a544c790ee2c2f3efbac5976d05427d093 # "update versions of dependencies and ca cert" (0.7.5)
here="$(cd "$(dirname "$0")" && pwd)"
work="${WORK_DIR:-$(mktemp -d)}"

emcc --version | head -1 | grep -q " 3\.1\.6 " || {
	echo "emscripten 3.1.6 is required (emsdk install 3.1.6 && emsdk activate 3.1.6)" >&2
	exit 1
}

if [ ! -d "$work/libcurl.js" ]; then
	git clone --quiet "$UPSTREAM" "$work/libcurl.js"
fi
cd "$work/libcurl.js"
git checkout --quiet --force "$COMMIT"
git submodule update --quiet --init client/wisp_client
for patch in "$here"/patches/*.patch; do
	git apply "$patch"
done

cd client
./build.sh release
cp out/libcurl.js out/libcurl.mjs out/libcurl.wasm "$here/"
echo "Built libcurl.js into $here"
