# BoxLite CLI

Command-line interface for BoxLite — use BoxLite without writing code, with a familiar Docker/Podman-like experience.


For CLI development (build, test, adding commands), see [CLI Development Guide](../docs/development/cli.md).


**Platforms:** macOS (Apple Silicon), Linux (x86_64, ARM64)

## Overview

The BoxLite CLI (`boxlite`) lets you create, run, and manage BoxLite boxes from the terminal. It targets quick testing, shell scripting and automation, debugging, and demos.


### Key Features

- **Run** — Create a box from an image or prepared rootfs and run a command (interactive, TTY, or detached); supports `-p` (publish ports) and `-v` (volumes)
- **Create** — Create a box from an image or prepared rootfs without running; supports `-p` and `-v`
- **Lifecycle** — Start, stop, restart, remove boxes
- **Inspect** — Show detailed box info (JSON, YAML, or Go template)
- **Exec** — Run commands inside a running box
- **Images** — Pull and list OCI images
- **Copy** — Copy files between host and box (`boxlite cp`)
- **Output formats** — Table, JSON, or YAML for list/images
- **Shell completion** — Bash, Zsh, Fish

## Installation

### One-line install (Linux & macOS Apple Silicon)

```bash
curl -fsSL https://sh.boxlite.ai | sh
```

