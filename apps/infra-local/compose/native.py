"""L2 native-process supervision + stack-level commands.

Ports the former `scripts/stack-*.sh` into Python: brings the five native host
processes (API, registry proxy, runner, proxy, dashboard) up/down/status/restart,
builds the Go binaries, tails logs, resets DB state, seeds init data, and rebuilds stuck L1
boxes. Daemons are spawned DETACHED (`start_new_session=True`) so they outlive
this process; stopped via SIGTERM→SIGKILL on the process **group**, which reaps
the `nx serve`/go grandchildren. Start-time records prevent accidental PID
reuse; unverified listeners are reported as conflicts and left untouched.

This is the L2 half of the orchestrator; L1 (the BoxLite boxes) lives in
`orchestrator.py` + `services.py`. `up`/`down`/`status`/`reset`/`rebuild` tie the
two together.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from . import _local_arm64
from . import orchestrator
from .config import InfraConfig, worktree_home
from .doctor import _lsof_owner
from .services import SERVICES

# ── L2 ports + identities (the native host processes) ──────────────────────
PORT_API = int(os.environ.get("BOXLITE_LOCAL_API_PORT", "3001"))  # override if :3001 is taken
PORT_RUNNER = 3003
PORT_PROXY = 4000
PORT_REGISTRY_PROXY = 4100  # the binary's own default; see apps/image-service
PORT_DASHBOARD = 3000
# Start order: api first. The registry proxy asks the API about every caller,
# so it follows the API and precedes nothing that depends on it at start-up.
ALL_COMPONENTS = ("api", "registry-proxy", "runner", "proxy", "dashboard")
_PORTS = {
    "api": PORT_API,
    "registry-proxy": PORT_REGISTRY_PROXY,
    "runner": PORT_RUNNER,
    "proxy": PORT_PROXY,
    "dashboard": PORT_DASHBOARD,
}
_RUNNER_TOKEN = "local-shared-runner-token-aaaa1111"
# The otel box's host-mapped OTLP HTTP port (the port literal lives in
# services.py SPEC_OTEL.ports); traces fan out from there to the jaeger box.
_OTEL_OTLP_HTTP_URL = "http://127.0.0.1:24318"
# The maildev box's host-mapped SMTP port (literal in SPEC_MAILDEV.ports).
_MAILDEV_SMTP_HOST = "127.0.0.1"
_MAILDEV_SMTP_PORT = "25054"


# ── colored logging (TTY only) ─────────────────────────────────────────────
def _c(code: str) -> str:
    return code if sys.stdout.isatty() else ""


_BLUE, _GREEN, _YELLOW, _RED, _DIM, _BOLD, _RESET = (
    _c("\033[34m"), _c("\033[32m"), _c("\033[33m"),
    _c("\033[31m"), _c("\033[2m"), _c("\033[1m"), _c("\033[0m"),
)


def log(m: str) -> None:
    print(f"{_BLUE}[stack]{_RESET} {m}")


def ok(m: str) -> None:
    print(f"{_GREEN}✓{_RESET} {m}")


def warn(m: str) -> None:
    print(f"{_YELLOW}⚠{_RESET} {m}")


def err(m: str) -> None:
    print(f"{_RED}✗{_RESET} {m}", file=sys.stderr)


# ── paths (derived from the repo root) ─────────────────────────────────────
@dataclass(frozen=True)
class _Paths:
    repo_root: Path

    @property
    def apps(self) -> Path:
        return self.repo_root / "apps"

    @property
    def infra_local(self) -> Path:
        return self.apps / "infra-local"

    @property
    def state(self) -> Path:
        return self.repo_root / ".apps-local"

    @property
    def logs(self) -> Path:
        return self.state / "logs"

    @property
    def bin(self) -> Path:
        return self.state / "bin"

    @property
    def runner_bin(self) -> Path:
        return self.bin / "boxlite-runner"

    @property
    def proxy_bin(self) -> Path:
        return self.bin / "boxlite-proxy"

    @property
    def registry_proxy_bin(self) -> Path:
        return self.bin / "boxlite-registry-proxy"

    @property
    def registry_secrets(self) -> Path:
        # Where the API's file store writes registry passwords and the registry
        # proxy's reads them: one directory, the local stand-in for Secret
        # Manager.
        return self.state / "registry-secrets"

    @property
    def runner_home(self) -> Path:
        # Anchored at the machine-global short root (NOT under .apps-local): the
        # runner's box sockets live at <home>/boxes/<id>/sockets/ready.sock and
        # macOS caps unix socket paths at 104 bytes (SUN_LEN), which a deep
        # worktree path overflows. See config.worktree_home.
        return Path(os.environ.get("BOXLITE_HOME_DIR") or worktree_home(self.repo_root, "r"))


def _paths(cfg: InfraConfig) -> _Paths:
    return _Paths(cfg.repo_root)


def _pid_file(p: _Paths, name: str) -> Path:
    return p.logs / f"{name}.pid"


def _log_file(p: _Paths, name: str) -> Path:
    return p.logs / f"{name}.log"


# ── port / process / health probes (reuse doctor + orchestrator helpers) ────
def _port_listening(port: int) -> bool:
    try:
        return _lsof_owner(port) is not None
    except Exception:
        return False


def _process_started_at(pid: int) -> str:
    return subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, check=False
    ).stdout.strip()


def _component_pid(p: _Paths, name: str) -> int | None:
    """Verify birth time and detached-group identity; legacy records fail closed.

    ps has one-second precision and signaling follows a separate identity read:
    this prevents accidental reuse, not hostile process replacement.
    """
    pf = _pid_file(p, name)
    if not pf.exists():
        return None
    try:
        record = json.loads(pf.read_text())
        pid, started_at = record["pid"], record["started_at"]
        if type(pid) is not int or pid <= 1 or not isinstance(started_at, str) or not started_at:
            return None
        if os.getpgid(pid) != pid or _process_started_at(pid) != started_at:
            return None
    except (ValueError, OSError, KeyError, TypeError):
        return None
    return pid


def _wait_port(port: int, timeout_s: int) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _port_listening(port):
            return True
        time.sleep(1)
    return False


def _wait_http(url: str, timeout_s: int) -> bool:
    # orchestrator._http_probe follows redirects, so a 3xx→2xx still passes.
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if orchestrator._http_probe(url):
            return True
        time.sleep(2)
    return False


def _parse_dotenv(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser (for sourcing apps/.env into the API's env)."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        # `. ./.env` (what the bash did) honors a leading `export` keyword;
        # drop it so `export KEY=val` binds KEY, not the literal "export KEY".
        if key.startswith("export ") or key.startswith("export\t"):
            key = key[len("export"):].strip()
        if key:
            env[key] = value.strip().strip('"').strip("'")
    return env


# ── L2 component table (the five native host processes) ────────────────────
@dataclass(frozen=True)
class _Component:
    name: str
    port: int
    health: str           # "http" | "tcp"
    health_url: str       # for http; "" for tcp
    timeout_s: int
    argv: list[str]
    cwd: Path | None
    env: dict[str, str]   # extra env layered on top of os.environ


def _components(p: _Paths) -> dict[str, _Component]:
    apps = p.apps
    api_env = {
        # M5-native dev override: the runner reports system-wide CPU/mem/disk
        # (the whole Mac), which drags availabilityScore below the prod cutoff
        # and makes the API reject box-create with "No available runners". Relax
        # the thresholds for a single idle dev runner. Set BEFORE apps/.env so a
        # value the user puts in .env still wins.
        "RUNNER_AVAILABILITY_SCORE_THRESHOLD": "5",
        "RUNNER_MEMORY_PENALTY_THRESHOLD": "95",
        "RUNNER_DISK_PENALTY_THRESHOLD": "95",
        # Private registries: the API writes a login's password to the file
        # store the registry proxy reads, and hands a private image to the
        # runner as a ref under the proxy's host.
        "REGISTRY_PROXY_HOST": f"127.0.0.1:{PORT_REGISTRY_PROXY}",
        "REGISTRY_SECRET_STORE": "file",
        "REGISTRY_SECRET_DIR": str(p.registry_secrets),
        **_parse_dotenv(apps / ".env"),
    }
    return {
        "api": _Component(
            "api", PORT_API, "http", f"http://localhost:{PORT_API}/api/health", 180,
            ["corepack", "yarn", "nx", "serve", "api"], apps, api_env,
        ),
        "runner": _Component(
            "runner", PORT_RUNNER, "tcp", "", 60,
            [str(p.runner_bin)], None,
            {
                "BOXLITE_API_URL": f"http://localhost:{PORT_API}/api",
                "BOXLITE_RUNNER_TOKEN": _RUNNER_TOKEN,
                "API_VERSION": "2",
                "API_PORT": str(PORT_RUNNER),
                "RUNNER_DOMAIN": "127.0.0.1",
                "BOXLITE_HOME_DIR": str(p.runner_home),
                # The registry proxy is served over plain HTTP here, so its host is
                # listed as insecure too: the runner folds that into the proxy's one
                # entry rather than adding a second, credential-less one.
                "INSECURE_REGISTRIES": f"127.0.0.1:25000,127.0.0.1:{PORT_REGISTRY_PROXY}",
                # The password is this runner's own API key, which is what the
                # proxy asks the API about; the username is not read.
                "REGISTRY_PROXY_HOST": f"127.0.0.1:{PORT_REGISTRY_PROXY}",
                "REGISTRY_PROXY_USERNAME": "runner",
                "REGISTRY_PROXY_PASSWORD": _RUNNER_TOKEN,
                "AWS_REGION": "us-east-1",
                "OTEL_TRACING_ENABLED": "true",
                "OTEL_EXPORTER_OTLP_ENDPOINT": _OTEL_OTLP_HTTP_URL,
            },
        ),
        "proxy": _Component(
            "proxy", PORT_PROXY, "tcp", "", 30,
            [str(p.proxy_bin)], None,
            {
                "PROXY_PORT": str(PORT_PROXY),
                "PROXY_PROTOCOL": "http",
                "PROXY_API_KEY": "boxlite-proxy-key",
                # Same value the API mints named-tunnel URLs with (apps/api/.env);
                # the proxy routes `<name>.app.localhost` through the API's lookup.
                "PROXY_APP_DOMAIN": f"app.localhost:{PORT_PROXY}",
                "BOXLITE_API_URL": f"http://localhost:{PORT_API}/api",
                "OIDC_CLIENT_ID": "boxlite",
                "OIDC_AUDIENCE": "boxlite",
                "OIDC_DOMAIN": "http://localhost:25556/dex",
                "REDIS_HOST": "127.0.0.1",
                "REDIS_PORT": "26379",
                "SHUTDOWN_TIMEOUT_SEC": "10",
                "OTEL_LOGGING_ENABLED": "true",
                "OTEL_TRACING_ENABLED": "true",
                "OTEL_EXPORTER_OTLP_ENDPOINT": _OTEL_OTLP_HTTP_URL,
            },
        ),
        # Presents the logins the API stored in the shared directory. It refuses
        # a private address as an upstream, so the local registry box is not a
        # registry it will reach: a private image here is a real one on one of
        # its default upstreams, ghcr.io, Docker Hub, quay.io or one of
        # Container Registry's gcr.io hosts.
        "registry-proxy": _Component(
            "registry-proxy", PORT_REGISTRY_PROXY, "http", f"http://127.0.0.1:{PORT_REGISTRY_PROXY}/health", 30,
            [str(p.registry_proxy_bin)], None,
            {
                "REGISTRY_PROXY_PORT": str(PORT_REGISTRY_PROXY),
                "BOXLITE_API_URL": f"http://localhost:{PORT_API}/api",
                "REGISTRY_SECRET_STORE": "file",
                "REGISTRY_SECRET_DIR": str(p.registry_secrets),
                "SHUTDOWN_TIMEOUT_SEC": "10",
                "ENVIRONMENT": "local",
                "OTEL_LOGGING_ENABLED": "true",
                "OTEL_TRACING_ENABLED": "true",
                "OTEL_EXPORTER_OTLP_ENDPOINT": _OTEL_OTLP_HTTP_URL,
            },
        ),
        # VITE_API_URL=/api routes dashboard API calls through the Vite dev proxy
        # (→ localhost:3001) instead of the hard-coded prod default.
        "dashboard": _Component(
            "dashboard", PORT_DASHBOARD, "http", f"http://localhost:{PORT_DASHBOARD}", 120,
            ["corepack", "yarn", "nx", "serve", "dashboard"], apps, {"VITE_API_URL": "/api"},
        ),
    }


# ── single-process supervision ─────────────────────────────────────────────
def start_component(p: _Paths, comp: _Component) -> bool:
    if _component_pid(p, comp.name) is not None:
        ready = orchestrator._http_probe(comp.health_url) if comp.health == "http" else _port_listening(comp.port)
        if ready:
            ok(f"{comp.name} already healthy")
            return True
        warn(f"{comp.name} is alive but unhealthy — restarting its recorded process")
        stop_component(p, comp.name)
    if _port_listening(comp.port):
        err(f"{comp.name}: port {comp.port} belongs to an unverified process; stop it explicitly before retrying")
        return False
    log(f"starting {comp.name}...")
    p.logs.mkdir(parents=True, exist_ok=True)
    with open(_log_file(p, comp.name), "ab") as logf:
        proc = subprocess.Popen(
            comp.argv,
            cwd=str(comp.cwd) if comp.cwd else None,
            env={**os.environ, **comp.env},
            stdout=logf,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # detach: survives our exit + own process group
        )
    started_at = _process_started_at(proc.pid)
    if not started_at:
        err(f"{comp.name} exited before its process identity could be recorded — see {_log_file(p, comp.name)}")
        return False
    _pid_file(p, comp.name).write_text(json.dumps({"pid": proc.pid, "started_at": started_at}))
    healthy = (
        _wait_http(comp.health_url, comp.timeout_s)
        if comp.health == "http"
        else _wait_port(comp.port, comp.timeout_s)
    )
    if healthy:
        ok(f"{comp.name} up on :{comp.port}")
        return True
    err(f"{comp.name} failed to become healthy in {comp.timeout_s}s — see {_log_file(p, comp.name)}")
    stop_component(p, comp.name)  # don't leave a stale daemon + pidfile that a retry would skip
    return False


def _terminate_group(p: _Paths, name: str, pid: int) -> None:
    """Revalidate the recorded identity before TERM and any KILL escalation."""
    if _component_pid(p, name) != pid:
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        pass  # best-effort: the group may already be gone (race) — fall through to the wait
    for _ in range(5):
        time.sleep(1)
        if _component_pid(p, name) != pid:
            return
    if _component_pid(p, name) != pid:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass  # best-effort final kill: nothing to do if it already exited


def stop_component(p: _Paths, name: str) -> None:
    pid = _component_pid(p, name)
    if pid is None:
        ok(f"{name} not running")
    else:
        log(f"stopping {name} (PID {pid})...")
        _terminate_group(p, name, pid)
        _pid_file(p, name).unlink(missing_ok=True)
        ok(f"{name} stopped")


# ── L1 helpers (talk to the BoxLite SDK via orchestrator) ──────────────────
# Each public command does ALL its L1 async work inside ONE `asyncio.run`: the
# SDK's default-runtime singleton is bound to the loop it's first used on, so we
# never spread SDK calls across loops (mirrors the old single-asyncio.run CLI).
def _l1_running(cfg: InfraConfig) -> bool:
    async def go() -> bool:
        orchestrator.ensure_home_env(cfg)
        infos = await orchestrator.get_runtime().list_info()
        return any((i.name or "") == "boxlite-local-postgres" and i.state.status.lower() == "running" for i in infos)

    return asyncio.run(go())


async def _ensure_l1_async(cfg: InfraConfig) -> bool:
    """Reconcile every dependency and its health before starting native apps."""
    changed = await orchestrator.up(cfg, SERVICES)
    ok("L1 boxes reconciled and healthy")
    return changed


def _l1_rows(cfg: InfraConfig) -> list[tuple[str, str]]:
    async def go() -> list[tuple[str, str]]:
        orchestrator.ensure_home_env(cfg)
        runtime = orchestrator.get_runtime()
        infos = {i.name: i for i in await runtime.list_info()}
        rows = []
        for name, spec in SERVICES.items():
            box_name = f"boxlite-local-{name}"
            item = infos.get(box_name)
            state = item.state.status.lower() if item else "missing"
            if state == "running" and spec.healthcheck:
                box = await runtime.get(box_name)
                if not await orchestrator.probe_health(box, spec.healthcheck, cfg):
                    state = "unhealthy"
            rows.append((box_name, state))
        return rows

    return asyncio.run(go())


# ── postgres helpers (psql via subprocess; port from the SPEC_PG literal) ───
def _pg_port() -> int:
    return SERVICES["postgres"].ports[0][0]


def _psql(cfg: InfraConfig, sql: str, *, tuples: bool = False) -> subprocess.CompletedProcess:
    args = ["psql", "-h", "127.0.0.1", "-p", str(_pg_port()), "-U", cfg.pg_user, "-d", cfg.pg_db]
    if tuples:
        args += ["-tA"]
    args += ["-c", sql]
    return subprocess.run(
        args,
        env={**os.environ, "PGPASSWORD": cfg.pg_password},
        capture_output=True,
        text=True,
        check=False,
    )


def _pg_reachable(cfg: InfraConfig) -> bool:
    return _psql(cfg, "SELECT 1", tuples=True).returncode == 0


def _pg_count(cfg: InfraConfig, sql: str) -> int:
    try:
        return int(_psql(cfg, sql, tuples=True).stdout.strip())
    except (ValueError, AttributeError):
        return 0


# ── stack-level commands (the former make stack-* targets) ─────────────────
# The native Go binaries: the module each is built in, its command, and its
# build tags. A table because the three no longer share a shape — the registry
# proxy's module is `image-service`, not its own name.
#
# The runner links the BoxLite SDK's native lib. Build it with the boxlite_dev
# tag so it links this worktree's target/debug/libboxlite.a (matching the local
# sdks/go via go.work) instead of a downloaded prebuilt — otherwise a
# locally-changed FFI surface fails to link.
_GO_BUILDS = {
    "runner": ("runner", "./cmd/runner", ["-tags", "boxlite_dev"]),
    "proxy": ("proxy", "./cmd/proxy", []),
    "registry-proxy": ("image-service", "./cmd/registry-proxy", []),
}


def _bin_for(p: _Paths, comp: str) -> Path:
    return {"runner": p.runner_bin, "proxy": p.proxy_bin, "registry-proxy": p.registry_proxy_bin}[comp]


def _go_build(p: _Paths, comp: str) -> None:
    """Rebuild one native Go binary."""
    module, command, tags = _GO_BUILDS[comp]
    out = _bin_for(p, comp)
    p.bin.mkdir(parents=True, exist_ok=True)
    log(f"go build {comp} → {out}")
    env = {**os.environ, "GOTOOLCHAIN": "auto"}
    if comp == "runner":
        # Go's cache does not track external .a files. Include their content in
        # cgo inputs so a rebuilt C archive forces a new executable to link.
        digest = _local_arm64.archive_digest(p.repo_root / "target/debug/libboxlite.a")
        env["CGO_CFLAGS"] = f"{env.get('CGO_CFLAGS', '')} -DBOXLITE_LOCAL_NATIVE_{digest}=1"
    subprocess.run(["go", "build", *tags, "-o", str(out), command],
                   cwd=str(p.apps / module), env=env, check=True)


def build(cfg: InfraConfig, *, only: list[str] | None = None) -> int:
    """Build requested native binaries; standalone callers default to all."""
    p = _paths(cfg)
    subprocess.run(["make", "_ensure-apps-deps"], cwd=str(p.repo_root), check=True)
    for comp in _GO_BUILDS:
        if only is None or comp in only:
            _go_build(p, comp)
    ok("binaries ready")
    return 0


def _ensure_installed(p: _Paths) -> None:
    """Zero-config bring-up. Ensures the venv has the repo's own boxlite engine
    build (with local fixes the PyPI wheel lacks — e.g. the macOS OCI read-only
    removal fix), then that the SDK is importable; otherwise `pip install -e .`
    + re-exec. The sentinel env var prevents an install loop."""
    # boxlite must be the local source build, not the PyPI wheel. This builds it
    # once (shared cargo cache → reused across worktrees) and no-ops thereafter.
    _local_arm64.ensure_local_boxlite()
    try:
        import boxlite  # noqa: F401
        return
    except ImportError:
        pass  # not installed yet — fall through to the install + re-exec below
    if os.environ.get("_COMPOSE_REINSTALLED"):
        err("boxlite SDK still not importable after install — check your Python env")
        raise SystemExit(1)
    log("boxlite SDK not importable — installing the package, then re-running...")
    subprocess.run([sys.executable, "-m", "pip", "install", "-e", "."],
                   cwd=str(p.infra_local), check=True)
    os.environ["_COMPOSE_REINSTALLED"] = "1"
    os.execv(sys.executable, [sys.executable, "-m", "compose", *sys.argv[1:]])


def _set_env_kv(path: Path, key: str, value: str) -> None:
    """Idempotently set KEY=value in a dotenv file (replace or append)."""
    lines = path.read_text().splitlines() if path.exists() else []
    out, found = [], False
    for ln in lines:
        if ln.startswith(f"{key}="):
            out.append(f"{key}={value}"); found = True
        else:
            out.append(ln)
    if not found:
        out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n")


def _seed_api_env(p: _Paths, agent_img: str) -> None:
    api_env = p.apps / "api" / ".env"
    if not api_env.exists():
        log("apps/api/.env missing — seeding from the infra-local template")
        shutil.copy(p.infra_local / "api.env", api_env)
    # Keep the API's listen port in lockstep with PORT_API (env-overridable),
    # and point the curated-image allowlist at the local arm64 agent image.
    _set_env_kv(api_env, "PORT", str(PORT_API))
    _set_env_kv(api_env, "APP_URL", f"http://localhost:{PORT_API}")
    # Trace export is infra-owned like PORT: the otel + jaeger boxes are always
    # up, so force-enable it — .envs seeded from older templates ship
    # OTEL_ENABLED=false (or no OTEL block at all) and would leave Jaeger empty.
    _set_env_kv(api_env, "OTEL_ENABLED", "true")
    _set_env_kv(api_env, "OTEL_EXPORTER_OTLP_ENDPOINT", _OTEL_OTLP_HTTP_URL)
    # Mail is infra-owned for the same reason: the maildev box is always up,
    # and an .env seeded before it existed carries no SMTP block — which makes
    # the API drop its transporter at boot (EmailService logs "email
    # functionality will be disabled") and swallow every invitation silently.
    #
    # All five keys, not just the endpoint: maildev speaks neither TLS nor auth,
    # so owning the host while leaving SMTP_SECURE or a credential to whatever
    # the file already held would point the API at this box under settings it
    # cannot answer. No .env this repo writes carries such a value, but the
    # split — two keys owned, three inherited — has no reason to exist.
    _set_env_kv(api_env, "SMTP_HOST", _MAILDEV_SMTP_HOST)
    _set_env_kv(api_env, "SMTP_PORT", _MAILDEV_SMTP_PORT)
    _set_env_kv(api_env, "SMTP_SECURE", "false")
    _set_env_kv(api_env, "SMTP_USER", "")
    _set_env_kv(api_env, "SMTP_PASSWORD", "")
    _set_env_kv(api_env, "BOXLITE_SYSTEM_BASE_IMAGE", agent_img)
    apps_env = p.apps / ".env"  # NestJS reads .env from cwd=apps/
    if not apps_env.is_symlink():
        try:
            apps_env.symlink_to("api/.env")
        except FileExistsError:
            pass  # a non-symlink apps/.env already exists — leave the dev's file alone


def up(cfg: InfraConfig, components: list[str] | None = None) -> int:
    p = _paths(cfg)
    comps = components or list(ALL_COMPONENTS)
    for name in comps:
        if name not in ALL_COMPONENTS:
            err(f"unknown component: {name} (valid: {' '.join(ALL_COMPONENTS)})")
            return 2
        if _component_pid(p, name) is None and _port_listening(_PORTS[name]):
            err(f"{name}: port {_PORTS[name]} belongs to an unverified process; stop it explicitly before retrying")
            return 1
    # 0. Apple-Silicon bootstrap (idempotent no-ops once done): thread docker.io
    # creds through to L1, build the native lib.
    _local_arm64.ensure_tools_on_path()
    _local_arm64.export_dockerhub_env()
    _ensure_installed(p)
    _local_arm64.ensure_native_lib()
    if any(name in comps for name in ("api", "dashboard")):
        subprocess.run(["make", "_ensure-apps-deps"], cwd=str(p.repo_root), check=True)

    # 1. Reconcile every L1 daemon inside one SDK event loop.
    l1_recreated = asyncio.run(_ensure_l1_async(cfg))

    # 2. a surviving L2 proc is stale once L1 was just (re)created — restart fresh
    if l1_recreated:
        log("L1 (re)created — stopping any stale L2 procs so they restart fresh")
        for name in reversed(comps):
            stop_component(p, name)

    # 3. Rebuild only selected components; stop a selected stale runner before
    # any build branch so its existing process cannot retain the old archive.
    library = p.repo_root / "target/debug/libboxlite.a"
    runner_stale = "runner" in comps and (
        not p.runner_bin.exists()
        or library.stat().st_mtime_ns > p.runner_bin.stat().st_mtime_ns
    )
    targets = [
        comp for comp in _GO_BUILDS
        if comp in comps and (not _bin_for(p, comp).exists() or (comp == "runner" and runner_stale))
    ]
    if "runner" in targets:
        stop_component(p, "runner")
    if targets:
        log(f"building missing or stale native binaries: {' '.join(targets)}")
        build(cfg, only=targets)

    # 3.5 box base image: the published agent image is multi-arch and public, so
    # the runner pulls the host-matching arch straight from ghcr — no local build,
    # L1-registry push, or credential.
    agent_img = _local_arm64.resolve_agent_image()

    # 4. API .env template + port + curated-image override + the apps/.env symlink
    _seed_api_env(p, agent_img)

    # 5. start the requested L2 components
    table = _components(p)
    healthy = True
    for name in comps:
        if not start_component(p, table[name]):
            healthy = False
            break

    # 6. ensure init data + a registered runner (the dashboard needs both)
    if healthy and any(c in comps for c in ("api", "runner")):
        log("ensuring init data + registered runner...")
        if seed(cfg, no_bounce=True) != 0:
            healthy = False  # a hard seed failure (pg down / never seeded) → up exits non-zero

    print()
    if healthy:
        ok("stack up — see status with: make status")
    else:
        err("stack incomplete — inspect make status and component logs")
    print(f"  Dashboard:    http://localhost:{PORT_DASHBOARD}")
    print(f"  API:          http://localhost:{PORT_API}/api")
    print(f"  Dex (OIDC):   http://localhost:25556/dex")
    print(f"  Logs at:      {p.logs}/")
    return 0 if healthy else 1


def down(cfg: InfraConfig, components: list[str] | None = None, *, include_l1: bool = False) -> int:
    p = _paths(cfg)
    comps = components or list(reversed(ALL_COMPONENTS))
    for name in comps:
        stop_component(p, name)
    if include_l1:
        log("stopping L1 boxes...")
        asyncio.run(orchestrator.down(cfg, SERVICES))  # boxes removed; data volumes survive
    ok("stack down")
    return 0


def status(cfg: InfraConfig) -> int:
    p = _paths(cfg)
    table = _components(p)
    exit_code = 0

    print(f"{_BOLD}L1 — infra-local boxes{_RESET}")
    rows = _l1_rows(cfg)
    expected = {f"boxlite-local-{name}" for name in SERVICES}
    if expected - {name for name, _ in rows} or any(state != "running" for _, state in rows):
        exit_code = 1
    if rows:
        for name, state in rows:
            print(f"  {name:<26} {state}")
    else:
        warn("no L1 boxes running")
        exit_code = 1

    print()
    print(f"{_BOLD}L2 — native processes{_RESET}")
    width = max(len(comp) for comp in ALL_COMPONENTS)
    print(f"  {'COMP':<{width}} {'PID':<8} {'PORT':<8} STATE")
    for comp in ALL_COMPONENTS:
        pid = _component_pid(p, comp)
        port = _PORTS[comp]
        if pid is None:
            print(f"  {comp:<{width}} {'-':<8} {port:<8} {_DIM}down{_RESET}")
            exit_code = 1
        elif (orchestrator._http_probe(table[comp].health_url)
              if table[comp].health == "http" else _port_listening(port)):
            print(f"  {comp:<{width}} {pid:<8} {port:<8} {_GREEN}up{_RESET}")
        else:
            print(f"  {comp:<{width}} {pid:<8} {port:<8} {_YELLOW}unhealthy{_RESET}")
            exit_code = 1

    print()
    print(f"{_BOLD}URLs{_RESET}")
    print(f"  Dashboard:      http://localhost:{PORT_DASHBOARD}")
    print(f"  API:            http://localhost:{PORT_API}/api")
    print(f"  Dex (OIDC):     http://localhost:25556/dex")
    print(f"  Caddy (entry):  http://localhost:28080")
    print()
    print(f"{_BOLD}Logs{_RESET}: {p.logs}/")
    return exit_code


def logs(cfg: InfraConfig, comp: str | None = None) -> int:
    p = _paths(cfg)
    if not comp:
        print(f"Available logs in {p.logs}:")
        for f in sorted(p.logs.glob("*.log")):
            print(f"  {f.name}")
        return 0
    files = (
        sorted(str(f) for f in p.logs.glob("*.log"))
        if comp == "all"
        else [str(_log_file(p, comp))]
    )
    if comp != "all" and not _log_file(p, comp).exists():
        err(f"no log at {_log_file(p, comp)} (component never started?)")
        return 1
    try:
        os.execvp("tail", ["tail", "-F", *files])  # replaces this process with tail on success
    except OSError as e:
        err(f"could not exec tail: {e}")
        return 1
    return 0  # unreachable on success (execvp replaced us); satisfies the -> int contract


def restart(cfg: InfraConfig, names: list[str]) -> int:
    """Restart L2 process(es) and/or recreate L1 box(es), by name.

    L2 components (see ALL_COMPONENTS) are stopped + restarted; the Go ones
    (see _GO_BUILDS) rebuild their binary first. L1 box names (dex/registry/...) are
    destroyed + recreated — the surgical fix for one wedged box (e.g. dex after
    the host sleeps and its clock drifts). The host data volume survives.
    """
    p = _paths(cfg)
    table = _components(p)
    l2 = [n for n in names if n in ALL_COMPONENTS]
    l1 = [n for n in names if n in SERVICES]
    unknown = [n for n in names if n not in ALL_COMPONENTS and n not in SERVICES]
    if unknown:
        err(f"unknown component/box: {' '.join(unknown)}")
        return 2

    healthy = True
    for name in l2:
        stop_component(p, name)
        if name in _GO_BUILDS:  # native Go binaries — no watch mode, rebuild
            if name == "runner":
                _local_arm64.ensure_native_lib()
            _go_build(p, name)
        healthy &= start_component(p, table[name])

    if l1:  # recreate L1 boxes inside ONE event loop (the SDK runtime is loop-bound)
        async def go() -> None:
            for box in l1:
                log(f"recreating L1 box: boxlite-local-{box}")
                await orchestrator.down(cfg, SERVICES, only=[box])
                await orchestrator.up(cfg, SERVICES, only=[box])

        asyncio.run(go())
        for box in l1:
            ok(f"{box} recreated")
    return 0 if healthy else 1


def _stop_l2_and_wipe_runner(p: _Paths) -> None:
    log("stopping L2 native processes...")
    for name in reversed(ALL_COMPONENTS):
        stop_component(p, name)
    log(f"wiping runner home: {p.runner_home}")
    for sub in ("db", "boxes", "images", "rootfs", "logs"):
        shutil.rmtree(p.runner_home / sub, ignore_errors=True)


def reset(cfg: InfraConfig, *, hard: bool = False) -> int:
    """Wipe L2 runtime state; L1 boxes stay. --hard also drops + rebuilds the schema."""
    p = _paths(cfg)
    _stop_l2_and_wipe_runner(p)
    if not _l1_running(cfg):
        warn("PG not running — skipping the DB wipe")
        return 0
    if hard:
        log("wiping schema + rebuilding via migrations...")
        r = _psql(cfg, "DROP SCHEMA public CASCADE; CREATE SCHEMA public; "
                       f"GRANT ALL ON SCHEMA public TO {cfg.pg_user};")
        if r.returncode != 0:
            err(f"schema drop/recreate failed — aborting hard reset:\n{r.stderr.strip()}")
            return 1
        _wipe_registry_secrets(p)
        if _migrate(cfg) != 0:
            err("migrations failed after schema reset — the schema may be incomplete")
            return 1
        ok("hard reset complete (schema rebuilt — identity wiped)")
        warn("browser must re-login: clear sessionStorage + localStorage, then sign in via dex")
    else:
        # Preserve identity + infra (user/org/region/runner/api_key); clear only
        # runtime/user-created state. Keeps OIDC sessions alive.
        log("truncating runtime data (identity + infra rows preserved)...")
        r = _psql(cfg, "TRUNCATE TABLE box, job, volume, audit_log RESTART IDENTITY CASCADE;")
        if r.returncode != 0:
            warn("truncate had errors (some tables may not exist on a fresh schema)")
        ok("soft reset complete (identity + L1 boxes + schema preserved — no re-login)")
    return 0


def nuke(cfg: InfraConfig) -> int:
    """Tear down EVERYTHING: stop L2, destroy all L1 boxes, wipe data + logs."""
    p = _paths(cfg)
    _stop_l2_and_wipe_runner(p)
    log("nuking everything (L1 boxes + data + logs)...")
    asyncio.run(orchestrator.down(cfg, SERVICES, wipe=True))
    shutil.rmtree(p.logs, ignore_errors=True)
    _wipe_registry_secrets(p)
    ok("nuke complete — next `up` is a true cold start")
    return 0


def _wipe_registry_secrets(p: _Paths) -> None:
    # Registry passwords, in plain files. Once the rows naming them are gone
    # nothing would ever delete them, so they go with the rows.
    shutil.rmtree(p.registry_secrets, ignore_errors=True)


def _migrate(cfg: InfraConfig) -> int:
    """Run all TypeORM migrations from apps/api (mirrors the old `make migrate`).
    Returns the migration process's exit code (0 == success)."""
    p = _paths(cfg)
    cmd = (
        "set -a && . ../.env && set +a && "
        "npx ts-node -P ./tsconfig.json -r tsconfig-paths/register "
        "../node_modules/typeorm/cli.js migration:run -d ./src/migrations/data-source.ts"
    )
    return subprocess.run(["bash", "-c", cmd], cwd=str(p.apps / "api"), check=False).returncode


