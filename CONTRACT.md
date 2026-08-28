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
- `WS /ws/events`: JSON events with `type=status|log`, `service`, and `data`.
- Optional bearer token for HTTP; WebSocket accepts `?token=`.

## Module map

- `models.py`, `store.py`: persistent service definitions and runtime data models.
- `manager.py`: platform process-tree lifecycle, metrics, and log capture.
- `api.py`: HTTP and WebSocket controller surface.
- `cli.py`, `tui.py`: command-line and terminal clients.
- `desktop.py`, `runtime.py`: native window lifecycle and private local discovery.
- `static/`: responsive dashboard and bundled terminal assets.
