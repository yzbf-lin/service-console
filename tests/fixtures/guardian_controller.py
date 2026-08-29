from __future__ import annotations

import asyncio
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

from service_console.manager import ServiceManager
from service_console.models import ServiceDefinition


def python_command(source: str) -> str:
    arguments = [sys.executable, "-u", "-c", source]
    return subprocess.list2cmdline(arguments) if os.name == "nt" else shlex.join(arguments)


async def run(data_dir: Path) -> None:
    workload_pid_file = data_dir / "workload.pid"
    manager = ServiceManager(data_dir, monitor_interval=0.05)
    await manager.add_service(
        ServiceDefinition(
            name="crash-fixture",
            command=python_command(
                "import os, pathlib, time; "
                f"pathlib.Path({str(workload_pid_file)!r}).write_text(str(os.getpid())); "
                "time.sleep(60)"
            ),
            cwd=str(data_dir),
            stop_timeout=0.25,
        )
    )
    service = await manager.start("crash-fixture")
    deadline = asyncio.get_running_loop().time() + 5.0
    workload_pid: int | None = None
    while workload_pid is None:
        if asyncio.get_running_loop().time() >= deadline:
            raise RuntimeError("workload did not publish its PID")
        try:
            workload_pid = int(workload_pid_file.read_text().strip())
        except (FileNotFoundError, ValueError):
            await asyncio.sleep(0.02)
    print(
        json.dumps(
            {
                "controller_pid": os.getpid(),
                "launcher_pid": service["pid"],
                "workload_pid": workload_pid,
            }
        ),
        flush=True,
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(run(Path(sys.argv[1]).resolve()))
