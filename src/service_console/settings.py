"""Small, resilient persistence for local UI preferences."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock


class UiPreferencesStore:
    """Persist non-sensitive UI preferences below the controller data directory."""

    THEMES = frozenset({"system", "light", "dark"})

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir).expanduser()
        self.path = self.data_dir / "ui-preferences.json"
        self._lock = RLock()
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def load_theme(self) -> str:
        """Return a validated theme, falling back when the cosmetic file is unavailable."""

        with self._lock:
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return "system"
        theme = payload.get("theme") if isinstance(payload, dict) else None
        return theme if isinstance(theme, str) and theme in self.THEMES else "system"

    def save_theme(self, theme: str) -> None:
        """Atomically save one validated theme preference."""

        if theme not in self.THEMES:
            raise ValueError(f"unsupported UI theme: {theme}")
        encoded = json.dumps({"version": 1, "theme": theme}, ensure_ascii=False, indent=2) + "\n"

        with self._lock:
            temporary_path: str | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    dir=self.data_dir,
                    prefix=".ui-preferences-",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_path = temporary.name
                    temporary.write(encoded)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, self.path)
            finally:
                if temporary_path is not None:
                    Path(temporary_path).unlink(missing_ok=True)
