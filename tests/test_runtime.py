from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from service_console import runtime
from service_console.runtime import (
    RuntimeConnection,
    load_runtime_connection,
    remove_runtime_connection,
    write_runtime_connection,
)


def connection(**overrides: object) -> RuntimeConnection:
    values: dict[str, object] = {
        "instance_id": "desktop-one",
        "pid": os.getpid(),
        "base_url": "http://127.0.0.1:43210",
        "token": "private-token",
        "started_at": "2026-08-28T00:00:00+00:00",
    }
    values.update(overrides)
    return RuntimeConnection(**values)  # type: ignore[arg-type]


def test_runtime_connection_round_trip_is_private_and_instance_scoped(tmp_path: Path) -> None:
    path = tmp_path / "controller.json"
    current = connection()

    write_runtime_connection(path, current)

    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_runtime_connection(path) == current
    assert remove_runtime_connection(path, "another-instance") is False
    assert path.exists()
    assert remove_runtime_connection(path, current.instance_id) is True
    assert not path.exists()


def test_runtime_connection_rejects_non_loopback_url(tmp_path: Path) -> None:
    path = tmp_path / "controller.json"

    with pytest.raises(ValueError, match="loopback"):
        write_runtime_connection(path, connection(base_url="https://example.com:443"))

    assert not path.exists()


@pytest.mark.skipif(os.name == "nt", reason="Windows does not expose POSIX permission bits")
def test_runtime_connection_rejects_exposed_permissions(tmp_path: Path) -> None:
    path = tmp_path / "controller.json"
    write_runtime_connection(path, connection())
    path.chmod(0o644)

    with pytest.raises(ValueError, match="permissions must be 0600"):
        load_runtime_connection(path)


def test_runtime_connection_ignores_stale_process(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "controller.json"
    write_runtime_connection(path, connection())

    monkeypatch.setattr(runtime, "_process_exists", lambda _pid: False)
    assert load_runtime_connection(path) is None


def test_runtime_connection_treats_permission_denied_process_as_live(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "controller.json"
    current = connection()
    write_runtime_connection(path, current)

    monkeypatch.setattr(runtime, "_process_exists", lambda _pid: True)
    assert load_runtime_connection(path) == current


def test_old_instance_does_not_remove_successor_descriptor(tmp_path: Path) -> None:
    path = tmp_path / "controller.json"
    successor = connection(instance_id="desktop-two", token="new-token")
    write_runtime_connection(path, successor)

    assert remove_runtime_connection(path, "desktop-one") is False
    assert load_runtime_connection(path) == successor


def test_live_desktop_instance_cannot_be_replaced(tmp_path: Path) -> None:
    path = tmp_path / "controller.json"
    current = connection(instance_id="desktop-one", token="current-token")
    successor = connection(instance_id="desktop-two", token="new-token")
    write_runtime_connection(path, current)

    with pytest.raises(ValueError, match="already active"):
        write_runtime_connection(path, successor)

    assert load_runtime_connection(path) == current


def test_runtime_connection_rejects_symbolic_link(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text("{}", encoding="utf-8")
    path = tmp_path / "controller.json"
    try:
        path.symlink_to(target)
    except OSError:
        pytest.skip("symbolic links are unavailable for this Windows runner")

    with pytest.raises(ValueError, match="regular file"):
        load_runtime_connection(path)


def test_windows_runtime_uses_msvcrt_lock_and_skips_posix_permissions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeMsvcrt:
        LK_LOCK = 1
        LK_UNLCK = 2

        def __init__(self) -> None:
            self.calls: list[tuple[int, int, int]] = []

        def locking(self, descriptor: int, mode: int, length: int) -> None:
            self.calls.append((mode, length, os.lseek(descriptor, 0, os.SEEK_CUR)))

    fake_msvcrt = FakeMsvcrt()
    monkeypatch.setattr(runtime, "_IS_WINDOWS", True)
    monkeypatch.setattr(runtime, "_msvcrt", fake_msvcrt)
    path = tmp_path / "controller.json"
    current = connection()

    write_runtime_connection(path, current)
    path.chmod(0o644)

    assert load_runtime_connection(path) == current
    assert fake_msvcrt.calls == [
        (fake_msvcrt.LK_LOCK, 1, 0),
        (fake_msvcrt.LK_UNLCK, 1, 0),
    ]
    assert path.with_name("controller.json.lock").read_bytes() == b"\0"
