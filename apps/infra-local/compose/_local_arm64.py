"""Apple-Silicon local-dev helpers, folded into `compose up` so a fresh arm64
Mac can `make up` with no manual env/build steps. Every function is idempotent
and a no-op when its work is already done (or its tools are absent), so it is
safe to call on every `up`.

Why these exist (gaps `compose up` otherwise assumes are pre-handled):
  • image pulls (L1 images + the box base) need registry auth or they hit the
    anonymous Docker Hub rate limit / a private-ghcr 401 — the BoxLite puller
    does NOT read ~/.docker/config.json, so creds must be threaded in.
  • the maturin *editable* SDK build does not embed boxlite-guest/shim into the
    runtime cache, so box boot fails with "boxlite-guest not found".
  • the box base is pulled from the published multi-arch agent image
    (ghcr.io/boxlite-ai/boxlite-agent-base), which now carries linux/arm64 — so
    an arm64 Mac boots a usable box straight from ghcr, no local image build.
  • the Go runner links the real libboxlite.a, which must be built once.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# repo root: this file is <repo>/apps/infra-local/compose/_local_arm64.py
REPO = Path(__file__).resolve().parents[3]

# The box base image. The curated agent images are now published multi-arch
# (linux/amd64 + linux/arm64) under the v0.1.0 tag, so the runner pulls the
# arch matching the host straight from ghcr — no local arm64 build/push to the
# L1 registry. (The default curated tag, …-p0-r3, is still amd64-only, hence
# the explicit v0.1.0 override for local arm64 dev.)
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


def dockerhub_creds() -> tuple[str | None, str | None]:
    """(username, token) for docker.io: explicit env first, then Docker
    Desktop's credStore (populated by `docker login`). (None, None) if neither."""
    u = os.environ.get("BOXLITE_DOCKERHUB_USER") or os.environ.get("DOCKERHUB_USERNAME")
    t = os.environ.get("BOXLITE_DOCKERHUB_TOKEN") or os.environ.get("DOCKERHUB_TOKEN")
    if u and t:
        return u, t
    return _credstore_get("https://index.docker.io/v1/")


def ghcr_creds() -> tuple[str | None, str | None]:
    """(username, token) for ghcr.io, so the runner can pull the private
    multi-arch agent image. Resolution order, each per-developer (no shared
    secret to distribute):
      1. explicit env (GHCR_USERNAME/GHCR_TOKEN or BOXLITE_GHCR_*)
      2. the GitHub CLI token (`gh auth token`) — its scope already covers
         read:packages for whoever is logged in
      3. Docker's credStore (populated by `docker login ghcr.io`)
    (None, None) if none resolve."""
    u = os.environ.get("GHCR_USERNAME") or os.environ.get("BOXLITE_GHCR_USER")
    t = os.environ.get("GHCR_TOKEN") or os.environ.get("BOXLITE_GHCR_TOKEN")
    if u and t:
        return u, t
    if shutil.which("gh"):
        try:
            token = subprocess.run(["gh", "auth", "token"], capture_output=True,
                                   text=True, timeout=5).stdout.strip()
            user = subprocess.run(["gh", "api", "user", "--jq", ".login"],
                                  capture_output=True, text=True, timeout=5).stdout.strip()
            if token and user:
                return user, token
        except Exception:
            pass
    return _credstore_get("ghcr.io")


def _credstore_get(registry: str) -> tuple[str | None, str | None]:
    """Read (username, secret) for `registry` from Docker Desktop's credStore."""
    try:
        out = subprocess.run(
            ["docker-credential-desktop", "get"],
            input=registry, capture_output=True, text=True, timeout=5,
        )
        d = json.loads(out.stdout or "{}")
        return d.get("Username") or None, d.get("Secret") or None
    except Exception:
        return None, None


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


def export_dockerhub_env() -> None:
    """Put docker.io creds into os.environ under every name the stack reads:
    the orchestrator (L1 SDK) and the Go runner (envconfig). No-op if absent."""
    u, t = dockerhub_creds()
    if u and t:
        os.environ.setdefault("BOXLITE_DOCKERHUB_USER", u)
        os.environ.setdefault("BOXLITE_DOCKERHUB_TOKEN", t)
        os.environ.setdefault("DOCKERHUB_USERNAME", u)
        os.environ.setdefault("DOCKERHUB_TOKEN", t)


def export_ghcr_env() -> None:
    """Thread ghcr.io creds into os.environ under the names the runner reads
    (GHCR_USERNAME/GHCR_TOKEN via envconfig) so it can pull the private
    multi-arch agent image. No-op if none resolve."""
    u, t = ghcr_creds()
    if u and t:
        os.environ.setdefault("GHCR_USERNAME", u)
        os.environ.setdefault("GHCR_TOKEN", t)
        os.environ.setdefault("BOXLITE_GHCR_USER", u)
        os.environ.setdefault("BOXLITE_GHCR_TOKEN", t)


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

    The published agent image is now multi-arch (linux/arm64 included), so the
    runner pulls the host-matching arch straight from ghcr — no local build or
    L1-registry push. Returns the remote ref when ghcr creds are available (the
    runner needs them to pull a private image), else None so the caller leaves
    the curated default in place (amd64-only — won't boot on arm64, but the
    failure is then an explicit, logged pull error rather than a silent one)."""
    u, t = ghcr_creds()
    if not (u and t):
        print("  no ghcr.io creds (try `gh auth login` or `docker login ghcr.io`) — "
              "runner can't pull the arm64 agent image; boxes won't boot")
        return None
    return REMOTE_AGENT_IMAGE
