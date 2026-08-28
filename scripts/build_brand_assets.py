#!/usr/bin/env python3
"""Generate consistent product logo assets from the transparent source mark."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "assets" / "service-console-logo.png"


def normalized_mark(source: Image.Image, size: int, padding: float) -> Image.Image:
    """Crop transparent margins, preserve aspect ratio, and center the mark."""
    image = source.convert("RGBA")
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("logo source has no visible pixels")

    cropped = image.crop(bbox)
    content_size = round(size * (1 - (padding * 2)))
    scale = min(content_size / cropped.width, content_size / cropped.height)
    resized = cropped.resize(
        (max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))),
        Image.Resampling.LANCZOS,
    )

    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.alpha_composite(
        resized,
        ((size - resized.width) // 2, (size - resized.height) // 2),
    )
    return result


def build_assets(source_path: Path) -> None:
    with Image.open(source_path) as source:
        source.load()

        # The top bar already supplies a light tile, so retain a transparent mark.
        web_logo = normalized_mark(source, 256, padding=0.08)

        # Desktop shells and browser tabs may be dark. A neutral plate keeps the
        # supplied dark mark readable without changing its shape or colours.
        icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        draw = ImageDraw.Draw(icon)
        draw.rounded_rectangle(
            (32, 32, 992, 992),
            radius=224,
            fill=(247, 248, 250, 255),
            outline=(214, 219, 226, 255),
            width=12,
        )
        icon.alpha_composite(normalized_mark(source, 1024, padding=0.17))

    outputs = {
        ROOT / "assets" / "service-console-icon-1024.png": icon,
        ROOT / "docs" / "assets" / "service-console-icon.png": icon.resize(
            (512, 512), Image.Resampling.LANCZOS
        ),
        ROOT / "web" / "public" / "service-console-logo.png": web_logo,
        ROOT / "web" / "public" / "favicon.png": icon.resize(
            (256, 256), Image.Resampling.LANCZOS
        ),
    }
    for path, image in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, format="PNG", optimize=True)
        print(f"Created: {path.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, nargs="?", default=DEFAULT_SOURCE)
    args = parser.parse_args()
    build_assets(args.source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
