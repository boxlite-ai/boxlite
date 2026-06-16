"""L2 native-process supervision + stack-level commands.

Ports the former `scripts/stack-*.sh` into Python: brings the four native host
processes (API, runner, proxy, dashboard) up/down/status/restart, builds the Go
binaries, tails logs, resets DB state, seeds init data, and rebuilds stuck L1
boxes. Daemons are spawned DETACHED (`start_new_session=True`) so they outlive
this process; stopped via SIGTERM→SIGKILL on the process **group**, which reaps
the `nx serve`/go grandchildren cleanly (the bash needed a pkill-by-name sweep
for this; we keep that only as a belt-and-suspenders fallback).

This is the L2 half of the orchestrator; L1 (the BoxLite boxes) lives in
`orchestrator.py` + `services.py`. `up`/`down`/`status`/`reset`/`rebuild` tie the
two together.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from . import orchestrator
from .config import InfraConfig
from .doctor import _lsof_owner
from .services import SERVICES

# ── L2 ports + identities (the native host processes) ──────────────────────
PORT_API = 3001
PORT_RUNNER = 3003
PORT_PROXY = 4000
PORT_DASHBOARD = 3000
ALL_COMPONENTS = ("api", "runner", "proxy", "dashboard")  # start order: api first
_RUNNER_TOKEN = "local-shared-runner-token-aaaa1111"


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
    def runner_home(self) -> Path:
        return Path(os.environ.get("BOXLITE_HOME_DIR") or (self.state / "boxlite-runner"))


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


def _kill_port_listeners(port: int) -> None:
    out = subprocess.run(
        ["lsof", "-ti", f":{port}", "-sTCP:LISTEN"], capture_output=True, text=True
    ).stdout
    for token in out.split():
        try:
            os.kill(int(token), signal.SIGKILL)
        except (ValueError, OSError):
            continue  # PID already gone or unparseable — skip it, keep killing the rest


def _component_pid(p: _Paths, name: str) -> int | None:
    """Recorded PID if still alive, else None (cleaning a stale pidfile)."""
    pf = _pid_file(p, name)
    if not pf.exists():
        return None
    try:
        pid = int(pf.read_text().strip())
    except (ValueError, OSError):
        return None
    try:
        os.kill(pid, 0)
        return pid
    except OSError:
        pf.unlink(missing_ok=True)
        return None


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


# ── L2 component table (the four native host processes) ────────────────────
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
    pkill_pattern: str    # orphan-sweep fallback (matches the bash pkill -f)


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
        **_parse_dotenv(apps / ".env"),
    }
    return {
        "api": _Component(
            "api", PORT_API, "http", f"http://localhost:{PORT_API}/api/health", 180,
            ["corepack", "yarn", "nx", "serve", "api"], apps, api_env, "nx.*serve.*api",
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
                "INSECURE_REGISTRIES": "127.0.0.1:25000",
                "AWS_REGION": "us-east-1",
            },
            "boxlite-runner$",
        ),
        "proxy": _Component(
            "proxy", PORT_PROXY, "tcp", "", 30,
            [str(p.proxy_bin)], None,
            {
                "PROXY_PORT": str(PORT_PROXY),
                "PROXY_PROTOCOL": "http",
                "PROXY_API_KEY": "boxlite-proxy-key",
                "BOXLITE_API_URL": f"http://localhost:{PORT_API}/api",
                "OIDC_CLIENT_ID": "boxlite",
                "OIDC_AUDIENCE": "boxlite",
                "OIDC_DOMAIN": "http://localhost:25556/dex",
                "REDIS_HOST": "127.0.0.1",
                "REDIS_PORT": "26379",
                "SHUTDOWN_TIMEOUT_SEC": "10",
            },
            "boxlite-proxy$",
        ),
        # VITE_API_URL=/api routes dashboard API calls through the Vite dev proxy
        # (→ localhost:3001) instead of the hard-coded prod default.
        "dashboard": _Component(
            "dashboard", PORT_DASHBOARD, "http", f"http://localhost:{PORT_DASHBOARD}", 120,
            ["corepack", "yarn", "nx", "serve", "dashboard"], apps, {"VITE_API_URL": "/api"},
            "nx.*serve.*dashboard",
        ),
    }


# ── single-process supervision ─────────────────────────────────────────────
def start_component(p: _Paths, comp: _Component) -> bool:
    if _component_pid(p, comp.name) is not None:
        ok(f"{comp.name} already running")
        return True
    if _port_listening(comp.port):  # stale listener from a crashed prior session
        warn(f"port {comp.port} already in use — killing prior listener")
        _kill_port_listeners(comp.port)
        time.sleep(1)
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
    _pid_file(p, comp.name).write_text(str(proc.pid))
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


def _terminate_group(pid: int) -> None:
    """SIGTERM the process group, then SIGKILL after 5s if still alive."""
    try:
        pgid = os.getpgid(pid)
    except OSError:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        pass  # best-effort: the group may already be gone (race) — fall through to the wait
    for _ in range(5):
        time.sleep(1)
        try:
            os.kill(pid, 0)
        except OSError:
            return  # gone
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass  # best-effort final kill: nothing to do if it already exited


def stop_component(p: _Paths, name: str) -> None:
    pid = _component_pid(p, name)
    if pid is None:
        ok(f"{name} not running")
    else:
        log(f"stopping {name} (PID {pid})...")
        _terminate_group(pid)
        _pid_file(p, name).unlink(missing_ok=True)
        ok(f"{name} stopped")
    # belt-and-suspenders: sweep any orphan by name (only for this component)
    comp = _components(p).get(name)
    if comp:
        subprocess.run(["pkill", "-TERM", "-f", comp.pkill_pattern], check=False)


# ── L1 helpers (talk to the BoxLite SDK via orchestrator) ──────────────────
# Each public command does ALL its L1 async work inside ONE `asyncio.run`: the
# SDK's default-runtime singleton is bound to the loop it's first used on, so we
# never spread SDK calls across loops (mirrors the old single-asyncio.run CLI).
def _l1_running(cfg: InfraConfig) -> bool:
    async def go() -> bool:
        orchestrator.ensure_home_env(cfg)
        infos = await orchestrator.get_runtime().list_info()
        return any((i.name or "") == "boxlite-local-postgres" for i in infos)

    return asyncio.run(go())


async def _ensure_l1_async(cfg: InfraConfig) -> bool:
    """Bring the whole L1 up if postgres isn't running. True if (re)created."""
    orchestrator.ensure_home_env(cfg)
    infos = await orchestrator.get_runtime().list_info()
    if any((i.name or "") == "boxlite-local-postgres" for i in infos):
        ok("L1 boxes already running")
        return False
    log("L1 boxes not running — starting...")
    await orchestrator.up(cfg, SERVICES)
    return True


