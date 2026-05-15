# BoxLite CLI Reference

Exhaustive reference for the `boxlite` command-line interface — every subcommand, every flag, every exit code.

**Platforms:** macOS (Apple Silicon), Linux (x86_64, ARM64), Windows (WSL2)

For a quick start, see [`src/cli/README.md`](../../../src/cli/README.md).

## Table of Contents

- [Synopsis](#synopsis)
- [Installation & Verification](#installation--verification)
- [Global Options](#global-options)
- [Environment Variables](#environment-variables)
- [Connecting to the cloud](#connecting-to-the-cloud)
- [Commands](#commands)
  - [`boxlite auth login`](#boxlite-auth-login)
  - [`boxlite auth logout`](#boxlite-auth-logout)
  - [`boxlite auth status`](#boxlite-auth-status)
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
  - [`boxlite serve`](#boxlite-serve)
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

## Installation & Verification

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

## Global Options

These flags can appear before *or* after the subcommand and apply to every command.

| Flag | Type | Default | Env Var | Description |
|------|------|---------|---------|-------------|
| `--debug` | bool | `false` | — | Enable debug output |
| `--home PATH` | path | `~/.boxlite` | `BOXLITE_HOME` | BoxLite runtime data directory |
| `--registry REGISTRY` | string (repeatable) | `[]` | — | Image registry hostname; prepended to the registries from `--config` |
| `--config PATH` | path | none | — | JSON config file (see [Configuration File](#configuration-file)) |
| `--url URL` | string | none | `BOXLITE_REST_URL` | Connect to a remote BoxLite REST API server instead of the local runtime |

**Precedence** (from `src/cli/src/cli.rs:163-201`):

1. `--url` short-circuits to the REST runtime — no local hypervisor is touched. `--home`, `--registry`, and `--config` are ignored.
2. Otherwise, `--config` is loaded as the base options, then `--home` overrides `home_dir`, and `--registry` flags are prepended to `image_registries`.

---

## Environment Variables

| Variable | Read by | Description |
|----------|---------|-------------|
| `BOXLITE_HOME` | `--home` | Runtime data directory; equivalent to `--home` |
| `BOXLITE_REST_URL` | `--url` | REST server endpoint; equivalent to `--url` |
| `BOXLITE_API_KEY` | REST runtime | Long-lived API key sent as `Authorization: Bearer`. Overrides any stored credentials. |
| `RUST_LOG` | tracing | Log level/filter (`error`, `warn`, `info`, `debug`, `trace`; or per-module e.g. `boxlite=debug`) |

---

## Connecting to the cloud

To target a remote BoxLite REST server instead of the local runtime, sign in with `boxlite auth login`. Credential precedence is **env vars > stored file > unauthenticated** (local runtime). The `--url` flag overrides the URL specifically without affecting credentials.

```bash
# Interactive
boxlite auth login

# CI / scripted (API key from stdin)
echo "$KEY" | boxlite auth login --api-key-stdin --url https://<your-server>

# CI via env vars only
BOXLITE_API_KEY=$KEY BOXLITE_REST_URL=https://<your-server> boxlite list
```

Credentials are stored at `~/.boxlite/credentials.toml` (perms `0600`). See [`boxlite auth login`](#boxlite-auth-login), [`boxlite auth logout`](#boxlite-auth-logout), and [`boxlite auth status`](#boxlite-auth-status) for the full command surface.

---

## Commands

### `boxlite auth login`

**Synopsis:** `boxlite auth login [OPTIONS]`

Log in to a BoxLite REST server using a dashboard-issued opaque API key.
Long-lived, org-scoped. Credentials are stored at
`~/.boxlite/credentials.toml` (perms `0600`).

**Options:**

| Flag | Description |
|------|-------------|
| `--url URL` | Server URL (default: `http://localhost:8100`, matching `boxlite serve`) |
| `--api-key-stdin` | Read the API key from stdin (one line). The flag takes no value, so the secret never appears on argv. |

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

Delete the stored credentials file at `~/.boxlite/credentials.toml`. Prompts for confirmation unless `--yes` is given. Prints `Logged out` on success, or `Not logged in` if no file exists.

**Options:**

| Flag | Short | Description |
|------|-------|-------------|
| `--yes` | `-y` | Skip the confirmation prompt |

---

### `boxlite auth status`

**Synopsis:** `boxlite auth status`

Print the current authentication state without revealing the secret. Reports
the logged-in URL and the source (stored file vs env var). If neither the
file nor env vars are present, prints `Not logged in.`

**Example output:**

```
Logged in to:    http://localhost:8100
Credential:      API key (from ~/.boxlite/credentials.toml)
```

When the env var override is active:

```
Credential:      API key (from BOXLITE_API_KEY env var)
```

---

### `boxlite run`

**Synopsis:** `boxlite run [OPTIONS] IMAGE [COMMAND...]`

Create a box from an image and run a command. If `COMMAND` is omitted, the box runs `sh` (`src/cli/src/commands/run.rs:138`).

**Options:** Uses [`ProcessFlags`](#processflags) + [`ResourceFlags`](#resourceflags) + [`PublishFlags`](#publishflags) + [`VolumeFlags`](#volumeflags) + [`ManagementFlags`](#managementflags).

**Exit behavior:**

- Default (foreground): streams stdout/stderr to the terminal, exits with the box command's exit code. If the command was killed by signal *N*, exits with `128 + N` (Unix convention, see [Exit Codes](#exit-codes)).
- `-d`/`--detach`: prints the box ID to stdout and exits `0` immediately; `auto_remove` is force-disabled in this mode so the box outlives the CLI process.
- `--tty` with non-TTY stdin: fails with `the input device is not a TTY.`

**Examples:**

```bash
boxlite run alpine:latest echo "Hello"
boxlite run -it --rm alpine:latest /bin/sh
boxlite run -d --name web -p 8080:80 nginx:alpine
boxlite run -v $(pwd):/work -w /work alpine:latest ls -la
boxlite run --cpus 4 --memory 4096 python:slim python -c "print(2+2)"
```

---

### `boxlite exec`

**Synopsis:** `boxlite exec [OPTIONS] BOX -- COMMAND [ARGS...]`

Run a command in a *running* box. The `--` separator is required (`src/cli/src/commands/exec.rs:22`, `last = true`).

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

**Synopsis:** `boxlite create [OPTIONS] IMAGE`

Create a box without running a command. Prints the new box's ID to stdout.

**Options:**

| Flag | Short | Description |
|------|-------|-------------|
| `--env KEY=VALUE` | `-e` | Set environment variables (repeatable) |
| `--workdir PATH` | `-w` | Working directory inside the box |

Also uses [`ResourceFlags`](#resourceflags) + [`PublishFlags`](#publishflags) + [`VolumeFlags`](#volumeflags) + [`ManagementFlags`](#managementflags).

> Note: `create` accepts `--env` and `--workdir` directly rather than via `ProcessFlags` (no `-i`/`-t`/`-u` here, since no command is being executed).

**Examples:**

```bash
boxlite create --name mybox alpine:latest
boxlite create -p 8080:80 -v /data:/app/data --name web nginx:alpine
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
| `--quiet` | `-q` | `false` | Print only IDs |
| `--format FMT` | — | `table` | Output format (see [Output Formats](#output-formats)) |

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
| `--all` | `-a` | `false` | Show all images (default: hide intermediates) |
| `--quiet` | `-q` | `false` | Print only image IDs |
| `--format FMT` | — | `table` | Output format (see [Output Formats](#output-formats)) |

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

**Examples:**

```bash
boxlite inspect mybox
boxlite inspect --format '{{.State.Status}}' mybox
boxlite inspect -l --format yaml
```

---

### `boxlite cp`

**Synopsis:** `boxlite cp [OPTIONS] SRC DST`

Copy files/folders between host and box. Exactly one of `SRC` or `DST` must be a `BOX:PATH` reference.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--follow-symlinks` | `false` | Resolve and copy the symlink target rather than the link itself |
| `--no-overwrite` | `false` | Skip files that already exist at the destination |
| `--include-parent` | `true` | Include the source's parent directory when copying out (docker-cp semantics) |

If the box is stopped at copy time, it's started temporarily and stopped again afterwards.

**Examples:**

```bash
boxlite cp ./script.py mybox:/work/script.py        # host -> box
boxlite cp mybox:/var/log/app.log ./app.log         # box -> host
boxlite cp --no-overwrite ./data/ mybox:/data/      # idempotent sync
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

### `boxlite serve`

**Synopsis:** `boxlite serve [OPTIONS]`

Run a long-running REST API server. The server holds a single `BoxliteRuntime` and exposes the full REST surface for `boxlite --url ...` clients and the language SDKs' REST mode.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port N` | `8100` | TCP port to listen on |
| `--host ADDR` | `0.0.0.0` | Bind address |

**Examples:**

```bash
boxlite serve
boxlite serve --host 127.0.0.1 --port 9000
```

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

## Shared Flag Groups

Several commands flatten shared `clap` `Args` structs. Each is documented here once.

### `ProcessFlags`

Used by `run` and `exec` (defined at `src/cli/src/cli.rs:208-281`).

| Flag | Short | Description |
|------|-------|-------------|
| `--interactive` | `-i` | Keep STDIN open even if not attached |
| `--tty` | `-t` | Allocate a pseudo-TTY (stdout and stderr are merged in TTY mode) |
| `--env KEY=VALUE` | `-e` | Set environment variables (repeatable; if value omitted, inherits from host) |
| `--workdir PATH` | `-w` | Working directory inside the box |
| `--user NAME[:GROUP]` | `-u` | Run as `name`/`uid`[:`group`/`gid`] |

`--tty` implies `--interactive` when stdin is a TTY. `--tty` without a TTY-attached stdin is a hard error.

### `ResourceFlags`

Used by `run` and `create` (defined at `src/cli/src/cli.rs:287-310`).

| Flag | Type | Description |
|------|------|-------------|
| `--cpus N` | u32 | Number of CPUs (capped at 255; values above 255 log a warning) |
| `--memory MiB` | u32 | Memory limit in mebibytes |

### `PublishFlags`

Used by `run` and `create` (defined at `src/cli/src/cli.rs:316-337`).

| Flag | Short | Description |
|------|-------|-------------|
| `--publish PORT` | `-p` | Publish a box port to the host; repeatable (see [Port Publish Syntax](#port-publish-syntax)) |

UDP is accepted syntactically but currently forwarded as TCP — a warning is printed on the first UDP mapping.

### `VolumeFlags`

Used by `run` and `create` (defined at `src/cli/src/cli.rs:407-578`).

| Flag | Short | Description |
|------|-------|-------------|
| `--volume VOLUME` | `-v` | Mount a volume; repeatable (see [Volume Mount Syntax](#volume-mount-syntax)) |

### `ManagementFlags`

Used by `run` and `create` (defined at `src/cli/src/cli.rs:584-604`).

| Flag | Short | Description |
|------|-------|-------------|
| `--name NAME` | — | Assign a name to the box |
| `--detach` | `-d` | Run in the background; print box ID and return |
| `--rm` | — | Automatically remove the box when it exits |

> `--rm` with `--detach` on `run` is silently downgraded — `run -d` always sets `auto_remove=false` (`src/cli/src/commands/run.rs:106`) so the detached box outlives the CLI process. Use `boxlite rm` to clean up.

---

## Volume Mount Syntax

`-v`/`--volume` accepts the grammar implemented at `src/cli/src/cli.rs:442-519`:

```
VOLUME := HOST_PATH ':' BOX_PATH [':' OPTIONS]          # bind mount
        | BOX_PATH [':' OPTIONS]                         # anonymous volume
```

| Form | Example | Behavior |
|------|---------|----------|
| `BOX_PATH` | `/data` | Anonymous volume stored under `{home}/volumes/anonymous/<ulid>` |
| `BOX_PATH:ro` / `BOX_PATH:rw` | `/data:ro` | Anonymous volume with explicit mode |
| `HOST_PATH:BOX_PATH` | `/host/data:/data` | Bind mount (host directory must exist) |
| `HOST_PATH:BOX_PATH:OPTIONS` | `/host/data:/data:ro` | Bind mount with options |
| `C:\HOST\PATH:/BOX_PATH[:OPTIONS]` | `C:\data:/app/data:ro` | Windows drive paths are handled — the drive-letter colon is not treated as a separator |

**Options:** `ro` (read-only) or `rw` (read-write, default). Other options are ignored. Relative host paths are canonicalized at parse time; missing host paths fail with `volume host path ...`.

The anonymous-volume base directory is resolved as: `--home`, else `$BOXLITE_HOME`, else `~/.boxlite`, else the system temp dir.

---

## Port Publish Syntax

`-p`/`--publish` accepts the grammar implemented at `src/cli/src/cli.rs:344-394`:

```
PORT := [HOST_PORT ':'] BOX_PORT ['/' ('tcp' | 'udp')]
```

| Form | Example | Behavior |
|------|---------|----------|
| `BOX_PORT` | `80` | Forward to the same port on the host |
| `HOST_PORT:BOX_PORT` | `8080:80` | Forward host port `8080` to box port `80` |
| `BOX_PORT/PROTO` | `5353/udp` | Specify protocol (default: `tcp`) |
| `HOST_PORT:BOX_PORT/PROTO` | `8080:80/tcp` | Full form |

Ports must be in `1..=65535`. Protocols are case-insensitive. UDP entries are accepted but currently forwarded as TCP (warning is printed once per UDP mapping).

---

## Output Formats

The `--format` flag is shared across `list`, `images`, `inspect`, `stats`, and `info`. Valid values come from `OutputFormat::from_str` at `src/cli/src/formatter.rs:26`:

| Format | Available on | Description |
|--------|--------------|-------------|
| `table` | `list`, `images`, `stats` | Human-readable columnar layout (default) |
| `json` | `list`, `images`, `stats`, `inspect`, `info` | Pretty-printed JSON (`serde_json::to_string_pretty`) |
| `yaml` | `list`, `images`, `stats`, `inspect`, `info` | YAML (`serde_yaml::to_string`) |
| Go template | `inspect` only | Any `gtmpl` template, e.g. `'{{.State.Status}}'`; `{{json .Field}}` serializes a nested value |

Defaults:

- `list`, `images`, `stats`: `table`
- `inspect`: `json`
- `info`: `yaml`

---

## Configuration File

`--config PATH` accepts a JSON file deserialized into `BoxliteOptions`. The primary field is `image_registries`; CLI flags like `--home` and `--registry` are layered on top after loading.

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

## Exit Codes

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

## See Also

- [`src/cli/README.md`](../../../src/cli/README.md) — quick start, install alternatives, common workflows
- [`docs/reference/README.md`](../README.md) — reference index (SDKs + CLI)
- [`docs/guides/image-registry-configuration.md`](../../guides/image-registry-configuration.md) — registry config deep dive
- [`docs/getting-started/`](../../getting-started/) — per-language getting-started guides
