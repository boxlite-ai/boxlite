#!/usr/bin/env python3
"""Run the local BoxLite E2E stack with Docker Compose and host processes."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "apps/e2e"
STATE = Path(os.environ.get("BOXLITE_E2E_STATE_DIR", ROOT / "target/e2e")).resolve()
# E2E_PYTHON: bare names go through PATH; relative paths are anchored at ROOT
# because the pytest cases run with cwd=apps/e2e.
_raw_python = os.environ.get("E2E_PYTHON")
PYTHON = Path(_raw_python) if _raw_python else ROOT / ".venv-e2e/bin/python"
if _raw_python and "/" in _raw_python and not PYTHON.is_absolute():
    PYTHON = ROOT / PYTHON
COMPOSE = E2E / "compose.yaml"
DEPENDENCIES = json.loads((E2E / "dependencies.json").read_text())
sys.path.insert(0, str(E2E))
from minio import image_ref as minio_image_ref  # noqa: E402
from python_env import interpreter  # noqa: E402

if _raw_python and "/" not in _raw_python:
    try:
        PYTHON = interpreter(_raw_python)
    except ValueError as error:
        raise SystemExit(str(error)) from error

PORTS = dict(API=3300, RUNNER=38080, PROXY=34000, REGISTRY_PROXY=34100,
             POSTGRES=35432, REDIS=36379, REGISTRY=35000, DEX=35556, MINIO=39000)
GUEST_IMAGE = DEPENDENCIES["guest"]["image"]
INSTANCE_ID = hashlib.sha256(f"{ROOT}:{STATE}".encode()).hexdigest()[:12]
RUNTIME_HOME = Path(f"/tmp/ble2e-{os.getuid()}-{INSTANCE_ID}/r")
COORDINATION = Path(f"/tmp/boxlite-e2e-{os.getuid()}")
PROJECT = f"boxlite-e2e-{os.getuid()}-{INSTANCE_ID}"


class Failure(Exception):
    pass


def endpoint(name: str) -> str:
    return f"http://127.0.0.1:{PORTS[name]}"


def run(argv, *, cwd=ROOT, env=None, timeout=None):
    argv = [str(item) for item in argv]
    print("+", " ".join(shlex.quote(item) for item in argv), flush=True)
    subprocess.run(argv, cwd=cwd, env=env or base_env(), timeout=timeout, check=True)


def compose(args, env, *, capture=False):
    binary = shutil.which("docker-compose")
    if binary:
        argv = [binary]
    elif shutil.which("docker"):
        argv = ["docker", "compose"]
    else:
        raise Failure("docker-compose or docker compose is required")
    env = dict(env)
    env["COMPOSE_PROJECT_NAME"] = PROJECT
    # Keep connection settings stable even if the caller's environment changes.
    selection = STATE / "compose-engine.json"
    keys = ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")
    if not selection.exists():
        atomic_json(selection, {key: env[key] for key in keys if key in env})
    engine = json.loads(selection.read_text())
    for key in keys:
        env.pop(key, None)
    env.update(engine)
    command = [*argv, "-p", PROJECT, "--project-directory", str(ROOT), "-f", str(COMPOSE),
               "--env-file", str(STATE / ".env"), *args]
    if capture:
        return subprocess.check_output(command, env=env, text=True)
    run(command, env=env)


def base_env():
    env = dict(os.environ)
    credentials = load_credentials()
    for key in ("BOXLITE_API_KEY", "BOXLITE_E2E_SKIP_PATH_VERIFY", "BOXLITE_DEPS_STUB"):
        env.pop(key, None)
    api = endpoint("API") + "/api"
    env.update({
        "BOXLITE_LISTEN_HOST": "127.0.0.1",
        "NODE_ENV": "development", "ENVIRONMENT": "development",
        "PORT": str(PORTS["API"]), "VERSION": "0.0.0-e2e", "RUN_MIGRATIONS": "true",
        "SKIP_CONNECTIONS": "false", "DISABLE_CRON_JOBS": "false",
        "NOTIFICATION_GATEWAY_DISABLED": "true", "APP_ROLE": "all", "LOG_REQUESTS_ENABLED": "true",
        "DB_HOST": "127.0.0.1", "DB_PORT": str(PORTS["POSTGRES"]), "DB_USERNAME": "boxlite",
        "DB_PASSWORD": credentials["POSTGRES_PASSWORD"], "DB_DATABASE": "boxlite_e2e",
        "PGHOST": "127.0.0.1", "PGPORT": str(PORTS["POSTGRES"]), "PGUSER": "boxlite",
        "PGPASSWORD": credentials["POSTGRES_PASSWORD"], "PGDATABASE": "boxlite_e2e",
        "POSTGRES_PASSWORD": credentials["POSTGRES_PASSWORD"], "MINIO_PASSWORD": credentials["MINIO_PASSWORD"],
        "REDIS_HOST": "127.0.0.1", "REDIS_PORT": str(PORTS["REDIS"]),
        "REDIS_PASSWORD": "", "REDIS_TLS": "false", "DB_TLS_ENABLED": "false",
        "ADMIN_API_KEY": credentials["ADMIN_KEY"],
        "ENCRYPTION_KEY": credentials["ENCRYPTION_KEY"], "ENCRYPTION_SALT": credentials["ENCRYPTION_SALT"],
        "OIDC_CLIENT_ID": "boxlite", "OIDC_AUDIENCE": "boxlite",
        "OIDC_ISSUER_BASE_URL": endpoint("DEX"), "OIDC_DOMAIN": endpoint("DEX"),
        "DEFAULT_REGION_ENFORCE_QUOTAS": "false", "DEFAULT_RUNNER_NAME": "boxlite-e2e",
        "DEFAULT_RUNNER_API_KEY": credentials["RUNNER_KEY"], "DEFAULT_RUNNER_DOMAIN": "127.0.0.1",
        "DEFAULT_RUNNER_API_VERSION": "2", "DEFAULT_RUNNER_API_URL": endpoint("RUNNER"),
        "DEFAULT_RUNNER_PROXY_URL": endpoint("PROXY"),
        "RUNNER_START_SCORE_THRESHOLD": "1", "RUNNER_AVAILABILITY_SCORE_THRESHOLD": "1",
        "RUNNER_DECLARATIVE_BUILD_SCORE_THRESHOLD": "1",
        "BOXLITE_API_URL": api, "BOXLITE_RUNNER_TOKEN": credentials["RUNNER_KEY"], "API_VERSION": "2",
        "API_PORT": str(PORTS["RUNNER"]), "API_LOG_REQUESTS": "true",
        "RUNNER_DOMAIN": "127.0.0.1", "BOXLITE_HOME_DIR": str(RUNTIME_HOME),
        "PROXY_PORT": str(PORTS["PROXY"]), "PROXY_PROTOCOL": "http",
        "PROXY_DOMAIN": f"localhost:{PORTS['PROXY']}",
        "PROXY_TEMPLATE_URL": f"http://{{{{PORT}}}}-{{{{boxId}}}}.localhost:{PORTS['PROXY']}",
        "PROXY_API_KEY": credentials["PROXY_KEY"],
        "REGISTRY_PROXY_PORT": str(PORTS["REGISTRY_PROXY"]),
        "REGISTRY_PROXY_HOST": f"127.0.0.1:{PORTS['REGISTRY_PROXY']}",
        "REGISTRY_PROXY_USERNAME": "runner", "REGISTRY_PROXY_PASSWORD": credentials["RUNNER_KEY"],
        "REGISTRY_SECRET_STORE": "file", "REGISTRY_SECRET_DIR": str(STATE / "registry-secrets"),
        "INTERNAL_REGISTRY_URL": endpoint("REGISTRY"), "TRANSIENT_REGISTRY_URL": endpoint("REGISTRY"),
        "INSECURE_REGISTRIES": f"127.0.0.1:{PORTS['REGISTRY']},127.0.0.1:{PORTS['REGISTRY_PROXY']}",
        "S3_ENDPOINT": endpoint("MINIO"), "S3_STS_ENDPOINT": endpoint("MINIO") + "/minio/v1/assume-role",
        "S3_REGION": "us-east-1", "S3_ACCESS_KEY": "e2eadmin", "S3_SECRET_KEY": credentials["MINIO_PASSWORD"],
        "S3_DEFAULT_BUCKET": "boxlite", "AWS_ENDPOINT_URL": endpoint("MINIO"),
        "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "e2eadmin",
        "AWS_SECRET_ACCESS_KEY": credentials["MINIO_PASSWORD"], "AWS_DEFAULT_BUCKET": "boxlite",
        "VOLUME_STORAGE_BACKEND": "s3",
        "BOXLITE_E2E_API_URL": api, "BOXLITE_E2E_ADMIN_KEY": credentials["ADMIN_KEY"],
        "BOXLITE_E2E_API_KEY": credentials["ADMIN_KEY"],
        "BOXLITE_REST_URL": api, "BOXLITE_HOME": str(STATE / "client-home"),
        "BOXLITE_E2E_API_LOG": str(STATE / "logs/api.log"),
        "BOXLITE_E2E_RUNNER_LOG": str(STATE / "logs/runner.log"),
        "BOXLITE_E2E_IMAGE": GUEST_IMAGE, "BOXLITE_SYSTEM_BASE_IMAGE": GUEST_IMAGE,
        "BOXLITE_E2E_CLI": str(ROOT / "target/debug/boxlite"),
        "BOXLITE_CLI": str(ROOT / "target/debug/boxlite"),
        "BOXLITE_E2E_NATIVE_LIB_DIR": str(ROOT / "target/debug"),
        "BOXLITE_E2E_TSX": str(ROOT / "apps/node_modules/.bin/tsx"),
        "DASHBOARD_URL": endpoint("API"), "DASHBOARD_BASE_API_URL": api,
        "APP_URL": endpoint("API"),
        "OTEL_ENABLED": "false", "OTEL_TRACING_ENABLED": "false",
        "OTEL_LOGGING_ENABLED": "false", "USAGE_EXPORT_ENABLED": "false",
        "USAGE_ALLOCATION_SNAPSHOT_ENABLED": "false", "BILLING_API_URL": "",
        "ANALYTICS_API_URL": "", "SMTP_HOST": "", "SMTP_USER": "", "SMTP_PASSWORD": "",
        "SVIX_AUTH_TOKEN": "", "KAFKA_ENABLED": "false", "INCIDENT_IO_ENABLED": "false",
        "CERT_PATH": "", "CERT_KEY_PATH": "", "ENABLE_TLS": "false",
    })
    env.setdefault("BOXLITE_E2E_AUTH", "api-key")
    env["PATH"] = f"{ROOT / '.venv-e2e/bin'}:{ROOT / 'target/debug'}:{env.get('PATH', '')}"
    env["PYTHONPATH"] = f"{E2E / 'lib'}:{env.get('PYTHONPATH', '')}"
    return env


def atomic_json(path, value):
    """Publish complete private state without exposing partial writes to readers."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-")
    os.close(fd)
    temporary = Path(temporary)
    try:
        temporary.write_text(json.dumps(value, indent=2))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_credentials():
    """Keep environment-specific credentials stable across restarts."""
    path = STATE / "credentials.json"
    if not path.exists():
        values = {name: secrets.token_hex(32) for name in (
            "ADMIN_KEY", "RUNNER_KEY", "PROXY_KEY", "POSTGRES_PASSWORD",
            "MINIO_PASSWORD", "ENCRYPTION_KEY", "ENCRYPTION_SALT")}
        # Overrides are consumed only at creation; existing data keeps its keys.
        for name in ("POSTGRES_PASSWORD", "MINIO_PASSWORD"):
            if os.environ.get(name):
                values[name] = os.environ[name]
        atomic_json(path, values)
    return json.loads(path.read_text())


