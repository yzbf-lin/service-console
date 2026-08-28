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

## Reporting a vulnerability

Please use GitHub's private security advisory feature for the repository. Include reproduction steps,
affected versions, expected impact, and any proposed mitigation. Avoid opening a public issue for an
unfixed vulnerability.
