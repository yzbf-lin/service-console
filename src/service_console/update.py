"""Signed application update discovery, download, and desktop installation."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal, cast
from urllib.parse import unquote, urlparse

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from service_console import __version__

UPDATE_MANIFEST_URL = (
    "https://github.com/yzbf-lin/service-console/releases/latest/download/latest-update.json"
)
UPDATE_SIGNATURE_URL = f"{UPDATE_MANIFEST_URL}.sig"
UPDATE_PUBLIC_KEY_PATH = Path(__file__).with_name("update_public_key.pem")

MAX_MANIFEST_BYTES = 1024 * 1024
MAX_SIGNATURE_BYTES = 8 * 1024
MAX_PACKAGE_BYTES = 512 * 1024 * 1024
MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 100_000
MAX_RESTART_ARGUMENTS_BYTES = 128 * 1024
UPDATE_HELPER_START_TIMEOUT = 8.0

UPDATE_READY_FILE_ENV = "SERVICE_CONSOLE_UPDATE_READY_FILE"
UPDATE_RESTART_ARGUMENTS_ENV = "SERVICE_CONSOLE_UPDATE_RESTART_ARGUMENTS"

UpdateState = Literal[
    "idle",
    "checking",
    "available",
    "unsupported",
    "up_to_date",
    "downloading",
    "downloaded",
    "installing",
    "restarting",
    "error",
]

_STRICT_SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SUPPORTED_PLATFORMS = frozenset({"darwin-arm64", "windows-x86_64"})


class UpdateError(RuntimeError):
    """A concise, user-facing application update error."""


@dataclass(frozen=True, slots=True)
class ReleaseAsset:
    """One platform-specific archive from the signed update manifest."""

    url: str
    sha256: str
    size: int
    filename: str


@dataclass(frozen=True, slots=True)
class ReleaseManifest:
    """The verified release metadata used by the updater."""

    version: str
    release_url: str
    published_at: str
    notes: str
    platforms: Mapping[str, ReleaseAsset]


@dataclass(frozen=True, slots=True)
class PreparedUpdate:
    """An extracted update ready to be swapped into the install location."""

    root: Path
    executable: Path


@dataclass(frozen=True, slots=True)
class InstalledApplication:
    """The currently running frozen application and its replaceable root."""

    root: Path
    executable: Path


def parse_semver(value: str) -> tuple[int, int, int]:
    """Parse the stable ``MAJOR.MINOR.PATCH`` form accepted by release manifests."""

    match = _STRICT_SEMVER.fullmatch(value)
    if match is None:
        raise UpdateError(f"Invalid release version: {value!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def detect_platform(system: str | None = None, machine: str | None = None) -> str | None:
    """Map the current machine to an explicitly supported release target."""

    system_name = (system or platform.system()).strip().lower()
    machine_name = (machine or platform.machine()).strip().lower()
    if system_name == "darwin" and machine_name in {"arm64", "aarch64"}:
        return "darwin-arm64"
    if system_name == "windows" and machine_name in {"amd64", "x86_64"}:
        return "windows-x86_64"
    return None


def encode_restart_arguments(arguments: Sequence[str]) -> str:
    """Serialize desktop arguments for lossless transport through helper environments."""

    if any(not isinstance(argument, str) for argument in arguments):
        raise UpdateError("Desktop restart arguments must be strings")
    payload = json.dumps(list(arguments), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_RESTART_ARGUMENTS_BYTES:
        raise UpdateError("Desktop restart arguments are too large")
    return base64.b64encode(payload).decode("ascii")


def decode_restart_arguments(encoded: str) -> list[str]:
    """Decode helper-transported desktop arguments without shell parsing."""

    try:
        payload = base64.b64decode(encoded, validate=True)
        if len(payload) > MAX_RESTART_ARGUMENTS_BYTES:
            raise UpdateError("Desktop restart arguments are too large")
        arguments = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise UpdateError("Desktop restart arguments are invalid") from exc
    if not isinstance(arguments, list) or any(not isinstance(argument, str) for argument in arguments):
        raise UpdateError("Desktop restart arguments are invalid")
    return arguments


def verify_manifest_signature(
    manifest_bytes: bytes,
    signature_bytes: bytes,
    public_key_path: str | Path = UPDATE_PUBLIC_KEY_PATH,
) -> None:
    """Verify an exact manifest byte sequence using the bundled Ed25519 key."""

    try:
        public_key = serialization.load_pem_public_key(Path(public_key_path).read_bytes())
    except (OSError, ValueError, TypeError) as exc:
        raise UpdateError(f"Unable to load the update verification key: {exc}") from exc
    if not isinstance(public_key, Ed25519PublicKey):
        raise UpdateError("The update verification key is not an Ed25519 public key")

    encoded_signature = signature_bytes.strip()
    try:
        signature = base64.b64decode(encoded_signature, validate=True)
    except ValueError as exc:
        raise UpdateError("The update manifest signature is not valid base64") from exc
    if len(signature) != 64:
        raise UpdateError("The update manifest signature has an invalid length")
    try:
        public_key.verify(signature, manifest_bytes)
    except InvalidSignature as exc:
        raise UpdateError("The update manifest signature is invalid") from exc


def parse_manifest(manifest_bytes: bytes) -> ReleaseManifest:
    """Parse and strictly validate a verified update manifest."""

    try:
        payload = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpdateError("The update manifest is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise UpdateError("The update manifest root must be an object")
    if payload.get("schema") != 1:
        raise UpdateError("Unsupported update manifest schema")

    version = _required_string(payload, "version")
    parse_semver(version)
    release_url = _required_https_url(payload, "release_url")
    published_at = _required_string(payload, "published_at")
    notes = payload.get("notes", "")
    if not isinstance(notes, str):
        raise UpdateError("Update manifest field 'notes' must be a string")

    raw_platforms = payload.get("platforms")
    if not isinstance(raw_platforms, dict):
        raise UpdateError("Update manifest field 'platforms' must be an object")
    platforms: dict[str, ReleaseAsset] = {}
    for platform_name in _SUPPORTED_PLATFORMS:
        raw_asset = raw_platforms.get(platform_name)
        if raw_asset is None:
            continue
        if not isinstance(raw_asset, dict):
            raise UpdateError(f"Update asset for {platform_name!r} must be an object")
        url = _required_https_url(raw_asset, "url")
        sha256 = _required_string(raw_asset, "sha256").lower()
        if _SHA256.fullmatch(sha256) is None:
            raise UpdateError(f"Update asset for {platform_name!r} has an invalid SHA-256")
        size = raw_asset.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_PACKAGE_BYTES:
            raise UpdateError(f"Update asset for {platform_name!r} has an invalid size")
        filename = _required_string(raw_asset, "filename")
        if not _safe_filename(filename):
            raise UpdateError(f"Update asset for {platform_name!r} has an unsafe filename")
        expected_filename = _expected_filename(platform_name, version)
        if filename != expected_filename:
            raise UpdateError(
                f"Update asset for {platform_name!r} must be named {expected_filename!r}"
            )
        url_filename = unquote(PurePosixPath(urlparse(url).path).name)
        if url_filename != filename:
            raise UpdateError(f"Update asset for {platform_name!r} has a mismatched filename")
        platforms[platform_name] = ReleaseAsset(
            url=url,
            sha256=sha256,
            size=size,
            filename=filename,
        )

    return ReleaseManifest(
        version=version,
        release_url=release_url,
        published_at=published_at,
        notes=notes,
        platforms=platforms,
    )


def validate_zip_archive(path: str | Path) -> None:
    """Reject traversal, unsafe links, special files, duplicates, and zip bombs."""

    archive_path = Path(path)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            if not infos:
                raise UpdateError("The update archive is empty")
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise UpdateError("The update archive contains too many entries")

            seen: set[str] = set()
            symlinks: set[str] = set()
            extracted_size = 0
            for info in infos:
                name = _validated_archive_name(info.filename)
                folded_name = name.casefold().rstrip("/")
                if folded_name in seen:
                    raise UpdateError(f"The update archive contains a duplicate entry: {name}")
                seen.add(folded_name)

                extracted_size += info.file_size
                if extracted_size > MAX_EXTRACTED_BYTES:
                    raise UpdateError("The update archive expands beyond the allowed size")
                if info.flag_bits & 0x1:
                    raise UpdateError(f"The update archive contains an encrypted entry: {name}")

                file_type = stat.S_IFMT(info.external_attr >> 16)
                if file_type == stat.S_IFLNK:
                    target = _read_safe_symlink_target(archive, info, name)
                    if target is None:
                        raise UpdateError(f"The update archive contains an unsafe symlink: {name}")
                    symlinks.add(folded_name)
                elif file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
                    raise UpdateError(f"The update archive contains a special file: {name}")

            for folded_name in seen:
                components = PurePosixPath(folded_name).parts
                parents = ("/".join(components[:index]) for index in range(1, len(components)))
                if any(parent in symlinks for parent in parents):
                    raise UpdateError("The update archive writes through a symlink")
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        raise UpdateError(f"The update archive is not a valid ZIP file: {exc}") from exc


def extract_update_archive(
    archive_path: str | Path,
    destination: str | Path,
    platform_name: str,
) -> PreparedUpdate:
    """Safely extract an already verified platform archive into an empty directory."""

    if platform_name not in _SUPPORTED_PLATFORMS:
        raise UpdateError(f"Unsupported update platform: {platform_name}")
    archive = Path(archive_path)
    destination_path = Path(destination)
    validate_zip_archive(archive)
    if destination_path.exists():
        shutil.rmtree(destination_path)
    destination_path.mkdir(parents=True)

    if platform_name == "darwin-arm64":
        try:
            subprocess.run(
                ["/usr/bin/ditto", "-x", "-k", str(archive), str(destination_path)],
                check=True,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise UpdateError(f"Unable to extract the macOS update: {_subprocess_error(exc)}") from exc
        candidates = [path for path in destination_path.rglob("Service Console.app") if path.is_dir()]
        if len(candidates) != 1:
            raise UpdateError("The macOS update must contain exactly one Service Console.app")
        executable = candidates[0] / "Contents" / "MacOS" / "Service Console"
        if not executable.is_file():
            raise UpdateError("The macOS update does not contain the expected executable")
        return PreparedUpdate(root=candidates[0], executable=executable)

    try:
        with zipfile.ZipFile(archive) as windows_archive:
            windows_archive.extractall(destination_path)
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        raise UpdateError(f"Unable to extract the Windows update: {exc}") from exc
    candidates = [
        path
        for path in destination_path.rglob("Service Console.exe")
        if path.is_file() and path.parent.name == "Service Console"
    ]
    if len(candidates) != 1:
        raise UpdateError("The Windows update must contain exactly one Service Console.exe")
    return PreparedUpdate(root=candidates[0].parent, executable=candidates[0])


def verify_prepared_update(
    prepared: PreparedUpdate,
    platform_name: str,
    version: str,
) -> None:
    """Validate platform identity metadata before launching the replacement helper."""

    parse_semver(version)
    if platform_name != "darwin-arm64":
        return
    info_plist = prepared.root / "Contents" / "Info.plist"
    if not info_plist.is_file():
        raise UpdateError("The macOS update is missing Contents/Info.plist")
    try:
        subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(prepared.root)],
            check=True,
            capture_output=True,
            text=True,
        )
        bundle_identifier = subprocess.run(
            [
                "/usr/bin/plutil",
                "-extract",
                "CFBundleIdentifier",
                "raw",
                "-o",
                "-",
                str(info_plist),
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        bundle_version = subprocess.run(
            [
                "/usr/bin/plutil",
                "-extract",
                "CFBundleShortVersionString",
                "raw",
                "-o",
                "-",
                str(info_plist),
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise UpdateError(f"Unable to verify the macOS update: {_subprocess_error(exc)}") from exc
    if bundle_identifier != "dev.service-console.desktop":
        raise UpdateError("The macOS update has an unexpected bundle identifier")
    if bundle_version != version:
        raise UpdateError("The macOS update bundle version differs from the signed manifest")


class UpdateManager:
    """Own the thread-safe application update state machine."""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        current_version: str = __version__,
        manifest_url: str = UPDATE_MANIFEST_URL,
        signature_url: str | None = None,
        public_key_path: str | Path = UPDATE_PUBLIC_KEY_PATH,
        install_enabled: bool = False,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        parse_semver(current_version)
        if not _is_https_url(manifest_url):
            raise ValueError("manifest_url must use HTTPS")
        selected_signature_url = signature_url or f"{manifest_url}.sig"
        if not _is_https_url(selected_signature_url):
            raise ValueError("signature_url must use HTTPS")

        self.data_dir = Path(data_dir).expanduser()
        self.current_version = current_version
        self.manifest_url = manifest_url
        self.signature_url = selected_signature_url
        self.public_key_path = Path(public_key_path)
        self.install_enabled = install_enabled
        self.transport = transport
        self.platform = detect_platform()
        self.platform_label = self.platform or (
            f"{platform.system().strip().lower()}-{platform.machine().strip().lower()}"
        )

        self._lock = threading.RLock()
        self._operation_lock = threading.Lock()
        self._state: UpdateState = "idle"
        self._manifest: ReleaseManifest | None = None
        self._asset: ReleaseAsset | None = None
        self._archive_path: Path | None = None
        self._downloaded_bytes = 0
        self._total_bytes: int | None = None
        self._restart_required = False
        self._error: str | None = None

        _prune_update_directories(self.data_dir / "updates", {self.current_version})

    def status(self) -> dict[str, Any]:
        """Return an immutable JSON-compatible snapshot for the API/UI."""

        with self._lock:
            manifest = self._manifest
            asset = self._asset
            total = self._total_bytes
            downloaded_bytes = self._downloaded_bytes
            state = self._state
            error = self._error
            restart_required = self._restart_required
            downloaded = self._archive_path is not None and self._archive_path.is_file()

        can_install, reason = self._install_capability()
        progress = 0.0
        if total:
            progress = min(100.0, round(downloaded_bytes * 100 / total, 1))
        platform_supported = self.platform is not None and (manifest is None or asset is not None)
        return {
            "state": state,
            "current_version": self.current_version,
            "latest_version": manifest.version if manifest is not None else None,
            "release_url": manifest.release_url if manifest is not None else None,
            "published_at": manifest.published_at if manifest is not None else None,
            "notes": manifest.notes if manifest is not None else "",
            "platform": self.platform_label,
            "platform_supported": platform_supported,
            "can_install": can_install,
            "reason": reason,
            "error": error,
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": total,
            "download_progress": progress,
            "restart_required": restart_required,
            "downloaded": downloaded,
        }

    def check(self) -> dict[str, Any]:
        """Fetch, authenticate, and compare the latest signed release manifest."""

        with self._operation("checking"):
            try:
                with self._client() as client:
                    manifest_bytes = _download_small_file(
                        client,
                        self.manifest_url,
                        MAX_MANIFEST_BYTES,
                        "update manifest",
                    )
                    signature_bytes = _download_small_file(
                        client,
                        self.signature_url,
                        MAX_SIGNATURE_BYTES,
                        "update manifest signature",
                    )
                verify_manifest_signature(manifest_bytes, signature_bytes, self.public_key_path)
                manifest = parse_manifest(manifest_bytes)
                _prune_update_directories(
                    self.data_dir / "updates",
                    {self.current_version, manifest.version},
                )
                asset = manifest.platforms.get(self.platform) if self.platform is not None else None
                with self._lock:
                    self._manifest = manifest
                    self._asset = asset
                    self._archive_path = None
                    self._downloaded_bytes = 0
                    self._total_bytes = asset.size if asset is not None else None
                    self._restart_required = False
                    self._error = None

                if parse_semver(manifest.version) <= parse_semver(self.current_version):
                    self._set_state("up_to_date")
                    return self.status()
                if self.platform is None or asset is None:
                    self._set_state("unsupported")
                    return self.status()

                cached_archive = self._archive_for(asset, manifest.version)
                if cached_archive.is_file() and _archive_matches(cached_archive, asset):
                    try:
                        validate_zip_archive(cached_archive)
                    except UpdateError:
                        cached_archive.unlink(missing_ok=True)
                    else:
                        with self._lock:
                            self._archive_path = cached_archive
                            self._downloaded_bytes = asset.size
                        self._set_state("downloaded")
                        return self.status()
                self._set_state("available")
                return self.status()
            except Exception as exc:
                raise self._record_error(exc) from exc

    def download(self) -> dict[str, Any]:
        """Download and authenticate the selected release archive."""

        with self._operation("downloading"):
            try:
                manifest, asset = self._selected_update()
                archive = self._archive_for(asset, manifest.version)
                archive.parent.mkdir(parents=True, exist_ok=True)
                part = archive.with_name(f"{archive.name}.part")
                part.unlink(missing_ok=True)
                digest = hashlib.sha256()
                downloaded_bytes = 0
                with self._lock:
                    self._archive_path = None
                    self._downloaded_bytes = 0
                    self._total_bytes = asset.size

                try:
                    with self._client() as client, client.stream("GET", asset.url) as response:
                        response.raise_for_status()
                        content_length = response.headers.get("content-length")
                        if content_length is not None:
                            try:
                                declared_length = int(content_length)
                            except ValueError as exc:
                                raise UpdateError("The update download has an invalid Content-Length") from exc
                            if declared_length != asset.size:
                                raise UpdateError("The update download size differs from the signed manifest")
                        with part.open("wb") as output:
                            for chunk in response.iter_bytes():
                                if not chunk:
                                    continue
                                downloaded_bytes += len(chunk)
                                if downloaded_bytes > asset.size or downloaded_bytes > MAX_PACKAGE_BYTES:
                                    raise UpdateError("The update download exceeded the signed size")
                                digest.update(chunk)
                                output.write(chunk)
                                with self._lock:
                                    self._downloaded_bytes = downloaded_bytes
                            output.flush()
                            os.fsync(output.fileno())
                    if downloaded_bytes != asset.size:
                        raise UpdateError("The update download is incomplete")
                    if digest.hexdigest() != asset.sha256:
                        raise UpdateError("The update download failed SHA-256 verification")
                    validate_zip_archive(part)
                    os.replace(part, archive)
                except Exception:
                    part.unlink(missing_ok=True)
                    raise

                with self._lock:
                    self._archive_path = archive
                    self._downloaded_bytes = asset.size
                    self._error = None
                self._set_state("downloaded")
                return self.status()
            except Exception as exc:
                raise self._record_error(exc) from exc

    def install(self) -> dict[str, Any]:
        """Prepare and launch an external swap helper for a frozen desktop build."""

        with self._operation("installing"):
            try:
                manifest, asset = self._selected_update()
                can_install, reason = self._install_capability()
                if not can_install:
                    raise UpdateError(reason or "Automatic installation is unavailable")
                installed = _find_installed_application(self.platform)
                if installed is None:
                    raise UpdateError("Unable to locate the installed desktop application")
                with self._lock:
                    archive = self._archive_path
                if archive is None or not archive.is_file():
                    raise UpdateError("Download the update before installing it")
                if not _archive_matches(archive, asset):
                    raise UpdateError("The downloaded update no longer matches the signed manifest")

                prepared_dir = archive.parent / "prepared"
                prepared = extract_update_archive(archive, prepared_dir, cast(str, self.platform))
                verify_prepared_update(prepared, cast(str, self.platform), manifest.version)
                helper_path = archive.parent / (
                    "install-update.exe" if self.platform == "windows-x86_64" else "install-update.sh"
                )
                ready_file = archive.parent / "install-update.ready"
                started_file = archive.parent / "install-update.started"
                log_file = archive.parent / "install-update.log"
                ready_file.unlink(missing_ok=True)
                started_file.unlink(missing_ok=True)
                _launch_install_helper(
                    platform_name=cast(str, self.platform),
                    helper_path=helper_path,
                    prepared=prepared,
                    installed=installed,
                    process_id=os.getpid(),
                    launch_arguments=sys.argv[1:],
                    ready_file=ready_file,
                    started_file=started_file,
                    log_file=log_file,
                )
                with self._lock:
                    self._restart_required = True
                    self._error = None
                self._set_state("restarting")
                return self.status()
            except Exception as exc:
                raise self._record_error(exc) from exc

    def _selected_update(self) -> tuple[ReleaseManifest, ReleaseAsset]:
        with self._lock:
            manifest = self._manifest
            asset = self._asset
        if manifest is None:
            raise UpdateError("Check for updates before continuing")
        if parse_semver(manifest.version) <= parse_semver(self.current_version):
            raise UpdateError("The application is already up to date")
        if self.platform is None or asset is None:
            raise UpdateError("No automatic update package is available for this platform")
        return manifest, asset

    def _archive_for(self, asset: ReleaseAsset, version: str) -> Path:
        return self.data_dir / "updates" / f"v{version}" / asset.filename

    def _install_capability(self) -> tuple[bool, str | None]:
        if self.platform is None:
            return False, "当前平台暂不支持自动安装，请从发布页手动下载"
        with self._lock:
            if self._manifest is not None and self._asset is None:
                return False, "当前平台没有对应的更新包，请从发布页手动下载"
        if not self.install_enabled:
            return False, "当前运行模式仅支持检查更新"
        if not getattr(sys, "frozen", False):
            return False, "开发模式仅支持检查更新，桌面 Release 包支持自动安装"
        installed = _find_installed_application(self.platform)
        if installed is None:
            return False, "未找到可替换的桌面应用目录"
        if not os.access(installed.root.parent, os.W_OK):
            return False, "应用所在目录不可写，请移动应用或调整目录权限"
        return True, None

    def _client(self) -> httpx.Client:
        return httpx.Client(
            transport=self.transport,
            follow_redirects=True,
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={"User-Agent": f"ServiceConsole/{self.current_version}"},
        )

    def _set_state(self, state: UpdateState) -> None:
        with self._lock:
            self._state = state

    def _record_error(self, exc: Exception) -> UpdateError:
        error = exc if isinstance(exc, UpdateError) else UpdateError(_exception_message(exc))
        with self._lock:
            self._state = "error"
            self._error = str(error)
            self._restart_required = False
        return error

    def _operation(self, state: UpdateState) -> _UpdateOperation:
        return _UpdateOperation(self, state)


class _UpdateOperation:
    def __init__(self, manager: UpdateManager, state: UpdateState) -> None:
        self.manager = manager
        self.state = state

    def __enter__(self) -> None:
        if not self.manager._operation_lock.acquire(blocking=False):
            raise UpdateError("Another update operation is already running")
        with self.manager._lock:
            if self.manager._state == "restarting":
                self.manager._operation_lock.release()
                raise UpdateError("The application update is waiting for restart")
            self.manager._state = self.state
            self.manager._error = None

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.manager._operation_lock.release()


def _required_string(payload: Mapping[str, object], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise UpdateError(f"Update manifest field {field!r} must be a non-empty string")
    return value


def _required_https_url(payload: Mapping[str, object], field: str) -> str:
    value = _required_string(payload, field)
    if not _is_https_url(value):
        raise UpdateError(f"Update manifest field {field!r} must use HTTPS")
    return value


def _is_https_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc) and not parsed.username and not parsed.password


def _safe_filename(value: str) -> bool:
    return (
        value == Path(value).name
        and value == PurePosixPath(value).name
        and value.lower().endswith(".zip")
        and "\x00" not in value
        and value not in {".", ".."}
    )


def _expected_filename(platform_name: str, version: str) -> str:
    if platform_name == "darwin-arm64":
        return f"Service-Console-v{version}-macOS-arm64.zip"
    return f"Service-Console-v{version}-Windows-x64.zip"


def _validated_archive_name(value: str) -> str:
    if not value or "\x00" in value:
        raise UpdateError("The update archive contains an empty or invalid filename")
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or normalized.startswith("/"):
        raise UpdateError(f"The update archive contains an absolute path: {value}")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise UpdateError(f"The update archive contains path traversal: {value}")
    if path.parts and ":" in path.parts[0]:
        raise UpdateError(f"The update archive contains a Windows drive path: {value}")
    return "/".join(path.parts) + ("/" if value.endswith(("/", "\\")) else "")


def _read_safe_symlink_target(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    name: str,
) -> str | None:
    if info.file_size > 4096:
        return None
    try:
        target = archive.read(info).decode("utf-8")
    except (KeyError, UnicodeDecodeError, RuntimeError):
        return None
    target_path = PurePosixPath(target.replace("\\", "/"))
    if target_path.is_absolute() or not target_path.parts:
        return None
    if any(part in {"", "."} for part in target_path.parts):
        return None
    if ":" in target_path.parts[0] or "\x00" in target:
        return None
    parent = PurePosixPath(name).parent
    if _normalize_archive_parts((*parent.parts, *target_path.parts)) is None:
        return None
    return target


def _normalize_archive_parts(parts: tuple[str, ...]) -> tuple[str, ...] | None:
    normalized: list[str] = []
    for part in parts:
        if part == "..":
            if not normalized:
                return None
            normalized.pop()
        elif part not in {"", "."}:
            normalized.append(part)
    return tuple(normalized) or None


def _download_small_file(client: httpx.Client, url: str, limit: int, label: str) -> bytes:
    data = bytearray()
    try:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > limit:
                    raise UpdateError(f"The {label} exceeds the allowed size")
    except httpx.HTTPStatusError as exc:
        raise UpdateError(
            f"Unable to download the {label}: HTTP {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise UpdateError(f"Unable to download the {label}: {exc}") from exc
    return bytes(data)


def _archive_matches(path: Path, asset: ReleaseAsset) -> bool:
    try:
        if path.stat().st_size != asset.size:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as archive:
            for chunk in iter(lambda: archive.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == asset.sha256
    except OSError:
        return False


def _find_installed_application(platform_name: str | None) -> InstalledApplication | None:
    if not getattr(sys, "frozen", False):
        return None
    executable = Path(sys.executable).resolve()
    if platform_name == "darwin-arm64":
        for parent in executable.parents:
            if parent.suffix.lower() == ".app":
                return InstalledApplication(root=parent, executable=executable)
        return None
    if platform_name == "windows-x86_64" and executable.suffix.lower() == ".exe":
        return InstalledApplication(root=executable.parent, executable=executable)
    return None


def _launch_install_helper(
    *,
    platform_name: str,
    helper_path: Path,
    prepared: PreparedUpdate,
    installed: InstalledApplication,
    process_id: int,
    launch_arguments: Sequence[str],
    ready_file: Path,
    started_file: Path,
    log_file: Path,
) -> None:
    helper_path.parent.mkdir(parents=True, exist_ok=True)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    encoded_arguments = encode_restart_arguments(launch_arguments)
    if platform_name == "darwin-arm64":
        helper_path.write_text(_MACOS_INSTALL_HELPER, encoding="utf-8")
        helper_path.chmod(0o700)
        command = [
            "/bin/sh",
            str(helper_path),
            str(process_id),
            str(prepared.root),
            str(installed.root),
            str(ready_file),
            str(started_file),
            str(log_file),
            encoded_arguments,
        ]
        try:
            with log_file.open("ab", buffering=0) as output:
                process = subprocess.Popen(
                    command,
                    cwd=str(helper_path.parent),
                    stdin=subprocess.DEVNULL,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    close_fds=True,
                    start_new_session=True,
                )
        except OSError as exc:
            raise UpdateError(f"Unable to start the macOS update helper: {exc}") from exc
        _wait_for_install_helper_start(process, started_file, log_file)
        return

    if platform_name != "windows-x86_64":
        raise UpdateError(f"Unsupported update platform: {platform_name}")
    try:
        relative_executable = prepared.executable.relative_to(prepared.root)
    except ValueError as exc:
        raise UpdateError("The prepared Windows executable is outside its application directory") from exc
    packaged_helper = prepared.root / "Service Console Updater.exe"
    if not packaged_helper.is_file():
        raise UpdateError("The Windows update package does not contain Service Console Updater.exe")
    temporary_helper = helper_path.with_name(f".{helper_path.name}.{os.getpid()}.tmp")
    try:
        shutil.copy2(packaged_helper, temporary_helper)
        os.replace(temporary_helper, helper_path)
    except OSError as exc:
        temporary_helper.unlink(missing_ok=True)
        raise UpdateError(f"Unable to prepare the native Windows update helper: {exc}") from exc
    command = [
        str(helper_path),
        "--process-id",
        str(process_id),
        "--source",
        str(prepared.root),
        "--target",
        str(installed.root),
        "--launch-relative",
        str(relative_executable),
        "--ready-file",
        str(ready_file),
        "--started-file",
        str(started_file),
        "--log-file",
        str(log_file),
        "--restart-arguments",
        encoded_arguments,
    ]
    creation_flags = (
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )
    try:
        with log_file.open("ab", buffering=0) as output:
            process = subprocess.Popen(
                command,
                cwd=str(helper_path.parent),
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                close_fds=True,
                creationflags=creation_flags,
            )
    except OSError as exc:
        raise UpdateError(f"Unable to start the Windows update helper: {exc}") from exc
    _wait_for_install_helper_start(process, started_file, log_file)


def _wait_for_install_helper_start(
    process: subprocess.Popen[bytes],
    started_file: Path,
    log_file: Path,
    timeout: float = UPDATE_HELPER_START_TIMEOUT,
) -> None:
    """Keep the desktop open until the external helper confirms it is durable."""

    deadline = time.monotonic() + timeout
    while True:
        if started_file.is_file():
            return
        return_code = process.poll()
        if return_code is not None:
            detail = _install_log_tail(log_file)
            suffix = f": {detail}" if detail else ""
            raise UpdateError(
                f"The update helper exited with status {return_code} before starting{suffix}"
            )
        if time.monotonic() >= deadline:
            try:
                process.terminate()
            except OSError:
                pass
            raise UpdateError(
                f"The update helper did not confirm startup within {timeout:g} seconds"
            )
        time.sleep(0.05)


def _install_log_tail(log_file: Path, limit: int = 2048) -> str:
    try:
        with log_file.open("rb") as source:
            source.seek(0, os.SEEK_END)
            size = source.tell()
            source.seek(max(0, size - limit))
            return source.read().decode("utf-8", errors="replace").strip().replace("\n", " | ")
    except OSError:
        return ""


def _exception_message(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"Update request failed with HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.HTTPError):
        return f"Update request failed: {exc}"
    return str(exc) or exc.__class__.__name__


def _subprocess_error(exc: OSError | subprocess.CalledProcessError) -> str:
    if isinstance(exc, subprocess.CalledProcessError):
        output = (exc.stderr or exc.stdout or "").strip()
        return output or f"ditto exited with status {exc.returncode}"
    return str(exc)


def _prune_update_directories(updates_root: Path, preferred_versions: set[str]) -> None:
    """Keep the current/latest update directories and at most one recent fallback."""

    if not updates_root.is_dir():
        return
    versioned: list[tuple[tuple[int, int, int], str, Path]] = []
    try:
        entries = list(updates_root.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.is_symlink() or not entry.is_dir() or not entry.name.startswith("v"):
            continue
        version = entry.name[1:]
        try:
            parsed = parse_semver(version)
        except UpdateError:
            continue
        versioned.append((parsed, version, entry))

    existing_versions = {item[1] for item in versioned}
    keep = preferred_versions & existing_versions
    for _parsed, version, _path in sorted(versioned, reverse=True):
        if len(keep) >= 2:
            break
        keep.add(version)
    for _parsed, version, path in versioned:
        if version in keep:
            continue
        try:
            shutil.rmtree(path)
        except OSError:
            # Cleanup is best-effort and must never block update discovery/startup.
            pass


_MACOS_INSTALL_HELPER = r"""#!/bin/sh
set -eu

