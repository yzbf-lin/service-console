#!/usr/bin/env python3
"""Build a multi-resolution Windows ICO file from the project icon master."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


ICON_SIZES = [
    (16, 16),
    (24, 24),
    (32, 32),
    (48, 48),
    (64, 64),
    (128, 128),
    (256, 256),
]


def build_icon(source: Path, output: Path) -> None:
    with Image.open(source) as original:
        if original.width != original.height or original.width < 256:
            raise ValueError("icon source must be a square image of at least 256×256 pixels")
        image = original.convert("RGBA")
        output.parent.mkdir(parents=True, exist_ok=True)
        image.save(output, format="ICO", sizes=ICON_SIZES)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_icon(args.source, args.output)
    print(f"Created: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