def _l1_rows(cfg: InfraConfig) -> list[tuple[str, str]]:
    async def go() -> list[tuple[str, str]]:
        orchestrator.ensure_home_env(cfg)
        infos = await orchestrator.get_runtime().list_info()
        return [
            (i.name, i.state.status) for i in infos if (i.name or "").startswith("boxlite-local-")
        ]

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
def _go_build(p: _Paths, comp: str) -> None:
    """Rebuild one native Go binary (`runner` or `proxy`)."""
    out = p.runner_bin if comp == "runner" else p.proxy_bin
    p.bin.mkdir(parents=True, exist_ok=True)
    log(f"go build {comp} → {out}")
    subprocess.run(["go", "build", "-o", str(out), f"./cmd/{comp}"],
                   cwd=str(p.apps / comp), env={**os.environ, "GOTOOLCHAIN": "auto"}, check=True)


def build(cfg: InfraConfig) -> int:
    """Build both native binaries (used by `up` when they're missing)."""
    p = _paths(cfg)
    if not (p.apps / "node_modules").is_dir():
        log("yarn install (node_modules missing)")
        subprocess.run(["corepack", "yarn", "install"], cwd=str(p.apps), check=True)
    _go_build(p, "runner")
    _go_build(p, "proxy")
    ok("binaries ready")
    return 0