PID="$1"
SOURCE="$2"
TARGET="$3"
READY_FILE="$4"
STARTED_FILE="$5"
LOG_FILE="$6"
RESTART_ARGUMENTS="$7"
INCOMING="${TARGET}.update-new"
BACKUP="${TARGET}.update-backup"
EXECUTABLE="$TARGET/Contents/MacOS/Service Console"
NEW_PID=""

umask 077
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
mkdir -p "$(dirname "$STARTED_FILE")"
STARTED_TEMP="${STARTED_FILE}.$$"
printf '{"pid":%s,"started_at":"%s"}\n' "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$STARTED_TEMP"
mv "$STARTED_TEMP" "$STARTED_FILE"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE"
}

launch() {
  MODE="$1"
  if [ "$MODE" = "health-check" ]; then
    /usr/bin/env \
      "SERVICE_CONSOLE_UPDATE_READY_FILE=$READY_FILE" \
      "SERVICE_CONSOLE_UPDATE_RESTART_ARGUMENTS=$RESTART_ARGUMENTS" \
      "$EXECUTABLE" >>"$LOG_FILE" 2>&1 &
  else
    /usr/bin/env \
      "SERVICE_CONSOLE_UPDATE_RESTART_ARGUMENTS=$RESTART_ARGUMENTS" \
      "$EXECUTABLE" >>"$LOG_FILE" 2>&1 &
  fi
  NEW_PID=$!
}

