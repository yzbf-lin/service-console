# Contributing

Contributions and focused bug reports are welcome.

## Development setup

```bash
pnpm install --frozen-lockfile
pnpm run build:web-assets
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace --all-targets
```

Please keep changes small, preserve existing CLI and API behavior unless a breaking change is
explicitly discussed, and add tests for lifecycle, persistence, authentication, or process-safety
changes.

## macOS desktop build

```bash
pnpm tauri build --bundles app
```

The local application is ad-hoc signed. Developer ID signing, notarization, and release packaging are
maintainer release steps and are not required for ordinary pull requests.

## Windows desktop build

Run this on Windows with PowerShell 7:

```powershell
pnpm tauri build --bundles nsis
```

The installer is written below `target/release/bundle/nsis`. Windows lifecycle changes must pass the
native Windows Rust CI job. The GitHub `Release` workflow owns portable ZIP packaging, checksums,
signed update manifests, and tag-based publication; generated binaries must not be committed.

## Pull requests

- Explain the user-facing problem and the chosen behavior.
- Include test results and manual verification where applicable.
- Do not commit `.service-console` data, logs, runtime descriptors, tokens, `node_modules`, or build
  output.
