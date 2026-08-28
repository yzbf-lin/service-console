from __future__ import annotations

import json

import pytest

from service_console.settings import UiPreferencesStore


def test_ui_preferences_default_and_atomic_round_trip(tmp_path) -> None:
    store = UiPreferencesStore(tmp_path)

    assert store.load_theme() == "system"
    store.save_theme("dark")

    assert UiPreferencesStore(tmp_path).load_theme() == "dark"
    assert json.loads((tmp_path / "ui-preferences.json").read_text(encoding="utf-8")) == {
        "version": 1,
        "theme": "dark",
    }
    assert not list(tmp_path.glob(".ui-preferences-*.tmp"))


def test_ui_preferences_ignore_corruption_and_reject_unknown_themes(tmp_path) -> None:
    store = UiPreferencesStore(tmp_path)
    store.path.write_text("not-json", encoding="utf-8")

    assert store.load_theme() == "system"
    with pytest.raises(ValueError, match="unsupported UI theme"):
        store.save_theme("sepia")
