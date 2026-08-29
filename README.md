<p align="center">
  <img src="docs/assets/service-console-icon.png" width="160" alt="Service Console icon">
</p>

<h1 align="center">Service Console</h1>

<p align="center">
  Run and supervise local development services — without containers.
</p>

<p align="center">
  Desktop · Web · CLI · TUI · MCP · Isolated logs · Port inspection · Remote control
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

<p align="center">
  <img src="docs/assets/screenshots/service-control.png" width="100%" alt="Service Console service control workspace">
</p>

<p align="center">
  <sub>Service list, live xterm.js output, lifecycle controls, and runtime metrics in one compact workspace.</sub>
</p>

## Highlights

- Register commands with a working directory, environment variables, auto-start policy, and graceful
  stop timeout.
- Use a fixed JetBrains-style icon rail with hover and keyboard-focus labels, while service items and
  service-specific actions remain inside the compact service workspace.
- Start, stop, restart, edit, copy, remove, and inspect services from the service list, live console,
  and runtime details panes.
- Track PID, uptime, exit code, restart count, CPU, and memory.
- Capture stdout and stderr in independent persistent logs and bounded live buffers.
- Render ANSI output with xterm.js search, selection, links, wrapping, and scrollback.
- Inspect listening ports and safely terminate their owning processes with PID/port verification.
- Configure multiple Jenkins controllers, switch between instance items, browse folders and jobs,
  inspect queues/builds/logs, and trigger, stop, or cancel work without leaving the desktop app.
- Discover new desktop releases automatically, verify an Ed25519-signed manifest and package SHA-256,
  then install and restart only after explicit confirmation.
- Discover the current user's running processes, including workers without ports, and prefill service
  definitions from restored `uv`/`pnpm` commands and working directories, with safe manual fallback
  when Windows denies access to complete metadata.
- Use the same controller through the desktop app, Web UI, CLI, TUI, HTTP, or WebSocket.
- Use a compact Next.js dashboard built with React, TypeScript, Tailwind CSS, shadcn/ui, Radix UI,
  and Lucide React, with persistent light and dark themes.
- Keep desktop automation private with a random loopback port, temporary bearer token, and a `0600`
  runtime descriptor.
- Let Codex and other AI clients configure and operate services through the bundled stdio MCP bridge.

## Feature tour

The screenshots below use isolated, anonymized demo processes. No personal service definitions,
credentials, or production logs are included.

### Create a service from a running process

<p align="center">
  <img src="docs/assets/screenshots/add-service.png" width="100%" alt="Create a Service Console definition from a running process">
</p>

Search by process name, command, or PID, then copy the inferred command and working directory into an
editable service definition. Existing stdout and stderr are not attached; managed log capture begins
the next time Service Console starts the saved command.

### Inspect ports and process ownership

<p align="center">
  <img src="docs/assets/screenshots/ports-processes.png" width="100%" alt="Inspect listening ports and owning processes">
</p>

Filter by port, expand grouped TCP/UDP listeners, create a service from the owning process, or
terminate it after Service Console verifies both the PID and expected port.

### Manage multiple Jenkins instances

Open **Jenkins** in the main sidebar to add one or more controllers. Each instance appears as a
separate item with its display name, host, enabled state, and current connection result. Selecting an
item switches the folder/job list, build history, queue, details, and console log to that controller;
the most recently selected instance is restored on the same computer. On narrow windows, the same
workspace uses single-panel tabs instead of rendering several heavy panels at once.

The Jenkins workspace supports job search, Folder navigation, ordinary and parameterized builds,
build status/history, stop, queue cancellation, and progressive console output. These records are
queried on demand through the local Service Console controller; they are not copied into a second
local Jenkins database. Switching the UI item never changes an in-flight MCP operation because every
Jenkins API and MCP call carries an explicit instance ID.

Build links are opened through the selected instance's configured Web address, even when Jenkins
reports an internal host or default port. The console viewer supports Cmd/Ctrl+F search with
previous/next navigation, native selection copy, a copy-selection button, and one-click copy-all as
plain text. Progressive updates preserve the active search and selection.

For ordinary parameterized builds, leaving a password blank omits it from `buildWithParameters` so
Jenkins can apply its configured default. A true Jenkins file-upload parameter remains unsupported
and disables local triggering. The File System List plugin is different: its value is a server-side
artifact choice, not an upload, so Service Console supports its single-select mode. The plugin renders
some filesystem errors as an ordinary, localized single option with no machine-readable error flag.
Service Console therefore treats a one-item list without an explicitly selected/configured default as
ambiguous and keeps local triggering disabled; set a valid default in Jenkins or run that case there.

