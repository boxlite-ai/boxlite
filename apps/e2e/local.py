#!/usr/bin/env python3
"""Run the local BoxLite E2E stack with Docker Compose and host processes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "apps/e2e"
STATE = Path(os.environ.get("BOXLITE_E2E_STATE_DIR", ROOT / "target/e2e")).resolve()
PYTHON = Path(os.environ.get("E2E_PYTHON", ROOT / ".venv-e2e/bin/python"))
COMPOSE = E2E / "compose.yaml"
DEPENDENCIES = json.loads((E2E / "dependencies.json").read_text())
sys.path.insert(0, str(E2E))
from minio import image_ref as minio_image_ref  # noqa: E402

PORTS = dict(API=3300, RUNNER=38080, PROXY=34000, REGISTRY_PROXY=34100,
             POSTGRES=35432, REDIS=36379, REGISTRY=35000, DEX=35556, MINIO=39000)
ADMIN_KEY = "e2e-admin-key"
RUNNER_KEY = "e2e-runner-key"
PROXY_KEY = "e2e-proxy-key"
POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "e2e-postgres")
MINIO_PASSWORD = os.environ.get("MINIO_PASSWORD", "e2e-minio")
ENCRYPTION_KEY = hashlib.sha256(b"boxlite-e2e-encryption").hexdigest()
ENCRYPTION_SALT = hashlib.sha256(b"boxlite-e2e-salt").hexdigest()
GUEST_IMAGE = DEPENDENCIES["guest"]["image"]
RUNTIME_HOME = Path(f"/tmp/ble2e-{os.getuid()}-{hashlib.sha256(str(ROOT).encode()).hexdigest()[:8]}/r")


class Failure(Exception):
    pass


def endpoint(name: str) -> str:
    return f"http://127.0.0.1:{PORTS[name]}"


def run(argv, *, cwd=ROOT, env=None, timeout=None):
    argv = [str(item) for item in argv]
    print("+", " ".join(shlex.quote(item) for item in argv), flush=True)
    subprocess.run(argv, cwd=cwd, env=env or base_env(), timeout=timeout, check=True)


def compose(args, env):
    binary = shutil.which("docker-compose")
    if binary:
        argv = [binary]
    elif shutil.which("docker"):
        argv = ["docker", "compose"]
    else:
        raise Failure("docker-compose or docker compose is required")
    env = dict(env)
    if not env.get("DOCKER_HOST") and shutil.which("podman"):
        socket = subprocess.run(
            ["podman", "info", "--format", "{{.Host.RemoteSocket.Path}}"],
            capture_output=True, text=True).stdout.strip()
        if socket and Path(socket).exists():
            env["DOCKER_HOST"] = f"unix://{socket}"
    run([*argv, "--project-directory", str(ROOT), "-f", str(COMPOSE),
         "--env-file", str(STATE / ".env"), *args], env=env)


def base_env():
    env = dict(os.environ)
    for key in ("BOXLITE_API_KEY", "BOXLITE_E2E_SKIP_PATH_VERIFY", "BOXLITE_DEPS_STUB"):
        env.pop(key, None)
    api = endpoint("API") + "/api"
    env.update({
        "NODE_ENV": "development", "ENVIRONMENT": "development",
        "PORT": str(PORTS["API"]), "VERSION": "0.0.0-e2e", "RUN_MIGRATIONS": "true",
        "SKIP_CONNECTIONS": "false", "DISABLE_CRON_JOBS": "false",
        "NOTIFICATION_GATEWAY_DISABLED": "true", "APP_ROLE": "all", "LOG_REQUESTS_ENABLED": "true",
        "DB_HOST": "127.0.0.1", "DB_PORT": str(PORTS["POSTGRES"]), "DB_USERNAME": "boxlite",
        "DB_PASSWORD": POSTGRES_PASSWORD, "DB_DATABASE": "boxlite_e2e",
        "PGHOST": "127.0.0.1", "PGPORT": str(PORTS["POSTGRES"]), "PGUSER": "boxlite",
        "PGPASSWORD": POSTGRES_PASSWORD, "PGDATABASE": "boxlite_e2e",
        "POSTGRES_PASSWORD": POSTGRES_PASSWORD, "MINIO_PASSWORD": MINIO_PASSWORD,
        "REDIS_HOST": "127.0.0.1", "REDIS_PORT": str(PORTS["REDIS"]),
        "REDIS_PASSWORD": "", "REDIS_TLS": "false", "DB_TLS_ENABLED": "false",
        "ADMIN_API_KEY": ADMIN_KEY, "ENCRYPTION_KEY": ENCRYPTION_KEY, "ENCRYPTION_SALT": ENCRYPTION_SALT,
        "OIDC_CLIENT_ID": "boxlite", "OIDC_AUDIENCE": "boxlite",
        "OIDC_ISSUER_BASE_URL": endpoint("DEX"), "OIDC_DOMAIN": endpoint("DEX"),
        "DEFAULT_REGION_ENFORCE_QUOTAS": "false", "DEFAULT_RUNNER_NAME": "boxlite-e2e",
        "DEFAULT_RUNNER_API_KEY": RUNNER_KEY, "DEFAULT_RUNNER_DOMAIN": "127.0.0.1",
        "DEFAULT_RUNNER_API_VERSION": "2", "DEFAULT_RUNNER_API_URL": endpoint("RUNNER"),
        "DEFAULT_RUNNER_PROXY_URL": endpoint("PROXY"),
        "RUNNER_START_SCORE_THRESHOLD": "1", "RUNNER_AVAILABILITY_SCORE_THRESHOLD": "1",
        "RUNNER_DECLARATIVE_BUILD_SCORE_THRESHOLD": "1",
        "BOXLITE_API_URL": api, "BOXLITE_RUNNER_TOKEN": RUNNER_KEY, "API_VERSION": "2",
        "API_PORT": str(PORTS["RUNNER"]), "API_LOG_REQUESTS": "true",
        "RUNNER_DOMAIN": "127.0.0.1", "BOXLITE_HOME_DIR": str(RUNTIME_HOME),
        "PROXY_PORT": str(PORTS["PROXY"]), "PROXY_PROTOCOL": "http",
        "PROXY_DOMAIN": f"localhost:{PORTS['PROXY']}",
        "PROXY_TEMPLATE_URL": f"http://{{{{PORT}}}}-{{{{boxId}}}}.localhost:{PORTS['PROXY']}",
        "PROXY_API_KEY": PROXY_KEY,
        "REGISTRY_PROXY_PORT": str(PORTS["REGISTRY_PROXY"]),
        "REGISTRY_PROXY_HOST": f"127.0.0.1:{PORTS['REGISTRY_PROXY']}",
        "REGISTRY_PROXY_USERNAME": "runner", "REGISTRY_PROXY_PASSWORD": RUNNER_KEY,
        "REGISTRY_SECRET_STORE": "file", "REGISTRY_SECRET_DIR": str(STATE / "registry-secrets"),
        "INTERNAL_REGISTRY_URL": endpoint("REGISTRY"), "TRANSIENT_REGISTRY_URL": endpoint("REGISTRY"),
        "INSECURE_REGISTRIES": f"127.0.0.1:{PORTS['REGISTRY']},127.0.0.1:{PORTS['REGISTRY_PROXY']}",
        "S3_ENDPOINT": endpoint("MINIO"), "S3_STS_ENDPOINT": endpoint("MINIO") + "/minio/v1/assume-role",
        "S3_REGION": "us-east-1", "S3_ACCESS_KEY": "e2eadmin", "S3_SECRET_KEY": MINIO_PASSWORD,
        "S3_DEFAULT_BUCKET": "boxlite", "AWS_ENDPOINT_URL": endpoint("MINIO"),
        "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "e2eadmin",
        "AWS_SECRET_ACCESS_KEY": MINIO_PASSWORD, "AWS_DEFAULT_BUCKET": "boxlite",
        "VOLUME_STORAGE_BACKEND": "s3",
        "BOXLITE_E2E_API_URL": api, "BOXLITE_E2E_ADMIN_KEY": ADMIN_KEY,
        "BOXLITE_E2E_API_KEY": ADMIN_KEY,
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


def state_dirs():
    for directory in (STATE, STATE / "logs", STATE / "client-home",
                      STATE / "registry-secrets", RUNTIME_HOME):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)


def write_files():
    state_dirs()
    dex = (ROOT / "apps/dex/config.yaml").read_text()
    dex = dex.replace("${DEX_ISSUER}", endpoint("DEX")).replace("${REDIRECT_URI}", endpoint("API"))
    dex = dex.replace("    redirectURIs:\n", "    redirectURIs:\n      - '/device/callback'\n")
    (STATE / "dex.yaml").write_text(dex)
    env_file = {
        "COMPOSE_PROJECT_NAME": "boxlite-e2e",
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
    run(["make", "--no-print-directory", target,
         *[f"{key}={value}" for key, value in variables.items()]], env=env)


def build(env):
    make("test:e2e:deps", env)
    make("test:e2e:deps:apps", env)
    make("test:e2e:deps:node", env)
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
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    pids = load_pids()
    pids[name] = {"pid": process.pid, "starttime": process_starttime(process.pid)}
    save_pids(pids)
    wait_http(health, timeout, process)
    return process


def load_pids():
    path = STATE / "pids.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save_pids(pids):
    path = STATE / "pids.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(pids, indent=2))


def process_starttime(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    return raw[raw.rfind(")") + 2:].split()[19]


def process_matches(pid, starttime):
    try:
        return process_starttime(pid) == starttime
    except (FileNotFoundError, ProcessLookupError):
        return False


def stop_host():
    for entry in load_pids().values():
        if not isinstance(entry, dict) or not process_matches(entry.get("pid"), entry.get("starttime")):
            continue
        pid = entry["pid"]
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if not process_matches(pid, entry["starttime"]):
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    save_pids({})


def _argv(pid):
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]


def owned_process(argv, home=RUNTIME_HOME):
    """Return True for a bwrap/shim process belonging to this checkout."""
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
        if os.getpgid(pid) == pid:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)
    except ProcessLookupError:
        pass


def stop_orphaned_boxes(grace=8.0):
    """Kill bwrap/boxlite-shim pairs left behind by an earlier runner.

    The jailer starts every shim with setsid(), so signalling the runner's
    process group never reaches it. Terminate the shim's own pid/group, then
    escalate to SIGKILL and return whatever is still alive.
    """
    pids = box_processes()
    if not pids:
        return []
    print(f"[e2e] stopping {len(pids)} leftover box process(es)", flush=True)
    for pid in pids:
        _signal_owned(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and box_processes():
        time.sleep(0.1)
    for pid in box_processes():
        _signal_owned(pid, signal.SIGKILL)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and box_processes():
        time.sleep(0.05)
    return box_processes()


def box_dirs(home=RUNTIME_HOME):
    """Box directories left in this checkout's runtime home."""
    root = home / "boxes"
    try:
        return sorted(path for path in root.iterdir() if path.is_dir())
    except FileNotFoundError:
        return []


