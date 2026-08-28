"""JSON persistence for definitions and per-service logs."""

from __future__ import annotations

import json
import os
import tempfile
from collections import deque
from collections.abc import Iterable, Mapping
from pathlib import Path
from threading import RLock
from urllib.parse import quote

from .models import LogEntry, ServiceDefinition


class DefinitionStore:
    """Persist service definitions atomically below a selected data directory."""

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir).expanduser()
        self.definitions_path = self.data_dir / "services.json"
        self.logs_dir = self.data_dir / "logs"
        self._lock = RLock()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> dict[str, ServiceDefinition]:
        with self._lock:
            if not self.definitions_path.exists():
                return {}
            try:
                payload = json.loads(self.definitions_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError(f"failed to load service definitions: {exc}") from exc

        raw_services = payload.get("services", []) if isinstance(payload, dict) else payload
        if not isinstance(raw_services, list):
            raise ValueError("service definitions must contain a JSON list")

        definitions: dict[str, ServiceDefinition] = {}
        for raw_definition in raw_services:
            if not isinstance(raw_definition, dict):
                raise ValueError("each service definition must be a JSON object")
            definition = ServiceDefinition.from_dict(raw_definition)
            if definition.name in definitions:
                raise ValueError(f"duplicate service definition: {definition.name}")
            definitions[definition.name] = definition
        return definitions

    def save(
        self,
        definitions: Mapping[str, ServiceDefinition] | Iterable[ServiceDefinition],
    ) -> None:
        values = definitions.values() if isinstance(definitions, Mapping) else definitions
        payload = {
            "version": 1,
            "services": [definition.to_dict() for definition in sorted(values, key=lambda item: item.name)],
        }
        encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

        with self._lock:
            temporary_path: str | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    dir=self.data_dir,
                    prefix=".services-",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_path = temporary.name
                    temporary.write(encoded)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, self.definitions_path)
            finally:
                if temporary_path is not None:
                    Path(temporary_path).unlink(missing_ok=True)

    # Explicit aliases make the store usable without knowing its short method names.
    load_definitions = load
    save_definitions = save

    def append_log(self, service: str, entry: LogEntry) -> None:
        encoded = json.dumps(entry.to_dict(), ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            with self._log_path(service).open("a", encoding="utf-8") as log_file:
                log_file.write(encoded)
                log_file.write("\n")

    def load_logs(self, service: str, tail: int = 500) -> list[LogEntry]:
        if tail <= 0:
            return []
        log_path = self._log_path(service)
        if not log_path.exists():
            return []

        raw_lines: deque[str] = deque(maxlen=tail)
        with self._lock:
            try:
                with log_path.open("r", encoding="utf-8") as log_file:
                    raw_lines.extend(log_file)
            except OSError as exc:
                raise ValueError(f"failed to load logs for {service}: {exc}") from exc

        entries: list[LogEntry] = []
        for raw_line in raw_lines:
            try:
                payload = json.loads(raw_line)
                entries.append(LogEntry.from_dict(payload))
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                # One interrupted write should not hide all otherwise valid log history.
                continue
        return entries

    def delete_logs(self, service: str) -> None:
        with self._lock:
            self._log_path(service).unlink(missing_ok=True)

    def _log_path(self, service: str) -> Path:
        safe_name = quote(service, safe="")
        return self.logs_dir / f"{safe_name}.jsonl"