def state_dirs():
    """Verify the private runtime root before creating launcher state."""
    checked_directory(RUNTIME_HOME.parent, private=True, create=True)
    checked_directory(RUNTIME_HOME, private=True, create=True)
    box_dirs(RUNTIME_HOME)  # Validate existing boxes before the Runner can use them.
    for directory in (STATE, STATE / "logs", STATE / "client-home",
                      STATE / "registry-secrets"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)


def checked_directory(path, *, private=False, create=False, repair=False):
    """Reject unsafe paths; repair owned box modes only inside a private root."""
    try:
        if create:
            path.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise Failure(f"unsafe runtime directory: {path}") from error
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or (info.st_mode & 0o022 and not repair):
            raise Failure(f"unsafe runtime directory ownership or permissions: {path}")
        # Runtime parents must already be non-writable by others. Box modes
        # inside the private parent may come from the Runner's older umask.
        if private or repair:
            os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def write_files():
    state_dirs()
    dex = (ROOT / "apps/dex/config.yaml").read_text()
    dex = dex.replace("${DEX_ISSUER}", endpoint("DEX")).replace("${REDIRECT_URI}", endpoint("API"))
    dex = dex.replace("    redirectURIs:\n", "    redirectURIs:\n      - '/device/callback'\n")
    (STATE / "dex.yaml").write_text(dex)
    env_file = {
        "COMPOSE_PROJECT_NAME": PROJECT,
        "POSTGRES_IMAGE": DEPENDENCIES["images"]["postgres"],
        "REDIS_IMAGE": DEPENDENCIES["images"]["redis"],
        "REGISTRY_IMAGE": DEPENDENCIES["images"]["registry"],
        "DEX_IMAGE": DEPENDENCIES["images"]["dex"],
        "MINIO_IMAGE": minio_image_ref(),
        "DEX_CONFIG": str(STATE / "dex.yaml"),
        **{f"{name}_PORT": str(port) for name, port in PORTS.items()},
    }
    path = STATE / ".env"
    path.write_text("".join(f"{key}={value}\n" for key, value in env_file.items()))
    path.chmod(0o600)


