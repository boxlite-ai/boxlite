"""Apple-Silicon local-dev helpers, folded into `compose up` so a fresh arm64
Mac can `make up` with no manual env/build steps. Every function is idempotent
and a no-op when its work is already done (or its tools are absent), so it is
safe to call on every `up`.

Why these exist (gaps `compose up` otherwise assumes are pre-handled):
  • docker.io pulls (L1 images + the box base) need auth or they hit the
    anonymous Docker Hub rate limit — the BoxLite puller does NOT read
    ~/.docker/config.json, so creds must be threaded in.
  • the maturin *editable* SDK build does not embed boxlite-guest/shim into the
    runtime cache, so box boot fails with "boxlite-guest not found".
  • the curated agent images are published amd64-only; an arm64 Mac needs a
    locally-built arm64 image (debian + the toolbox daemon) to boot a usable box.
  • the Go runner links the real libboxlite.a, which must be built once.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

# repo root: this file is <repo>/apps/infra-local/compose/_local_arm64.py
REPO = Path(__file__).resolve().parents[3]
AGENT_IMG = "127.0.0.1:25000/boxlite-agent-base:local-arm64"
# Machine-global cache: build the arm64 image once, then every worktree's
# `make up` just pushes this tar to its own L1 registry (seconds, no rebuild).
AGENT_TAR = Path.home() / ".cache" / "boxlite" / "agent-base-arm64.tar"


def dockerhub_creds() -> tuple[str | None, str | None]:
    """(username, token) for docker.io: explicit env first, then Docker
    Desktop's credStore (populated by `docker login`). (None, None) if neither."""
    u = os.environ.get("BOXLITE_DOCKERHUB_USER") or os.environ.get("DOCKERHUB_USERNAME")
    t = os.environ.get("BOXLITE_DOCKERHUB_TOKEN") or os.environ.get("DOCKERHUB_TOKEN")
    if u and t:
        return u, t
    try:
        out = subprocess.run(
            ["docker-credential-desktop", "get"],
            input="https://index.docker.io/v1/",
            capture_output=True, text=True, timeout=5,
        )
        d = json.loads(out.stdout or "{}")
        return d.get("Username") or None, d.get("Secret") or None
    except Exception:
        return None, None


def ensure_tools_on_path() -> None:
    """The seed step shells out to `psql`, and the agent-image step to `crane`;
    add their Homebrew keg-only / go-install dirs to PATH if they're not already
    resolvable, so a bare `make up` finds them."""
    extra = ["/opt/homebrew/opt/libpq/bin", str(Path.home() / "go" / "bin")]
    parts = os.environ.get("PATH", "").split(os.pathsep)
    for d in extra:
        if d not in parts and Path(d).is_dir():
            parts.append(d)
    os.environ["PATH"] = os.pathsep.join(parts)


def export_dockerhub_env() -> None:
    """Put docker.io creds into os.environ under every name the stack reads:
    the orchestrator (L1 SDK) and the Go runner (envconfig). No-op if absent."""
    u, t = dockerhub_creds()
    if u and t:
        os.environ.setdefault("BOXLITE_DOCKERHUB_USER", u)
        os.environ.setdefault("BOXLITE_DOCKERHUB_TOKEN", t)
        os.environ.setdefault("DOCKERHUB_USERNAME", u)
        os.environ.setdefault("DOCKERHUB_TOKEN", t)


def fix_runtime_cache() -> None:
    """maturin editable builds leave the SDK runtime cache missing the big
    boxlite-guest/shim binaries; copy them from the cargo build output."""
    base = Path.home() / "Library" / "Application Support" / "boxlite" / "runtimes"
    caches = sorted(base.glob("v*"))
    if not caches:
        return
    cache = caches[0]
    if (cache / "boxlite-guest").is_file():
        return
    for d in REPO.glob("target/debug/build/boxlite-*/out/runtime"):
        if (d / "boxlite-guest").is_file():
            for f in ("boxlite-guest", "boxlite-shim"):
                shutil.copy2(d / f, cache / f)
            print(f"  patched runtime cache: boxlite-guest+shim -> {cache}")
            return


def ensure_native_lib() -> None:
    """Build the real libboxlite.a (the Go runner links it) if missing,
    initializing the libkrun/e2fsprogs submodules first if needed."""
    if (REPO / "target" / "debug" / "libboxlite.a").is_file():
        return
    status = subprocess.run(["git", "submodule", "status"], cwd=str(REPO),
                            capture_output=True, text=True)
    if any(ln.startswith("-") for ln in status.stdout.splitlines()):
        print("  initializing git submodules (libkrun/e2fsprogs)...")
        subprocess.run(["git", "submodule", "update", "--init", "--recursive"], cwd=str(REPO), check=True)
    print("  building native libboxlite.a (real libkrun — slow on first run)...")
    subprocess.run(["make", "dev:go"], cwd=str(REPO), check=True)


