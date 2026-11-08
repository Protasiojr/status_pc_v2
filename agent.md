# Agent Notes — STATUS PC v2

## Project overview

- This is a small Node.js HTTP server with a vanilla HTML/CSS/JavaScript frontend. It is not a Next.js app and has no frontend build step.
- `server.js` serves the API and the allowlisted frontend assets. `index.html` defines the UI, `app.js` handles browser behavior, and the CSS files contain the styles.
- The production target is a Linux server. `compose.yaml` uses host networking so LAN scanning, ARP discovery, and Wake-on-LAN can access the host network interfaces.
- The service listens on port `6001` by default. SSH normally uses each device's configured port (usually `22`); Wake-on-LAN sends UDP packets to port `9`.

## Development and deployment

- Requires Node.js 18 or newer. Install dependencies with `npm ci`.
- Run locally with `npm start`; use `npm run dev` for watch mode.
- For the Linux Docker deployment, prepare `data/ssh/`, ensure `data/` is writable by UID 1000 (`node`), preserve `.env`, then run `docker compose up -d --build`.
- The `.env` file must contain a persistent `SSH_CREDENTIALS_SECRET`. Do not regenerate it for an existing data directory: saved SSH passwords and inline private keys depend on it.
- `SSH_KNOWN_HOSTS_PATH` points to the trusted host keys file. Keep strict host-key verification enabled.
- There is no `npm run build` script. The production image is built with Docker Compose.

## SSH and credential handling

- Use the cross-platform `ssh2` package for SSH connections, key generation, and remote command execution. Avoid OS-specific SSH command-line assumptions in the application server.
- Passwords and inline private keys are encrypted before saving in `data/devices.json`. Never return their ciphertext or plaintext from API responses or configuration exports.
- Public keys are safe to show and export. Private keys, passwords, `.env`, and `data/ssh/` must not be committed or logged.
- Generated Ed25519 public keys must be installed on the target Linux or Windows OpenSSH server before key authentication can succeed.
- A key path is interpreted by the machine/container running STATUS PC. In Docker, use container paths such as `/app/data/ssh/id_ed25519`.
- Keep Linux and Windows remote power commands aligned with the target platform. Linux shutdown/restart requires passwordless `sudo`; Windows requires OpenSSH Server and appropriate remote permissions.

## Data and API conventions

- `data/devices.json` is user data. Preserve it during changes and deployments; use backward-compatible migrations when its schema changes.
- Keep device validation consistent across create, edit, and import routes. Reject duplicate IP addresses and invalid SSH ports/addresses.
- Do not expose files outside the static asset allowlist in `server.js`.
- Escape user-provided values before inserting them into `innerHTML`.
- Keep SSH credentials out of browser-visible API responses. For saved credentials, expose only configured-state booleans.
- Update `README.md` when changing ports, environment variables, SSH setup, or deployment steps.

## Verification

- For JavaScript edits, run `node --check server.js` and `node --check app.js`.
- Validate Compose changes with `docker compose config --quiet`.
- Do not add or run a test suite unless the user asks for tests or verification. Never run SSH power commands against a real device as part of routine validation.