stop_new_process() {
  if [ -z "$NEW_PID" ] || ! kill -0 "$NEW_PID" 2>/dev/null; then
    return
  fi
  kill "$NEW_PID" 2>/dev/null || true
  COUNT=0
  while kill -0 "$NEW_PID" 2>/dev/null && [ "$COUNT" -lt 25 ]; do
    COUNT=$((COUNT + 1))
    sleep 0.2
  done
  if kill -0 "$NEW_PID" 2>/dev/null; then
    kill -9 "$NEW_PID" 2>/dev/null || true
  fi
  wait "$NEW_PID" 2>/dev/null || true
}

rollback() {
  REASON="$1"
  log "Update failed: $REASON"
  stop_new_process
  rm -f "$READY_FILE"
  rm -rf "$INCOMING"
  if [ -e "$BACKUP" ]; then
    rm -rf "$TARGET"
    if ! mv "$BACKUP" "$TARGET"; then
      log "Rollback failed: unable to restore backup"
      exit 1
    fi
  fi
  EXECUTABLE="$TARGET/Contents/MacOS/Service Console"
  if [ -x "$EXECUTABLE" ]; then
    launch "rollback"
    log "Rollback restored and relaunched the previous version"
  else
    log "Rollback failed: restored executable is missing"
  fi
  exit 1
}