Parameter discovery supports both the Jenkins core `property` export and the compatible `actions`
export. Static choices and Git Parameter `allValueItems` come from the Remote API. Active Choices and
File System List options are not exported consistently, so the controller reads a bounded copy of the
job's Jenkins build form only when **Run** is opened, extracts its server-rendered selects, and refreshes
and validates them again immediately before queuing. Hidden parameters are never returned to the UI
and use the value supplied by the same Jenkins form; separators are display-only. Form-backed plugin
jobs use Jenkins' classic structured `/build` request for compatibility with older plugins, while
ordinary jobs continue to use `buildWithParameters`.

Radio controls, multi-select, reactive/cascade Active Choices, and true upload parameters remain
disabled with an explicit explanation. Reactive choices stay in Jenkins until dependency-aware refresh is available.
A form-backed job that also has a password parameter requires the password to be entered, because
the classic form cannot safely recover an unread secret default. Dynamic option discovery uses the
authenticated job's read-only build-form page; Jenkins enforces `Job/Build` when the subsequent POST
queues the build, so discovering choices is not itself a build-permission test. Keep Jenkins and the
Git Parameter, Active Choices, and File System List plugins on security-fixed versions. Malformed,
truncated, stale, or structurally incompatible option data is rejected instead of falling back to an
arbitrary text value.

### Persist appearance preferences

<p align="center">
  <img src="docs/assets/screenshots/settings.png" width="100%" alt="Service Console theme, signed updates, and connection settings">
</p>

Follow the operating system or select a persistent light or dark theme. The same page shows the
installed version, checks for signed updates, and guides download and restart. Optional Supabase
connection settings remain separate from the local FastAPI controller and are not required locally.

### Appearance

The dashboard is a statically exported Next.js application. Its reusable components follow
shadcn/ui conventions, use Radix UI accessibility primitives, Tailwind CSS design tokens, and Lucide
React icons. Use the sun/moon button in the top bar to switch themes without reloading. The first
visit follows the operating-system color scheme; an explicit choice is saved in the controller data
directory as `ui-preferences.json`, so it survives desktop restarts and random loopback ports. The
selected palette also updates the xterm.js log console and browser theme-color metadata.

On desktop, the left rail is a fixed icon-only tool window bar inspired by JetBrains IDEs. Hover an icon
or move keyboard focus to it to reveal its destination name. Service cards, filters, and **Add** stay in
the **Services** content area, matching the content-owned layout used by the Jenkins workspace. On
mobile, the rail becomes a labeled bottom navigation and the service selector keeps the Add action in
its own toolbar.

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

When the frozen macOS app is opened from Finder, Service Console captures the user's interactive
login-shell environment once during desktop startup. Managed services therefore resolve Homebrew,
`uv`, pnpm, pyenv, and other user-installed commands with the same exported `PATH` used by Terminal.
Environment precedence is desktop process < login shell < the service definition's `env`. Source and
CLI launches keep their existing process environment and do not start another shell. If shell startup
fails or exceeds eight seconds, the desktop falls back to its process environment; set an explicit
`PATH` in the service definition when troubleshooting an unusual shell profile.

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

Open **Services**, use **Add** in the upper-right corner of the service list, and select the **Running
processes** tab to search by name, command, or PID. For a listening process, the plus button in **Ports
and processes** opens the same form with its definition prefilled. Review and edit the inferred name,
command, working directory, and allow-listed environment variables before saving.

This creates configuration from the process; it does not reconnect to that process's existing stdout
or stderr pipes. Stop the original process before starting the saved service in Service Console to
avoid a duplicate instance or port conflict. Log capture begins with the first managed start. Token,
password, secret, and API-key command arguments are redacted and require manual confirmation.

#### Windows process permissions and manual completion

Windows may represent the same account as either `DOMAIN\User` or `User`. Service Console normalizes
both forms so a current-user process is not mistaken for another user's process. If Windows cannot
verify the process owner or start time, the UI switches to **Manual completion**. The safe draft uses
only the PID, process name, and known ports; it does not read or reuse that process's command line,
working directory, or environment. If only individual metadata fields are unavailable, Service
Console preserves the fields it could safely inspect and marks the missing values. Enter the command
and working directory, review the arguments, and then save the definition.

The general process search excludes processes confirmed to belong to another account. Service
Console's own processes and already-managed processes also remain unavailable for import. Selecting
a restricted process from **Ports and processes** opens the same manual-completion flow. The app runs
with the current user's permissions by default, so Administrator mode is not required merely to
import a process; Windows can still restrict metadata for another account or a high-integrity process.

### Configure Jenkins connections