Installs to `$HOME/.local/bin/boxlite`. For version pinning, a custom
install dir, and release-artifact verification (sigstore, `SHA256SUMS`,
`gh attestation verify`), see the [CLI Reference's Installation & Verification section](../../docs/reference/cli/README.md#installation--verification).

### cargo install (from source)

```bash
cargo install boxlite-cli
```

### cargo binstall (prebuilt binary)

```bash
cargo binstall boxlite-cli
```

### Homebrew

Coming soon

### Build from Source

```bash
# From repository root
git clone https://github.com/boxlite-ai/boxlite.git
cd boxlite

# Initialize submodules (required)
git submodule update --init --recursive

# Build the CLI
cargo build --release -p boxlite-cli

# Binary: target/release/boxlite
```



### System Requirements

| Platform       | Architecture          | Status           |
|----------------|-----------------------|------------------|
| macOS          | Apple Silicon (ARM64) | ✅ Supported     |
| Linux          | x86_64                | ✅ Supported     |
| Linux          | ARM64                 | ✅ Supported     |
| Windows (WSL2) | x86_64                | ✅ Supported     |
| macOS          | Intel (x86_64)        | ❌ Not supported |


## Quick Start

### Run a one-off command

```bash
boxlite run python:slim python -c "print('Hello from BoxLite!')"
```

### Run interactively with a TTY

```bash
boxlite run -it alpine:latest /bin/sh
```

### Create a box and run in the background

```bash
# Create and start (prints box ID)
boxlite run -d --name mybox alpine:latest sleep 3600

# Run a command in the box
boxlite exec mybox echo "Hello"

# List boxes
boxlite list -a

# Stop and remove
boxlite stop mybox
boxlite rm mybox
```

### Pull an image and list images

```bash
boxlite pull alpine:latest
boxlite images
```

## Connecting to a remote server

To target a remote BoxLite REST server instead of the local runtime, sign in
with `boxlite auth login`. Three login methods are supported:

| Method      | When to use                                            | Token type           |
|-------------|--------------------------------------------------------|----------------------|
| `api-key`   | CI / automation, or a server-minted long-lived key     | Opaque `blk_…` key   |
| `browser`   | Local developer machine with a desktop browser         | OIDC access token    |
| `device`    | SSH session / headless container with no browser       | OIDC access token    |

Credential precedence is **`BOXLITE_API_KEY` env > stored file > unauthenticated** (local runtime).
The `--url` flag overrides the URL specifically without affecting credentials.
Multiple profiles coexist in one file via `--profile <name>` (or `BOXLITE_PROFILE` env var).

```bash
# Browser OIDC against a control plane (default for `auth login` on a TTY).
# Requires the IdP admin to have registered `http://127.0.0.1:5555/callback`
# in the SPA application's Allowed Callback URLs — see apps/infra/README.md
# "OIDC provider setup" for the one-time setup.
boxlite --profile cloud auth login --url https://<your-control-plane>/api

# Same target, headless (SSH / no browser): prints a code + URL to type into
# any browser on another device.
boxlite --profile cloud auth login --url https://<your-control-plane>/api --no-browser

# Local boxlite serve with a static API key (unchanged from the original behavior).
boxlite --profile local auth login --url http://localhost:8100  # interactive paste
echo "$KEY" | boxlite --profile local auth login --url http://localhost:8100 --api-key-stdin

# CI via env vars only — no `auth login` call needed.
BOXLITE_API_KEY=$KEY BOXLITE_REST_URL=https://<your-server> boxlite list
```

Credentials are stored at `~/.boxlite/credentials.toml` (perms `0600`). OIDC
sessions auto-refresh on use when within 5 minutes of expiry; if the refresh
token is rejected (`invalid_grant`) the CLI prompts you to re-run `auth login`.

## Commands Reference

> For an exhaustive man-page-style reference (shared flag groups, volume/port grammar,
> exit codes, configuration file format), see the
> [CLI Reference](../../docs/reference/cli/README.md).

### Global flags

Available for all commands:

| Flag | Description |
|------|-------------|
| `--debug` | Enable debug output. Precedence: `--debug` > `RUST_LOG` env > default (`warn`). |
| `--home PATH` | BoxLite home directory (default: `~/.boxlite`). Overridden by `BOXLITE_HOME` |
| `--registry REGISTRY` | Image registry (repeatable; prepended to config) |
| `--config PATH` | JSON config file path (e.g. for `image_registries`) |
| `--url URL` | Connect to a remote BoxLite REST server instead of the local runtime. Env: `BOXLITE_REST_URL`. |
| `--profile NAME` | Named credential profile in `~/.boxlite/credentials.toml`. Lets one machine hold separate logins (e.g. `local` for `boxlite serve`, `cloud` for a remote control plane). Default `default`. Env: `BOXLITE_PROFILE`. |
| `--path-prefix VALUE` | Routing-slot value for the URL path (`/v1/<prefix>/boxes/...`). Opaque — the server decides what it means (organization, workspace, catalog, …). Captured automatically at `auth login` time from `Principal.path_prefix`. This flag overrides the stored profile's value for credentials with scope over multiple routing values. Unset / empty → URL skips the segment (`/v1/boxes/...`), the canonical shape for single-tenant deployments like `boxlite serve`. Env: `BOXLITE_REST_PATH_PREFIX`. |

### `boxlite auth login`

Log in to a BoxLite REST server. Supports three flows that all save to
`~/.boxlite/credentials.toml` (perms `0600`):

- **API key** — paste or stdin. Long-lived, org-scoped. Good for CI, SDK
  integrations, `boxlite serve` setups.
- **Browser OIDC** — Authorization Code + PKCE against the IdP that
  `apps/api` is configured for (Auth0, Dex, Okta, etc.). Opens the system
  browser; the CLI listens on `127.0.0.1:5555` for the callback. Mints an
  access token + refresh token; the latter is used to silently refresh
  within 5 minutes of expiry.
- **Device code OIDC** — RFC 8628. Headless / SSH-friendly: prints a short
  code + URL to enter on any browser on another device. Same token type
  and refresh behavior as the browser flow.

When `--method` is unset, the CLI infers it: piped stdin → `api-key` (CI-safe),
TTY → interactive picker, `$SSH_CONNECTION` set → silent fallback to `device`.

**Usage:** `boxlite auth login [OPTIONS]`

| Option | Description |
|--------|-------------|
| `--url URL` | Server URL (default: `http://localhost:8100`, matching `boxlite serve`). For cloud control planes include the `/api` prefix, e.g. `https://api.example.com/api`. |
| `--method <api-key\|browser\|device>` | Explicit flow choice. Overrides inference. |
| `--api-key-stdin` | Read the API key from stdin (one line). The flag takes no value, so the secret never appears on argv. Implies `--method api-key`. |
| `--no-browser` | Skip the browser; use device code instead. Implies `--method device`. |
| `--callback-port <PORT>` | Local port for the browser-flow callback (default `5555`). **Must match an entry in the IdP's allow-list byte-for-byte** — a different port produces "Callback URL mismatch" exactly like no entry at all. |
| `--issuer URL` | OIDC issuer URL. Overrides what `GET /api/config` returns. Useful for self-hosted Dex tenants where the discovery is wrong. |
| `--client-id ID` | OIDC client_id. Overrides `/api/config`. |
| `--audience VAL` | OIDC audience. Auth0 requires it; Dex tolerates `None`. |

Global flags also apply — most importantly `--profile NAME` to log in to a
specific credential profile (default `default`).

**Examples:**

```bash
# Cloud control plane via browser (most common; opens system browser).
boxlite --profile cloud auth login --url https://<your-control-plane>/api

# Same target, headless: prints a code + URL.
boxlite --profile cloud auth login --url https://<your-control-plane>/api --no-browser

# Local boxlite serve with paste-API-key (interactive).
boxlite --profile local auth login --url http://localhost:8100

# CI: API key from stdin (nothing on argv).
echo "$KEY" | boxlite --profile local auth login --url http://localhost:8100 --api-key-stdin
```

**Deployment-side setup (one-time, by the IdP admin):**

Browser and device flows fail with "Callback URL mismatch" until the IdP
knows about the CLI's loopback URL. For Auth0 see
`apps/infra/README.md` "OIDC provider setup" — add
`http://127.0.0.1:5555/callback` to the SPA Application's
**Allowed Callback URLs**. For Dex see `apps/dex/config.yaml` — the same
URL goes under the `boxlite` static client's `redirectURIs`, plus
`oauth2.deviceFlow: {}` at the top level for device flow.

### `boxlite auth logout`

Remove stored credentials at `~/.boxlite/credentials.toml`. Prompts for confirmation unless `--yes` is given.

**Usage:** `boxlite auth logout [OPTIONS]`

| Option | Short | Description |
|--------|-------|-------------|
| `--yes` | `-y` | Skip the confirmation prompt |

### `boxlite auth status`

Print the current authentication state: the logged-in URL, the source
(stored file vs env var), the credential type (API key vs OIDC), and for
OIDC sessions the access token's expiry. Offline — no network calls,
no secret material printed.

**Usage:** `boxlite auth status [--profile NAME]`

**Example output (API key):**

```
Logged in to:    http://localhost:8100
Credential:      API key (from ~/.boxlite/credentials.toml [local])
```

**Example output (OIDC session):**

```
Logged in to:    https://api.boxlite.ai/api
Credential:      OIDC bearer token (from ~/.boxlite/credentials.toml [cloud])
Expires:         2026-05-21T15:42:00+00:00
```

### `boxlite auth whoami`

Confirm the active credential's identity by making one authenticated
request to `GET /v1/me`. Unlike `auth status` (offline, only reports where
the credential came from), `whoami` shows the server-resolved principal,
organization, and scopes. Triggers a silent OIDC refresh if the access
token is within 5 minutes of expiry.

**Usage:** `boxlite auth whoami [--profile NAME]`

**Example output:**

```
Logged in as:    dev@acme.test
Name:            Dev McAcme
Principal:       auth0|abc123 (user)
Organization:    acme
Server:          https://api.boxlite.ai/api
Scopes:          box:read, box:write, box:exec, image:read, snapshot:read
```

### `boxlite run`

Create a box from an image or prepared rootfs and run a command.

**Usage:**

- `boxlite run [OPTIONS] IMAGE [COMMAND]...`
- `boxlite run [OPTIONS] --rootfs PATH [COMMAND]...`

| Option | Short | Description |
|--------|-------|-------------|
| `--rootfs PATH` | | Use a prepared rootfs path instead of pulling/resolving an image |
| `--interactive` | `-i` | Keep STDIN open |
| `--tty` | `-t` | Allocate a pseudo-TTY |
| `--env KEY=VALUE` | `-e` | Set environment variables (repeatable) |
| `--workdir PATH` | `-w` | Working directory in the box |
| `--publish PORT` | `-p` | Publish box port to host (e.g. `8080:80`, `8080:80/tcp`) |
| `--volume VOLUME` | `-v` | Mount a volume (e.g. `hostPath:boxPath`, `boxPath` for anonymous) |
| `--cpus N` | | CPU limit |
| `--memory MiB` | | Memory limit (MiB) |
| `--name NAME` | | Name the box |
| `--detach` | `-d` | Run in background, print box ID |
| `--rm` | | Remove the box when it exits |

**Examples:**

```bash
boxlite run alpine:latest echo "Hello"
boxlite run -it --rm alpine:latest /bin/sh
boxlite run -d --name openclaw -p 18789:18789 ghcr.io/openclaw/openclaw:main
boxlite run -v /host/data:/app/data alpine:latest cat /app/data/hello.txt
boxlite run --rootfs /path/to/rootfs /bin/sh
```

### `boxlite create`

Create a new box from an image or prepared rootfs without running a command.

**Usage:**

- `boxlite create [OPTIONS] IMAGE`
- `boxlite create [OPTIONS] --rootfs PATH`

| Option | Short | Description |
|--------|-------|-------------|
| `--rootfs PATH` | | Use a prepared rootfs path instead of pulling/resolving an image |
| `--name NAME` | | Name the box |
| `--env KEY=VALUE` | `-e` | Environment variables |
| `--workdir PATH` | `-w` | Working directory |
| `--publish PORT` | `-p` | Publish box port to host (e.g. `8080:80`) |
| `--volume VOLUME` | `-v` | Mount a volume (e.g. `hostPath:boxPath`, or box path for anonymous) |
| `--cpus N` | | CPU limit |
| `--memory MiB` | | Memory limit (MiB) |
| `--detach` | `-d` | (create always “detaches”) |
| `--rm` | | Auto-remove when stopped |

**Examples:**

```bash
boxlite create --name mybox alpine:latest
boxlite create -p 18789:18789 -v /data:/app/data --name openclaw ghcr.io/openclaw/openclaw:main
boxlite create --rootfs /path/to/rootfs --name local-rootfs
boxlite start mybox
boxlite start openclaw
```

### `boxlite exec`

Run a command in a running box.

**Usage:** `boxlite exec [OPTIONS] BOX COMMAND [ARGS]...`

| Option | Short | Description |
|--------|-------|-------------|
| `--interactive` | `-i` | Keep STDIN open |
| `--tty` | `-t` | Allocate a TTY |
| `--env KEY=VALUE` | `-e` | Environment variables |
| `--workdir PATH` | `-w` | Working directory |
| `--detach` | `-d` | Run in background (don’t wait) |

**Example:**

```bash
boxlite exec -it mybox /bin/sh
```

### `boxlite list` (alias: `ls`, `ps`)

List boxes.

**Usage:** `boxlite list [OPTIONS]`

| Option | Short | Description |
|--------|-------|-------------|
| `--all` | `-a` | Show all boxes (default: running only) |
| `--quiet` | `-q` | Show only IDs |
| `--format FMT` | | Output format: `table`, `json`, `yaml` (default: `table`) |

### `boxlite start`

Start one or more stopped boxes.

**Usage:** `boxlite start BOX [BOX ...]`

### `boxlite stop`

Stop one or more running boxes.

**Usage:** `boxlite stop BOX [BOX ...]`

### `boxlite restart`

Restart one or more boxes.

**Usage:** `boxlite restart BOX [BOX ...]`

### `boxlite rm`

Remove one or more boxes.

**Usage:** `boxlite rm [OPTIONS] BOX [BOX ...]` or `boxlite rm [OPTIONS] --all`

| Option | Short | Description |
|--------|-------|-------------|
| `--force` | `-f` | Force remove (e.g. running box) |
| `--all` | `-a` | Remove all boxes (prompts unless `--force`) |

### `boxlite pull`

Pull an image from a registry.

**Usage:** `boxlite pull [OPTIONS] IMAGE`

| Option | Short | Description |
|--------|-------|-------------|
| `--quiet` | `-q` | Only print digest |

### `boxlite inspect`

Display detailed information on one or more boxes (JSON, YAML, or Go-style template).

**Usage:** `boxlite inspect [OPTIONS] [BOX ...]` or `boxlite inspect --latest`

| Option | Short | Description |
|--------|-------|-------------|
| `--latest` | `-l` | Inspect the most recently created box (cannot be used with BOX) |
| `--format FMT` | `-f` | Output: `json`, `yaml`, or a Go template (e.g. `{{.State.Status}}`, `{{.Id}}`). Default: `json`. Table format is not supported. |

**Examples:**

```bash
boxlite inspect mybox
boxlite inspect -f '{{.State.Status}}' mybox
boxlite inspect --latest -f yaml
boxlite inspect box1 box2 -f json
```


### `boxlite images`

List cached images.

**Usage:** `boxlite images [OPTIONS]`

| Option | Short | Description |
|--------|-------|-------------|
| `--all` | `-a` | Show all images (including intermediate) |
| `--quiet` | `-q` | Show only image IDs |
| `--format FMT` | | Output format: `table`, `json`, `yaml` |

### `boxlite cp`

Copy files or directories between host and box.

**Usage:** `boxlite cp [OPTIONS] SRC DST`

- **SRC / DST:** host path or `BOX:PATH` (e.g. `mybox:/app/data`).

| Option | Description |
|--------|-------------|
| `--follow-symlinks` | Follow symlinks when copying |
| `--no-overwrite` | Do not overwrite existing files |
| `--include-parent` | Include parent directory when copying from box (default: true) |

**Examples:**

```bash
boxlite cp ./local.txt mybox:/tmp/
boxlite cp mybox:/app/out ./output
```


### `boxlite info`

Display system-wide runtime information (version, paths, host/virtualization, box and image counts). Default output is YAML.

**Usage:** `boxlite info [OPTIONS]`

| Option | Description |
|--------|-------------|
| `--format FMT` | Output format: `yaml`, `json` (default: `yaml`). Table format is not supported. |

**Output fields:** `version`, `homeDir`, `virtualization`, `os`, `arch`, `boxesTotal`, `boxesRunning`, `boxesStopped`, `boxesConfigured`, `imagesCount`.

**Examples:**

```bash
boxlite info
boxlite info --format json
```

## Shell completion

Generate completion scripts for your shell:

```bash
# Bash
boxlite completion bash > /etc/bash_completion.d/boxlite
# or for current user
boxlite completion bash > ~/.local/share/bash-completion/completions/boxlite

# Zsh
boxlite completion zsh > "${fpath[1]}/_boxlite"

# Fish
boxlite completion fish > ~/.config/fish/completions/boxlite.fish
```

Then reload your shell or source the file.

## Environment variables

| Variable | Description |
|----------|-------------|
| `BOXLITE_HOME` | Runtime home directory (default: `~/.boxlite`). Overridden by `--home`. |
| `BOXLITE_API_KEY` | Long-lived API key sent as `Authorization: Bearer`. Overrides any stored credentials. |
| `RUST_LOG` | Log level: `trace`, `debug`, `info`, `warn`, `error`. Use `RUST_LOG=debug` for troubleshooting. |

## Configuration file

Use `--config PATH` to load a JSON config file. Useful for default registries and other options. See [Image registry configuration](../../docs/guides/image-registry-configuration.md) for details.

## Troubleshooting

### Image pull fails
- Check network and registry access.
- For private registries, see [Image registry configuration](../../docs/guides/image-registry-configuration.md) for details.
- **"Failed to pull manifest"** or **"error sending request for url"** (e.g. to `index.docker.io`): often network-related or Docker Hub rate limit/access in some regions. Retry later, use a mirror, or configure registries via `--registry` / `--config`. See [issue #190](https://github.com/boxlite-ai/boxlite/issues/190) for discussion.
- Enable debug output: `boxlite --debug pull IMAGE` or `RUST_LOG=debug boxlite pull IMAGE`.

### Box fails to start
- Enable debug output: `boxlite --debug run IMAGE [COMMAND]...` or `RUST_LOG=debug boxlite run IMAGE [COMMAND]...`.



## Further documentation

- [BoxLite README](../../README.md) — Project overview and SDK quick starts
- [Getting started](../../docs/getting-started/README.md) — Prerequisites and platform setup
- [Reference](../../docs/reference/README.md) — Python, Node, Rust, C API reference


## License

Licensed under the Apache License, Version 2.0. See [LICENSE](../LICENSE) for details.