def make(target, env, **variables):
    variables.setdefault("E2E_PYTHON", str(PYTHON))
    run(["make", "--no-print-directory", target,
         *[f"{key}={value}" for key, value in variables.items()]], env=env)


def input_digest(env, *, dependencies=False):
    """Hash working-tree inputs, including untracked sources and submodule edits."""
    digest = hashlib.sha256()

    def scan(root, prefix=Path()):
        files = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others",
             "--exclude-standard"], stderr=subprocess.DEVNULL).split(b"\0")
        for raw in sorted(set(files) - {b""}):
            relative = prefix / os.fsdecode(raw)
            path = ROOT / relative
            parts = relative.parts
            if ("tests" in parts or "__tests__" in parts or "cases" in parts
                    or relative.suffix == ".md" or parts[0] == "docs"
                    or (ROOT in STATE.parents and (path == STATE or STATE in path.parents))):
                continue
            if path.is_dir() and not path.is_symlink():
                if not dependencies:
                    scan(path, relative)
                continue
            if dependencies and path.name not in (
                    "package.json", "package-lock.json", "yarn.lock", ".yarnrc.yml",
                    "pyproject.toml", "uv.lock", "dependencies.json", "python_env.py"):
                continue
            digest.update(str(relative).encode() + b"\0")
            if path.is_symlink():
                digest.update(os.readlink(path).encode())
            elif path.exists():
                with path.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
            else:
                digest.update(b"<missing>")
            digest.update(b"\0")

    scan(ROOT)
    ignored = {"FILTER", "E2E_ARGS", "MAKEFLAGS", "MFLAGS", "MAKELEVEL"}
    digest.update(json.dumps({key: value for key, value in env.items()
                              if key not in ignored}, sort_keys=True).encode())
    digest.update(str(PYTHON).encode())
    return digest.hexdigest()


