# Rust/Tauri rewrite

## Runtime architecture

Service Console keeps the statically exported Next.js dashboard. All native runtime components are
Rust workspace binaries:

- `service-console-desktop`: Tauri 2 desktop shell and private loopback controller owner.
- `service-console`: standalone Axum controller, HTTP client, CLI, and terminal UI.
- `service-console-mcp`: stdio MCP bridge that discovers the private desktop controller.
- `service-console-guardian`: independent process-lease guardian for crash cleanup.
- `service-console-updater`: one-release Rust compatibility helper for the Windows 0.3.x updater.
- `service-console-release-manifest`: release-only manifest and Ed25519 signature generator.

The packaged application has no Python, Node.js, or external runtime dependency. Node.js and pnpm
are build-time tools for producing the static dashboard only.

## Implemented cutover

- Validated service models, atomic JSON persistence, and compatible existing data-directory loading.
- Process-group or Windows Job Object ownership, graceful/forced stop, restart, stdout/stderr
  capture, persistent JSONL logs, bounded live logs, resource sampling, auto-start, and status/log
  broadcasts.
- Persistent guardian leases, controller-crash cleanup, PID identity checks, and stale-lease recovery.
- Bearer-authenticated Axum HTTP API, lifecycle WebSocket, embedded dashboard, controller discovery,
  port inspection, process discovery/redaction, and guarded process termination.
- Jenkins keyring-backed instances, jobs, builds, queues, progressive logs, crumb handling, and
  bounded dynamic-parameter/form parsing.
- Tauri desktop lifecycle, Rust CLI/TUI, stdio MCP bridge, Codex MCP registration, and MCP self-test.
- Ed25519 update verification, bounded package download, safe archive extraction, external helper
  handoff, atomic replacement, readiness confirmation, backup, and rollback.
- A 0.4.0 transition contract that preserves the legacy macOS bundle identifier and desktop entry
  name, plus the legacy Windows package filenames and helper arguments required by 0.3.x clients.
- Rust-only CI and release jobs for macOS and Windows, including native tests and Tauri bundles.

The old `pyproject.toml`, Python package, Python tests, PyInstaller scripts, and Python lockfile were
removed after the Rust runtime, release pipeline, and core HTTP/WebSocket/lifecycle contract tests
were in place.

## Compatibility and validation boundaries

The persistent service definitions, logs, UI preferences, controller descriptor, and public endpoint
names remain compatible with the previous implementation. Validation errors now follow Axum/Rust
semantics in a few malformed-request edge cases, so clients should rely on the documented status
classes and `detail` message rather than FastAPI-specific 422 response internals.

macOS development and bundle tests run locally. Windows Job Object, NSIS, and updater behavior must
be validated by the native Windows CI runner because a macOS host does not provide the Windows SDK.
Release artifacts are still ad-hoc signed on macOS and unsigned on Windows; Developer ID
notarization and Authenticode signing remain release-infrastructure work, not runtime migration work.
