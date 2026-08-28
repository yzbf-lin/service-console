<p align="center">
  <img src="docs/assets/service-console-icon.png" width="160" alt="Service Console icon">
</p>

<h1 align="center">Service Console</h1>

<p align="center">
  Run and supervise local development services — without containers.
</p>

<p align="center">
  Desktop · Web · CLI · TUI · Isolated logs · Port inspection · Remote control
</p>

<p align="center">
  <img alt="Python 3.12+" src="https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white">
  <img alt="macOS, Windows, and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555555">
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2ea44f">
</p>

<p align="center"><a href="README.zh-CN.md">简体中文</a></p>

Service Console is a native-process supervisor for development workflows. Register any host command
once, then start, stop, restart, monitor, and inspect its isolated logs from a desktop app, browser
dashboard, command-line client, or terminal UI. It launches ordinary processes directly instead of
requiring Docker or another container runtime.

## Highlights

- Register commands with a working directory, environment variables, auto-start policy, and graceful
  stop timeout.
- Start, stop, restart, edit, copy, remove, and inspect services from compact service cards.
- Track PID, uptime, exit code, restart count, CPU, and memory.
- Capture stdout and stderr in independent persistent logs and bounded live buffers.
- Render ANSI output with xterm.js search, selection, links, wrapping, and scrollback.
- Inspect listening ports and safely terminate their owning processes with PID/port verification.
- Discover the current user's running processes, including workers without ports, and prefill service
  definitions from restored `uv`/`pnpm` commands and working directories.
- Use the same controller through the desktop app, Web UI, CLI, TUI, HTTP, or WebSocket.
- Use a compact Next.js dashboard built with React, TypeScript, Tailwind CSS, shadcn/ui, Radix UI,
  and Lucide React, with persistent light and dark themes.
- Keep desktop automation private with a random loopback port, temporary bearer token, and a `0600`
  runtime descriptor.

### Appearance

The dashboard is a statically exported Next.js application. Its reusable components follow
shadcn/ui conventions, use Radix UI accessibility primitives, Tailwind CSS design tokens, and Lucide
React icons. Use the sun/moon button in the top bar to switch themes without reloading. The first
visit follows the operating-system color scheme; an explicit choice is saved in the controller data
directory as `ui-preferences.json`, so it survives desktop restarts and random loopback ports. The
selected palette also updates the xterm.js log console and browser theme-color metadata.

Supabase is an optional cloud adapter. To make a Supabase client available to future authentication
or state-sync integrations, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` at
build time. Local start, stop, restart, logging, and port operations always remain on the FastAPI
controller and work without Supabase.

## Requirements

| Purpose | Requirement |
|---|---|
| Controller, CLI, TUI | Python 3.12+ and [uv](https://docs.astral.sh/uv/) |
| Web asset development | Node.js 22+ and pnpm 11 |
| Native desktop window | macOS, Windows, or a Linux environment supported by pywebview |
| macOS `.app` build | macOS, Xcode command-line tools, Node.js, pnpm, and uv |
| Windows `.exe` build | Windows, PowerShell 7, Node.js, pnpm, and uv |

## Quick start

```bash
git clone https://github.com/yzbf-lin/service-console.git
cd service-console
uv sync --all-groups
uv run service-console-desktop
```

The desktop app starts a private FastAPI controller on a random loopback port and opens the dashboard
in a native pywebview window. Definitions and logs are stored in `~/.service-console` by default.

Register and control a native service:

```bash
uv run service-console add api \
  --command "uv run backend/run.py" \
  --cwd /path/to/project

