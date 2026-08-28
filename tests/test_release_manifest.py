from __future__ import annotations

import base64
import json
import runpy
import sys
import tomllib
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from service_console import __version__

SCRIPT = runpy.run_path(str(Path(__file__).parents[1] / "scripts/create_update_manifest.py"))
PLATFORMS = SCRIPT["PLATFORMS"]
create_manifest = SCRIPT["create_manifest"]
main = SCRIPT["main"]


def test_runtime_version_matches_project_metadata() -> None:
    project = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())

    assert __version__ == project["project"]["version"]


def _write_artifacts(release_dir, version: str = "1.2.3") -> None:
    release_dir.mkdir()
    for template in PLATFORMS.values():
        (release_dir / template.format(version=version)).write_bytes(b"fixture-package")


def test_create_manifest_binds_platform_artifacts_to_release(tmp_path) -> None:
    release_dir = tmp_path / "release"
    _write_artifacts(release_dir)

    manifest = create_manifest(
        version="1.2.3",
        repository="owner/service-console",
        release_dir=release_dir,
        published_at="2026-08-28T00:00:00Z",
    )

    assert manifest["schema"] == 1
    assert manifest["version"] == "1.2.3"
    platforms = manifest["platforms"]
    assert isinstance(platforms, dict)
    assert set(platforms) == {"darwin-arm64", "windows-x86_64"}
    macos = platforms["darwin-arm64"]
    assert macos["size"] == len(b"fixture-package")
    assert len(str(macos["sha256"])) == 64
    assert str(macos["url"]).endswith("/Service-Console-v1.2.3-macOS-arm64.zip")


def test_manifest_cli_signs_exact_payload(monkeypatch, tmp_path) -> None:
    release_dir = tmp_path / "release"
    _write_artifacts(release_dir)
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(
        private_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    output = release_dir / "latest-update.json"
    signature_output = release_dir / "latest-update.json.sig"
    monkeypatch.setenv("UPDATE_PRIVATE_KEY_B64", base64.b64encode(private_pem).decode())
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "create_update_manifest.py",
            "--version",
            "1.2.3",
            "--repository",
            "owner/service-console",
            "--release-dir",
            str(release_dir),
            "--output",
            str(output),
            "--signature-output",
            str(signature_output),
            "--public-key",
            str(public_path),
            "--published-at",
            "2026-08-28T00:00:00Z",
        ],
    )

    assert main() == 0
    payload = output.read_bytes()
    private_key.public_key().verify(base64.b64decode(signature_output.read_bytes()), payload)
    assert json.loads(payload)["version"] == "1.2.3"


def test_create_manifest_rejects_missing_platform_artifact(tmp_path) -> None:
    release_dir = tmp_path / "release"
    release_dir.mkdir()

    with pytest.raises(SystemExit, match="Missing release artifact"):
        create_manifest(
            version="1.2.3",
            repository="owner/service-console",
            release_dir=release_dir,
            published_at="2026-08-28T00:00:00Z",
        )


@pytest.mark.parametrize("version", ["v1.2.3", "01.2.3", "1.2", "1.2.3-beta.1"])
def test_create_manifest_rejects_non_stable_versions(tmp_path, version: str) -> None:
    with pytest.raises(SystemExit, match="X.Y.Z"):
        create_manifest(
            version=version,
            repository="owner/service-console",
            release_dir=tmp_path,
            published_at="2026-08-28T00:00:00Z",
        )
