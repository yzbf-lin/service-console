# Security Policy

Service Console executes registered commands with the same operating-system permissions as its
controller. Treat service definitions and anyone who can reach the authenticated controller as
trusted.

## Deployment guidance

- Keep the controller on loopback unless remote access is explicitly required.
- Require a strong bearer token for every non-loopback binding.
- Terminate TLS in front of remotely reachable controllers.
- Protect `~/.service-console`, especially `controller.json` and service definitions.
- Use force termination only after graceful process-group shutdown times out.

## Update trust model

Desktop releases use an Ed25519-signed update manifest. The private signing key is stored only as a
protected GitHub Actions secret; packaged clients contain the matching public key. Each manifest
binds a version and platform to an immutable filename, download URL, byte size, and SHA-256 digest.
The updater rejects invalid signatures, downgrades, unsafe ZIP entries, and packages that fail size
or digest verification. It still discovers releases on unsupported architectures but refuses their
automatic installation and directs the user to the manual download page.

The current macOS build is ad-hoc signed and not notarized, and the Windows executable does not yet
carry an Authenticode signature. The update signature authenticates this project's release channel;
it does not replace operating-system code signing or notarization.

## Reporting a vulnerability

Please use GitHub's private security advisory feature for the repository. Include reproduction steps,
affected versions, expected impact, and any proposed mitigation. Avoid opening a public issue for an
unfixed vulnerability.
