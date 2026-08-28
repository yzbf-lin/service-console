from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import stat
import zipfile
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import service_console.update as update_module
from service_console.update import (
    InstalledApplication,
    PreparedUpdate,
    UpdateError,
    UpdateManager,
    detect_platform,
    extract_update_archive,
    parse_manifest,
    parse_semver,
    validate_zip_archive,
    verify_manifest_signature,
    verify_prepared_update,
)


def _macos_archive() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "Service Console/Service Console.app/Contents/MacOS/Service Console",
            b"desktop-binary",
        )
        archive.writestr("Service Console/README.md", b"release notes")
    return output.getvalue()


def _windows_archive() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("Service Console/Service Console.exe", b"desktop-binary")
        archive.writestr("Service Console/README.md", b"release notes")
    return output.getvalue()


def _signed_update(
    tmp_path: Path,
    package: bytes,
    *,
    platform_name: str = "darwin-arm64",
    sha256: str | None = None,
) -> tuple[bytes, bytes, Path, httpx.MockTransport]:
    filename = (
        "Service-Console-v0.2.0-macOS-arm64.zip"
        if platform_name == "darwin-arm64"
        else "Service-Console-v0.2.0-Windows-x64.zip"
    )
    package_url = f"https://updates.example/{filename}"
    manifest = json.dumps(
        {
            "schema": 1,
            "version": "0.2.0",
            "release_url": "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
            "published_at": "2026-08-28T12:00:00Z",
            "notes": "Signed updater",
            "platforms": {
                platform_name: {
                    "url": package_url,
                    "sha256": sha256 or hashlib.sha256(package).hexdigest(),
                    "size": len(package),
                    "filename": filename,
                }
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    private_key = Ed25519PrivateKey.generate()
    signature = base64.b64encode(private_key.sign(manifest)) + b"\n"
    public_key_path = tmp_path / "update-public-key.pem"
    public_key_path.write_bytes(
        private_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/latest-update.json":
            return httpx.Response(200, content=manifest)
        if request.url.path == "/latest-update.json.sig":
            return httpx.Response(200, content=signature)
        if str(request.url) == package_url:
            return httpx.Response(
                200,
                headers={"content-length": str(len(package))},
                content=package,
            )
        return httpx.Response(404)

    return manifest, signature, public_key_path, httpx.MockTransport(handler)


def _manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    package: bytes,
    *,
    sha256: str | None = None,
    install_enabled: bool = False,
) -> UpdateManager:
    monkeypatch.setattr(update_module.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(update_module.platform, "machine", lambda: "arm64")
    _, _, public_key_path, transport = _signed_update(tmp_path, package, sha256=sha256)
    return UpdateManager(
        tmp_path / "data",
        current_version="0.1.0",
        manifest_url="https://updates.example/latest-update.json",
        public_key_path=public_key_path,
        install_enabled=install_enabled,
        transport=transport,
    )


@pytest.mark.parametrize("value", ["v1.2.3", "1.2", "1.2.3-beta.1", "01.2.3", "1.02.3"])
def test_parse_semver_rejects_non_stable_strict_forms(value: str) -> None:
    with pytest.raises(UpdateError, match="Invalid release version"):
        parse_semver(value)


def test_parse_semver_and_platform_detection() -> None:
    assert parse_semver("12.3.45") == (12, 3, 45)
    assert detect_platform("Darwin", "arm64") == "darwin-arm64"
    assert detect_platform("Darwin", "aarch64") == "darwin-arm64"
    assert detect_platform("Windows", "AMD64") == "windows-x86_64"
    assert detect_platform("Linux", "x86_64") is None
    assert detect_platform("Windows", "arm64") is None


def test_restart_arguments_round_trip_without_shell_quoting(tmp_path: Path) -> None:
    arguments = [
        "--data-dir",
        str(tmp_path / "data directory with spaces"),
        "--runtime-file",
        str(tmp_path / 'runtime "quoted".json'),
        "",
    ]

    encoded = update_module.encode_restart_arguments(arguments)

    assert update_module.decode_restart_arguments(encoded) == arguments
    with pytest.raises(UpdateError, match="invalid"):
        update_module.decode_restart_arguments("not base64!")


def test_verify_and_parse_signed_manifest(tmp_path: Path) -> None:
    package = _macos_archive()
    manifest_bytes, signature, public_key_path, _ = _signed_update(tmp_path, package)

    verify_manifest_signature(manifest_bytes, signature, public_key_path)
    manifest = parse_manifest(manifest_bytes)

    assert manifest.version == "0.2.0"
    assert manifest.platforms["darwin-arm64"].size == len(package)
    with pytest.raises(UpdateError, match="signature is invalid"):
        verify_manifest_signature(manifest_bytes + b" ", signature, public_key_path)


def test_manifest_requires_the_versioned_platform_filename(tmp_path: Path) -> None:
    manifest_bytes, _, _, _ = _signed_update(tmp_path, _macos_archive())
    payload = json.loads(manifest_bytes)
    payload["platforms"]["darwin-arm64"]["filename"] = "Service-Console-latest.zip"
    payload["platforms"]["darwin-arm64"]["url"] = "https://updates.example/Service-Console-latest.zip"

    with pytest.raises(UpdateError, match="must be named"):
        parse_manifest(json.dumps(payload).encode())


def test_check_reports_update_and_development_install_reason(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(update_module.sys, "frozen", raising=False)
    manager = _manager(tmp_path, monkeypatch, _macos_archive(), install_enabled=True)

    status = manager.check()

    assert status == {
        "state": "available",
        "current_version": "0.1.0",
        "latest_version": "0.2.0",
        "release_url": "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
        "published_at": "2026-08-28T12:00:00Z",
        "notes": "Signed updater",
        "platform": "darwin-arm64",
        "platform_supported": True,
        "can_install": False,
        "reason": "开发模式仅支持检查更新，桌面 Release 包支持自动安装",
        "error": None,
        "downloaded_bytes": 0,
        "total_bytes": len(_macos_archive()),
        "download_progress": 0.0,
        "restart_required": False,
        "downloaded": False,
    }


def test_check_rejects_an_invalid_signature(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(update_module.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(update_module.platform, "machine", lambda: "arm64")
    package = _macos_archive()
    manifest, _, public_key_path, _ = _signed_update(tmp_path, package)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".sig"):
            return httpx.Response(200, content=base64.b64encode(b"x" * 64))
        return httpx.Response(200, content=manifest)

    manager = UpdateManager(
        tmp_path,
        current_version="0.1.0",
        manifest_url="https://updates.example/latest-update.json",
        public_key_path=public_key_path,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(UpdateError, match="signature is invalid"):
        manager.check()
    assert manager.status()["state"] == "error"
    assert manager.status()["error"] == "The update manifest signature is invalid"


def test_check_reports_concise_http_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(update_module.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(update_module.platform, "machine", lambda: "arm64")
    manager = UpdateManager(
        tmp_path,
        current_version="0.1.0",
        manifest_url="https://updates.example/latest-update.json",
        transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )

    with pytest.raises(UpdateError, match="update manifest: HTTP 404") as error:
        manager.check()

    assert "updates.example" not in str(error.value)


def test_check_marks_unknown_platform_as_unsupported(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(update_module.platform, "system", lambda: "Linux")
    monkeypatch.setattr(update_module.platform, "machine", lambda: "x86_64")
    _, _, public_key_path, transport = _signed_update(tmp_path, _macos_archive())
    manager = UpdateManager(
        tmp_path,
        current_version="0.1.0",
        manifest_url="https://updates.example/latest-update.json",
        public_key_path=public_key_path,
        transport=transport,
    )

    status = manager.check()

    assert status["state"] == "unsupported"
    assert status["platform_supported"] is False


def test_download_uses_part_file_and_verifies_size_and_sha256(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package = _macos_archive()
    manager = _manager(tmp_path, monkeypatch, package)
    manager.check()

    status = manager.download()

    archive = (
        tmp_path
        / "data"
        / "updates"
        / "v0.2.0"
        / "Service-Console-v0.2.0-macOS-arm64.zip"
    )
    assert archive.read_bytes() == package
    assert not archive.with_name(f"{archive.name}.part").exists()
    assert status["state"] == "downloaded"
    assert status["download_progress"] == 100.0
    assert status["downloaded"] is True


def test_download_removes_part_file_after_hash_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package = _macos_archive()
    manager = _manager(tmp_path, monkeypatch, package, sha256="0" * 64)
    manager.check()

    with pytest.raises(UpdateError, match="SHA-256"):
        manager.download()

    update_dir = tmp_path / "data" / "updates" / "v0.2.0"
    assert not list(update_dir.glob("*.zip"))
    assert not list(update_dir.glob("*.part"))
    assert manager.status()["state"] == "error"


def test_validate_zip_rejects_traversal_and_unsafe_symlink(tmp_path: Path) -> None:
    traversal = tmp_path / "traversal.zip"
    with zipfile.ZipFile(traversal, "w") as archive:
        archive.writestr("../escape", b"bad")
    with pytest.raises(UpdateError, match="path traversal"):
        validate_zip_archive(traversal)

    symlink_archive = tmp_path / "symlink.zip"
    link = zipfile.ZipInfo("Service Console/link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(symlink_archive, "w") as archive:
        archive.writestr(link, "../../outside")
    with pytest.raises(UpdateError, match="unsafe symlink"):
        validate_zip_archive(symlink_archive)


def test_validate_zip_allows_macos_bundle_relative_symlink(tmp_path: Path) -> None:
    archive_path = tmp_path / "bundle-symlink.zip"
    link = zipfile.ZipInfo("Service Console/Service Console.app/Contents/Resources/WebKit")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(link, "../Frameworks/WebKit")
        archive.writestr(
            "Service Console/Service Console.app/Contents/Frameworks/WebKit/module",
            b"binary",
        )

    validate_zip_archive(archive_path)


def test_extract_windows_archive_locates_the_application(tmp_path: Path) -> None:
    archive = tmp_path / "windows.zip"
    archive.write_bytes(_windows_archive())

    prepared = extract_update_archive(archive, tmp_path / "prepared", "windows-x86_64")

    assert prepared.root == tmp_path / "prepared" / "Service Console"
    assert prepared.executable.read_bytes() == b"desktop-binary"


def test_extract_macos_uses_ditto_and_locates_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive = tmp_path / "mac.zip"
    archive.write_bytes(_macos_archive())

    def fake_run(command: list[str], **kwargs: object) -> None:
        assert command[:3] == ["/usr/bin/ditto", "-x", "-k"]
        assert kwargs == {"check": True, "capture_output": True, "text": True}
        executable = (
            Path(command[-1])
            / "Service Console"
            / "Service Console.app"
            / "Contents"
            / "MacOS"
            / "Service Console"
        )
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"desktop-binary")

    monkeypatch.setattr(update_module.subprocess, "run", fake_run)

    prepared = extract_update_archive(archive, tmp_path / "prepared", "darwin-arm64")

    assert prepared.root.name == "Service Console.app"
    assert prepared.executable.read_bytes() == b"desktop-binary"


def test_verify_macos_prepared_update_checks_signature_identity_and_version(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "Service Console.app"
    executable = root / "Contents" / "MacOS" / "Service Console"
    info_plist = root / "Contents" / "Info.plist"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"binary")
    info_plist.write_bytes(b"plist")
    prepared = PreparedUpdate(root=root, executable=executable)
    bundle_version = "0.2.0"
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> object:
        calls.append(command)
        assert kwargs == {"check": True, "capture_output": True, "text": True}
        if command[0] == "/usr/bin/codesign":
            return update_module.subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        field = command[2]
        value = "dev.service-console.desktop" if field == "CFBundleIdentifier" else bundle_version
        return update_module.subprocess.CompletedProcess(command, 0, stdout=f"{value}\n", stderr="")

    monkeypatch.setattr(update_module.subprocess, "run", fake_run)

    verify_prepared_update(prepared, "darwin-arm64", "0.2.0")
    assert calls[0][:4] == ["/usr/bin/codesign", "--verify", "--deep", "--strict"]

    bundle_version = "0.1.0"
    with pytest.raises(UpdateError, match="bundle version"):
        verify_prepared_update(prepared, "darwin-arm64", "0.2.0")


def test_install_launches_external_helper_for_frozen_application(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _manager(tmp_path, monkeypatch, _macos_archive(), install_enabled=True)
    current_executable = (
        tmp_path / "Applications" / "Service Console.app" / "Contents" / "MacOS" / "Service Console"
    )
    current_executable.parent.mkdir(parents=True)
    current_executable.write_bytes(b"old")
    monkeypatch.setattr(update_module.sys, "frozen", True, raising=False)
    monkeypatch.setattr(update_module.sys, "executable", str(current_executable))
    manager.check()
    manager.download()

    prepared_executable = (
        tmp_path / "prepared-app" / "Service Console.app" / "Contents" / "MacOS" / "Service Console"
    )
    prepared_executable.parent.mkdir(parents=True)
    prepared_executable.write_bytes(b"new")
    prepared = PreparedUpdate(
        root=tmp_path / "prepared-app" / "Service Console.app",
        executable=prepared_executable,
    )
    monkeypatch.setattr(update_module, "extract_update_archive", lambda *_args: prepared)
    monkeypatch.setattr(update_module, "verify_prepared_update", lambda *_args: None)
    restart_arguments = ["--data-dir", str(tmp_path / "data directory"), "--debug"]
    monkeypatch.setattr(update_module.sys, "argv", ["Service Console", *restart_arguments])
    launched: dict[str, object] = {}

    def fake_launch(**kwargs: object) -> None:
        launched.update(kwargs)

    monkeypatch.setattr(update_module, "_launch_install_helper", fake_launch)

    status = manager.install()

    assert status["state"] == "restarting"
    assert status["restart_required"] is True
    assert launched["prepared"] == prepared
    assert launched["process_id"] == update_module.os.getpid()
    assert launched["launch_arguments"] == restart_arguments
    assert launched["ready_file"] == (
        tmp_path / "data" / "updates" / "v0.2.0" / "install-update.ready"
    )
    assert launched["log_file"] == (
        tmp_path / "data" / "updates" / "v0.2.0" / "install-update.log"
    )
    assert launched["installed"].root == tmp_path / "Applications" / "Service Console.app"  # type: ignore[union-attr]


def test_development_mode_cannot_install(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(update_module.sys, "frozen", raising=False)
    manager = _manager(tmp_path, monkeypatch, _macos_archive(), install_enabled=True)
    manager.check()
    manager.download()

    with pytest.raises(UpdateError, match="开发模式仅支持检查更新"):
        manager.install()
    assert manager.status()["state"] == "error"


def test_macos_helper_command_preserves_restart_arguments(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared = PreparedUpdate(
        root=tmp_path / "prepared source" / "Service Console.app",
        executable=tmp_path / "prepared source" / "Service Console.app" / "unused",
    )
    installed = InstalledApplication(
        root=tmp_path / "installed target" / "Service Console.app",
        executable=tmp_path / "installed target" / "Service Console.app" / "unused",
    )
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_popen(command: list[str], **kwargs: object) -> object:
        calls.append((command, kwargs))
        return object()

    monkeypatch.setattr(update_module.subprocess, "Popen", fake_popen)
    arguments = ["--data-dir", str(tmp_path / "configuration with spaces"), "--debug"]
    helper_path = tmp_path / "updates with spaces" / "install-update.sh"

    update_module._launch_install_helper(
        platform_name="darwin-arm64",
        helper_path=helper_path,
        prepared=prepared,
        installed=installed,
        process_id=1234,
        launch_arguments=arguments,
        ready_file=tmp_path / "ready marker",
        log_file=tmp_path / "failure log",
    )

    command, kwargs = calls[0]
    assert command[:2] == ["/bin/sh", str(helper_path)]
    assert update_module.decode_restart_arguments(command[-1]) == arguments
    assert kwargs["start_new_session"] is True
    if os.name != "nt":
        assert helper_path.stat().st_mode & stat.S_IXUSR


def test_windows_helper_command_preserves_restart_arguments(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared_root = tmp_path / "prepared source" / "Service Console"
    prepared = PreparedUpdate(
        root=prepared_root,
        executable=prepared_root / "bin with spaces" / "Service Console.exe",
    )
    installed = InstalledApplication(
        root=tmp_path / "installed target" / "Service Console",
        executable=tmp_path / "installed target" / "Service Console" / "Service Console.exe",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr(update_module.shutil, "which", lambda _name: "powershell.exe")
    monkeypatch.setattr(
        update_module.subprocess,
        "Popen",
        lambda command, **_kwargs: calls.append(command),
    )
    arguments = ["--runtime-file", str(tmp_path / "runtime with spaces.json"), "--debug"]

    update_module._launch_install_helper(
        platform_name="windows-x86_64",
        helper_path=tmp_path / "updates with spaces" / "install-update.ps1",
        prepared=prepared,
        installed=installed,
        process_id=4321,
        launch_arguments=arguments,
        ready_file=tmp_path / "ready marker",
        log_file=tmp_path / "failure log",
    )

    command = calls[0]
    assert command[command.index("-LaunchRelative") + 1] == str(
        Path("bin with spaces") / "Service Console.exe"
    )
    encoded = command[command.index("-RestartArguments") + 1]
    assert update_module.decode_restart_arguments(encoded) == arguments


def test_install_helpers_wait_for_exit_without_deadline_and_commit_after_readiness() -> None:
    macos = update_module._MACOS_INSTALL_HELPER
    assert 'while kill -0 "$PID"' in macos
    assert '"$COUNT" -ge 600' not in macos
    macos_ready = macos.index('if [ -f "$READY_FILE" ]')
    assert macos_ready < macos.index('rm -rf "$BACKUP"', macos_ready)
    assert "rollback \"updated application did not become ready" in macos
    assert "Update failed:" in macos

    windows = update_module._WINDOWS_INSTALL_HELPER
    assert "while (Get-Process -Id $ProcessId" in windows
    assert "AddSeconds(120)" not in windows
    windows_ready = windows.index("if (-not (Test-Path -LiteralPath $ReadyFile))")
    assert windows_ready < windows.index("Remove-Item -LiteralPath $Backup", windows_ready)
    assert "Rollback restored and relaunched" in windows
    assert "Write-InstallLog \"Update failed:" in windows


def test_update_directory_cleanup_keeps_current_and_most_recent(tmp_path: Path) -> None:
    updates_root = tmp_path / "updates"
    for version in ("0.1.0", "0.2.0", "0.3.0"):
        (updates_root / f"v{version}").mkdir(parents=True)
    unrelated = updates_root / "manual-backup"
    unrelated.mkdir()

    update_module._prune_update_directories(updates_root, {"0.2.0"})

    assert not (updates_root / "v0.1.0").exists()
    assert (updates_root / "v0.2.0").is_dir()
    assert (updates_root / "v0.3.0").is_dir()
    assert unrelated.is_dir()
