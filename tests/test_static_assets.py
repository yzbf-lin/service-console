from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from service_console.api import create_app


class StaticAssetManager:
    async def initialize(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass


def test_dashboard_serves_local_xterm_assets(tmp_path: Path) -> None:
    app = create_app(data_dir=tmp_path, manager=StaticAssetManager())

    with TestClient(app) as client:
        index = client.get("/")
        bundle = client.get("/static/vendor/xterm-bundle.js")
        stylesheet = client.get("/static/vendor/xterm.css")
        component_stylesheet = client.get("/static/vendor/tabler.min.css")
        favicon = client.get("/static/favicon.svg")
        licenses = client.get("/static/vendor/THIRD_PARTY_LICENSES.txt")

    assert index.status_code == 200
    assert '/static/vendor/xterm.css' in index.text
    assert '/static/vendor/xterm-bundle.js' in index.text
    assert 'src="http://' not in index.text
    assert 'src="https://' not in index.text
    assert 'href="http://' not in index.text
    assert 'href="https://' not in index.text

    assert bundle.status_code == 200
    assert "javascript" in bundle.headers["content-type"]
    assert "ServiceConsoleTerminal" in bundle.text
    assert stylesheet.status_code == 200
    assert stylesheet.headers["content-type"].startswith("text/css")
    assert ".xterm" in stylesheet.text
    assert "@import" not in stylesheet.text
    assert component_stylesheet.status_code == 200
    assert component_stylesheet.headers["content-type"].startswith("text/css")
    assert "--tblr-primary" in component_stylesheet.text
    assert favicon.status_code == 200
    assert favicon.headers["content-type"].startswith("image/svg+xml")
    assert '<link rel="icon" href="/static/favicon.svg"' in index.text
    assert licenses.status_code == 200
    assert "bootstrap@5.3.7" in licenses.text
    assert "@xterm/xterm@6.0.0" in licenses.text
    assert "@tabler/core@1.4.0" in licenses.text


def test_dashboard_wires_persistent_light_and_dark_themes() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "service_console" / "static"
    application = (static_dir / "app.js").read_text(encoding="utf-8")
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    stylesheet = (static_dir / "styles.css").read_text(encoding="utf-8")

    assert '/static/vendor/tabler.min.css' in index
    assert 'id="themeToggleButton"' in index
    assert '<dialog class="service-dialog modal-content"' not in index
    assert 'data-theme-preference="system"' in index
    assert 'data-bs-theme' in index
    assert 'service-console:theme' not in application
    assert 'apiRequest("/api/ui-preferences"' in application
    assert 'function applyTheme(' in application
    assert 'terminal.options.theme' in application
    assert ':root[data-bs-theme="dark"]' in stylesheet


def test_dashboard_wires_read_only_xterm_addons() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "service_console" / "static"
    application = (static_dir / "app.js").read_text(encoding="utf-8")
    index = (static_dir / "index.html").read_text(encoding="utf-8")

    assert "disableStdin: true" in application
    assert "new FitAddon()" in application
    assert "new SearchAddon()" in application
    assert "new WebLinksAddon(openTerminalLink)" in application
    assert "terminal.scrollToBottom()" in application
    assert 'document.querySelector("#xtermHost")' in application
    assert 'id="terminalSearchInput"' in index
    assert 'id="logLines"' not in index


def test_dashboard_wires_service_edit_and_copy_actions() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "service_console" / "static"
    application = (static_dir / "app.js").read_text(encoding="utf-8")
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    stylesheet = (static_dir / "styles.css").read_text(encoding="utf-8")

    assert "function openServiceForm(mode, serviceName = null)" in application
    assert "function nextCopyName(sourceName)" in application
    assert 'actionButton("edit", "编辑服务"' in application
    assert 'actionButton("copy", "复制服务"' in application
    assert 'method: "PUT"' in application
    assert 'method: "POST"' in application
    assert 'id="serviceDialog"' in index
    assert 'id="serviceNameInput"' in index
    assert "随控制台自动启动" in index
    assert "创建后自动启动" not in index
    assert ".service-definition-actions" in stylesheet
    assert ".action-button-icon" in stylesheet
