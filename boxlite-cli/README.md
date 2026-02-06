# BoxLite CLI

Command-line interface for BoxLite — use BoxLite without writing code, with a familiar Docker/Podman-like experience.


For CLI development (build, test, adding commands), see [CLI Development Guide](../docs/development/cli.md).


**Version:** 0.2.0  
**Platforms:** macOS (Apple Silicon), Linux (x86_64, ARM64)

## Overview

The BoxLite CLI (`boxlite`) lets you create, run, and manage BoxLite boxes from the terminal. It targets quick testing, shell scripting and automation, debugging, and demos.


### Key Features

- **Run** — Create a box from an image and run a command (interactive, TTY, or detached)
- **Lifecycle** — Create, start, stop, restart, remove boxes
- **Exec** — Run commands inside a running box
- **Images** — Pull and list OCI images
- **Copy** — Copy files between host and box (`boxlite cp`)
- **Output formats** — Table, JSON, or YAML for list/images
- **Shell completion** — Bash, Zsh, Fish

## Installation

The CLI is built from the BoxLite repository.

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


### homebrew
Coming soon


### Crate.io
Coming soon



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

## Commands Reference

### Global flags

Available for all commands:

| Flag | Description |
|------|-------------|
| `--debug` | Enable debug output |
| `--home PATH` | BoxLite home directory (default: `~/.boxlite`). Overridden by `BOXLITE_HOME` |
| `--registry REGISTRY` | Image registry (repeatable; prepended to config) |
| `--config PATH` | JSON config file path (e.g. for `image_registries`) |

### `boxlite run`

Create a box from an image and run a command.

**Usage:** `boxlite run [OPTIONS] IMAGE [COMMAND]...`

| Option | Short | Description |
|--------|-------|-------------|
| `--interactive` | `-i` | Keep STDIN open |
| `--tty` | `-t` | Allocate a pseudo-TTY |
| `--env KEY=VALUE` | `-e` | Set environment variables (repeatable) |
| `--workdir PATH` | `-w` | Working directory in the box |
| `--cpus N` | | CPU limit |
| `--memory MiB` | | Memory limit (MiB) |
| `--name NAME` | | Name the box |
| `--detach` | `-d` | Run in background, print box ID |
| `--rm` | | Remove the box when it exits |

**Examples:**

```bash
boxlite run alpine:latest echo "Hello"
boxlite run -it --rm alpine:latest /bin/sh
boxlite run -d --name web -p 8080:80 nginx:alpine
```

### `boxlite create`

Create a new box without running a command.

**Usage:** `boxlite create [OPTIONS] IMAGE`

| Option | Short | Description |
|--------|-------|-------------|
| `--name NAME` | | Name the box |
| `--env KEY=VALUE` | `-e` | Environment variables |
| `--workdir PATH` | `-w` | Working directory |
| `--cpus N` | | CPU limit |
| `--memory MiB` | | Memory limit (MiB) |
| `--detach` | `-d` | (create always “detaches”) |
| `--rm` | | Auto-remove when stopped |

**Example:**

```bash
boxlite create --name mybox alpine:latest
boxlite start mybox
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
