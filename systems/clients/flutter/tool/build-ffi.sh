#!/bin/sh
# Build libgzero_ffi.so (the automerge C ABI) for Android and drop it in
# jniLibs. Requires cargo with the aarch64-linux-android target and the
# Android NDK ($ANDROID_HOME/ndk/<ver> or ANDROID_NDK_HOME).
#
#   systems/clients/flutter/tool/build-ffi.sh
set -e
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$root/systems/crates/gzero-ffi"

ndk="${ANDROID_NDK_HOME:-$(ls -d "${ANDROID_HOME:-$HOME/projects/android/Android/Sdk}"/ndk/* 2>/dev/null | tail -1)}"
[ -d "$ndk" ] || { echo "NDK not found (set ANDROID_NDK_HOME)" >&2; exit 1; }
toolchain="$ndk/toolchains/llvm/prebuilt/linux-x86_64"
api=24

mkdir -p .cargo
cat > .cargo/config.toml <<EOF
[target.aarch64-linux-android]
linker = "$toolchain/bin/aarch64-linux-android$api-clang"
EOF

echo "building aarch64-linux-android..."
cargo build --release --target aarch64-linux-android

out="$root/systems/clients/flutter/android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$out"
"$toolchain/bin/llvm-strip" -o "$out/libgzero_ffi.so" \
  $root/target/aarch64-linux-android/release/libgzero_ffi.so
ls -la "$out/libgzero_ffi.so"
echo "done — rebuilt after any gzero-ffi change."
