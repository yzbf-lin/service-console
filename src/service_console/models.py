"""Core data models for the service supervisor."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Mapping


class ServiceState(str, Enum):
    """Observable lifecycle states for a managed service."""

    STOPPED = "STOPPED"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    STOPPING = "STOPPING"
    EXITED = "EXITED"
    FAILED = "FAILED"


# RuntimeState is kept as a descriptive alias for callers that use the contract term.
RuntimeState = ServiceState


@dataclass(slots=True)
class ServiceDefinition:
    """Persistent definition of a command managed by the controller."""

    name: str
    command: str
    cwd: str = "."
    env: dict[str, str] = field(default_factory=dict)
    auto_start: bool = False
    stop_timeout: float = 5.0

    def __post_init__(self) -> None:
        self.name = str(self.name).strip()
        self.command = str(self.command).strip()
        self.cwd = str(self.cwd)
        self.env = {str(key): str(value) for key, value in self.env.items()}
        self.auto_start = bool(self.auto_start)
        self.stop_timeout = float(self.stop_timeout)

        if not self.name:
            raise ValueError("service name must not be empty")
        if "\x00" in self.name:
            raise ValueError("service name must not contain a null byte")
        if not self.command:
            raise ValueError("service command must not be empty")
        if not self.cwd:
            raise ValueError("service cwd must not be empty")
        if self.stop_timeout < 0:
            raise ValueError("stop_timeout must be greater than or equal to zero")

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "command": self.command,
            "cwd": self.cwd,
            "env": dict(self.env),
            "auto_start": self.auto_start,
            "stop_timeout": self.stop_timeout,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> ServiceDefinition:
        return cls(
            name=value["name"],
            command=value["command"],
            cwd=value.get("cwd", "."),
            env=dict(value.get("env") or {}),
            auto_start=value.get("auto_start", False),
            stop_timeout=value.get("stop_timeout", 5.0),
        )


@dataclass(slots=True)
class LogEntry:
    """One stdout or stderr line emitted by a service."""

    timestamp: str
    stream: str
    message: str

    @classmethod
    def create(cls, stream: str, message: str) -> LogEntry:
        return cls(timestamp=datetime.now(UTC).isoformat(), stream=stream, message=message)

    def to_dict(self) -> dict[str, str]:
        return {
            "timestamp": self.timestamp,
            "stream": self.stream,
            "message": self.message,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> LogEntry:
        return cls(
            timestamp=str(value["timestamp"]),
            stream=str(value["stream"]),
            message=str(value["message"]),
        )


@dataclass(slots=True)
class ServiceRuntime:
    """Mutable runtime values associated with a service definition."""

    state: ServiceState = ServiceState.STOPPED
    pid: int | None = None
    exit_code: int | None = None
    started_at: str | None = None
    stopped_at: str | None = None
    cpu_percent: float = 0.0
    memory_rss: int = 0
    restart_count: int = 0
    last_error: str | None = None

    def to_dict(
        self,
        definition: ServiceDefinition,
        *,
        uptime_seconds: float = 0.0,
    ) -> dict[str, Any]:
        return {
            **definition.to_dict(),
            "state": self.state.value,
            "pid": self.pid,
            "exit_code": self.exit_code,
            "started_at": self.started_at,
            "stopped_at": self.stopped_at,
            "cpu_percent": self.cpu_percent,
            "memory_rss": self.memory_rss,
            "uptime_seconds": uptime_seconds,
            "restart_count": self.restart_count,
            "last_error": self.last_error,
        }


def utc_now() -> str:
    """Return an ISO-8601 UTC timestamp suitable for JSON payloads."""

    return datetime.now(UTC).isoformat()