log "Waiting for desktop process $PID to exit"
while kill -0 "$PID" 2>/dev/null; do
  sleep 0.2
done
log "Desktop process exited; preparing application swap"

if [ ! -e "$TARGET" ] && [ -e "$BACKUP" ]; then
  mv "$BACKUP" "$TARGET"
fi
[ -e "$TARGET" ] || { log "Installed application is missing"; exit 1; }
rm -rf "$INCOMING" "$BACKUP"
rm -f "$READY_FILE"

if ! /usr/bin/ditto "$SOURCE" "$INCOMING"; then
  rm -rf "$INCOMING"
  log "Update failed: unable to copy prepared application"
  exit 1
fi
if ! mv "$TARGET" "$BACKUP"; then
  rm -rf "$INCOMING"
  log "Update failed: unable to create backup"
  exit 1
fi
if ! mv "$INCOMING" "$TARGET"; then
  rollback "unable to activate prepared application"
fi

EXECUTABLE="$TARGET/Contents/MacOS/Service Console"
[ -x "$EXECUTABLE" ] || rollback "updated executable is missing"
launch "health-check"
log "Started updated application process $NEW_PID"

COUNT=0
while [ "$COUNT" -lt 450 ]; do
  if [ -f "$READY_FILE" ]; then
    if kill -0 "$NEW_PID" 2>/dev/null; then
      rm -rf "$BACKUP"
      rm -f "$READY_FILE"
      log "Update completed after the desktop readiness marker"
      exit 0
    fi
    rollback "updated application exited after writing readiness marker"
  fi
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    wait "$NEW_PID" 2>/dev/null || true
    rollback "updated application exited before becoming ready"
  fi
  COUNT=$((COUNT + 1))
  sleep 0.2
done
rollback "updated application did not become ready within 90 seconds"
"""
