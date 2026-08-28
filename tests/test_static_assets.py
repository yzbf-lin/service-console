from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from fastapi.testclient import TestClient

from service_console.api import create_app


class StaticAssetManager:
    async def initialize(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass


class AssetReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: set[str] = set()

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name in {"href", "src"} and value:
                self.references.add(value)


def _asset_references(html: str) -> set[str]:
    parser = AssetReferenceParser()
    parser.feed(html)
    return parser.references


def test_dashboard_serves_hashed_next_assets_without_a_cdn(tmp_path: Path) -> None:
    app = create_app(data_dir=tmp_path, manager=StaticAssetManager())

    with TestClient(app) as client:
        index = client.get("/")
        references = _asset_references(index.text)
        local_assets = sorted(reference for reference in references if reference.startswith("/static/"))
        next_assets = [reference for reference in local_assets if reference.startswith("/static/_next/")]
        responses = {
            reference: client.get(urlsplit(reference).path)
            for reference in local_assets
        }
        licenses = client.get("/static/THIRD_PARTY_LICENSES.txt")

    assert index.status_code == 200
    assert index.headers["cache-control"] == "no-store"
    assert "__SERVICE_CONSOLE_THEME__" not in index.text
    assert 'data-theme-preference="system"' in index.text
    assert next_assets
    assert any(urlsplit(reference).path.endswith(".js") for reference in next_assets)
    assert any(urlsplit(reference).path.endswith(".css") for reference in next_assets)
    assert not any(reference.startswith("/_next/") for reference in references)

    for reference in references:
        parsed = urlsplit(reference)
        assert parsed.scheme not in {"http", "https"}, f"external asset referenced: {reference}"
        assert not reference.startswith("//"), f"protocol-relative asset referenced: {reference}"

    for reference, response in responses.items():
        assert response.status_code == 200, reference
        path = urlsplit(reference).path
        if path.endswith(".js"):
            assert "javascript" in response.headers["content-type"]
        elif path.endswith(".css"):
            assert response.headers["content-type"].startswith("text/css")

    assert licenses.status_code == 200
    assert "next@" in licenses.text.lower()
    assert "react@" in licenses.text.lower()
    assert "@radix-ui/react-dialog@" in licenses.text.lower()
    assert "@supabase/auth-js@" in licenses.text.lower()
    assert "scheduler@" in licenses.text.lower()


def test_dashboard_injects_persistent_theme_into_next_shell(tmp_path: Path) -> None:
    static_index = (
        Path(__file__).parents[1] / "src" / "service_console" / "static" / "index.html"
    ).read_text(encoding="utf-8")
    assert "__SERVICE_CONSOLE_THEME__" in static_index

    app = create_app(data_dir=tmp_path, manager=StaticAssetManager())
    with TestClient(app) as client:
        initial = client.get("/")
        saved = client.put("/api/ui-preferences", json={"theme": "dark"})
        restored = client.get("/")

    assert initial.status_code == 200
    assert 'data-theme-preference="system"' in initial.text
    assert saved.status_code == 200
    assert saved.json() == {"theme": "dark"}
    assert restored.status_code == 200
    assert "__SERVICE_CONSOLE_THEME__" not in restored.text
    assert 'data-theme-preference="dark"' in restored.text