def read_record(name):
    """Treat missing or damaged cache records as requiring preparation."""
    try:
        return json.loads((STATE / name).read_text())
    except (OSError, ValueError):
        return None


def build(env):
    dependencies = input_digest(env, dependencies=True)
    ready = (PYTHON.exists() and (ROOT / "apps/node_modules").is_dir()
             and (ROOT / "sdks/node/node_modules").is_dir())
    if not ready or read_record("dependencies-inputs.json") != dependencies:
        (STATE / "dependencies-inputs.json").unlink(missing_ok=True)
        make("test:e2e:deps", env)
        make("test:e2e:deps:apps", env)
        make("test:e2e:deps:node", env)
        atomic_json(STATE / "dependencies-inputs.json", dependencies)
    make("runtime:debug", env)
    make("test:e2e:build:python", env, SETUP_DONE=1)
    make("test:e2e:build:node", env, SETUP_DONE=1)
    make("dev:go", env, SETUP_DONE=1)
    make("cli", env, SETUP_DONE=1)
    make("test:e2e:build:runner", env, E2E_STATE_DIR=STATE)
    make("test:e2e:build:proxies", env, E2E_STATE_DIR=STATE)
    make("test:e2e:build:minio", env, E2E_STATE_DIR=STATE)


def wait_http(address, timeout, process=None):
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise Failure(f"{address} process exited with {process.returncode}")
        try:
            with urllib.request.urlopen(address, timeout=3) as response:
                if response.status < 500:
                    return
        except (OSError, urllib.error.URLError, ValueError) as error:
            last = str(error)
        time.sleep(0.25)
    raise Failure(f"{address} not ready after {timeout}s: {last}")


