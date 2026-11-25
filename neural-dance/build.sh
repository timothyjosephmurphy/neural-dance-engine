#!/bin/sh
# Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
# SPDX-License-Identifier: MIT

# Rebuild neural-dance/neural-dance.wasm from the C++ mural runtime.
# Requires clang with the wasm32 target and lld (wasm-ld). The site ships the
# committed wasm so a normal page build does not need this toolchain.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
out=${1:-"$root/neural-dance/neural-dance.wasm"}
if ! command -v clang++ >/dev/null 2>&1 && [ -n "${ZIG:-}" ]; then
  # No system clang: zig's bundled clang + wasm-ld (e.g. ZIG="python3 -m ziglang").
  obj=$(mktemp)
  $ZIG c++ -target wasm32-freestanding -std=c++17 -O2 -nostdlib -ffreestanding \
    -fno-exceptions -fno-rtti -fno-threadsafe-statics \
    -Wall -Wextra -Wno-unused-function -c -o "$obj" "$root/neural-dance/src/neural_dance.cpp"
  $ZIG wasm-ld --no-entry --export-all --no-gc-sections --export-memory --strip-all \
    -z stack-size=16384 --initial-memory=131072 -o "$out" "$obj"
  rm -f "$obj"
  exit 0
fi
clang++ --target=wasm32-unknown-unknown -std=c++17 -O2 -nostdlib -ffreestanding \
  -fno-exceptions -fno-rtti -fno-threadsafe-statics \
  -Wall -Wextra -Wno-unused-function \
  -Wl,--no-entry \
  -Wl,--export-all \
  -Wl,--no-gc-sections \
  -Wl,--export-memory \
  -Wl,-z,stack-size=16384 \
  -Wl,--initial-memory=131072 \
  -o "$out" \
  "$root/neural-dance/src/neural_dance.cpp"
