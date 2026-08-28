#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' "The macOS application bundle must be built on macOS." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf '%s\n' "pnpm is required to build the local Next.js application." >&2
  exit 1
fi

ICON_PATH="$ROOT_DIR/assets/macos/ServiceConsole.icns"
APP_PATH="$ROOT_DIR/dist/Service Console.app"
VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$ROOT_DIR/pyproject.toml" | head -n 1)"
if [[ -z "$VERSION" ]]; then
  printf '%s\n' "Unable to read the project version from pyproject.toml." >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm run build:web-assets
uv sync --group icon
"$ROOT_DIR/scripts/build-macos-icon.sh"
uv sync --group desktop
uv run --group desktop pyinstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name "Service Console" \
  --osx-bundle-identifier "dev.service-console.desktop" \
  --icon "$ICON_PATH" \
  --paths "$ROOT_DIR/src" \
  --collect-data service_console \
  --collect-all webview \
  --hidden-import webview.platforms.cocoa \
  "$ROOT_DIR/src/service_console/desktop.py"

plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_PATH/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP_PATH/Contents/Info.plist"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"

printf '\nCreated: %s (version %s)\n' "$APP_PATH" "$VERSION"