def request(path, env):
    req = urllib.request.Request(
        endpoint("API") + "/api" + path, headers={"Authorization": f"Bearer {env['ADMIN_API_KEY']}"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.loads(response.read() or "null")


def start_process(name, argv, cwd, health, env, timeout):
    logs = STATE / "logs" / f"{name}.log"
    logs.parent.mkdir(parents=True, exist_ok=True)
    with logs.open("ab") as output:
        process = subprocess.Popen(
            [str(item) for item in argv], cwd=cwd, env=env,
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True, umask=0o077)
    pids = load_pids()
    pids[name] = {"pid": process.pid, "starttime": process_starttime(process.pid)}
    save_pids(pids)
    wait_http(health, timeout, process)
    return process


def load_pids():
    path = STATE / "pids.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save_pids(pids):
    atomic_json(STATE / "pids.json", pids)


def process_starttime(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    return raw[raw.rfind(")") + 2:].split()[19]


def process_matches(pid, starttime):
    try:
        return process_starttime(pid) == starttime
    except (FileNotFoundError, ProcessLookupError):
        return False


def stop_host(records=None):
    saved = load_pids()
    records = saved if records is None else records
    for entry in records.values():
        if not isinstance(entry, dict) or not process_matches(entry.get("pid"), entry.get("starttime")):
            continue
        pid = entry["pid"]
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass  # A later launcher invocation is not the child's parent.
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    save_pids({name: entry for name, entry in saved.items()
               if name not in records or entry != records[name]})


def _argv(pid):
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]


def owned_process(argv, home=None):
    """Return True for a bwrap/shim process belonging to this checkout."""
    home = RUNTIME_HOME if home is None else home
    if not argv:
        return False
    if f"{home}/boxes/" not in "\0".join(argv):
        return False
    return Path(argv[0]).name in ("bwrap", "boxlite-shim")


def box_processes():
    """PIDs of bwrap/boxlite-shim processes under this checkout's runtime home."""
    pids = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            pid = int(entry.name)
            if owned_process(_argv(pid)):
                pids.append(pid)
    return pids


def _signal_owned(pid, sig):
    """Signal a process, and its group only when it leads one."""
    try:
        if not owned_process(_argv(pid)):
            return
        if os.getpgid(pid) == pid:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)
    except ProcessLookupError:
        pass


def stop_orphaned_boxes(grace=8.0, *, pids=None):
    """Kill bwrap/boxlite-shim pairs left behind by an earlier runner.

    The jailer starts every shim with setsid(), so signalling the runner's
    process group never reaches it. Terminate the shim's own pid/group, then
    escalate to SIGKILL and return whatever is still alive.
    When pids is supplied, leave every unselected tree untouched.
    """
    selected = None if pids is None else set(pids)

    def remaining():
        current = box_processes()
        return current if selected is None else [pid for pid in current if pid in selected]

    pids = remaining()
    if not pids:
        return []
    print(f"[e2e] stopping {len(pids)} leftover box process(es)", flush=True)
    for pid in pids:
        _signal_owned(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and remaining():
        time.sleep(0.1)
    for pid in remaining():
        _signal_owned(pid, signal.SIGKILL)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and remaining():
        time.sleep(0.05)
    return remaining()


def box_dirs(home=RUNTIME_HOME):
    """Validate the boxes root and return owned, non-symlink box directories."""
    root = home / "boxes"
    try:
        checked_directory(home, private=True)
        checked_directory(root, repair=True)
        result = []
        for path in sorted(root.iterdir()):
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise Failure(f"symlink in runtime boxes directory: {path}")
            if stat.S_ISDIR(mode):
                checked_directory(path, repair=True)
                result.append(path)
        return result
    except FileNotFoundError:
        return []


def prune_box_dirs(dirs=None):
    """Remove leftover box directories; returns how many were deleted."""
    removed = 0
    for path in dirs if dirs is not None else box_dirs():
        try:
            checked_directory(path.parent)
            checked_directory(path)
            shutil.rmtree(path)
        except FileNotFoundError:
            continue
        removed += 1
    return removed


def adoptable_box(box):
    """Mirror runtime recovery's live/fingerprinted or legacy shim PID rule."""
    try:
        checked_directory(box)
        lines = (box / "shim.pid").read_text().splitlines()
        pid_text = lines[0].strip().removeprefix("+")
        if not pid_text.isascii() or not pid_text.isdecimal():
            return False
        pid_text = pid_text.lstrip("0") or "0"
        if len(pid_text) > 10:
            return False
        pid = int(pid_text)
        if not 0 < pid < 2**31:
            return False
        os.kill(pid, 0)
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 2:].split()
        if fields[0] == "Z":
            return False
        expected = lines[1].strip().removeprefix("+") if len(lines) > 1 else ""
        # As PidFileReader does, accept missing/unparseable legacy fingerprints.
        fingerprint = -1
        if expected.isascii() and expected.isdecimal():
            expected = expected.lstrip("0") or "0"
            if len(expected) <= 20:
                fingerprint = int(expected)
        return not 0 <= fingerprint < 2**64 or fingerprint == int(fields[19])
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, IndexError):
        return False


