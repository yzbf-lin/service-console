#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT_DIR/assets/service-console-icon-1024.png}"
OUTPUT="${2:-$ROOT_DIR/assets/macos/ServiceConsole.icns}"

if [[ ! -f "$SOURCE" ]]; then
  printf '%s\n' "Icon source not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
uv run --locked --group icon python "$ROOT_DIR/scripts/build_macos_icon.py" "$SOURCE" "$OUTPUT"