def seed(cfg: InfraConfig, *, no_bounce: bool = False, no_wait: bool = False) -> int:
    """Wait for the API's onApplicationBootstrap auto-seed + a registered runner."""
    p = _paths(cfg)
    if not _pg_reachable(cfg):
        err(f"postgres not reachable at 127.0.0.1:{_pg_port()} — bring up L1 first (`compose up`)")
        return 1

    if not no_bounce:
        if _component_pid(p, "api") is not None:
            log("restarting api so it re-runs its initialize* cycle...")
            restart(cfg, ["api"])
        else:
            log("api not running — skipping restart (seed runs on next up)")

    log("waiting for API auto-seed to land admin user + org...")
    deadline = time.monotonic() + 60
    while not _verify_seeded(cfg):
        if time.monotonic() > deadline:
            err("API never seeded admin user/org in 60s — check the api log")
            return 1
        time.sleep(2)

    if not no_wait:
        log("waiting for the default runner to register...")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if _pg_count(cfg, "SELECT count(*) FROM runner;") > 0:
                ok("runner registered")
                break
            time.sleep(2)
        else:
            warn("no runner row after 60s — box create will fail until it registers")

    ok("init data ready")
    return 0


def _verify_seeded(cfg: InfraConfig) -> bool:
    # The API self-seeds admin user + a default org (createdBy=boxlite-admin) +
    # region 'us' on boot. All three present == the seed cycle completed.
    return (
        _pg_count(cfg, "SELECT count(*) FROM \"user\" WHERE id = 'boxlite-admin';") > 0
        and _pg_count(cfg, "SELECT count(*) FROM organization WHERE \"createdBy\" = 'boxlite-admin';") > 0
        and _pg_count(cfg, "SELECT count(*) FROM region WHERE id = 'us';") > 0
    )