def reap_unrecoverable_boxes():
    """Reap only owned trees that runtime recovery cannot identify as live."""
    prefix = str(RUNTIME_HOME / "boxes") + "/"
    unrecoverable = []
    for pid in box_processes():
        names = {arg[len(prefix):].split("/", 1)[0]
                 for arg in _argv(pid) if arg.startswith(prefix)}
        if not names or any(name in ("", ".", "..") for name in names):
            continue  # Ambiguous ownership is not permission to kill.
        if not any(adoptable_box(RUNTIME_HOME / "boxes" / name) for name in names):
            unrecoverable.append(pid)
    if unrecoverable:
        remaining = stop_orphaned_boxes(pids=unrecoverable)
        if remaining:
            raise Failure("unrecoverable box processes survived startup cleanup")


def start(env):
    """Restart host services after reaping only unrecoverable owned guests."""
    stop_host()
    reap_unrecoverable_boxes()
    start_process(
        "api",
        [ROOT / "apps/node_modules/.bin/ts-node", "--transpile-only",
         "--project", "api/tsconfig.app.json", "-r", "tsconfig-paths/register",
         "api/src/main.ts"],
        ROOT / "apps", endpoint("API") + "/api/health", env, 180)
    for name, port, health in (
            ("registry-proxy", "REGISTRY_PROXY", "/health"),
            ("runner", "RUNNER", "/"),
            ("proxy", "PROXY", "/health")):
        start_process(
            name, [STATE / "bin" / name], STATE,
            f"{endpoint(port)}{health}", env, 90)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            rows = request("/admin/runners", env)
        except (urllib.error.HTTPError, OSError):
            rows = []
        if any(row.get("name") == "boxlite-e2e" and row.get("state") == "ready"
               for row in rows):
            return
        time.sleep(0.25)
    raise Failure("Runner did not register as ready")


