#!/usr/bin/env bash
# Builds dist/libsignal-client-<version>.wasm from source: Signal's libsignal
# Node bridge (libsignal-node) for wasm32-wasip1-threads, loaded by emnapi.
#
# Needs: git, curl, tar, patch, node + npm, rustup, cmake, ninja, protoc, and
# wasi-sdk 34 (set WASI_SDK to its directory). Set WORK_DIR to reuse a build tree.
set -euo pipefail

LIBSIGNAL_VERSION=0.106.2
EMNAPI_VERSION=1.11.3
here="$(cd "$(dirname "$0")" && pwd)"
work="${WORK_DIR:-$(mktemp -d)}"
: "${WASI_SDK:?Set WASI_SDK to a wasi-sdk 34 directory}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"
source="$work/libsignal"

# 1. libsignal at the release tag, plus Neutron's patches.
if [ ! -d "$source" ]; then
	git clone --quiet --depth 1 --branch "v$LIBSIGNAL_VERSION" https://github.com/signalapp/libsignal "$source"
	# Crates patched for WebAssembly, from their crates.io releases.
	for patch in "$here"/patches/crates/*.patch; do
		crate="$(basename "$patch" .patch)"
		name="${crate%-*}"
		version="${crate##*-}"
		mkdir -p "$source/neutron/crates"
		curl -fsSL "https://static.crates.io/crates/$name/$crate.crate" | tar -xz -C "$source/neutron/crates"
		patch --quiet -p1 -d "$source/neutron/crates/$crate" < "$patch"
	done
	git -C "$source" apply "$here/patches/libsignal.patch"
fi

# 2. emnapi's Node-API implementation (C part) for wasm32-wasip1-threads.
if [ ! -d "$work/emnapi" ]; then
	mkdir -p "$work/emnapi"
	(cd "$work/emnapi" && npm pack --silent "emnapi@$EMNAPI_VERSION" > /dev/null && tar -xzf "emnapi-$EMNAPI_VERSION.tgz")
fi
emnapi="$work/emnapi/package/lib/wasm32-wasip1-threads"

# 3. Cross-compile. BoringSSL is built without sockets or assembly; bindgen
#    needs default visibility to see its declarations.
cd "$source"
toolchain="$(cat rust-toolchain)"
rustup toolchain install --profile minimal "$toolchain" > /dev/null
rustup target add --toolchain "$toolchain" wasm32-wasip1-threads > /dev/null
T=wasm32_wasip1_threads
clang_include="$(ls -d "$WASI_SDK"/lib/clang/*/include | head -1)"
defines="-DOPENSSL_NO_SOCK -DOPENSSL_NO_ASM -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL"
export "CC_$T=$WASI_SDK/bin/clang" "CXX_$T=$WASI_SDK/bin/clang++"
export "AR_$T=$WASI_SDK/bin/llvm-ar" "RANLIB_$T=$WASI_SDK/bin/llvm-ranlib"
export "CFLAGS_$T=--target=wasm32-wasip1-threads -pthread $defines -D_WASI_EMULATED_PROCESS_CLOCKS"
export "CXXFLAGS_$T=--target=wasm32-wasip1-threads -pthread $defines"
export "CMAKE_TOOLCHAIN_FILE_$T=$WASI_SDK/share/cmake/wasi-sdk-pthread.cmake"
export WASI_SDK_PREFIX="$WASI_SDK" CMAKE_GENERATOR=Ninja LIBCLANG_PATH="$WASI_SDK/lib"
export "BINDGEN_EXTRA_CLANG_ARGS_$T=--target=wasm32-wasip1-threads --sysroot=$WASI_SDK/share/wasi-sysroot -fvisibility=default -DBORINGSSL_SHARED_LIBRARY -DBORINGSSL_IMPLEMENTATION -DOPENSSL_NO_SOCK -DOPENSSL_NO_ASM -isystem $clang_include"
export CARGO_TARGET_DIR="$work/target"
link=(
	-L"$emnapi" -lemnapi-mt
	-L"$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasip1-threads/noeh" -lc++ -lc++abi
	--import-undefined --export-table --export=malloc --export=free
	--export-if-defined=emnapi_thread_crashed
	--export-if-defined=node_api_module_get_api_version_v1
	--max-memory=4294967296 -zstack-size=8388608
)
RUSTFLAGS="--cfg tokio_unstable --cfg getrandom_backend=\"wasi_p1\""
RUSTFLAGS+=" --remap-path-prefix=$work=/build --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
for arg in "${link[@]}"; do RUSTFLAGS+=" -C link-arg=$arg"; done
export RUSTFLAGS
# As upstream's release builds (node/build_node_bridge.py).
export CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_LTO=fat CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
cargo build --locked --release --target wasm32-wasip1-threads -p libsignal-node \
	--features log/release_max_level_info

# 4. Browsers trap on memory.atomic.wait in a page's main thread; route waits
#    through imports the embedder implements (see wasm-waits/src/main.rs).
CARGO_TARGET_DIR="$work/wasm-waits" RUSTFLAGS="" \
	cargo build --quiet --release --manifest-path "$here/wasm-waits/Cargo.toml"
mkdir -p "$here/dist"
output="$here/dist/libsignal-client-$LIBSIGNAL_VERSION.wasm"
"$work/wasm-waits/release/neutron-wasm-waits" \
	"$CARGO_TARGET_DIR/wasm32-wasip1-threads/release/signal_node.wasm" "$output"
sha256sum "$output"
