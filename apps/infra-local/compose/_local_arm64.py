"""Apple-Silicon local-dev helpers, folded into `compose up` so a fresh arm64
Mac can `make up` with no manual env/build steps. Every function is idempotent
and a no-op when its work is already done (or its tools are absent), so it is
safe to call on every `up`.

Why these exist (gaps `compose up` otherwise assumes are pre-handled):
  • the box base is pulled from the published multi-arch agent image
    (ghcr.io/boxlite-ai/boxlite-agent-base), which now carries linux/arm64 — so
    an arm64 Mac boots a usable box straight from ghcr, no local image build.
  • the Go runner links the real libboxlite.a, which must be built once.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from . import registries

# repo root: this file is <repo>/apps/infra-local/compose/_local_arm64.py
REPO = Path(__file__).resolve().parents[3]

# The box base image. The curated agent images are published multi-arch
# (linux/amd64 + linux/arm64) under the v0.1.0 tag, so the runner pulls the
# arch matching the host straight from ghcr — no local arm64 build/push to the
# L1 registry. This now matches the curated default, so the override only
# changes anything when BOXLITE_LOCAL_AGENT_IMAGE points elsewhere.
REMOTE_AGENT_IMAGE = os.environ.get(
    "BOXLITE_LOCAL_AGENT_IMAGE", "ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0"
)

# Machine-global cargo target dir. A fresh worktree's target/ is symlinked here
# so the first worktree to build pays the slow libkrun/e2fsprogs compile once,
# and every other worktree just relinks against the shared artifacts — "build
# once per machine, reuse across worktrees".
SHARED_CARGO_TARGET = Path(
    os.environ.get("BOXLITE_LOCAL_CARGO_TARGET") or (Path.home() / ".cache" / "boxlite" / "cargo-target")
).expanduser()


def ensure_tools_on_path() -> None:
    """The seed step shells out to `psql`; add Homebrew's keg-only libpq bin
    (and the go-install bin) to PATH if not already resolvable, so a bare
    `make up` finds them."""
    extra = ["/opt/homebrew/opt/libpq/bin", str(Path.home() / "go" / "bin")]
    parts = os.environ.get("PATH", "").split(os.pathsep)
    for d in extra:
        if d not in parts and Path(d).is_dir():
            parts.append(d)
    os.environ["PATH"] = os.pathsep.join(parts)


def ensure_shared_target() -> None:
    """Point this worktree's `target/` at the machine-global cargo dir, so the
    Rust artifacts (libkrun, e2fsprogs, libboxlite.a, the python ext) are shared
    across worktrees — the first build is slow, the rest just relink.

    Only acts on a fresh worktree (no `target/` yet); an existing real `target/`
    is left untouched (e.g. a checkout that already built locally). Both the
    maturin build and `make dev:go` write through `target/` (cargo's default),
    and the Go dev cgo links `target/debug/libboxlite.a`, so the symlink makes
    all three share one cache with no recipe changes."""
    target = REPO / "target"
    if target.exists() or target.is_symlink():
        return
    SHARED_CARGO_TARGET.mkdir(parents=True, exist_ok=True)
    try:
        target.symlink_to(SHARED_CARGO_TARGET)
        print(f"  target/ -> shared cargo cache {SHARED_CARGO_TARGET}")
    except OSError as e:
        print(f"  could not symlink target/ to the shared cargo cache ({e}); building per-worktree")


def ensure_submodules() -> None:
    """Init the libkrun/e2fsprogs/bubblewrap submodules if any are missing —
    their vendored sources are needed to build the native lib + python ext."""
    status = subprocess.run(["git", "submodule", "status"], cwd=str(REPO),
                            capture_output=True, text=True)
    if any(ln.startswith("-") for ln in status.stdout.splitlines()):
        print("  initializing git submodules (libkrun/e2fsprogs)...")
        subprocess.run(["git", "submodule", "update", "--init", "--recursive"], cwd=str(REPO), check=True)


def ensure_native_lib() -> None:
    """Build the real libboxlite.a (the Go runner links it) if missing."""
    if (REPO / "target" / "debug" / "libboxlite.a").is_file():
        return
    ensure_shared_target()
    ensure_submodules()
    print("  building native libboxlite.a (real libkrun — slow on first run, shared cache after)...")
    subprocess.run(["make", "dev:go"], cwd=str(REPO), check=True)


def _boxlite_is_local_build() -> bool:
    """True when the importable boxlite is the repo's own (editable) build, not
    the PyPI wheel — maturin develop installs an editable, the wheel doesn't."""
    try:
        import importlib.metadata as md

        durl = md.distribution("boxlite").read_text("direct_url.json")
        return bool(durl) and '"editable": true' in durl
    except Exception:
        return False


def ensure_local_boxlite() -> None:
    """Install the repo's own boxlite engine build into the running venv,
    replacing the PyPI wheel — the wheel lacks fixes the local stack needs
    (e.g. the macOS OCI read-only-dir removal fix). maturin-develops from
    sdks/python; the Rust compile lands in the shared cargo cache so other
    worktrees reuse it. No-op when a local (editable) boxlite is already in.

    Skipped outside a venv (no isolated site-packages to install into) — the
    caller's pip path then falls back to the PyPI wheel.
    """
    if _boxlite_is_local_build():
        return
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    if not in_venv:
        print("  not running in a venv — skipping local boxlite build (will use PyPI wheel)")
        return
    venv = Path(sys.prefix)
    print("  building boxlite engine from source (first time per machine is slow — "
          "libkrun compile; later worktrees reuse the shared cargo cache)...")
    ensure_shared_target()
    ensure_submodules()
    maturin = venv / "bin" / "maturin"
    if not maturin.exists():
        subprocess.run([str(venv / "bin" / "pip"), "install", "-q", "maturin"], check=True)
    subprocess.run(
        [str(maturin), "develop"],
        cwd=str(REPO / "sdks" / "python"),
        env={**os.environ, "VIRTUAL_ENV": str(venv)},
        check=True,
    )


def resolve_agent_image() -> str | None:
    """The box base image ref to use as BOXLITE_SYSTEM_BASE_IMAGE.

    The published agent image is multi-arch (linux/arm64 included), so the
    runner pulls the host-matching arch straight from ghcr — no local build or
    L1-registry push. Returns the remote ref when ghcr creds are available, else
    None so the caller leaves the curated default in place — which is the same
    multi-arch tag, and public, so an anonymous pull still succeeds."""
    u, t = registries.ghcr_creds()
    if not (u and t):
        print("  no ghcr.io creds (try `gh auth login` or `docker login ghcr.io`) — "
              "using the curated default, which is public and pulls anonymously")
        return None
    return REMOTE_AGENT_IMAGE