def wait_command(argv, env, timeout=60):
    """Bound command execution and retries by one readiness deadline."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            if subprocess.run(argv, env=env, capture_output=True, timeout=remaining).returncode == 0:
                return
        except subprocess.TimeoutExpired:
            break
        time.sleep(min(0.25, max(0, deadline - time.monotonic())))
    raise Failure(f"{argv[0]} did not become ready")


def wait_dependencies(env):
    wait_command(["psql", "-h", "127.0.0.1", "-p", str(PORTS["POSTGRES"]),
                  "-U", "boxlite", "-d", "boxlite_e2e", "-c", "select 1"], env)
    wait_command(["redis-cli", "-h", "127.0.0.1", "-p", str(PORTS["REDIS"]), "ping"], env)
    for address in (endpoint("REGISTRY") + "/v2/",
                    endpoint("DEX") + "/.well-known/openid-configuration",
                    endpoint("MINIO") + "/minio/health/live"):
        wait_http(address, 60)


def create_bucket(env):
    script = (
        "const {S3Client,CreateBucketCommand}=require('@aws-sdk/client-s3');"
        "const c=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.S3_REGION,"
        "forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY,"
        "secretAccessKey:process.env.S3_SECRET_KEY}});"
        "c.send(new CreateBucketCommand({Bucket:'boxlite'})).catch(e=>{"
        "if(!['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes(e.name)){"
        "console.error(e.name,e.message);process.exitCode=1}})")
    run(["node", "-e", script], cwd=ROOT / "apps", env=env, timeout=30)


def fixture(env):
    run([str(PYTHON), E2E / "fixture_setup.py"], env=env)


def pytest(env, extra):
    """Honor explicit paths from both CLI arguments and E2E_ARGS."""
    args = [*extra, *shlex.split(os.environ.get("E2E_ARGS", ""))]
    if not any(arg.startswith("cases/") or arg.endswith(".py") or "::" in arg for arg in args):
        args.insert(0, "cases/")
    selector = os.environ.get("FILTER", "")
    if selector:
        args += ["-k", selector]
    run([str(PYTHON), "-m", "pytest", *args, "-v", "--tb=short",
         "--timeout=180", "-p", "no:cacheprovider"], cwd=E2E, env=env)


@contextlib.contextmanager
def stack_lock(home=COORDINATION, *, reserve=True):
    """Reserve fixed host ports for one checkout/state until successful down."""
    checked_directory(home, private=True, create=True)
    handle = os.fdopen(os.open(home / "stack.lock",
                              os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "a+")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Failure(f"another e2e stack command holds {home / 'stack.lock'}")
        owner = home / "owner.json"
        identity = {"root": str(ROOT), "state": str(STATE)}
        if owner.exists() and json.loads(owner.read_text()) != identity:
            raise Failure("another checkout/state owns the local E2E stack; "
                          "run down with its original checkout and E2E_STATE_DIR")
        if reserve:
            atomic_json(owner, identity)
        yield
    finally:
        handle.close()


def reusable(env):
    """Require owned processes, built artifacts and live dependency/service checks."""
    artifacts = [STATE / "bin" / name for name in ("runner", "proxy", "registry-proxy")]
    artifacts += [PYTHON, ROOT / "target/debug/boxlite", ROOT / "target/debug/libboxlite.a",
                  ROOT / "sdks/node/dist/index.js", ROOT / "sdks/node/node_modules",
                  ROOT / "apps/node_modules/.bin/ts-node"]
    if not all(path.exists() for path in artifacts):
        return False
    pids = load_pids()
    for name in ("api", "runner", "proxy", "registry-proxy"):
        entry = pids.get(name, {})
        if not entry or not process_matches(entry.get("pid"), entry.get("starttime")):
            return False
    try:
        wait_dependencies(env)
        for name, health in (("API", "/api/health"), ("RUNNER", "/"),
                             ("PROXY", "/health"), ("REGISTRY_PROXY", "/health")):
            wait_http(endpoint(name) + health, 3)
        return any(row.get("name") == "boxlite-e2e" and row.get("state") == "ready"
                   for row in request("/admin/runners", env))
    except (Failure, OSError, ValueError, subprocess.SubprocessError):
        return False


def up(env):
    write_files()
    inputs = input_digest(env)
    record = STATE / "stack-inputs.json"
    if read_record(record.name) == inputs and reusable(env):
        print("[e2e] reusing unchanged healthy stack", flush=True)
        return
    record.unlink(missing_ok=True)
    build(env)
    existing = compose_services(env)
    previous = load_pids()
    guests = {}
    for pid in box_processes():
        try:
            guests[pid] = process_starttime(pid)
        except FileNotFoundError:
            pass
    host_starting = False
    try:
        compose(["up", "-d"], env)
        wait_dependencies(env)
        create_bucket(env)
        host_starting = True
        start(env)
        fixture(env)
        atomic_json(record, inputs)
    except BaseException:
        # Only resources created by this attempt are unwound. Existing Compose
        # dependencies and volumes are retained, as are logs for diagnosis.
        try:
            new = {name: entry for name, entry in load_pids().items()
                   if entry != previous.get(name)}
            stop_host(new)
            if host_starting:
                created = [pid for pid in box_processes()
                           if pid not in guests or not process_matches(pid, guests[pid])]
                leftover = stop_orphaned_boxes(pids=created)
                if leftover:
                    print("[e2e] leftover box processes; run down to retry cleanup", file=sys.stderr)
            if not existing:
                compose(["down"], env)
            else:
                created = [name for name in ("postgres", "redis", "registry", "dex", "minio")
                           if name not in existing]
                if created:
                    compose(["rm", "-s", "-f", *created], env)
        except Exception as error:
            print(f"[e2e] startup cleanup failed: {error}; run down to retry", file=sys.stderr)
        raise


def compose_services(env):
    """Return existing services in this checkout's Compose project."""
    output = compose(["ps", "-a", "--services"], env, capture=True)
    return set(output.split())