Use **Jenkins → Add instance** to configure a display name, base URL, username, API token, optional CA
bundle, enabled state, and request timeout. Existing instances can be edited, copied, deleted, or
connection-tested independently. The API token is write-only in the UI: it is stored by the operating
system credential backend through Python `keyring` (Keychain on macOS and Credential Locker on
Windows), while the ordinary JSON configuration stores only non-sensitive instance fields. On Linux,
only a secure Secret Service, KWallet, or libsecret backend is accepted. If no secure credential
backend is available, the token remains in process memory only and must be entered again after a
restart. API responses expose only `token_present`; neither the browser nor MCP tool results receive
the token, and Service Console never falls back to a plaintext token file.

Expand **How to get an API token** while adding or editing an instance. After a Jenkins URL is entered,
the dialog provides shortcuts to the current `/me/security` page and the legacy `/me/configure` page,
plus the **Add new Token → Generate** steps. Use Configure when Security returns `404`; if an
authenticated request still returns `403`, ask the Jenkins administrator to confirm access to the
personal configuration page. An API token retains the owning account's existing permissions and does
not expand its visible job scope.

Create a dedicated Jenkins user or API token with only the permissions needed by the enabled actions.
Read-only use normally needs `Overall/Read` and `Job/Read`; triggering builds adds `Job/Build`, while
stopping builds or cancelling queued items adds `Job/Cancel`. Service Console must still be able to
reach every configured Jenkins URL, and a private CA must be supplied explicitly when the system trust
store does not contain it.

#### Troubleshoot Jenkins `403` responses

For controllers configured with username and password credentials, Service Console automatically
requests the Jenkins CSRF crumb before each write action and reuses the same session cookie for the
request. API token authentication is normally exempt from crumb checks and is the recommended option
for automation.

A `403` can still have several causes. First test the connection: if read requests also fail, verify
the username and credential. If browsing works but build, stop, or queue actions fail, verify the
required `Job/Build` or `Job/Cancel` permission. If Jenkins specifically reports a missing or invalid
crumb, check the controller's CSRF and reverse-proxy session-cookie configuration; Service Console
does not reuse crumbs across different sessions.

Prefer an HTTPS Jenkins URL. Plain HTTP remains available for legacy or isolated internal
controllers, but Basic authentication sends the username and API token without transport
encryption, so it should be used only on a trusted network.

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

## AI and MCP integration

Desktop release packages include a separate console-mode stdio MCP bridge. Open **Settings → AI /
MCP integration** and choose **Install in Codex** once, then restart Codex once so it loads the new
tools. On subsequent launches, the desktop app publishes its private controller and the registered
bridge becomes ready automatically. Codex starts
the bridge on demand; the bridge discovers the random port and temporary token from
`~/.service-console/controller.json`, so no credential or changing port is stored in Codex.

If an AI tool is called while the desktop app is closed, the bridge starts the app from the same
installation and waits for the controller. It re-reads the descriptor after application updates and
restarts. **Test connection** performs a real MCP handshake and calls the read-only `service_list`
tool.

Manual registration is also available:

```bash
# macOS release
codex mcp add service-console -- \
  "/Applications/Service Console.app/Contents/MacOS/Service Console MCP"

# Source checkout
codex mcp add service-console -- \
  "$(pwd)/.venv/bin/python" -m service_console.mcp_server
```

```powershell
# Windows release; adjust the installation directory as needed
codex mcp add service-console -- `
  "C:\Program Files\Service Console\Service Console MCP.exe"
