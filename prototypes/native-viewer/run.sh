#!/bin/sh
# Disposable SDK feasibility check. All generated files stay under .build.
set -eu
viewer_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
viewer_build="$viewer_root/.build/shelf-native-feasibility"
viewer_mode=${1:-dev}
case "$viewer_mode" in
  dev|build) ;;
  *) echo 'Usage: ./run.sh [dev|build]' >&2; exit 2 ;;
esac
if [ ! -f "$viewer_build/build.zig.zon" ]; then
  mkdir -p "$viewer_root/.build"
  npx --yes @native-sdk/cli@0.10.1 init "$viewer_build" --template zig-core --full
fi
cp "$viewer_root/src/main.zig" "$viewer_build/src/main.zig"
cp "$viewer_root/app.json" "$viewer_build/app.json"
exec npx --yes @native-sdk/cli@0.10.1 "$viewer_mode" "$viewer_build" --yes