def down(env):
    write_files()
    stop_host()
    stop_orphaned_boxes()
    compose(["down"], env)
    leftover = stop_orphaned_boxes()
    if leftover:
        raise Failure("leftover box processes after teardown: "
                      + ", ".join(str(pid) for pid in leftover))
    removed = prune_box_dirs()
    if removed:
        print(f"[e2e] removed {removed} leftover box director"
              f"{'y' if removed == 1 else 'ies'}", flush=True)
    (STATE / "compose-engine.json").unlink(missing_ok=True)
    (COORDINATION / "owner.json").unlink(missing_ok=True)


def doctor(env):
    required = ("make", "node", "corepack", "go", "gcc", "protoc", "docker", "psql", "redis-cli", "python3")
    missing = [name for name in required if not shutil.which(name)]
    compose_ok = bool(shutil.which("docker-compose"))
    if not compose_ok and shutil.which("docker"):
        compose_ok = subprocess.run(
            ["docker", "compose", "version"], capture_output=True).returncode == 0
    if not compose_ok:
        missing.append("docker-compose")
    if not os.access("/dev/kvm", os.R_OK | os.W_OK):
        missing.append("read/write /dev/kvm")
    if not shutil.which("mount-s3"):
        missing.append("mount-s3")
    if not os.access("/dev/fuse", os.R_OK | os.W_OK):
        missing.append("read/write /dev/fuse")
    fuse = Path("/etc/fuse.conf")
    if not (fuse.exists() and any(line.strip() == "user_allow_other" for line in fuse.read_text().splitlines())):
        missing.append("user_allow_other in /etc/fuse.conf")
    if shutil.which("node"):
        node = subprocess.run(["node", "--version"], capture_output=True, text=True, check=True).stdout.strip()
        if tuple(map(int, node.lstrip("v").split(".")[:2])) < (22, 12):
            missing.append("Node 22.12+")
    if sys.version_info < (3, 11):
        missing.append("Python 3.11+")
    if missing:
        raise Failure("Missing prerequisites: " + ", ".join(missing))
    print(f"prerequisites available; API {endpoint('API')}/api")


def status(env):
    """Fail when any required host service is missing or no longer matches."""
    write_files()
    compose(["ps"], env)
    pids = load_pids()
    missing = []
    for name in ("api", "registry-proxy", "runner", "proxy"):
        entry = pids.get(name)
        if isinstance(entry, dict) and process_matches(entry.get("pid"), entry.get("starttime")):
            print(f"{name}: running (pid {entry['pid']})")
        else:
            print(f"{name}: stopped")
            missing.append(name)
    if missing:
        raise Failure("host services not running: " + ", ".join(missing))
    print(f"box processes: {len(box_processes())} running")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor", "setup", "up", "run", "down", "status"])
    args, extra = parser.parse_known_args(argv)
    if extra[:1] == ["--"]:
        extra.pop(0)
    try:
        if args.command == "doctor":
            doctor(dict(os.environ))
        else:
            with stack_lock(reserve=args.command in ("setup", "up", "run")):
                env = base_env()
                if args.command == "down":
                    down(env)
                elif args.command == "status":
                    status(env)
                else:
                    up(env)
                    if args.command == "setup":
                        pytest(env, ["cases/test_path_verification.py"])
                    elif args.command == "run":
                        pytest(env, extra)
        return 0
    except KeyboardInterrupt:
        print("[e2e] interrupted", file=sys.stderr)
        return 130
    except (Failure, OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"[e2e] {error}", file=sys.stderr)
        return 2


def interrupted(signum, frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