```

### Declarative project configuration

Create `.service-console.json` in the project root. Relative working directories resolve from the
manifest directory:

```json
{
  "version": 1,
  "project": "example-project",
  "services": [
    {
      "name": "example-backend",
      "command": "uv run backend/run.py",
      "cwd": ".",
      "env": {"PYTHONUNBUFFERED": "1"},
      "auto_start": true,
      "stop_timeout": 10
    }
  ]
}
```

`project_apply_config` creates, updates, or skips unchanged definitions without deleting other
services. An AI agent can then use `service_restart`, `service_status`, and `service_logs` to validate
a code change. The bridge also exposes service lifecycle/configuration tools, port inspection, running
process discovery/import, and explicit process termination. Mutating tools carry MCP annotations so
clients can apply their normal confirmation policy.

### Jenkins tools for AI

Call `jenkins_instance_list` first, then pass the selected `instance_id` to every other Jenkins tool.
The UI's currently selected item is intentionally not an implicit default, so an operator switching
instances cannot redirect an AI operation.

| Purpose | MCP tools |
|---|---|
| Browse instances and jobs | `jenkins_instance_list`, `jenkins_job_list`, `jenkins_job_status` |
| Inspect builds and bounded logs | `jenkins_build_list`, `jenkins_build_status`, `jenkins_build_logs` |
| Inspect the queue | `jenkins_queue_list` |
| Start work | `jenkins_build_trigger` |
| Stop or cancel work | `jenkins_build_stop`, `jenkins_queue_cancel` |

`jenkins_build_logs` reads one finite progressive-text chunk. Its output is capped by `max_bytes`
(64 KiB by default, 1 MiB maximum); use the returned `next_offset` for another explicit read rather
than opening an endless stream. Build triggering is non-idempotent and the bridge never retries it
automatically after a transport failure. Stop and queue-cancel tools are marked destructive, while
the browse/status/log tools are read-only. Jenkins tokens are not MCP inputs and are never returned
to the AI—the local controller resolves the selected instance's credential from the system keyring.
To inspect Git Parameter, Active Choices, or File System List values, call `jenkins_job_status` with
`include_parameter_options=true`, then pass one of the returned `choices` to
`jenkins_build_trigger`. Dynamic discovery can query SCM or the Jenkins controller's configured
filesystem and is therefore disabled by default. The trigger path re-reads and validates these
choices; stale, empty, ambiguous one-item File System List, multi-select, reactive, and unavailable
option sets are rejected before any POST.

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

## Desktop updates

The packaged desktop app reads its local version immediately and checks for a newer stable GitHub
Release shortly after launch. A release is trusted only when its `latest-update.json` payload passes
Ed25519 verification with the public key embedded in the app. The selected platform package must
also match the signed filename, byte size, and SHA-256 digest.

Open **Settings → Application update** to check manually, download an available package, and choose
**Install and restart**. Installation is never silent: confirmation warns that closing Service
Console gracefully stops its managed services. After the updated app opens, services with
`auto_start` enabled start again.

Automatic replacement is available only in frozen macOS arm64 and Windows x64 Release builds and
requires a writable install directory. Source runs, browser-only controllers, and unsupported
architectures still discover a release but direct the user to its download page. The first version
that contains this updater must be installed manually; subsequent releases can update in-app.

On Windows, the Release package includes a native `Service Console Updater.exe`. Before the desktop
closes, that helper is copied outside the installation directory and must acknowledge that it has
started. It then waits for the exact desktop process, replaces the application directory, starts the
new executable, and keeps the backup until the new window reports ready. A failed launch restores
and relaunches the previous version. Diagnostic details are written to
`%USERPROFILE%\.service-console\updates\vVERSION\install-update.log`.

Windows releases 0.2.0 and 0.2.1 contain the legacy update launcher. If **Install and restart** only
closes one of those versions, download and extract 0.2.2 or later manually once. In-app updates after
that migration use the native helper and the readiness/rollback flow described above.

## Build the macOS application

```bash
./scripts/build-macos-app.sh
open "dist/Service Console.app"
```

The build script:

1. regenerates the multi-resolution ICNS icon from `assets/service-console-icon-1024.png`; the
   original transparent product mark is retained in `assets/service-console-logo.png`;
2. builds and statically exports the Next.js dashboard into the Python package;
3. installs the desktop dependency group;
4. bundles CPython, pywebview, FastAPI, the complete dashboard, and a console-mode MCP sidecar with
   PyInstaller;
5. synchronizes the bundle version with `pyproject.toml` and applies an ad-hoc signature.

The resulting app runs without Node.js or network access. It matches the build machine architecture;
the current build has been tested on Apple Silicon. It is ad-hoc signed and not notarized with an
Apple Developer ID, so downloaded builds may trigger a Gatekeeper warning. `dist/` is intentionally
ignored; publish distributable binaries through GitHub Releases.

When replacing the product mark, save the transparent source as
`assets/service-console-logo.png`, then regenerate the desktop, README, top-bar, and favicon assets:

```bash
uv run --group icon python scripts/build_brand_assets.py
./scripts/build-macos-icon.sh
pnpm run build:web-assets
```

## Build the Windows application

Run the PowerShell build on Windows:

```powershell
pwsh ./scripts/build-windows-app.ps1
& "dist/Service Console/Service Console.exe" --help
```

The script generates a multi-resolution ICO icon, builds the same offline dashboard, and creates a
PyInstaller directory bundle at `dist/Service Console`, including `Service Console MCP.exe` and the
one-file native `Service Console Updater.exe`. Windows 10/11 must have the Microsoft Edge
WebView2 Runtime installed. The executable is unsigned, so Windows may show a SmartScreen warning
until the project is configured with a trusted code-signing certificate.

## Publish release packages

The `Release` GitHub Actions workflow builds an Apple Silicon macOS ZIP and a Windows x64 ZIP. A tag
matching the version in `pyproject.toml` publishes both packages, `SHA256SUMS.txt`, and the signed
`latest-update.json` / `latest-update.json.sig` pair to GitHub Releases:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Signing uses the protected `SERVICE_CONSOLE_UPDATE_PRIVATE_KEY_B64` Actions secret; only the matching
public key is committed. Publishing is staged through a recoverable draft, explicitly marks the
release as Latest, and refuses to overwrite an already-published release. Enable GitHub Immutable
Releases in the repository settings when platform-enforced tag and asset immutability is required.

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
