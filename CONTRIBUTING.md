# Contributing

Contributions and focused bug reports are welcome.

## Development setup

```bash
uv sync --group dev
pnpm install --frozen-lockfile
pnpm run build:web-assets
uv run pytest
```

Please keep changes small, preserve existing CLI and API behavior unless a breaking change is
explicitly discussed, and add tests for lifecycle, persistence, authentication, or process-safety
changes.

## macOS desktop build

```bash
./scripts/build-macos-app.sh
```

The local application is ad-hoc signed. Developer ID signing, notarization, and release packaging are
maintainer release steps and are not required for ordinary pull requests.

## Pull requests

- Explain the user-facing problem and the chosen behavior.
- Include test results and manual verification where applicable.
- Do not commit `.service-console` data, logs, runtime descriptors, tokens, virtual environments,
  `node_modules`, or build output.