def _ensure_crane() -> str | None:
    crane = shutil.which("crane") or str(Path.home() / "go" / "bin" / "crane")
    if Path(crane).exists():
        return crane
    print("  installing crane (host-side OCI push tool)...")
    subprocess.run(["go", "install", "github.com/google/go-containerregistry/cmd/crane@latest"],
                   env={**os.environ, "GOBIN": str(Path.home() / "go" / "bin"), "GOTOOLCHAIN": "auto"})
    crane = str(Path.home() / "go" / "bin" / "crane")
    return crane if Path(crane).exists() else None


def _build_agent_tar() -> bool:
    """Build the arm64 agent image (debian + toolbox daemon) and save it to the
    machine-global tar. Once per machine; needs docker. Returns True on success."""
    if not shutil.which("docker") or subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        print("  docker daemon not running — can't build the arm64 agent image (boxes won't boot)")
        return False
    print("  building arm64 agent image (debian + boxlite-daemon) — once per machine...")
    ctx = Path(tempfile.mkdtemp())
    try:
        subprocess.run(
            ["go", "build", "-tags", "netgo", "-ldflags", "-s -w",
             "-o", str(ctx / "boxlite-daemon"), "./cmd/daemon"],
            cwd=str(REPO / "apps" / "daemon"),
            env={**os.environ, "GOOS": "linux", "GOARCH": "arm64",
                 "CGO_ENABLED": "0", "GOTOOLCHAIN": "auto"},
            check=True,
        )
        (ctx / "start-agent-runtime.sh").write_text(
            '#!/bin/sh\nset -eu\nmkdir -p /workspace\n'
            '[ -n "${BOXLITE_SANDBOX_ID:-}" ] || { BOXLITE_SANDBOX_ID="$(hostname)"; export BOXLITE_SANDBOX_ID; }\n'
            'exec /boxlite/bin/boxlite-daemon "$@"\n'
        )
        (ctx / "Dockerfile").write_text(
            "FROM debian:bookworm-slim\n"
            "COPY boxlite-daemon /boxlite/bin/boxlite-daemon\n"
            "COPY start-agent-runtime.sh /boxlite/bin/start-agent-runtime\n"
            "RUN chmod 0755 /boxlite/bin/boxlite-daemon /boxlite/bin/start-agent-runtime && mkdir -p /workspace\n"
            "WORKDIR /workspace\n"
            'ENTRYPOINT ["/boxlite/bin/start-agent-runtime"]\n'
            'CMD ["sleep", "infinity"]\n'
        )
        subprocess.run(["docker", "build", "--platform", "linux/arm64", "-t", AGENT_IMG, str(ctx)], check=True)
        AGENT_TAR.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["docker", "save", AGENT_IMG, "-o", str(AGENT_TAR)], check=True)
    finally:
        shutil.rmtree(ctx, ignore_errors=True)
    return True


def ensure_agent_image() -> str | None:
    """Ensure this worktree's L1 registry has an arm64 agent image (no arm64
    curated image exists). Build is cached machine-globally as a tar, so every
    worktree after the first only pushes the tar (seconds). Returns the ref to
    use as BOXLITE_SYSTEM_BASE_IMAGE, or None if it can't be made available."""
    crane = _ensure_crane()
    if crane is None:
        return None
    try:
        urllib.request.urlopen("http://127.0.0.1:25000/v2/", timeout=5)
    except Exception:
        return None  # L1 registry not up yet
    try:
        ls = subprocess.run([crane, "ls", "127.0.0.1:25000/boxlite-agent-base", "--insecure"],
                            capture_output=True, text=True, timeout=15)
        if "local-arm64" in ls.stdout:
            return AGENT_IMG  # already in THIS worktree's registry
    except Exception:
        pass
    # Build once per machine (cached tar); every worktree just pushes the tar.
    if not AGENT_TAR.is_file():
        if not _build_agent_tar():
            return None
    print(f"  pushing arm64 agent image to local registry (from cached {AGENT_TAR.name})...")
    # host-side HTTP push: the docker VM cannot reach the host's :25000.
    subprocess.run([crane, "push", str(AGENT_TAR), AGENT_IMG, "--insecure"], check=True)
    return AGENT_IMG
