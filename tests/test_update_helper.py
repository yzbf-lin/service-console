from __future__ import annotations

import json
from pathlib import Path

import pytest

import service_console.update_helper as helper


class FakeProcess:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.return_code: int | None = None
        self.terminated = False

    def poll(self) -> int | None:
        return self.return_code

    def terminate(self) -> None:
        self.terminated = True
        self.return_code = 0

    def kill(self) -> None:
        self.return_code = -9

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self.return_code or 0


def _application_trees(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "prepared" / "Service Console"
    source.mkdir(parents=True)
    (source / "Service Console.exe").write_bytes(b"new-desktop")
    (source / "Service Console Updater.exe").write_bytes(b"new-updater")
    (source / "new-version.txt").write_text("0.2.2", encoding="utf-8")

    target = tmp_path / "installed" / "Service Console"
    target.mkdir(parents=True)
    (target / "Service Console.exe").write_bytes(b"old-desktop")
    (target / "old-version.txt").write_text("0.2.1", encoding="utf-8")
    return source, target


def test_apply_update_replaces_directory_and_waits_for_new_application_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, target = _application_trees(tmp_path)
    ready_file = tmp_path / "state" / "install-update.ready"
    started_file = tmp_path / "state" / "install-update.started"
    log_file = tmp_path / "state" / "install-update.log"
    launches: list[tuple[Path, Path | None, str]] = []

    monkeypatch.setattr(helper, "_wait_for_process_exit", lambda _process_id: None)

    def fake_start(
        executable: Path,
        application_root: Path,
        *,
        ready_file: Path | None,
        restart_arguments: str,
        log_file: Path,
    ) -> FakeProcess:
        del log_file
        launches.append((executable, ready_file, restart_arguments))
        assert application_root == target
        assert executable.read_bytes() == b"new-desktop"
        assert ready_file is not None
        ready_file.parent.mkdir(parents=True, exist_ok=True)
        ready_file.write_text("ready", encoding="utf-8")
        return FakeProcess(9001)

    monkeypatch.setattr(helper, "_start_application", fake_start)

    helper.apply_update(
        process_id=1234,
        source=source,
        target=target,
        launch_relative="Service Console.exe",
        ready_file=ready_file,
        started_file=started_file,
        log_file=log_file,
        restart_arguments="encoded-arguments",
        ready_timeout=0.1,
    )

    assert (target / "Service Console.exe").read_bytes() == b"new-desktop"
    assert (target / "new-version.txt").read_text(encoding="utf-8") == "0.2.2"
    assert not (target / "old-version.txt").exists()
    assert not target.with_name("Service Console.update-new").exists()
    assert not target.with_name("Service Console.update-backup").exists()
    assert launches == [(target / "Service Console.exe", ready_file, "encoded-arguments")]
    assert json.loads(started_file.read_text(encoding="utf-8"))["pid"] > 0
    assert not ready_file.exists()
    assert "Update completed after the desktop readiness marker" in log_file.read_text(
        encoding="utf-8"
    )


def test_apply_update_rolls_back_and_relaunches_previous_application(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, target = _application_trees(tmp_path)
    ready_file = tmp_path / "state" / "install-update.ready"
    started_file = tmp_path / "state" / "install-update.started"
    log_file = tmp_path / "state" / "install-update.log"
    launches: list[tuple[bytes, Path | None]] = []

    monkeypatch.setattr(helper, "_wait_for_process_exit", lambda _process_id: None)

    def fake_start(
        executable: Path,
        application_root: Path,
        *,
        ready_file: Path | None,
        restart_arguments: str,
        log_file: Path,
    ) -> FakeProcess:
        del application_root, restart_arguments, log_file
        launches.append((executable.read_bytes(), ready_file))
        return FakeProcess(9001 + len(launches))

    def fail_readiness(*_args: object) -> None:
        raise helper.UpdateHelperError("readiness probe failed")

    monkeypatch.setattr(helper, "_start_application", fake_start)
    monkeypatch.setattr(helper, "_wait_for_readiness", fail_readiness)

    with pytest.raises(helper.UpdateHelperError, match="readiness probe failed"):
        helper.apply_update(
            process_id=1234,
            source=source,
            target=target,
            launch_relative="Service Console.exe",
            ready_file=ready_file,
            started_file=started_file,
            log_file=log_file,
            restart_arguments="encoded-arguments",
            ready_timeout=0.1,
        )

    assert (target / "Service Console.exe").read_bytes() == b"old-desktop"
    assert (target / "old-version.txt").read_text(encoding="utf-8") == "0.2.1"
    assert not (target / "new-version.txt").exists()
    assert not target.with_name("Service Console.update-new").exists()
    assert not target.with_name("Service Console.update-backup").exists()
    assert launches == [(b"new-desktop", ready_file), (b"old-desktop", None)]
    assert "Update failed: readiness probe failed" in log_file.read_text(encoding="utf-8")
    assert "Rollback restored and relaunched the previous version" in log_file.read_text(
        encoding="utf-8"
    )


@pytest.mark.parametrize(
    "launch_relative",
    ["../Service Console.exe", r"C:\\Service Console.exe", r"C:Service Console.exe"],
)
def test_apply_update_rejects_unsafe_launch_paths(
    tmp_path: Path,
    launch_relative: str,
) -> None:
    source, target = _application_trees(tmp_path)
    started_file = tmp_path / "state" / "install-update.started"

    with pytest.raises(helper.UpdateHelperError, match="safe relative path"):
        helper.apply_update(
            process_id=1234,
            source=source,
            target=target,
            launch_relative=launch_relative,
            ready_file=tmp_path / "state" / "install-update.ready",
            started_file=started_file,
            log_file=tmp_path / "state" / "install-update.log",
            restart_arguments="encoded-arguments",
        )

    assert not started_file.exists()
