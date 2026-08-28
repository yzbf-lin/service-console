# Implementation contract

## Runtime model

- `ServiceDefinition`: `name`, `command`, `cwd`, `env`, `auto_start`, `stop_timeout`.
- Runtime states: `STOPPED`, `STARTING`, `RUNNING`, `STOPPING`, `EXITED`, `FAILED`.
- A controller owns all processes, isolates each service in a Unix process group or Windows process
  tree, captures stdout/stderr, and escalates from graceful termination after `stop_timeout`.
- Definitions persist as JSON below the selected data directory. Logs persist per service and are
  also held in a bounded in-memory buffer.

## HTTP and WebSocket contract

- `GET /api/health`
- `GET /api/services`
- `POST /api/services`
- `PUT /api/services/{name}`
- `DELETE /api/services/{name}`
- `POST /api/services/{name}/start`
- `POST /api/services/{name}/stop`
- `POST /api/services/{name}/restart`
- `GET /api/services/{name}/logs?tail=500`
- `GET /api/ports?port=PORT`
- `GET /api/processes?query=QUERY&limit=100`
- `GET /api/processes/{pid}`
- `POST /api/processes/{pid}/terminate`
- `GET /api/app-update`: cached local update state; never performs network I/O.
- `POST /api/app-update/check`: fetch and verify the signed stable-release manifest.
- `POST /api/app-update/download`: download and verify the selected platform package.
- `POST /api/app-update/install`: stage the verified package and schedule the desktop restart; the GUI
  asks for confirmation before invoking this endpoint.
- `WS /ws/events`: JSON events with `type=status|log`, `service`, and `data`.
- Optional bearer token for HTTP; WebSocket accepts `?token=`.

Update responses expose `state`, `can_install`, `downloaded`, `downloaded_bytes`, `total_bytes`,
`download_progress`, and `restart_required`. `download_progress` is a percentage from `0` to `100`;
`state` is one of `idle`, `checking`, `available`, `unsupported`, `up_to_date`, `downloading`,
`downloaded`, `installing`, `restarting`, or `error`.

## Module map

- `models.py`, `store.py`: persistent service definitions and runtime data models.
- `manager.py`: platform process-tree lifecycle, metrics, and log capture.
- `api.py`: HTTP and WebSocket controller surface.
- `cli.py`, `tui.py`: command-line and terminal clients.
- `desktop.py`, `runtime.py`: native window lifecycle and private local discovery.
- `update.py`: signed release discovery, package verification, staging, replacement, and rollback.
- `static/`: responsive dashboard and bundled terminal assets.
