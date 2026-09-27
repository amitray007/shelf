#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
zig="${SHELF_ZIG:-$HOME/.native/toolchains/zig-0.16.0/zig}"
"$zig" test "$root/src/session.zig"
test_dir="$(mktemp -d -t shelf-desktop-storage)"
trap 'rm -rf "$test_dir"' EXIT
xcrun clang -fobjc-arc -framework Foundation "$root/test/storage.m" "$root/src/storage.m" -o "$test_dir/storage-check"
SHELF_DESKTOP_DATA_DIR="$test_dir/session" "$test_dir/storage-check"

xcrun clang -Wall -Wextra -Werror -fobjc-arc -fmodules -framework Foundation -lsqlite3 -I"$root/src" "$root/test/link_cache.m" "$root/src/link_cache.m" -o "$test_dir/cache-check"
"$test_dir/cache-check"