def prune_box_dirs(dirs=None):
    """Remove leftover box directories; returns how many were deleted."""
    removed = 0
    for path in dirs if dirs is not None else box_dirs():
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            continue
        removed += 1
    return removed


def start(env):
    stop_host()
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
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if subprocess.run(argv, env=env, capture_output=True).returncode == 0:
            return
        time.sleep(0.25)
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
    args = list(extra)
    if not any(arg.startswith("cases/") or arg.endswith(".py") or "::" in arg for arg in args):
        args.insert(0, "cases/")
    selector = os.environ.get("FILTER", "")
    if selector:
        args += ["-k", selector]
    args += shlex.split(os.environ.get("E2E_ARGS", ""))
    run([str(PYTHON), "-m", "pytest", *args, "-v", "--tb=short",
         "--timeout=180", "-p", "no:cacheprovider"], cwd=E2E, env=env)


def up(env):
    write_files()
    build(env)
    compose(["up", "-d"], env)
    wait_dependencies(env)
    create_bucket(env)
    start(env)
    fixture(env)


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
    write_files()
    compose(["ps"], env)
    for name, entry in load_pids().items():
        if isinstance(entry, dict) and process_matches(entry.get("pid"), entry.get("starttime")):
            print(f"{name}: running (pid {entry['pid']})")
        else:
            print(f"{name}: stopped")
            raise Failure(f"{name} is not running")
    print(f"box processes: {len(box_processes())} running")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor", "setup", "up", "run", "down", "status"])
    args, extra = parser.parse_known_args(argv)
    if extra[:1] == ["--"]:
        extra.pop(0)
    try:
        env = base_env()
        if args.command == "doctor":
            doctor(env)
        elif args.command == "down":
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
    except (Failure, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"[e2e] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
