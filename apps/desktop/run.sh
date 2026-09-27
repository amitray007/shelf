#!/bin/sh
set -eu
printf "%s\n" "Shelf Desktop: experimental beta. Development experiments only. Do not use for daily work or production." >&2
app_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_build="$app_root/.build/shelf-desktop"
mode=${1:-build}
case "$mode" in
  build|dev|bundle) ;;
  install) exec python3 "$app_root/install.py" ;;
  *) echo 'Usage: ./run.sh [build|bundle|install]' >&2; exit 2 ;;
esac
if [ ! -f "$app_build/build.zig.zon" ]; then
  mkdir -p "$app_root/.build"
  npx --yes @native-sdk/cli@0.10.1 init "$app_build" --template zig-core --full
fi
cp "$app_root"/src/* "$app_build/src/"
cp "$app_root/app.json" "$app_root/build.zig" "$app_build/"
mkdir -p "$app_build/assets"
python3 "$app_root/icon.py" "$app_build/assets/icon.png"
npx --yes @native-sdk/cli@0.10.1 build "$app_build" --yes
(
  cd "$app_build"
  npx --yes @native-sdk/cli@0.10.1 package --target macos \
    --output "$app_root/.build/Shelf.app" --binary "$app_build/zig-out/bin/shelf-desktop" \
    --web-layer exclude --signing adhoc
)
if [ "$mode" != bundle ]; then exec python3 "$app_root/install.py"; fi
