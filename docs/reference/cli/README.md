# BoxLite CLI reference

Exhaustive reference for the `boxlite` command-line interface — every subcommand, every flag, every exit code.

**Platforms:** macOS (Apple Silicon), Linux (x86_64, ARM64), Windows (WSL2)

For a quick start, see [`src/cli/README.md`](../../../src/cli/README.md).

## Table of contents

- [Synopsis](#synopsis)
- [Installation & Verification](#installation--verification)
- [Global Options](#global-options)
- [Environment Variables](#environment-variables)
- [Connecting to the cloud](#connecting-to-the-cloud)
- [Commands](#commands)
  - [`boxlite context`](#boxlite-context)
  - [`boxlite auth login`](#boxlite-auth-login)
  - [`boxlite auth logout`](#boxlite-auth-logout)
  - [`boxlite auth status`](#boxlite-auth-status)
  - [`boxlite auth whoami`](#boxlite-auth-whoami)
  - [`boxlite run`](#boxlite-run)
  - [`boxlite exec`](#boxlite-exec)
  - [`boxlite create`](#boxlite-create)
  - [`boxlite list`](#boxlite-list)
  - [`boxlite rm`](#boxlite-rm)
  - [`boxlite start`](#boxlite-start)
  - [`boxlite stop`](#boxlite-stop)
  - [`boxlite restart`](#boxlite-restart)
  - [`boxlite pull`](#boxlite-pull)
  - [`boxlite images`](#boxlite-images)
  - [`boxlite inspect`](#boxlite-inspect)
  - [`boxlite cp`](#boxlite-cp)
  - [`boxlite info`](#boxlite-info)
  - [`boxlite logs`](#boxlite-logs)
  - [`boxlite stats`](#boxlite-stats)
  - [`boxlite network tunnel`](#boxlite-network-tunnel)
  - [`boxlite network inbound / outbound`](#boxlite-network-inbound--outbound)
  - [`boxlite ssh`](#boxlite-ssh)
  - [`boxlite agent`](#boxlite-agent)
  - [`boxlite serve`](#boxlite-serve)
  - [`boxlite volume`](#boxlite-volume)
  - [`boxlite completion`](#boxlite-completion)
- [Shared Flag Groups](#shared-flag-groups)
- [Volume Mount Syntax](#volume-mount-syntax)
- [Port Publish Syntax](#port-publish-syntax)
- [Output Formats](#output-formats)
- [Configuration File](#configuration-file)
- [Exit Codes](#exit-codes)
- [See Also](#see-also)

---

## Synopsis

```
boxlite [GLOBAL OPTIONS] <COMMAND> [ARGS...]
```

`boxlite` is the command-line interface for the BoxLite runtime. It creates and manages "boxes" (lightweight VMs running OCI containers) on the local host or — with `--url` — against a remote BoxLite REST server.

---

## Installation & verification

The `boxlite` CLI can be installed three ways:

- One-line script: `curl -fsSL https://sh.boxlite.ai | sh`
- From crates.io: `cargo install boxlite-cli`
- Prebuilt binary via cargo: `cargo binstall boxlite-cli`

The one-line script installs to `$HOME/.local/bin/boxlite` and embeds the runtime — no extra setup. `sh.boxlite.ai` is a thin Cloudflare Worker that serves the same `install.sh` published on every GitHub Release; the long form `https://github.com/boxlite-ai/boxlite/releases/latest/download/install.sh` is the verifiable upstream and is what `gh attestation verify` covers.

### Pin a version or override the install dir

```bash
curl -fsSL https://sh.boxlite.ai \
  | BOXLITE_VERSION=v0.9.4 BOXLITE_INSTALL_DIR=/usr/local/bin sh
```

The env-var prefix has to sit on the `sh` side of the pipe — variables placed before `curl` only decorate the curl process and never reach the installer.

### Pinning with an attested digest

When pinning a non-latest version, the installer falls back to the remote `.sha256` sidecar in that release for the expected digest. That anchor shares its trust root with the tarball, so for a guarantee independent of the release page, look up the digest in the release's attested `SHA256SUMS` and pass it in explicitly:

```bash
curl -fsSL https://sh.boxlite.ai \
  | BOXLITE_VERSION=v0.9.4 \
    BOXLITE_EXPECTED_SHA256=<sha256-of-boxlite-cli-vX.Y.Z-target.tar.gz> sh
```

### Verifying a downloaded tarball

Each release publishes raw tarballs (`boxlite-cli-vX.Y.Z-<target>.tar.gz`), matching `.sha256` sidecars, a combined `SHA256SUMS`, and sigstore-backed build provenance attestations. To verify a manually-downloaded artifact:

```bash
sha256sum -c "boxlite-cli-${VERSION}-${TARGET}.tar.gz.sha256"
gh attestation verify "boxlite-cli-${VERSION}-${TARGET}.tar.gz" \
  --repo boxlite-ai/boxlite
```

### Verifying `install.sh` before running it

The `curl … | sh` shortcut can't self-verify, since the script runs as it is piped in. For users who want to verify the installer first, `install.sh` is also covered by `SHA256SUMS`, an `install.sh.sha256` sidecar, and the same sigstore attestation:

```bash
curl -fsSL -o install.sh \
  "https://github.com/boxlite-ai/boxlite/releases/latest/download/install.sh"
curl -fsSL -o install.sh.sha256 \
  "https://github.com/boxlite-ai/boxlite/releases/latest/download/install.sh.sha256"
sha256sum -c install.sh.sha256
gh attestation verify install.sh --repo boxlite-ai/boxlite
sh ./install.sh
```

### Related operator notes

- [`scripts/release/install.sh.template`](../../../scripts/release/install.sh.template) — the installer source, with inline comments documenting how each verification anchor is consumed
- [`scripts/release/sh-installer/README.md`](../../../scripts/release/sh-installer/README.md) — operator notes for the `sh.boxlite.ai` Cloudflare Worker

---

## Global options

Place these options before the top-level command or after the complete command
path. A parent command accepts only options shared by all children; for example,
use `boxlite auth status --url URL` or `boxlite --url URL auth status`, not
`boxlite auth --url URL status`. Help lists only options meaningful to that
backend, and executing invocations reject unsupported options. Clap's `--help`
and `--version` display actions remain terminal.

| Flag | Scope | Env Var | Description |
|------|-------|---------|-------------|
| `--debug` | all commands except `completion` | `RUST_LOG` (lower precedence) | Enable debug output. |
| `--home PATH` | local runtime + credentials + contexts | `BOXLITE_HOME` | Absolute runtime data, credential, and context preference directory. |
| `--registry REGISTRY` | `run`, `create`, `pull`, `serve` | — | Image registry hostname; repeatable and prepended to config. |
| `--config PATH` | local-capable commands | — | JSON runtime config (see [Configuration File](#configuration-file)). |
| `--url URL` | REST-capable commands | `BOXLITE_REST_URL` | Select a REST API server. |
| `--context NAME` | REST-capable commands + `auth` + `context` | `BOXLITE_CONTEXT` | Override the saved current context. Legacy aliases: `--profile`, `BOXLITE_PROFILE`. |
| `--path-prefix VALUE` | REST box/volume commands | `BOXLITE_REST_PATH_PREFIX` | Override the context's routing path segment. |

**Precedence** (from `src/cli/src/cli.rs`):

1. On dual-backend commands, a REST URL from the selected context or URL override
   selects REST; local runtime config is then unused. See [context precedence](#boxlite-context).
2. Otherwise, `--config` is the base, `--home` overrides `home_dir`, and
   `--registry` values are prepended to `image_registries`.
3. `serve`, `pull`, `images`, `info`, and `logs` always use the embedded local runtime.

---

## Environment variables

| Variable | Read by | Description |
|----------|---------|-------------|
| `BOXLITE_HOME` | `--home` | Runtime data, credentials, and context preferences; equivalent to `--home` |
| `BOXLITE_REST_URL` | `--url` | REST server endpoint; equivalent to `--url` |
| `BOXLITE_API_KEY` | REST runtime | Long-lived API key sent as `Authorization: Bearer`. Overrides any stored credentials. |
| `BOXLITE_CONTEXT` | context selection | Override the saved current context |
| `BOXLITE_PROFILE` | context selection | Legacy fallback when `BOXLITE_CONTEXT` is unset or empty |
| `BOXLITE_REST_PATH_PREFIX` | `--path-prefix` | REST routing path segment; overrides the selected context's value |
| `BOXLITE_SECURITY` | `run`, `create` | Sandbox preset; equivalent to `--security` |
| `BOXLITE_SERVE_API_KEY` | `serve` | Expected bearer key; equivalent to `serve --api-key` |
| `OIDC_ISSUER` | `auth login` | OIDC issuer fallback after an explicit flag and server discovery |
| `OIDC_CLIENT_ID` | `auth login` | OIDC client-id fallback after an explicit flag and server discovery |
| `OIDC_AUDIENCE` | `auth login` | OIDC audience fallback after an explicit flag and server discovery |
| `BOXLITE_LOG_FILE` | logging | Explicit JSON log-file path for any command; a bare filename is relative to the current directory. `serve` otherwise logs to `<BOXLITE_HOME>/logs/serve.log`. |
| `BOXLITE_EXPERIMENTAL` | `run`, `create` | Comma-separated RC features: `custom-kernel`, `nested-virtualization` |
| `BOXLITE_RECONNECT_GRACE` | `serve` | Reconnect grace before SIGHUP; default `5m` |
| `BOXLITE_SHUTDOWN_GRACE` | `serve` | Grace between shutdown escalation stages; default `30s` |
| `BOXLITE_MAX_SESSION_LIFETIME` | `serve` | Session hard cap; default `24h` |
| `SSH_CONNECTION` | `auth login` | Headless detection; choosing Browser from the TTY picker falls back to device flow when set |
| `RUST_LOG` | tracing | Log level/filter (`error`, `warn`, `info`, `debug`, `trace`; or per-module e.g. `boxlite=debug`) |

The three `serve` duration variables accept bare seconds or `Ns`, `Nm`, and
`Nh`. Invalid values log a warning and use the documented default.

---

## Connecting to the cloud

Create a remote context with `auth login`, then select it with `context use`.
The selected context supplies the endpoint, tenant path, and stored credentials.
`BOXLITE_API_KEY` overrides only the bearer credential.

```bash
# Interactive; select once for subsequent commands
boxlite --context cloud auth login --url https://<your-server>
boxlite context use cloud
boxlite list

# CI / scripted (API key from stdin)
echo "$KEY" | boxlite auth login --api-key-stdin --url https://<your-server>

# CI via env vars only
BOXLITE_API_KEY=$KEY BOXLITE_REST_URL=https://<your-server> boxlite list
```

Credentials are stored at `<BOXLITE_HOME>/credentials.toml` (default
`~/.boxlite/credentials.toml`, perms `0600`). See [`boxlite auth login`](#boxlite-auth-login),
[`boxlite auth logout`](#boxlite-auth-logout), [`boxlite auth status`](#boxlite-auth-status),
and [`boxlite auth whoami`](#boxlite-auth-whoami) for the full command surface.

---

## Commands

### `boxlite context`

| Command | Behavior |
|---------|----------|
| `boxlite context use NAME` | Save the current context for subsequent commands. Validates that a named context exists; `default` always exists. |
| `boxlite context show` | Print the effective name, including flag and environment overrides. Does not validate credentials or contact the server. |
| `boxlite context ls` | List names and endpoints; mark the effective context with `*`. Alias: `list`. `-q` / `--quiet` prints names only. |

Create or update contexts with `boxlite --context NAME auth login --url URL`.
Login stores credentials without changing the saved selection. All context
commands work offline and omit tokens from their output.

Selection follows Docker's context/host behavior (`--url` is BoxLite's host
override). For commands other than `auth login`, resolve in this order:

1. Explicit `--context NAME` (legacy alias `--profile NAME`).
2. Explicit `--url URL`, selecting `default` with that URL.
3. Nonempty `BOXLITE_REST_URL`, selecting `default` with that URL.
4. Nonempty `BOXLITE_CONTEXT`.
5. Nonempty `BOXLITE_PROFILE` (legacy fallback).
6. Saved `current_context` in `<BOXLITE_HOME>/cli.toml`.
7. `default`.

Explicit context and URL flags conflict, except for `auth login`, where the URL
configures the selected context. An explicit named context ignores the URL
environment variable; explicit `--context default` still honors it. Empty
environment values are unset; empty selector flags are errors. Overrides never
change the saved selection. `context use` warns when an override remains active.

`default` represents the existing BoxLite default configuration: use the URL
override, otherwise credentials named `default`, otherwise the embedded runtime.
Existing remote default logins therefore keep working. `local` is an ordinary
user-defined name. A missing named context fails before a workload starts, without
falling back to the embedded runtime. Logout removes credentials but keeps the
selection; log in again or explicitly `context use default` to recover.

Preferences and credentials share the `--home` / `BOXLITE_HOME` directory.
`cli.toml` stores only the current name; `credentials.toml` retains the compatible
`[profiles.NAME]` schema. Switching atomically replaces a private preference file
and does not rewrite credentials. Concurrent switches use the last completed
write. Malformed or unreadable preferences are errors when selection needs them.
Workload commands snapshot the context and credentials before dispatch, so a
concurrent switch cannot redirect a running command. Local-only commands (`serve`,
`pull`, `images`, `info`, `logs`), help, and completion do not read context state.

```bash
boxlite context use cloud
boxlite list                       # cloud
boxlite --context staging list     # one invocation; cloud stays selected
boxlite context show              # cloud
boxlite context use default       # restore the default configuration
```

The precedence is verified against Docker CLI 29.4.3 and its
[context resolver source](https://github.com/docker/cli/blob/v28.5.2/cli/command/cli.go#L461-L485).
Docker's [context use documentation](https://docs.docker.com/reference/cli/docker/context/use/)
describes persisted switching. Its [environment-variable documentation](https://docs.docker.com/reference/cli/docker/#environment-variables)
differs from that executable ordering. BoxLite follows the executable behavior above.
See [design #2167](https://github.com/boxlite-ai/boxlite/issues/2167).

---

### `boxlite auth login`

**Synopsis:** `boxlite auth login [OPTIONS]`

Log in with a long-lived API key, browser OIDC, or device-code OIDC.
Credentials are stored at `<BOXLITE_HOME>/credentials.toml` (default
`~/.boxlite/credentials.toml`, perms `0600`).
`--context NAME` selects the context to create or update; otherwise login uses
the effective current context. `--url` configures that context and does not
change the selected name. Login never changes the saved current context.

**Options:**

| Flag | Description |
|------|-------------|
| `--url URL` | Server URL. Precedence: flag, `BOXLITE_REST_URL`, selected context URL, then `https://api.boxlite.ai`. |
| `--method <api-key\|browser\|device>` | Select the login flow explicitly. |
| `--api-key-stdin` | Read the API key from stdin (one line); selects `api-key` and conflicts with explicit browser/device methods. |
| `--no-browser` | Use device-code login when no method is explicit; conflicts with API-key stdin and explicit `api-key`/`browser` methods. |
| `--issuer URL` | Browser/device only: override the OIDC issuer discovered from the server. |
| `--client-id ID` | Browser/device only: override the discovered OIDC client ID. |
| `--audience VALUE` | Browser/device only: override the discovered OIDC audience. |
| `--callback-port PORT` | Browser only: callback port, `1..=65535` (default `5555`). |

**Examples:**

```bash
# Interactive — prompts for the API key with hidden input
boxlite auth login

# API key from stdin (CI-friendly)
echo "$KEY" | boxlite auth login --api-key-stdin --url https://<your-server>
```

---

### `boxlite auth logout`

**Synopsis:** `boxlite auth logout [OPTIONS]`

Delete the selected context from `<BOXLITE_HOME>/credentials.toml`. The file is
removed when its final context is deleted. Prompts unless `--yes` is given.
The current selection stays unchanged. Workload commands fail if the selected
named context is now missing; log in again or switch explicitly.

**Options:**

| Flag | Short | Description |
|------|-------|-------------|
| `--yes` | `-y` | Skip the confirmation prompt |

---

### `boxlite auth status`

**Synopsis:** `boxlite auth status [--url URL | --context NAME]`

Print the current authentication state without revealing the secret. Reports
the context name and selection source, logged-in URL, and credential source
(stored file vs env var). If neither the
file nor env vars are present, prints
``Not logged in (context `NAME`).`` An explicit `--url`
selects the default context with that endpoint. With only `BOXLITE_API_KEY` set, the
auth probe reports the default API endpoint, `https://api.boxlite.ai`.

**Example output:**

```
Context:         default (from default)
Logged in to:    https://api.boxlite.ai
Credential:      API key (from <BOXLITE_HOME>/credentials.toml [default])
```

When the env var override is active:

```
Credential:      API key (from BOXLITE_API_KEY env var)
```

---

### `boxlite auth whoami`

**Synopsis:** `boxlite auth whoami [--url URL | --context NAME]`

Call `GET /v1/me` with the active credential and print the server-resolved
principal, path prefix, scopes, and server URL. An explicit `--url` selects the
default context with that endpoint. OIDC credentials refresh when near expiry.

**Example output:**

```
Logged in as:    dev@acme.test
Name:            Dev McAcme
Principal:       auth0|abc123 (user)
Path prefix:     acme
Server:          https://api.boxlite.ai
Scopes:          box:read, box:write, box:exec
```

---

### `boxlite run`

**Synopsis:**

- `boxlite run [OPTIONS] IMAGE [COMMAND...]`
- `boxlite run [OPTIONS] --rootfs PATH [COMMAND...]`

Create a box from an image (or a prepared rootfs via `--rootfs`) and run a
command, with docker's semantics: `COMMAND` replaces the image's `CMD`, the
image's `ENTRYPOINT` is prepended, and the result **is** the container's init
(PID 1).

`--entrypoint EXEC` replaces the image entrypoint and clears its default
CMD; only an explicit `COMMAND` is appended. Omit both to run the image's defaults.
See [startup command overrides](../../concepts/images.md#startup-command-overrides).

The box's lifetime is that command's lifetime. When it exits, the box stops and
takes the command's exit code; `boxlite ps` shows it stopped and
`boxlite inspect -f '{{.State.ExitCode}}'` gives the code.

**Options:** Uses [`ProcessFlags`](#processflags) + [`CapabilityFlags`](#capabilityflags) + [`ResourceFlags`](#resourceflags) + [`PublishFlags`](#publishflags) + [`VolumeFlags`](#volumeflags) + [`NetworkFlags`](#networkflags) + [`ManagementFlags`](#managementflags), plus:

| Flag | Short | Description |
|------|-------|-------------|
| `--rootfs PATH` | — | Use a prepared rootfs path instead of pulling/resolving an image |
| `--entrypoint EXEC` | — | Override the image entrypoint |
| `--detach` | `-d` | Run in the background and print the box ID |
| `--rm` | — | Remove the box when it stops; conflicts with lifecycle deadlines and is ignored with `--detach` |

**Exit behavior:**

- Default (foreground): streams stdout/stderr to the terminal, exits with the box command's exit code. If the command was killed by signal *N*, exits with `128 + N` (Unix convention, see [Exit Codes](#exit-codes)).
- `-d`/`--detach`: prints the box ID to stdout and exits `0` immediately; remove-on-stop is force-disabled in this mode so the box outlives the CLI process.
- `--tty` with non-TTY stdin: fails with `the input device is not a TTY.`

**Examples:**

```bash
boxlite run alpine:latest echo "Hello"
boxlite run -it --rm alpine:latest /bin/sh
boxlite run -d --name web -p 8080:80 nginx:alpine
boxlite run -v $(pwd):/work -w /work alpine:latest ls -la
boxlite run --cpus 4 --memory 4096 python:slim python -c "print(2+2)"
boxlite run --cap-add SYS_ADMIN --cap-drop NET_RAW alpine:latest sh
boxlite run --rootfs /path/to/rootfs /bin/sh
```

---

### `boxlite exec`

**Synopsis:** `boxlite exec [OPTIONS] BOX -- COMMAND [ARGS...]`

Run a command in a box. A safely resumable stopped box starts implicitly; a
job box whose start would run or re-run its user-selected main command is
refused, so start it deliberately with `boxlite start` first. The `--`
separator is required (`src/cli/src/commands/exec.rs:22`, `last = true`).

**Options:** Uses [`ProcessFlags`](#processflags), plus:

| Flag | Short | Description |
|------|-------|-------------|
| `--detach` | `-d` | Start the command and return immediately without streaming |

**Exit behavior:** Same as `boxlite run` (foreground streams + propagates exit code; detach exits `0`). After a foreground exec finishes the CLI calls `runtime.shutdown(None)` to release the box handle gracefully.

**Examples:**

```bash
boxlite exec mybox -- echo "hello"
boxlite exec -it mybox -- /bin/sh
boxlite exec -e DEBUG=1 -w /app mybox -- pytest tests/
```

---

### `boxlite create`

**Synopsis:**

- `boxlite create [OPTIONS] IMAGE [COMMAND...]`
- `boxlite create [OPTIONS] --rootfs PATH [COMMAND...]`

Create a box without starting it. Prints the new box's ID to stdout.

`COMMAND` is stored, not run — it becomes the box's main command (the container's
init) when the box is next started, exactly as it would under `run`.
`--entrypoint EXEC` uses the same override rules as [`run`](#boxlite-run), including
clearing the image CMD. Omit both `COMMAND` and `--entrypoint` to use image defaults.

A box created **with** `COMMAND` or `--entrypoint` is a job: `exec` and `cp` will not
start it implicitly, because starting it runs that command. Start it deliberately with
`boxlite start`. A box created **without** either boots the image's default, and
`exec` still starts it on demand.

**Options:**

| Flag | Short | Description |
|------|-------|-------------|
| `--rootfs PATH` | — | Use a prepared rootfs path instead of pulling/resolving an image |
| `--env KEY[=VALUE]` | `-e` | Set environment variables; a bare key inherits its host value (repeatable) |
| `--workdir PATH` | `-w` | Working directory inside the box |
| `--entrypoint EXEC` | — | Replace the image entrypoint with one executable |

Also uses [`CapabilityFlags`](#capabilityflags) + [`ResourceFlags`](#resourceflags) + [`PublishFlags`](#publishflags) + [`VolumeFlags`](#volumeflags) + [`NetworkFlags`](#networkflags) + [`ManagementFlags`](#managementflags).

> Note: `create` accepts `--env` and `--workdir` directly rather than via `ProcessFlags` (no `-i`/`-t`/`-u` here, since no command is being executed).

**Examples:**

```bash
boxlite create --name mybox alpine:latest
boxlite create -p 8080:80 -v /data:/app/data --name web nginx:alpine
boxlite create --cap-drop ALL --cap-add NET_BIND_SERVICE --name web nginx:alpine
boxlite create --rootfs /path/to/rootfs --name local-rootfs
```

---

### `boxlite list`

**Aliases:** `ls`, `ps`

**Synopsis:** `boxlite list [OPTIONS]`

List boxes.

**Options:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--all` | `-a` | `false` | Show all boxes (default: only active) |
| `--quiet` | `-q` | `false` | Print only IDs; conflicts with `--format` |
| `--format FMT` | — | `table` | Output format; conflicts with `--quiet` (see [Output Formats](#output-formats)) |

**Examples:**

```bash
boxlite list                  # active boxes, table
boxlite ls -aq                # all box IDs, one per line
boxlite ps --format json
```

---

### `boxlite rm`

**Synopsis:** `boxlite rm [OPTIONS] [BOX...]`

Remove one or more boxes. Either name them or use `--all`.

**Options:**

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Force-remove a running box |
| `--all` | `-a` | Remove all boxes (prompts unless `--force`) |

**Exit behavior:** Prints each removed box ID to stdout. If any target fails, prints its error to stderr and exits non-zero after attempting the rest.

**Examples:**

```bash
boxlite rm mybox
boxlite rm -f mybox1 mybox2
boxlite rm --all --force
```

---

### `boxlite start`

**Synopsis:** `boxlite start BOX [BOX...]`

Start one or more stopped boxes. No options. Prints each started box's name/ID to stdout; aggregates errors and exits non-zero if any failed.

---

### `boxlite stop`

**Synopsis:** `boxlite stop BOX [BOX...]`

Stop one or more running boxes. Same shape as `start`.

---

### `boxlite restart`

**Synopsis:** `boxlite restart BOX [BOX...]`

Stop then start one or more boxes. If `stop` fails for a box, that box is skipped (resources may still be locked) and the error is reported. After `stop`, the CLI re-fetches the box handle with `runtime.get()` because the post-stop handle is invalidated.

---

### `boxlite pull`

**Synopsis:** `boxlite pull [OPTIONS] IMAGE`

Pull an image from a registry into the local image cache.

**Options:**

| Flag | Short | Description |
|------|-------|-------------|
| `--quiet` | `-q` | Print only the image's config digest |

**Examples:**

```bash
boxlite pull alpine:latest
boxlite pull -q ghcr.io/openclaw/openclaw:main
```

---

### `boxlite images`

**Synopsis:** `boxlite images [OPTIONS]`

List cached images.

**Options:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--quiet` | `-q` | `false` | Print only image IDs; conflicts with `--format` |
| `--format FMT` | — | `table` | Output format; conflicts with `--quiet` (see [Output Formats](#output-formats)) |

---

### `boxlite inspect`

**Synopsis:** `boxlite inspect [OPTIONS] [BOX...]`

Show detailed information for one or more boxes.

**Options:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--latest` | `-l` | `false` | Inspect the most recently created box (cannot combine with `BOX`) |
| `--format FMT` | `-f` | `json` | `json`, `yaml`, or a Go template (e.g. `'{{.State.Status}}'`) |

The Go-template engine exposes a `json` function for serializing nested values.
`State.StartedAt` is when the box most recently entered `Running`, in RFC 3339
format, or `null` if the start time has not been recorded or is unavailable
over REST. `State.LastActivityAt` is when the box was last active in RFC 3339
format — the clock AutoStop measures idleness against — or `null` for a local
box, which records no activity. `Network.Outbound` and `Network.Inbound` each
carry `Mode` (`enabled` or `disabled`) and `AllowNet`; `Network` is `null` when
the runtime does not know the policy, such as a REST server that predates it.

**Examples:**

```bash
boxlite inspect mybox
boxlite inspect --format '{{.State.Status}}' mybox
boxlite inspect --format '{{.Network.Inbound.Mode}}' mybox
boxlite inspect --format '{{.State.StartedAt}}' mybox
boxlite inspect --format '{{.State.LastActivityAt}}' mybox
boxlite inspect -l --format yaml
```

---

### `boxlite cp`

**Synopsis:** `boxlite cp [OPTIONS] SRC DST`

Copy files/folders between host and box. Exactly one of `SRC` or `DST` must be a `BOX:PATH` reference.
End a directory `SRC` with `/.` to copy its contents rather than the directory itself, as
`docker cp` does.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--follow-symlinks` | `false` | Resolve symlink targets (embedded local runtime only) |
| `--no-overwrite` | `false` | Refuse to overwrite destination files (embedded local runtime only) |

If a stopped box is safe to resume, it is started temporarily and restored to
stopped state after the copy succeeds or fails. A job box whose start would run
or re-run its user-selected main command is refused; start it deliberately
before copying.

Paths at or under a mount inside the box are refused in both directions — `/tmp`,
`/dev/shm`, volumes, and the `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` binds.
`cp` works on the rootfs layer from outside the box's mount namespace, so such a copy
would write where nothing in the box can see it, or read back the image's file rather
than the one the box has.

A directory that merely *contains* a mount is treated differently per direction. Copying
one **out** is refused (`boxlite cp box:/etc ./etc`), since the archive would carry the
image's files rather than the mounted ones. Copying **in** is allowed, and refused only
if a file being written would land on a mount — so `boxlite cp ./x box:/etc` works.

Copy a path outside the mount, or pipe a tar through `boxlite exec`. Files copied in are
owned by the box's exec user.

**Examples:**

```bash
boxlite cp ./script.py mybox:/work/script.py        # host -> box
boxlite cp mybox:/var/log/app.log ./app.log         # box -> host
boxlite cp --no-overwrite ./data/ mybox:/data/      # local runtime only
boxlite cp ./dist/. mybox:/srv/www                  # the contents of ./dist
```

---

### `boxlite info`

**Synopsis:** `boxlite info [OPTIONS]`

System-wide runtime information: version, home dir, virtualization status, OS/arch, and box/image counts.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--format {yaml\|json}` | `yaml` | Output format |

Output fields: `version`, `homeDir`, `virtualization` (`available` or `unavailable: <reason>`), `os`, `arch`, `boxesTotal`, `boxesRunning`, `boxesStopped`, `boxesConfigured`, `imagesCount`.

---

### `boxlite logs`

**Synopsis:** `boxlite logs [OPTIONS] BOX`

Show the box's console log (`{home}/boxes/{box_id}/logs/console.log`).

**Options:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--tail N` | `-n` | `0` | Show only the last N lines (0 = all) |
| `--follow` | `-f` | `false` | Stream new output as it's written |

If the log file does not exist (box never started), prints a hint to stderr and exits `0`.

---

### `boxlite stats`

**Synopsis:** `boxlite stats [OPTIONS] BOX`

Display resource usage statistics for a box.

**Options:**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--format FMT` | — | `table` | Output format (see [Output Formats](#output-formats)) |
| `--stream` | `-s` | `false` | Refresh every second until Ctrl-C |

---

### `boxlite network inbound / outbound`

```text
boxlite network inbound BOX MODE
boxlite network outbound BOX MODE [--allow-net RULE]...
```

`BOX` is an ID or name; `MODE` is required and accepts `enabled` or `disabled`.
Each invocation replaces the selected direction. `inbound` accepts no allowlist.

```bash
boxlite network inbound mybox enabled
boxlite network outbound mybox enabled --allow-net '*.example.com' --allow-net 10.0.0.0/8
boxlite network outbound mybox enabled  # default empty list: unrestricted
boxlite network outbound mybox disabled
boxlite inspect mybox
```

`--allow-net` takes one hostname, wildcard hostname, IPv4 address or CIDR.
Repeat it for multiple rules; comma-separated values and empty rules such as
`''` are invalid, as they are at create. Omit `--allow-net` for the default
empty list, which removes restrictions when enabled. Disabled mode accepts no
`--allow-net`. No previous allowlist is retained or restored.

Outbound updates require a running box with an existing NIC. Local inbound
updates are unsupported; cloud inbound uses the proxy's existing visibility
contract. See [runtime behavior and persistence](../../guides/networking.md#updating-a-running-box).

### `boxlite network tunnel`

**Synopsis:** `boxlite network tunnel BOX GUEST_PORT [--private] [--listen ADDRESS | --revoke]`

Without `--listen`, print the public URL supplied by a remote REST service;
local boxes have no public URL. With `--listen`, bind a local listener and
forward it to either a local or remote box instead:

```bash
boxlite network tunnel mybox 3000 --listen 8080
boxlite network tunnel mybox 3000 --listen 127.0.0.1:8080
boxlite network tunnel mybox 3000 --listen '[::1]:8080'
boxlite network tunnel mybox 3000 --listen unix:/tmp/app.sock
```

A bare port binds `127.0.0.1`; listener port `0` asks the OS to allocate a
port. A client that connects while nothing in the box listens on `GUEST_PORT`
is disconnected; the listener keeps running. The canonical bound address is
printed to stdout before clients are accepted.
Ctrl-C closes the listener and active connections. TCP hosts must be numeric
addresses, and Unix socket paths must be absolute.

A remote box needs inbound access enabled before it can be tunneled: create it
with `--inbound enabled`.

For a private cloud tunnel, use the context's API key or JWT:

```bash
boxlite --context cloud network tunnel mybox 3000 --private
boxlite --context cloud network tunnel mybox 3000 --private --listen 8080
```

Private creation prints one JSON line containing `uri`, `isPublic`, and `token`.
Only creation returns the complete token; repeating the same command returns its
mask. An existing public tunnel must be revoked before recreating it as private.
With `--listen`, the descriptor is printed and flushed **before** binding, followed
by the bound address on the next line. A bind failure leaves the created tunnel
and its already-printed token available; Ctrl-C closes only the local forwarder.
Each accepted client opens an authenticated CONNECT without preparing again.
There is no `--token` option: external visitors use the URL query or HTTP header,
while CLI traffic uses the configured organization credential.

`--revoke` withdraws the port's public or private tunnel instead, without `--private`. New requests to it get
`404` within 3 seconds; connections already open are not closed. It is safe to
repeat, and running the command again without `--revoke` reopens the same URL:

```bash
boxlite network tunnel mybox 3000 --revoke
```

---

### `boxlite ssh`

**Synopsis:**

```
boxlite ssh configure BOX CONFIG
boxlite ssh status BOX
boxlite ssh disable BOX
boxlite ssh configure-and-forward BOX CONFIG [--listen ADDRESS]
boxlite ssh forward BOX [--listen ADDRESS]

CONFIG := --ssh-config FILE
        | --host-key FILE --login NAME --authorized-key FILE... [--guest-listen ADDRESS]
```

Control the guest SSH server of a local box or a REST box (`--url`/`--context`).
The CLI reads keys from files and never generates or stores them.

These five CLI subcommands reuse existing SDK and HTTP operations; they add no
server routes. Backend requirements differ:

| Commands | Local backend | REST backend |
|----------|---------------|--------------|
| `configure`, `status`, `disable` | Existing SSH SDK operations | Requires SSH control; supported by `boxlite serve` |
| `configure-and-forward`, `forward` | Existing local tunnel implementation | Requires both SSH control and tunnel support; unavailable through `boxlite serve` |

| Subcommand | Effect | stdout |
|------------|--------|--------|
| `configure` | Replace the complete configuration once; disconnects existing SSH clients | `SshStatus` JSON |
| `status` | Read state; never starts the box | `SshStatus` JSON |
| `disable` | Stop SSH; never starts the box | `SshStatus` JSON |
| `configure-and-forward` | `configure` once, then `forward` | Bound address |
| `forward` | Read status; fail if disabled; forward to the port SSH actually bound | Bound address |

Use `configure-and-forward` to configure SSH and start forwarding together. Every
invocation replaces the SSH configuration and disconnects existing SSH clients. Use
`forward` to reopen forwarding after SSH is configured; it leaves the configuration and
generation unchanged.

| Flag | Description |
|------|-------------|
| `--ssh-config FILE` | Complete `SshConfig` JSON ([schema](../../guides/ssh.md#http-control-with-boxlite-serve)): several accounts, authorized keys, CAs. |
| `--host-key FILE` | Unencrypted OpenSSH host private key. Requires `--login` and `--authorized-key`. |
| `--login NAME` | The single login accepted for `--authorized-key`. |
| `--authorized-key FILE` | One OpenSSH public key per file; repeatable. |
| `--guest-listen ADDRESS` | Guest listener for flag mode; default `0.0.0.0:2222`; port `0` lets the guest choose. |
| `--listen ADDRESS` | Local listener, same syntax as [`network tunnel`](#boxlite-network-tunnel); default `127.0.0.1:0`. |

`--ssh-config` conflicts with the flag-mode options. Configuration errors name the
file and position but never print its contents. `configure` follows the SDK's
startup rules: it may start a Configured or Stopped box that uses its image's default
command. `configure-and-forward` and `configure` are never retried.

`configure-and-forward` and `forward` print the canonical bound address to stdout, then
the host public key, its fingerprint, and a connect hint to stderr:

```bash
$ boxlite ssh forward dev
tcp://127.0.0.1:52811
SSH host key: ssh-ed25519 AAAAC3Nz...
SSH host key fingerprint: SHA256:...
Connect: ssh -p 52811 -l LOGIN 127.0.0.1
```

The guest must listen on `0.0.0.0` or the guest IP; `configure-and-forward` checks this
before configuring. Ctrl-C closes the listener and its connections, then exits 0; guest
SSH stays configured. If forwarding fails after `configure-and-forward` configured SSH,
the error says so; the configuration is not rolled back.

- **Local boxes:** the foreground command holds the runtime home, so other local
  commands on that home fail until Ctrl-C. Exiting the CLI stops running boxes that
  are not detached, which ends their SSH; use `boxlite create` or `run -d`.
- **REST boxes:** forwarding uses the box's public tunnel URL for the SSH port and
  leaves it open on exit, so anyone reaching the URL can attempt SSH logins. Withdraw it
  with `boxlite network tunnel BOX PORT --revoke`. `boxlite serve` has no tunnel
  route, so there `configure-and-forward` and `forward` fail after the SSH step.

---

### `boxlite agent`

Agent commands address a Box, an agent and, where needed, a turn. See the
[failure contract](../agents.md#failure-contract) for operation availability.
Unsupported operations report an error on stderr and exit with code 1 before
runtime initialization. Malformed arguments use the normal CLI usage error (code 2).

| Purpose | Command after `boxlite agent` | Operation |
|---|---|---|
| Lifecycle | `create BOX --agent IMPLEMENTATION` | Create an instance with the selected implementation and initial configuration. |
| Lifecycle | `close BOX --agent AGENT` | End the agent. |
| Work | `send BOX --agent AGENT TEXT` | Submit a new turn. |
| Work | `wait BOX --agent AGENT --turn TURN` | Wait for an existing turn's result. |
| Observe | `inspect BOX --agent AGENT [--turn TURN]` | Read agent or turn state. |
| Observe | `events BOX --agent AGENT [--turn TURN]` | Follow agent or turn events. |
| Interact | `steer BOX --agent AGENT --turn TURN TEXT` | Redirect that turn without submitting another. |
| Interact | `interrupt BOX --agent AGENT --turn TURN` | Interrupt that turn's agent loop. |
| Interact | `respond BOX --agent AGENT --request REQUEST JSON` | Answer a question or approve/deny a permission request. |

`BOX` is positional, as in `boxlite exec`. Creation requires `--agent IMPLEMENTATION`.
For example, `boxlite agent create dev --agent coder` selects implementation
`coder` inside Box `dev`. Other commands use `--agent ID` for a created instance.
Mutations never infer an active turn. `inspect --view config|capabilities|requests` selects an agent-only
read and cannot be combined with `--turn`; omission reads state. The SDK's
`get`/`get_turn` handle lookups are implicit in CLI targeting.

The optional flags are grouped by operation:

| Group | Commands | Flags |
|---|---|---|
| `AgentCreateOptions` | `create` | `--cwd PATH`, `--agent-config JSON`, `--idempotency-key KEY` |
| `AgentSendOptions` | `send` | `--mode queue\|reject` (default `queue`), `--data JSON`, `--idempotency-key KEY` |
| `AgentControlOptions` | close, respond, steer, interrupt | `--idempotency-key KEY` |
| `AgentWaitOptions` | `wait` | `--timeout-seconds SECONDS` (nonnegative whole seconds; omitted means no deadline) |
| `AgentEventsOptions` | `events` | `--after CURSOR` |
| `AgentInspectOptions` | `inspect` | `--view config\|capabilities\|requests` |

`--agent-config` is distinct from the global runtime `--config FILE`. Config,
data and response arguments must be valid JSON. Response JSON uses either
`{"type":"answer","text":"yes"}` (optional `data`) or
`{"type":"permission","approved":false}`. The
[agent API reference](../agents.md#inputs-and-records) describes other record fields.

```bash
boxlite agent create dev --agent coder --cwd /workspace --agent-config '{"model":"model-id"}'
boxlite agent send dev --agent agent-id "Review this code" --mode reject
boxlite agent inspect dev --agent agent-id --view requests
boxlite agent steer dev --agent agent-id --turn turn-id "Focus on tests" --idempotency-key steer-1
boxlite agent events dev --agent agent-id --turn turn-id --after cursor-1
```

Agent commands accept the usual Box
targeting globals (`--home`, `--config`, `--url`, `--context`, `--path-prefix`)
and `--debug`; `--registry` is irrelevant and rejected. Existing diagnostic
logging still applies.

### `boxlite serve`

**Synopsis:** `boxlite serve [OPTIONS]`

Run a long-running REST API server. The server holds a single `BoxliteRuntime` and exposes the full REST surface for `boxlite --url ...` clients and the language SDKs' REST mode.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--debug` | `false` | Enable debug output |
| `--port N` | `8100` | TCP port to listen on |
| `--home PATH` | `~/.boxlite` | Absolute runtime data directory; env `BOXLITE_HOME` |
| `--host ADDR` | `127.0.0.1` | Bind address. Any non-loopback address (e.g. `0.0.0.0`) requires `--api-key`; `serve` refuses to start otherwise. |
| `--api-key KEY` | unset | Require this exact `Authorization: Bearer` value (constant-time match) on every route except `GET /v1/config`; env `BOXLITE_SERVE_API_KEY`. Unset is permissive. |
| `--registry REGISTRY` | none | Image registry; repeatable and prepended to config |
| `--config PATH` | none | JSON runtime configuration file |

**Examples:**

```bash
boxlite serve
boxlite serve --port 9000
BOXLITE_SERVE_API_KEY="$KEY" boxlite serve --host 0.0.0.0
```

---

### `boxlite volume`

**Synopsis:** `boxlite volume <create|ls|get|rm>`

Manage managed persistent volumes. Volumes are a REST-runtime capability — the
local runtime has no volume backend, so every subcommand returns
`named volumes are not supported yet` against it. See
[Connecting to the cloud](#connecting-to-the-cloud).

| Subcommand | Synopsis | Notes |
|---|---|---|
| `create` | `boxlite volume create [--name NAME]` | Prints the new id |
| `ls` (`list`) | `boxlite volume ls [-q \| --format FORMAT]` | `table`, `json`, or `yaml` (default `table`); quiet and format conflict |
| `get` (`inspect`) | `boxlite volume get ID [--format FORMAT]` | `table`, `json`, or `yaml` (default `table`); by id |
| `rm` (`delete`) | `boxlite volume rm ID... [--force]` | By id; `--force` ignores missing volumes |

**`--name`** is mountable in place of the id, so a box can ask for the volume it
wants without knowing the id:

```bash
boxlite volume create --name my-data       # prints e.g. vol_01K2EXAMPLE
boxlite run -v my-data:/data alpine        # by name
boxlite run -v vol_01K2EXAMPLE:/data alpine # or by id
```

Names must be at least two characters of `[a-zA-Z0-9][a-zA-Z0-9_.-]` — Docker's
rule, and for the same reason: the name has to survive
[`-v` parsing](#volume-mount-syntax). A leading `.`, `/` or `~` would classify
the source as a host path; a `:` would split the spec into the wrong fields.
Neither name could ever be mounted. Without `--name` the server names the
volume after its id, which stays mountable.

`get` and `rm` take an id only; mounting is what accepts either.

---

### `boxlite completion`

**Synopsis:** `boxlite completion <SHELL>`

Print a shell completion script to stdout. *Hidden from `--help`* but functional.

**Supported shells:** `bash`, `zsh`, `fish`.

**Examples:**

```bash
boxlite completion bash > /etc/bash_completion.d/boxlite
boxlite completion zsh  > "${fpath[1]}/_boxlite"
boxlite completion fish > ~/.config/fish/completions/boxlite.fish
```

---

## Shared flag groups

Several commands flatten shared `clap` `Args` structs. Each is documented here once.

### `ProcessFlags`

Used by `run` and `exec` (defined in `src/cli/src/cli.rs`).

| Flag | Short | Description |
|------|-------|-------------|
| `--interactive` | `-i` | Keep STDIN open even if not attached; conflicts with `--detach` |
| `--tty` | `-t` | Allocate a pseudo-TTY (stdout and stderr are merged in TTY mode) |
| `--env KEY[=VALUE]` | `-e` | Set environment variables (repeatable; a bare key inherits from the host) |
| `--workdir PATH` | `-w` | Working directory inside the box |
| `--user NAME[:GROUP]` | `-u` | Run as `name`/`uid`[:`group`/`gid`] |

For `run`, `--tty` always requires TTY-attached stdin, including with
`--detach`. Foreground `exec --tty` has the same requirement and implies
interactive input; detached `exec --tty` skips the stdin check and attaches no
stdin.

### `CapabilityFlags`

Used by `run` and `create` to adjust the Linux capability set inherited by the
container's init and every later `exec` process.

| Flag | Description |
|------|-------------|
| `--cap-add CAPABILITY` | Add a capability; repeatable |
| `--cap-drop CAPABILITY` | Drop a capability; repeatable |

Names are case-insensitive and may include the `CAP_` prefix. `ALL` is
supported. With neither flag, BoxLite keeps its Docker-compatible 14-capability
baseline. `--cap-drop ALL --cap-add NET_BIND_SERVICE` creates a minimal set
containing only `NET_BIND_SERVICE`.

### `ResourceFlags`

Used by `run` and `create` (defined in `src/cli/src/cli.rs`).

| Flag | Type | Description |
|------|------|-------------|
| `--cpus N` | u8 | Number of CPUs, 1–16 with the bundled guest kernel. 17–255 are rejected when the box is created; 0 and values above 255 fail while parsing the command line |
| `--memory MiB` | u32 | Memory limit in mebibytes |
| `--disk-size GB` | u64 | Sparse root filesystem disk size in gigabytes |

### `PublishFlags`

Used by `run` and `create` (defined in `src/cli/src/cli.rs`).

| Flag | Short | Description |
|------|-------|-------------|
| `--publish PORT` | `-p` | Publish a box port to the host; repeatable (see [Port Publish Syntax](#port-publish-syntax)) |

TCP is the only supported publication protocol; UDP is rejected.

### `VolumeFlags`

Used by `run` and `create` (defined in `src/cli/src/cli.rs`).

| Flag | Short | Description |
|------|-------|-------------|
| `--volume VOLUME` | `-v` | Mount a volume; repeatable (see [Volume Mount Syntax](#volume-mount-syntax)) |

### `NetworkFlags`

Used by `run` and `create` (defined in `src/cli/src/cli.rs`).

| Flag | Description |
|------|-------------|
| `--network <enabled\|disabled>` | Outbound mode; default `enabled`. Disabled mode creates no network interface. |
| `--allow-net HOST` | Restrict TCP/UDP egress to exact hosts, `*.example.com`, IPv4 addresses, or IPv4 CIDRs; repeatable, implies enabled networking, and is incompatible with `--network disabled`. Hostname-only rules deny UDP unless an IP/CIDR is also allowed. |
| `--inbound <enabled\|disabled>` | Inbound mode; default `disabled` (services exposed by the box are unreachable from outside). |
| `--net-tx-kbps KBPS` | Cap what the box sends (guest to internet), in kilobits/sec. `0` or unset leaves it uncapped. |
| `--net-rx-kbps KBPS` | Cap what reaches the box (internet to guest), in kilobits/sec. `0` or unset leaves it uncapped. |

Bandwidth caps are enforced below IP by the local gvproxy bridge, so a single
budget per direction covers TCP, UDP, ICMP and ARP together, and inbound
port-forward traffic counts against the same budget as outbound requests —
the cap is on the box's interface, not on a connection's direction.
Directions are named from the box's point of view, matching Firecracker.
Remote runtimes reject these flags: the server owns its own network policy.
Verified on Linux; on macOS the guest link is a datagram socket whose sender
behaviour under backpressure is not yet verified, so `--net-tx-kbps` may drop
frames there instead of slowing the guest.

### `ManagementFlags`

Used by `run` and `create` (defined in `src/cli/src/cli.rs`).
`--detach` and `--rm` belong only to `run`; `create` is always detached and
does not expose remove-on-stop.

| Flag | Short | Description |
|------|-------|-------------|
| `--name NAME` | — | Assign a name to the box |
| `--auto-stop DURATION` | — | Stop the box after this much inactivity; `0` disables |
| `--auto-delete DURATION` | — | Delete the box this long after it stops; `0` disables |
| `--no-auto-resume` | — | Ask a REST server to refuse implicit resume after a box has run; first boot is unaffected, and the embedded runtime records but does not enforce it |
| `--security <enable\|disable>` | — | Sandbox security for the embedded runtime (env `BOXLITE_SECURITY`, default `enable`); REST servers own this policy and do not accept a client override |

`DURATION` is seconds when bare, or a suffixed value: `30s`, `15m`, `2h`, `7d`.

> `--auto-stop` and `--auto-delete` are deadlines a sweeper acts on, so they need a server — `boxlite serve` or the cloud. Against the embedded runtime a non-zero value is refused rather than silently reinterpreted. The sweep runs on a 30s tick, so a deadline fires on the first tick at or after it. A server also requires `auto_delete` to exceed `auto_stop`; a box cannot be scheduled for deletion sooner than it is scheduled to stop.

> `--rm` removes the box when it stops. Against the embedded runtime that is synchronous, at the stop itself. Against `boxlite serve` it is carried as the shortest possible deadline and swept on the same 30s tick, so removal can lag the stop by up to one tick — and, because `serve` holds that policy in memory, is skipped entirely if the server restarts in between.

> `--rm` with `--detach` on `run` is silently downgraded — a detached box outlives the CLI process, so it keeps manual lifecycle control. An explicit `--auto-delete` survives detaching, which is the pairing the flag exists for. Use `boxlite rm` to clean up.

---

## Volume mount syntax

`-v`/`--volume` accepts the grammar implemented in `src/cli/src/volumespec.rs`:

```
VOLUME := SOURCE ':' BOX_PATH [':' OPTIONS]             # managed volume or bind mount
        | BOX_PATH [':' OPTIONS]                         # anonymous volume
```

`SOURCE` is classified by its **first character**, the same rule Docker uses
(`docker/cli/internal/volumespec`). Nothing inspects the filesystem, so a spec
means the same thing on every machine:

| `SOURCE` starts with | Meaning |
|---|---|
| `/`, `./`, `../`, `~` | Host path |
| `\\` (UNC / named pipe) | Host path |
| A drive letter, e.g. `C:\` or `D:/` | Host path |
| Anything else | **Managed volume**, by id or by name |

| Form | Example | Behavior |
|------|---------|----------|
| `BOX_PATH` | `/data` | Anonymous volume stored under `{home}/volumes/anonymous/<ulid>` |
| `BOX_PATH:ro` / `BOX_PATH:rw` | `/data:ro` | Anonymous volume with explicit mode |
| `VOLUME:BOX_PATH` | `my-data:/data` | Managed volume by name |
| `VOLUME:BOX_PATH` | `vol_01K2EXAMPLE:/data` | Managed volume by server-assigned id |
| `HOST_PATH:BOX_PATH` | `/host/data:/data` | Bind mount (host directory must exist) |
| `HOST_PATH:BOX_PATH:OPTIONS` | `./data:/data:ro` | Bind mount with options |
| `C:\HOST\PATH:/BOX_PATH[:OPTIONS]` | `C:\data:/app/data:ro` | Windows drive paths are handled — the drive-letter colon is not treated as a separator |

**Options:** `ro` (read-only) or `rw` (read-write, default). Other options are ignored. Relative host paths are canonicalized at parse time; missing host paths fail with `volume host path ...`.

**Runtime support.** Managed volumes require a REST runtime — the local runtime
has no volume backend and rejects them at create. Host binds are the mirror
image: they name a path on the machine running the box, so a REST runtime
refuses them. Manage volumes with [`boxlite volume`](#boxlite-volume).

> **Behavior change.** A bare relative source is no longer a bind mount:
> `-v data:/app` now means the managed volume `data`, not `./data`. Write
> `./data:/app` for the bind. Unlike Docker, a mistyped name cannot silently
> create an empty volume — boxlite never auto-creates, so an unknown reference
> fails with "Volume 'data' not found".

**Single-character names are not addressable via `-v`.** The parser cannot
distinguish `a:` from a drive letter, so `-v a:/data` is read as one field and
fails. Docker has the same limitation and rejects one-character volume names
outright.

The anonymous-volume base directory is resolved as: `--home`, else `$BOXLITE_HOME`, else `~/.boxlite`, else the system temp dir.

---

## Port publish syntax

`-p`/`--publish` accepts the grammar implemented at
`src/cli/src/cli.rs`:

```
PORT := [HOST_PORT ':'] BOX_PORT ['/tcp']
```

| Form | Example | Behavior |
|------|---------|----------|
| `BOX_PORT` | `80` | Let the OS select an available host port and forward it to box port `80` |
| `HOST_PORT:BOX_PORT` | `8080:80` | Forward host port `8080` to box port `80` |
| `HOST_PORT:BOX_PORT/PROTO` | `8080:80/tcp` | Full form |

Ports must be in `1..=65535`. TCP is the only supported protocol; UDP is rejected.
`-p` is explicit local publication and is rejected for remote REST runtimes.
For a remote box, use `boxlite network tunnel BOX PORT` to obtain its public
service URL. For SDK code that must run with either runtime, use the box network
tunnel API; each returned tunnel is one-shot.
Image `EXPOSE` declarations remain metadata and do not open host listeners.

---

## Output formats

The `--format` flag is shared across `list`, `images`, `inspect`, `stats`,
`info`, `volume ls`, and `volume get`. Valid values come from
`OutputFormat::from_str` at `src/cli/src/formatter.rs:26`:

| Format | Available on | Description |
|--------|--------------|-------------|
| `table` | `list`, `images`, `stats`, `volume ls`, `volume get` | Human-readable columnar layout |
| `json` | `list`, `images`, `stats`, `inspect`, `info`, `volume ls`, `volume get` | Pretty-printed JSON (`serde_json::to_string_pretty`) |
| `yaml` | `list`, `images`, `stats`, `inspect`, `info`, `volume ls`, `volume get` | YAML (`serde_yaml::to_string`) |
| Go template | `inspect` only | Any `gtmpl` template, e.g. `'{{.State.Status}}'`; `{{json .Field}}` serializes a nested value |

Defaults:

- `list`, `images`, `stats`, `volume ls`, `volume get`: `table`
- `inspect`: `json`
- `info`: `yaml`

---

## Configuration file

`--config PATH` accepts a JSON file deserialized into `BoxliteOptions`. The primary field is `image_registries`; `image_registry_proxy` sets a pull proxy (see [Pull proxy](../../guides/image-registry-configuration.md#pull-proxy)). CLI flags like `--home` and `--registry` are layered on top after loading. A context that targets a remote server ignores this file.

```json
{
  "home_dir": "/custom/.boxlite",
  "image_registries": [
    {
      "host": "registry.example.com",
      "protocol": "https",
      "search": true,
      "username": "user",
      "password": "password"
    },
    {
      "host": "127.0.0.1:5000",
      "protocol": "http",
      "search": false
    }
  ]
}
```

For a richer treatment of the registry config (auth flows, fallbacks, mirrors), see [`docs/guides/image-registry-configuration.md`](../../guides/image-registry-configuration.md).

---

## Exit codes

`boxlite` follows POSIX shell exit-code conventions. The mapping lives at `src/cli/src/util/mod.rs:11-15`.

| Code | Source | Meaning |
|------|--------|---------|
| `0` | success | Command (or box command) finished successfully |
| `1` | runtime | Any anyhow error from a CLI command — `main.rs:71` prints `Error: ...` to stderr and exits `1` |
| `2` | clap | Invalid CLI usage (unknown flag, missing required arg, bad value) |
| `N` (1-127) | box command | `run`/`exec` propagate the box command's exit status |
| `128 + N` | signal | `run`/`exec` exited because the box command was killed by signal *N* (e.g. `137` for `SIGKILL`, `143` for `SIGTERM`) |

`boxlite rm`, `start`, `stop`, `restart` aggregate per-target errors and exit `1` if any target failed, after attempting all targets.

---

## See also

- [`src/cli/README.md`](../../../src/cli/README.md) — quick start, install alternatives, common workflows
- [`docs/reference/README.md`](../README.md) — reference index (SDKs + CLI)
- [`docs/guides/image-registry-configuration.md`](../../guides/image-registry-configuration.md) — registry config deep dive
- [`docs/getting-started/`](../../getting-started/) — per-language getting-started guides