def _ensure_installed(p: _Paths) -> None:
    """Zero-config bring-up: if the boxlite SDK isn't importable, `pip install -e .`
    (which pulls it in) and re-exec — a fresh interpreter then sees the install.
    The sentinel env var prevents an install loop if it still doesn't import."""
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


def _seed_api_env(p: _Paths) -> None:
    api_env = p.apps / "api" / ".env"
    if not api_env.exists():
        log("apps/api/.env missing — seeding from the infra-local template")
        shutil.copy(p.infra_local / "api.env", api_env)
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
    _ensure_installed(p)

    # 1. ensure L1 boxes (single asyncio.run; brings L1 up if postgres is down)
    l1_recreated = asyncio.run(_ensure_l1_async(cfg))

    # 2. a surviving L2 proc is stale once L1 was just (re)created — restart fresh
    if l1_recreated:
        log("L1 (re)created — stopping any stale L2 procs so they restart fresh")
        for name in reversed(comps):
            stop_component(p, name)

    # 3. binaries present? (auto-build the missing ones)
    if not p.runner_bin.exists() or not p.proxy_bin.exists():
        log("native binaries missing — building")
        build(cfg)

    # 4. API .env template + the apps/.env symlink NestJS needs
    _seed_api_env(p)

    # 5. start the requested L2 components
    table = _components(p)
    healthy = True
    for name in comps:
        healthy &= start_component(p, table[name])

    # 6. ensure init data + a registered runner (the dashboard needs both)
    if any(c in comps for c in ("api", "runner")):
        log("ensuring init data + registered runner...")
        if seed(cfg, no_bounce=True) != 0:
            healthy = False  # a hard seed failure (pg down / never seeded) → up exits non-zero

    print()
    ok("stack up — see status with: make status")
    print(f"  Dashboard:    http://localhost:{PORT_DASHBOARD}")
    print(f"  API:          http://localhost:{PORT_API}/api")
    print(f"  Dex (OIDC):   http://localhost:25556/dex")
    print(f"  Logs at:      {p.logs}/")
    return 0 if healthy else 1


def down(cfg: InfraConfig, components: list[str] | None = None, *, include_l1: bool = False) -> int:
    p = _paths(cfg)
    comps = components or ["dashboard", "proxy", "runner", "api"]  # reverse of start order
    for name in comps:
        stop_component(p, name)
    if include_l1:
        log("stopping L1 boxes...")
        asyncio.run(orchestrator.down(cfg, SERVICES))  # boxes removed; data volumes survive
    ok("stack down")
    return 0


def status(cfg: InfraConfig) -> int:
    p = _paths(cfg)
    exit_code = 0

    print(f"{_BOLD}L1 — infra-local boxes{_RESET}")
    rows = _l1_rows(cfg)
    if rows:
        for name, state in rows:
            print(f"  {name:<26} {state}")
    else:
        warn("no L1 boxes running")
        exit_code = 1

    print()
    print(f"{_BOLD}L2 — native processes{_RESET}")
    print(f"  {'COMP':<10} {'PID':<8} {'PORT':<8} STATE")
    ports = {"api": PORT_API, "runner": PORT_RUNNER, "proxy": PORT_PROXY, "dashboard": PORT_DASHBOARD}
    for comp in ALL_COMPONENTS:
        pid = _component_pid(p, comp)
        port = ports[comp]
        if pid is None:
            print(f"  {comp:<10} {'-':<8} {port:<8} {_DIM}down{_RESET}")
            exit_code = 1
        elif _port_listening(port):
            print(f"  {comp:<10} {pid:<8} {port:<8} {_GREEN}up{_RESET}")
        else:
            print(f"  {comp:<10} {pid:<8} {port:<8} {_YELLOW}alive but not listening{_RESET}")
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

    L2 components (api/runner/proxy/dashboard) are stopped + restarted (runner/
    proxy rebuild their Go binary first). L1 box names (dex/registry/...) are
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
        if name in ("runner", "proxy"):  # native Go binaries — no watch mode, rebuild
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
    for name in ["dashboard", "proxy", "runner", "api"]:
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
    ok("nuke complete — next `up` is a true cold start")
    return 0


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
