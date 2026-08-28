"""Create and sign the immutable update manifest for a GitHub Release."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
PLATFORMS = {
    "darwin-arm64": "Service-Console-v{version}-macOS-arm64.zip",
    "windows-x86_64": "Service-Console-v{version}-Windows-x64.zip",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_private_key(value: str) -> Ed25519PrivateKey:
    try:
        encoded = base64.b64decode(value, validate=True)
        key = serialization.load_pem_private_key(encoded, password=None)
    except (ValueError, TypeError) as exc:
        raise SystemExit("UPDATE_PRIVATE_KEY_B64 is not a valid base64-encoded PEM key") from exc
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit("UPDATE_PRIVATE_KEY_B64 must contain an Ed25519 private key")
    return key


def _load_public_key(path: Path) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(path.read_bytes())
    if not isinstance(key, Ed25519PublicKey):
        raise SystemExit(f"{path} must contain an Ed25519 public key")
    return key


def create_manifest(
    *,
    version: str,
    repository: str,
    release_dir: Path,
    published_at: str,
) -> dict[str, object]:
    if VERSION_RE.fullmatch(version) is None:
        raise SystemExit(f"Version must use X.Y.Z format: {version!r}")
    if repository.count("/") != 1:
        raise SystemExit(f"Repository must use OWNER/NAME format: {repository!r}")

    tag = f"v{version}"
    platforms: dict[str, dict[str, object]] = {}
    for platform_key, template in PLATFORMS.items():
        filename = template.format(version=version)
        artifact = release_dir / filename
        if not artifact.is_file():
            raise SystemExit(f"Missing release artifact: {artifact}")
        platforms[platform_key] = {
            "filename": filename,
            "url": f"https://github.com/{repository}/releases/download/{tag}/{filename}",
            "sha256": _sha256(artifact),
            "size": artifact.stat().st_size,
        }

    return {
        "schema": 1,
        "version": version,
        "release_url": f"https://github.com/{repository}/releases/tag/{tag}",
        "published_at": published_at,
        "notes": "",
        "platforms": platforms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--release-dir", type=Path, default=Path("release"))
    parser.add_argument("--output", type=Path, default=Path("release/latest-update.json"))
    parser.add_argument(
        "--signature-output",
        type=Path,
        default=Path("release/latest-update.json.sig"),
    )
    parser.add_argument(
        "--public-key",
        type=Path,
        default=Path("src/service_console/update_public_key.pem"),
    )
    parser.add_argument("--published-at", default=datetime.now(UTC).isoformat())
    args = parser.parse_args()

    private_value = os.environ.get("UPDATE_PRIVATE_KEY_B64", "").strip()
    if not private_value:
        raise SystemExit("UPDATE_PRIVATE_KEY_B64 is required")
    private_key = _load_private_key(private_value)
    expected_public_key = _load_public_key(args.public_key)
    if private_key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    ) != expected_public_key.public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    ):
        raise SystemExit("The signing key does not match the public key embedded in the app")

    manifest = create_manifest(
        version=args.version,
        repository=args.repository,
        release_dir=args.release_dir,
        published_at=args.published_at,
    )
    payload = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    signature = private_key.sign(payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(payload)
    args.signature_output.write_bytes(base64.b64encode(signature) + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