uv run service-console start api
uv run service-console restart api
uv run service-console logs api --tail 200 --follow
```

When `--url` is omitted, the CLI automatically discovers the running desktop controller. Explicit
`--url` and `--token` options, or their environment variables, always take precedence.

### Add a service from a running process

Open **Add service** and select the **Running processes** tab to search by name, command, or PID. For a
listening process, the plus button in **Ports and processes** opens the same form with its definition
prefilled. Review and edit the inferred name, command, working directory, and allow-listed environment
variables before saving.

This creates configuration from the process; it does not reconnect to that process's existing stdout
or stderr pipes. Stop the original process before starting the saved service in Service Console to
avoid a duplicate instance or port conflict. Log capture begins with the first managed start. Token,
password, secret, and API-key command arguments are redacted and require manual confirmation.

## CLI reference

| Operation | Command |
|---|---|
| List services and status | `service-console list` |
| Start a service | `service-console start SERVICE` |
| Stop a service | `service-console stop SERVICE` |
| Restart a service | `service-console restart SERVICE` |
| Read or follow logs | `service-console logs SERVICE --tail 200 --follow` |
| Open the terminal UI | `service-console tui` |
| Inspect listening ports | `service-console ports --port PORT` |
| Gracefully terminate an owner | `service-console kill-process PID --port PORT --timeout 3` |
| Force termination after timeout | `service-console kill-process PID --port PORT --force` |

Run `service-console --help` for all options.

## Browser controller

The standalone controller is useful on Linux, headless machines, or when a browser UI is preferred:

```bash
uv run service-console serve --host 127.0.0.1 --port 8787
```

Open <http://127.0.0.1:8787>. The controller owns its child process groups. Closing the last desktop
window or stopping the controller normally triggers graceful shutdown of all managed processes.
Force-quitting or killing the controller can leave child processes behind, so inspect ports before
starting replacements.

Do not run `service-console serve` and `service-console-desktop` against the same data directory at
the same time.

## Desktop discovery and security

The desktop controller always listens on loopback. Once ready, it writes its random URL, PID,
instance ID, and temporary token to `~/.service-console/controller.json` with mode `0600`. The
descriptor is removed during graceful shutdown. A process lock prevents two live desktop instances
from silently replacing each other's descriptor.

Registered commands are trusted local configuration and run with the same OS permissions as the
controller. Keep localhost as the default. For remote access, require a strong token and terminate TLS
in front of the controller:

```bash
uv run service-console serve \
  --host 0.0.0.0 \
  --port 8787 \
  --token "$SERVICE_CONSOLE_TOKEN"

service-console \
  --url https://HOST:PORT \
  --token "$SERVICE_CONSOLE_TOKEN" \
  list
```

Never expose an unauthenticated controller to an untrusted network.

## Build the macOS application

```bash
./scripts/build-macos-app.sh
open "dist/Service Console.app"
```

The build script:

1. regenerates the multi-resolution ICNS icon from `assets/service-console-icon-1024.png`;
2. builds and statically exports the Next.js dashboard into the Python package;
3. installs the desktop dependency group;
4. bundles CPython, pywebview, FastAPI, and the complete dashboard with PyInstaller;
5. synchronizes the bundle version with `pyproject.toml` and applies an ad-hoc signature.

The resulting app runs without Node.js or network access. It matches the build machine architecture;
the current build has been tested on Apple Silicon. It is ad-hoc signed and not notarized with an
Apple Developer ID, so downloaded builds may trigger a Gatekeeper warning. `dist/` is intentionally
ignored; publish distributable binaries through GitHub Releases.

## Build the Windows application

Run the PowerShell build on Windows:

```powershell
pwsh ./scripts/build-windows-app.ps1
& "dist/Service Console/Service Console.exe" --help
```

The script generates a multi-resolution ICO icon, builds the same offline dashboard, and creates a
PyInstaller directory bundle at `dist/Service Console`. Windows 10/11 must have the Microsoft Edge
WebView2 Runtime installed. The executable is unsigned, so Windows may show a SmartScreen warning
until the project is configured with a trusted code-signing certificate.

## Publish release packages

The `Release` GitHub Actions workflow builds an Apple Silicon macOS ZIP and a Windows x64 ZIP. A tag
matching the version in `pyproject.toml` publishes both packages and `SHA256SUMS.txt` to GitHub
Releases:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow can also be started manually to build downloadable Actions artifacts without creating
a GitHub Release.

## Web application and terminal assets

The interface uses Next.js, React, TypeScript, Tailwind CSS, shadcn/ui-style components, Radix UI,
Lucide React, and an xterm.js console with Fit, Search, and WebLinks addons. Runtime assets are
statically exported into the Python package and never loaded from a CDN:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:web
pnpm run lint:web
pnpm run test:web
pnpm run build:web-assets
```

The log console is read-only rather than an interactive PTY. Full-screen curses applications and
stdin prompts are outside its scope.

## HTTP and WebSocket control

The authenticated `/ws/events` stream emits status and log events and accepts lifecycle commands:

```json
{"id":"request-1","action":"restart","service":"api"}
```

The matching response preserves the request ID:

```json
{"type":"command_result","id":"request-1","action":"restart","service":"api","ok":true,"data":{}}
```

See [CONTRACT.md](CONTRACT.md) for the complete controller contract.

## FastAPI + Vite + Celery example

The repository includes a concrete native profile for supervising a FastAPI backend, Vite frontend,
Celery worker, and Celery beat. See [examples/pd-qa-backend.md](examples/pd-qa-backend.md). Beat is
kept explicit in that workflow to avoid accidental duplicate scheduling.

## Development

```bash
uv sync --group dev
pnpm install --frozen-lockfile
pnpm run build:web-assets
uv run pytest
```

Architecture and API invariants are documented in [CONTRACT.md](CONTRACT.md). Contributions are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
