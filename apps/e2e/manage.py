#!/usr/bin/env python3
"""One local E2E environment, current-source clients, and recorded test runs."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "apps/e2e"
sys.path.insert(0, str(E2E / "lib"))
sys.path.insert(0, str(E2E))
from minio import image_ref as minio_image_ref

DEPENDENCIES = json.loads((E2E / "dependencies.json").read_text())

PORTS = dict(API=3300, RUNNER=38080, PROXY=34000, REGISTRY_PROXY=34100,
             POSTGRES=35432, REDIS=36379, REGISTRY=35000, DEX=35556, MINIO=39000)
IMAGES = {**DEPENDENCIES["images"], "minio": minio_image_ref()}


def utc():
    return datetime.now(timezone.utc).isoformat()


def save(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    temporary.replace(path)


def load(path: Path):
    return json.loads(path.read_text()) if path.exists() else {}


def digest(path: Path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


class Failure(Exception):
    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


class Environment:
    def __init__(self):
        self.state = Path(os.environ.get("BOXLITE_E2E_STATE_DIR", ROOT / "target/e2e")).resolve()
        self.identity = hashlib.sha256(f"{ROOT}\n{self.state}".encode()).hexdigest()[:8]
        self.prefix = f"boxlite-e2e-{self.identity}"
        self.ports = {key: int(os.environ.get(f"BOXLITE_E2E_{key}_PORT", value)) for key, value in PORTS.items()}
        if any(not 1024 <= p <= 65535 for p in self.ports.values()) or len(set(self.ports.values())) != len(PORTS):
            raise Failure("E2E ports must be distinct integers between 1024 and 65535")
        self.url = f"http://127.0.0.1:{self.ports['API']}/api"
        self.remote = bool(os.environ.get("BOXLITE_E2E_API_URL") and os.environ["BOXLITE_E2E_API_URL"].rstrip("/") != self.url)
        python = Path(os.environ.get("E2E_PYTHON", ROOT / ".venv-e2e/bin/python")).absolute()
        self.python = str(python)
        self.venv = python.parent.parent
        if self.venv.exists() and not (self.venv / "pyvenv.cfg").exists():
            raise Failure(f"E2E_PYTHON must point into a virtual environment: {self.python}")
        self.runtime_home = Path(f"/tmp/ble2e-{os.getuid()}-{self.identity}/r")
        self.run_dir = None
        self.processes = load(self.state / "processes.json")
        self.env = dict(os.environ)
        self.env["BOXLITE_CARGO_LOCKED"] = "1"
        self.env["GOFLAGS"] = self.env.get("GOFLAGS", "") + " -mod=readonly"
        self.stages = threading.Lock()
        self.new_processes = []
        self.new_containers = []
        self.cancelled = threading.Event()
        self.children = set()
        self.children_lock = threading.Lock()
        self.startup_complete = False

    def initialize(self, command):
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.run_dir = self.state / "runs" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-{os.getpid()}")
        self.run_dir.mkdir(parents=True, mode=0o700)
        self.started_ns = time.monotonic_ns()
        self.record = dict(command=command, auth=os.environ.get("BOXLITE_E2E_AUTH", "api-key"),
                           selector=os.environ.get("FILTER", ""), source_sha=self.capture(["git", "rev-parse", "HEAD"]),
                           started_at=utc(), complete=False, host=platform.platform(), cpus=os.cpu_count())
        save(self.run_dir / "run.json", self.record)

    @contextmanager
    def locked(self):
        with (self.state / "lock").open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock.seek(0)
                raise Failure(f"E2E environment busy: {lock.read().strip()}")
            lock.seek(0)
            lock.truncate()
            lock.write(f"pid={os.getpid()} since={utc()}")
            lock.flush()
            yield

    @contextmanager
    def stage(self, name, cache_hit=False):
        started, wall = time.monotonic_ns(), utc()
        print(f"[e2e] {name}{' (cached)' if cache_hit else ''}", flush=True)
        status = "passed"
        try:
            yield
        except BaseException:
            status = "failed"
            raise
        finally:
            item = dict(stage=name, started_at=wall, ended_at=utc(),
                        elapsed_ms=(time.monotonic_ns() - started) / 1e6, status=status, cache_hit=cache_hit)
            with self.stages, (self.run_dir / "timings.jsonl").open("a") as stream:
                stream.write(json.dumps(item) + "\n")

    def capture(self, argv, *, cwd=ROOT, env=None, check=True, timeout=30, input=None):
        result = subprocess.run(list(map(str, argv)), cwd=cwd, env=env or self.env, input=input,
                                text=True, capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise Failure(f"{argv[0]} failed ({result.returncode}): {result.stderr.strip()}", result.returncode)
        return result.stdout.strip() if check else result

    def command(self, argv, *, cwd=ROOT, env=None, timeout=1800, log="commands.log"):
        if self.cancelled.is_set():
            raise Failure("Environment preparation cancelled", 130)
        argv = list(map(str, argv))
        with (self.run_dir / log).open("a") as output:
            output.write(f"\n+ {shlex.join(argv)}\n")
            output.flush()
            proc = subprocess.Popen(argv, cwd=cwd, env=env or self.env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True)
            with self.children_lock:
                self.children.add(proc.pid)
            reader_errors = []
            def copy():
                try:
                    for line in proc.stdout:
                        output.write(line)
                        output.flush()
                        print(line, end="", flush=True)
                except (OSError, UnicodeError) as error:
                    reader_errors.append(error)
                    self.terminate(proc.pid)
            reader = threading.Thread(target=copy, daemon=True)
            reader.start()
            try:
                code = proc.wait(timeout=timeout)
            except (KeyboardInterrupt, subprocess.TimeoutExpired) as error:
                if isinstance(error, KeyboardInterrupt):
                    self.cancelled.set()
                    with self.children_lock:
                        children = list(self.children)
                    for pid in children:
                        try:
                            os.killpg(pid, signal.SIGINT)
                        except ProcessLookupError:
                            pass
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        self.terminate(proc.pid)
                    reader.join(timeout=10)
                    raise
                self.terminate(proc.pid)
                reader.join(timeout=10)
                raise Failure(f"Command exceeded {timeout}s", 124)
            finally:
                with self.children_lock:
                    self.children.discard(proc.pid)
            reader.join(timeout=10)
            if code:
                raise Failure(f"Command failed with exit {code}; see {self.run_dir / log}", code if code > 0 else 128 - code)
            if reader.is_alive():
                self.terminate(proc.pid)
                reader.join(timeout=10)
                raise Failure(f"Command output did not close; see {self.run_dir / log}")
            if reader_errors:
                raise Failure(f"Cannot record command output: {reader_errors[0]}; see {self.run_dir / log}")

    def make(self, target, **variables):
        self.command(["make", "--no-print-directory", target, *[f"{k}={v}" for k, v in variables.items()]])

    def doctor(self, strict=True):
        required = ("make", "node", "corepack", "gcc", "protoc", "cargo", "rustc") if self.remote else ("make", "node", "corepack", "go", "gcc", "protoc", "docker", "psql", "cargo", "rustc")
        missing = [name for name in required if not shutil.which(name)]
        if sys.version_info < (3, 11):
            missing.append("Python 3.11+")
        if not self.remote and not os.access("/dev/kvm", os.R_OK | os.W_OK):
            missing.append("read/write /dev/kvm")
        if missing:
            raise Failure("Missing prerequisites: " + ", ".join(missing) + "; use nix develop -c make test:e2e:setup")
        node_version = tuple(map(int, self.capture(["node", "--version"]).lstrip("v").split(".")[:2]))
        if node_version < (22, 12):
            raise Failure("E2E apps dependencies require Node 22.12+; SDK Node support is unchanged")
        if not self.remote:
            self.capture(["docker", "ps", "--format", "{{.Names}}"])
            self.check_ports()
            fuse = Path("/etc/fuse.conf")
            configured = fuse.exists() and any(line.strip() == "user_allow_other" for line in fuse.read_text().splitlines())
            if not configured or not shutil.which("mount-s3") or not os.access("/dev/fuse", os.R_OK | os.W_OK):
                message = "Volumes require mount-s3, read/write /dev/fuse and user_allow_other in /etc/fuse.conf"
                if strict:
                    raise Failure(message)
                print(f"[e2e] VOLUME PREREQUISITE: {message}", flush=True)
        print(f"[e2e] prerequisites available; API {self.url if not self.remote else self.env['BOXLITE_E2E_API_URL']}")

    def process_matches(self, name):
        entry = self.processes.get(name)
        if not entry:
            return False
        try:
            raw = Path(f"/proc/{entry['pid']}/stat").read_text()
            fields = raw[raw.rfind(")") + 2:].split()
            return fields[0] != "Z" and fields[19] == entry["starttime"]
        except (FileNotFoundError, ProcessLookupError):
            return False

    def check_ports(self):
        native = {"API": "api", "RUNNER": "runner", "PROXY": "proxy", "REGISTRY_PROXY": "registry-proxy"}
        native_keys = {"API": "PORT", "RUNNER": "API_PORT", "PROXY": "PROXY_PORT", "REGISTRY_PROXY": "REGISTRY_PROXY_PORT"}
        dependency_names = {"POSTGRES", "REDIS", "REGISTRY", "DEX", "MINIO"}
        previous = load(self.state / "env.json")
        for name, port in self.ports.items():
            if name in native and str(port) == previous.get(native_keys[name]) and self.process_matches(native[name]):
                continue
            if name in dependency_names:
                container = self.container(name.lower(), check=False)
                if container and container.get("State", {}).get("Running"):
                    self.assert_owner(container)
                    bindings = container.get("HostConfig", {}).get("PortBindings", {})
                    if any(row.get("HostIp") == "127.0.0.1" and row.get("HostPort") == str(port) for rows in bindings.values() for row in rows):
                        continue
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    raise Failure(f"Port conflict: {name} 127.0.0.1:{port}; leave the listener running and configure BOXLITE_E2E_{name}_PORT")

    def configure(self):
        if self.remote:
            return
        secret_file = self.state / "secrets.json"
        keys = load(secret_file)
        if not keys:
            keys = {key: secrets.token_hex(32) for key in ("admin", "runner", "proxy", "encryption", "salt", "postgres", "minio")}
        if not keys.get("generation"):
            keys["generation"] = secrets.token_hex(16)
        save(secret_file, keys)
        p = self.ports
        endpoint = lambda name: f"http://127.0.0.1:{p[name]}"
        config = dict(NODE_ENV="development", ENVIRONMENT="development", PORT=str(p["API"]), VERSION="0.0.0-e2e",
                      RUN_MIGRATIONS="true", SKIP_CONNECTIONS="false", DISABLE_CRON_JOBS="false",
                      NOTIFICATION_GATEWAY_DISABLED="true", APP_ROLE="all", LOG_REQUESTS_ENABLED="true",
                      DB_HOST="127.0.0.1", DB_PORT=str(p["POSTGRES"]), DB_USERNAME="boxlite", DB_PASSWORD=keys["postgres"], DB_DATABASE="boxlite_e2e",
                      PGHOST="127.0.0.1", PGPORT=str(p["POSTGRES"]), PGUSER="boxlite", PGPASSWORD=keys["postgres"], PGDATABASE="boxlite_e2e",
                      REDIS_HOST="127.0.0.1", REDIS_PORT=str(p["REDIS"]), REDIS_PASSWORD="", REDIS_TLS="false", DB_TLS_ENABLED="false",
                      ADMIN_API_KEY=keys["admin"], ENCRYPTION_KEY=keys["encryption"], ENCRYPTION_SALT=keys["salt"],
                      OIDC_CLIENT_ID="boxlite", OIDC_AUDIENCE="boxlite", OIDC_ISSUER_BASE_URL=endpoint("DEX"), OIDC_DOMAIN=endpoint("DEX"),
                      DEFAULT_REGION_ENFORCE_QUOTAS="false", DEFAULT_RUNNER_NAME=self.prefix,
                      DEFAULT_RUNNER_API_KEY=keys["runner"], DEFAULT_RUNNER_DOMAIN="127.0.0.1", DEFAULT_RUNNER_API_VERSION="2",
                      DEFAULT_RUNNER_API_URL=endpoint("RUNNER"), DEFAULT_RUNNER_PROXY_URL=endpoint("PROXY"),
                      RUNNER_START_SCORE_THRESHOLD="1", RUNNER_AVAILABILITY_SCORE_THRESHOLD="1", RUNNER_DECLARATIVE_BUILD_SCORE_THRESHOLD="1",
                      BOXLITE_API_URL=self.url, BOXLITE_RUNNER_TOKEN=keys["runner"], API_VERSION="2", API_PORT=str(p["RUNNER"]), API_LOG_REQUESTS="true",
                      RUNNER_DOMAIN="127.0.0.1", BOXLITE_HOME_DIR=str(self.runtime_home),
                      PROXY_PORT=str(p["PROXY"]), PROXY_PROTOCOL="http", PROXY_DOMAIN=f"localhost:{p['PROXY']}",
                      PROXY_TEMPLATE_URL=f"http://{{{{PORT}}}}-{{{{boxId}}}}.localhost:{p['PROXY']}", PROXY_API_KEY=keys["proxy"],
                      REGISTRY_PROXY_PORT=str(p["REGISTRY_PROXY"]), REGISTRY_PROXY_HOST=f"127.0.0.1:{p['REGISTRY_PROXY']}",
                      REGISTRY_PROXY_USERNAME="runner", REGISTRY_PROXY_PASSWORD=keys["runner"],
                      REGISTRY_SECRET_STORE="file", REGISTRY_SECRET_DIR=str(self.state / "registry-secrets"),
                      INTERNAL_REGISTRY_URL=endpoint("REGISTRY"), TRANSIENT_REGISTRY_URL=endpoint("REGISTRY"),
                      INSECURE_REGISTRIES=f"127.0.0.1:{p['REGISTRY']},127.0.0.1:{p['REGISTRY_PROXY']}",
                      S3_ENDPOINT=endpoint("MINIO"), S3_STS_ENDPOINT=endpoint("MINIO") + "/minio/v1/assume-role",
                      S3_REGION="us-east-1", S3_ACCESS_KEY="e2eadmin", S3_SECRET_KEY=keys["minio"], S3_DEFAULT_BUCKET="boxlite",
                      AWS_ENDPOINT_URL=endpoint("MINIO"), AWS_REGION="us-east-1", AWS_ACCESS_KEY_ID="e2eadmin", AWS_SECRET_ACCESS_KEY=keys["minio"], AWS_DEFAULT_BUCKET="boxlite",
                      VOLUME_STORAGE_BACKEND="s3", BOXLITE_E2E_API_URL=self.url, BOXLITE_E2E_ADMIN_KEY=keys["admin"],
                      BOXLITE_E2E_API_KEY=keys["admin"], BOXLITE_HOME=str(self.state / "client-home"),
                      BOXLITE_E2E_API_LOG=str(self.state / "logs/api.log"), BOXLITE_E2E_RUNNER_LOG=str(self.state / "logs/runner.log"),
                      DASHBOARD_URL=endpoint("API"), DASHBOARD_BASE_API_URL=self.url, APP_URL=endpoint("API"),
                      OTEL_ENABLED="false", OTEL_TRACING_ENABLED="false", OTEL_LOGGING_ENABLED="false", USAGE_EXPORT_ENABLED="false",
                      USAGE_ALLOCATION_SNAPSHOT_ENABLED="false", BILLING_API_URL="", ANALYTICS_API_URL="", SMTP_HOST="", SMTP_USER="", SMTP_PASSWORD="",
                      SVIX_AUTH_TOKEN="", KAFKA_ENABLED="false", INCIDENT_IO_ENABLED="false", CERT_PATH="", CERT_KEY_PATH="", ENABLE_TLS="false")
        self.env.update(config)
        self.env.pop("BOXLITE_E2E_SKIP_PATH_VERIFY", None)
        self.env.pop("BOXLITE_API_KEY", None)
        self.env["BOXLITE_REST_URL"] = self.url
        self.env.pop("BOXLITE_REST_PATH_PREFIX", None)
        self.env.pop("BOXLITE_DEPS_STUB", None)
        guest = DEPENDENCIES["guest"]
        if not os.environ.get("BOXLITE_E2E_IMAGE") and (ROOT / "apps/box-images/VERSION").read_text().strip().lstrip("v") != guest["version"]:
            raise Failure("Curated guest VERSION changed; update apps/e2e/dependencies.json before E2E setup")
        guest_ref = os.environ.get("BOXLITE_E2E_IMAGE") or guest["image"]
        self.env["BOXLITE_E2E_IMAGE"] = guest_ref
        self.env["BOXLITE_SYSTEM_BASE_IMAGE"] = guest_ref
        for directory in (self.runtime_home, self.state / "registry-secrets", self.state / "logs", self.state / "client-home"):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        save(self.state / "env.json", config)
        dex = (ROOT / "apps/dex/config.yaml").read_text().replace("${DEX_ISSUER}", endpoint("DEX")).replace("${REDIRECT_URI}", endpoint("API"))
        dex = dex.replace("    redirectURIs:\n", "    redirectURIs:\n      - '/device/callback'\n")
        (self.state / "dex.yaml").write_text(dex)

    def clients(self):
        self.env.update(BOXLITE_E2E_CLI=str(ROOT / "target/debug/boxlite"), BOXLITE_CLI=str(ROOT / "target/debug/boxlite"),
                        BOXLITE_E2E_NATIVE_LIB_DIR=str(ROOT / "target/debug"), BOXLITE_E2E_TSX=str(ROOT / "apps/node_modules/.bin/tsx"),
                        PATH=f"{self.venv / 'bin'}:{ROOT / 'target/debug'}:{self.env.get('PATH', '')}")
        self.env["PYTHONPATH"] = str(E2E / "lib") + os.pathsep + self.env.get("PYTHONPATH", "")
        self.env["BOXLITE_E2E_RUN_DIR"] = str(self.run_dir)

    def fingerprint(self, prefixes):
        files = self.capture(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")
        result = hashlib.sha256()
        for name in sorted(files):
            if not name or not any(name == prefix or name.startswith(prefix + "/") for prefix in prefixes):
                continue
            path = ROOT / name
            if path.is_file():
                result.update(name.encode())
                result.update(path.read_bytes())
        result.update(self.capture(["rustc", "--version"]).encode())
        return result.hexdigest()

    BUILD_ENV = ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET",
                 "CARGO_INCREMENTAL", "RUSTC_WRAPPER", "RUSTUP_TOOLCHAIN", "CC", "CXX",
                 "CFLAGS", "CXXFLAGS", "LDFLAGS", "GOFLAGS", "GOOS", "GOARCH", "CGO_ENABLED",
                 "BOXLITE_CARGO_LOCKED")

    def recipe_identity(self):
        """Hash the build recipes, flags and toolchains, not only their inputs."""
        result = hashlib.sha256(self.fingerprint(["make", "scripts/build"]).encode())
        for key in self.BUILD_ENV:
            result.update(f"{key}={self.env.get(key, '')}\0".encode())
        for argv in (["rustc", "-vV"], ["cargo", "-V"], ["gcc", "--version"], ["cc", "--version"],
                     ["go", "version"], ["node", "--version"], ["npm", "--version"],
                     ["corepack", "--version"], ["protoc", "--version"]):
            if not shutil.which(argv[0]):
                continue
            result.update(self.capture(argv).encode())
            result.update(b"\0")
        return result.hexdigest()

    def record_inputs(self):
        self.record["inputs"] = dict(
            source=self.fingerprint(["apps/e2e", "apps/api", "apps/libs", "make", "scripts/test/rest", "flake.nix", "flake.lock"]),
            recipe=self.recipe_identity(),
            builds=load(self.state / "build.json"),
            images={name: load(self.state / f"image-{name}.json") for name in IMAGES} if not self.remote else {},
            versions={name: self.capture(argv) for name, argv in {
                "python": [self.python, "--version"], "rust": ["rustc", "--version"],
                "node": ["node", "--version"], "go": ["go", "version"],
            }.items() if shutil.which(argv[0])},
        )
        save(self.run_dir / "run.json", self.record)


    def prepare_dependencies(self):
        previous = load(self.state / "dependencies.json")
        updated = dict(previous)
        python_env = dict(self.env, UV_PROJECT_ENVIRONMENT=str(self.venv))
        python_inputs = ["apps/e2e/pyproject.toml", "apps/e2e/uv.lock", "apps/e2e/dependencies.json"]
        python_id = self.fingerprint(python_inputs)
        if Path(self.python).exists():
            python_id += self.capture([self.python, "-c", "import sys,sysconfig; print(sys.version, sysconfig.get_config_var('SOABI'))"])
            check = self.capture([self.python, "-m", "uv", "sync", "--project", str(E2E), "--locked", "--inexact",
                                  "--no-install-project", "--check", "--python", self.python, "--no-python-downloads"],
                                 env=python_env, check=False)
            probe = self.capture([self.python, "-c", "import boxlite, greenlet"], check=False)
            python_ready = check.returncode == 0 and probe.returncode == 0
        else:
            python_ready = False
        with self.stage("deps-python", python_ready and previous.get("python") == python_id):
            if not python_ready or previous.get("python") != python_id:
                self.make("test:e2e:deps")
                python_id = self.fingerprint(python_inputs) + self.capture([self.python, "-c", "import sys,sysconfig; print(sys.version, sysconfig.get_config_var('SOABI'))"])
            updated["python"] = python_id
        node_version = self.capture(["node", "--version"]) + self.capture(["npm", "--version"])
        app_manifests = [name for name in self.capture(["git", "ls-files", "apps"]).splitlines() if name.endswith("package.json")]
        groups = {
            "apps": (app_manifests + ["apps/yarn.lock", "apps/.yarnrc.yml"], ROOT / "apps/node_modules/.bin/ts-node"),
            "node": (["sdks/node/package.json", "sdks/node/package-lock.json"], ROOT / "sdks/node/node_modules/.bin/napi"),
        }
        for name, (inputs, sentinel) in groups.items():
            identity = self.fingerprint(inputs) + node_version
            cached = previous.get(name) == identity and sentinel.exists()
            with self.stage(f"deps-{name}", cached):
                if not cached:
                    self.make(f"test:e2e:deps:{name}")
                updated[name] = identity
        save(self.state / "dependencies.json", updated)
        return updated

    def prepare(self):
        dependencies = self.prepare_dependencies()
        old = load(self.state / "build.json")
        groups = {
            "runtime": (["src/boxlite", "src/shim", "src/guest", "src/shared", "src/deps", "scripts/build", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"], list((ROOT / "target/debug/runtime").glob("*"))),
            "sdk-python": (["sdks/python/src", "sdks/python/boxlite", "sdks/python/Cargo.toml", "sdks/python/pyproject.toml", "sdks/python/build.rs"], list((ROOT / "sdks/python/boxlite").glob("*.so"))),
            "sdk-node": (["sdks/node/src", "sdks/node/lib", "sdks/node/Cargo.toml", "sdks/node/package.json", "sdks/node/package-lock.json", "sdks/node/tsconfig.json", "sdks/node/build.rs"], list((ROOT / "sdks/node/native").glob("*.node")) + [ROOT / "sdks/node/native/boxlite.js", ROOT / "sdks/node/dist/index.js"]),
            "sdk-c-go": (["sdks/c", "sdks/go"], [ROOT / "target/debug/libboxlite.a", ROOT / "target/debug/libboxlite.so"]),
            "cli": (["src/cli"], [ROOT / "target/debug/boxlite"]),
            "runner": (["apps/runner", "sdks/go", "apps/libs/common-go", "apps/libs/api-client-go", "apps/go.work", "apps/go.work.sum"], [self.state / "bin/runner"]),
            "proxies": (["apps/proxy", "apps/image-service", "apps/libs/common-go", "apps/libs/api-client-go"], [self.state / "bin/proxy", self.state / "bin/registry-proxy"]),
        }
        if self.remote:
            groups = {name: group for name, group in groups.items()
                      if name in ("sdk-python", "sdk-node", "sdk-c-go", "cli")}
        runtime_prefixes = ["src/boxlite", "src/shared", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]
        runtime_input = self.fingerprint(runtime_prefixes)
        if not self.remote:
            submodules = self.capture(["git", "submodule", "status", "--recursive"])
            submodule_diff = self.capture(["git", "submodule", "foreach", "--quiet", "--recursive", "git diff HEAD --; git ls-files --others --exclude-standard"], timeout=60)
            runtime_input += hashlib.sha256((submodules + submodule_diff).encode()).hexdigest()
        updated = dict(old)
        archive_before = old.get("archive")
        recipe = self.recipe_identity()
        changed = False
        for name, (prefixes, artifacts) in groups.items():
            source = self.fingerprint(prefixes) + recipe
            if name != "proxies":
                source += runtime_input
            if name == "sdk-python":
                source += dependencies["python"]
            elif name == "sdk-node":
                source += dependencies["node"]
            if name == "runner":
                source += digest(ROOT / "target/debug/libboxlite.a") if (ROOT / "target/debug/libboxlite.a").exists() else "missing"
                source += self.capture(["go", "version"])
            if name == "sdk-python" and not artifacts:
                artifacts = [ROOT / "sdks/python/boxlite/missing.so"]
            if name == "sdk-node" and not artifacts:
                artifacts = [ROOT / "sdks/node/native/missing.node"]
            if name == "runtime" and not artifacts:
                artifacts = [ROOT / "target/debug/runtime/boxlite-shim"]
            identities = {str(p): digest(p) for p in artifacts if p.is_file()}
            cached = bool(artifacts) and len(identities) == len(artifacts) and old.get(name) == dict(source=source, artifacts=identities)
            with self.stage(name, cached):
                if cached:
                    continue
                changed = True
                if name == "runtime":
                    self.make("runtime:debug")
                    artifacts = list((ROOT / "target/debug/runtime").glob("*"))
                elif name == "sdk-python":
                    self.make("test:e2e:build:python", SETUP_DONE=1)
                    artifacts = list((ROOT / "sdks/python/boxlite").glob("*.so"))
                elif name == "sdk-node":
                    self.make("test:e2e:build:node", SETUP_DONE=1)
                    artifacts = list((ROOT / "sdks/node/native").glob("*.node")) + [ROOT / "sdks/node/native/boxlite.js", ROOT / "sdks/node/dist/index.js"]
                elif name == "sdk-c-go":
                    self.make("dev:go", SETUP_DONE=1)
                elif name == "cli":
                    self.make("cli", SETUP_DONE=1)
                else:
                    force = "-a" if name == "runner" and archive_before != digest(ROOT / "target/debug/libboxlite.a") else ""
                    self.make(f"test:e2e:build:{name}", E2E_STATE_DIR=self.state, E2E_GO_REBUILD=force)
                if not artifacts or any(not p.is_file() for p in artifacts):
                    raise Failure(f"{name} build did not produce {artifacts}")
                updated[name] = dict(source=source, artifacts={str(p): digest(p) for p in artifacts})
                save(self.state / "build.json", updated)
        archive = ROOT / "target/debug/libboxlite.a"
        updated["archive"] = digest(archive) if archive.exists() else "missing"
        self.env["BOXLITE_E2E_FORCE_GO_REBUILD"] = "1" if archive_before != updated["archive"] else "0"
        save(self.state / "build.json", updated)
        return changed

    def container(self, name, check=True):
        result = self.capture(["docker", "container", "inspect", f"{self.prefix}-{name}"], check=False)
        if result.returncode:
            if check:
                raise Failure(f"Container {name} absent: {result.stderr}")
            return None
        return json.loads(result.stdout)[0]

    def assert_owner(self, info):
        labels = info.get("Config", {}).get("Labels") or {}
        if labels.get("boxlite.e2e.state") != str(self.state):
            raise Failure(f"Container ownership conflict: {info.get('Name')}")

    DEPENDENCY_PORTS = {"postgres": ("POSTGRES", 5432), "redis": ("REDIS", 6379),
                        "registry": ("REGISTRY", 5000), "dex": ("DEX", 5556), "minio": ("MINIO", 9000)}

    def credential_identity(self, name):
        """Identify the credential generation a dependency was created with."""
        if name in ("postgres", "minio"):
            return str(load(self.state / "secrets.json").get("generation", "missing"))
        if name == "dex":
            config = self.state / "dex.yaml"
            return digest(config) if config.exists() else "missing"
        return "static"

    def dependency(self, name):
        if self.cancelled.is_set():
            return
        mappings = self.DEPENDENCY_PORTS
        key, inner = mappings[name]
        info = self.container(name, check=False)
        if info:
            self.assert_owner(info)
            labels = info.get("Config", {}).get("Labels", {})
            binding = info.get("HostConfig", {}).get("PortBindings", {}).get(f"{inner}/tcp", [])
            matches = labels.get("boxlite.e2e.image") == IMAGES[name] and any(row.get("HostIp") == "127.0.0.1" and row.get("HostPort") == str(self.ports[key]) for row in binding)
            credentials = labels.get("boxlite.e2e.credentials") == self.credential_identity(name)
            if not matches or not credentials:
                self.capture(["docker", "rm", "-f", f"{self.prefix}-{name}"])
                if not credentials and name == "postgres":
                    # POSTGRES_PASSWORD is consumed only by initdb, so the old
                    # volume keeps the old password no matter the new env file.
                    self.capture(["docker", "volume", "rm", "-f", f"{self.prefix}-postgres"], check=False)
            else:
                if not info["State"]["Running"]:
                    self.capture(["docker", "start", f"{self.prefix}-{name}"])
                    self.new_containers.append(name)
                return
        image_file = self.state / f"image-{name}.json"
        image = IMAGES[name]
        inspected = self.capture(["docker", "image", "inspect", image], check=False)
        if inspected.returncode:
            if name == "minio":
                self.make("test:e2e:build:minio", E2E_STATE_DIR=self.state)
            else:
                self.command(["docker", "pull", image], timeout=300, log=f"dependency-{name}.log")
            inspected = self.capture(["docker", "image", "inspect", image], check=False)
        if inspected.returncode:
            raise Failure(f"Cannot inspect {image}: {inspected.stderr}")
        metadata = json.loads(inspected.stdout)[0]
        save(image_file, dict(reference=image, digest=metadata["Id"]))
        if self.cancelled.is_set():
            return
        args = ["docker", "run", "-d", "--name", f"{self.prefix}-{name}", "--label", f"boxlite.e2e.state={self.state}",
                "--label", f"boxlite.e2e.image={image}",
                "--label", f"boxlite.e2e.credentials={self.credential_identity(name)}",
                "-p", f"127.0.0.1:{self.ports[key]}:{inner}"]
        env = {}
        commands = []
        if name == "postgres":
            env = dict(POSTGRES_USER="boxlite", POSTGRES_PASSWORD=self.env["PGPASSWORD"], POSTGRES_DB="boxlite_e2e")
            args += ["-v", f"{self.prefix}-postgres:/var/lib/postgresql/data"]
        elif name == "minio":
            env = dict(MINIO_ROOT_USER="e2eadmin", MINIO_ROOT_PASSWORD=self.env["S3_SECRET_KEY"])
            args += ["-v", f"{self.prefix}-minio:/data"]
            commands = ["server", "/data"]
        elif name == "registry":
            args += ["-v", f"{self.prefix}-registry:/var/lib/registry"]
        elif name == "dex":
            args += ["-v", f"{self.state / 'dex.yaml'}:/etc/dex/config.yaml:ro", "-v", f"{self.prefix}-dex:/var/dex"]
            commands = ["dex", "serve", "/etc/dex/config.yaml"]
        if env:
            env_file = self.state / f"{name}.env"
            fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write("".join(f"{k}={v}\n" for k, v in env.items()))
            args += ["--env-file", str(env_file)]
        self.capture([*args, image, *commands], timeout=60)
        self.new_containers.append(name)

    def request(self, path, *, base=None, token=None):
        req = urllib.request.Request((base or self.url) + path, headers={"Authorization": f"Bearer {token or self.env.get('ADMIN_API_KEY', '')}"})
        with urllib.request.urlopen(req, timeout=3) as response:
            return json.loads(response.read() or "null")

    def wait(self, description, probe, timeout):
        deadline, last = time.monotonic() + timeout, ""
        while time.monotonic() < deadline:
            try:
                if probe():
                    return
            except (OSError, ValueError) as error:
                last = str(error)
            time.sleep(0.25)
        raise Failure(f"{description} not ready after {timeout}s: {last}")

    def dependencies(self):
        with self.stage("dependencies"):
            with ThreadPoolExecutor(max_workers=5) as workers:
                list(workers.map(self.dependency, IMAGES))
            for name, argv in {"postgres": ["psql", "-U", "boxlite", "-d", "boxlite_e2e", "-tAc", "SELECT 1"], "redis": ["redis-cli", "PING"]}.items():
                self.wait(name, lambda n=name, a=argv: self.capture(["docker", "exec", f"{self.prefix}-{n}", *a], check=False).returncode == 0, 60)
            for key, path in (("DEX", "/.well-known/openid-configuration"), ("REGISTRY", "/v2/"), ("MINIO", "/minio/health/live")):
                self.wait(key, lambda k=key, p=path: self.http_ok(f"http://127.0.0.1:{self.ports[k]}{p}"), 60)

    @staticmethod
    def http_ok(url):
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200

    @staticmethod
    def terminate(pid):
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def stop_process(self, name):
        if self.process_matches(name):
            self.terminate(self.processes[name]["pid"])
        self.processes.pop(name, None)
        save(self.state / "processes.json", self.processes)

    def start_process(self, name, argv, cwd, health, timeout):
        service_env = load(self.state / "env.json")
        source_id = self.fingerprint(["apps/api/src", "apps/api/tsconfig.app.json", "apps/libs"]) if name == "api" else digest(Path(argv[0]))
        if name == "api":
            source_id += load(self.state / "dependencies.json").get("apps", "")
        if name == "runner":
            source_id += json.dumps(load(self.state / "build.json").get("runtime", {}).get("artifacts", {}), sort_keys=True)
        config_id = hashlib.sha256(json.dumps([argv, service_env, source_id], sort_keys=True).encode()).hexdigest()
        entry = self.processes.get(name, {})
        if self.process_matches(name) and entry.get("config") == config_id:
            try:
                if self.http_ok(health):
                    return False
            except OSError:
                pass
        self.stop_process(name)
        with (self.state / f"logs/{name}.log").open("a") as output:
            proc = subprocess.Popen(argv, cwd=cwd, env=self.env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        raw = Path(f"/proc/{proc.pid}/stat").read_text()
        self.processes[name] = dict(pid=proc.pid, starttime=raw[raw.rfind(")") + 2:].split()[19], argv=argv, config=config_id)
        save(self.state / "processes.json", self.processes)
        self.new_processes.append(name)
        def ready():
            code = proc.poll()
            if code is not None:
                raise Failure(f"{name} exited with code {code}; see {self.state / 'logs' / (name + '.log')}", code if code > 0 else 128 - code)
            return self.http_ok(health)
        self.wait(name, ready, timeout)
        return True

    def up(self, smoke=True):
        with self.stage("doctor"):
            self.doctor(strict=False)
        self.configure()
        self.clients()
        if self.remote:
            self.prepare()
            self.record_inputs()
            return
        worker = ThreadPoolExecutor(max_workers=1)
        dependencies = worker.submit(self.dependencies)
        try:
            changed = self.prepare()
            dependencies.result()
        except BaseException:
            self.cancelled.set()
            with self.children_lock:
                children = list(self.children)
            for pid in children:
                self.terminate(pid)
            raise
        finally:
            worker.shutdown(wait=True, cancel_futures=True)
        self.record_inputs()
        p = self.ports
        with self.stage("storage"):
            script = "const {S3Client,CreateBucketCommand}=require('@aws-sdk/client-s3'); const c=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.S3_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY,secretAccessKey:process.env.S3_SECRET_KEY}}); c.send(new CreateBucketCommand({Bucket:'boxlite'})).catch(e=>{if(!['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes(e.name)){console.error(e.name,e.message);process.exitCode=1}})"
            self.command(["node", "-e", script], cwd=ROOT / "apps", timeout=30)
        with self.stage("services"):
            started = self.start_process("api", [str(ROOT / "apps/node_modules/.bin/ts-node"), "--transpile-only", "--project", "api/tsconfig.app.json", "-r", "tsconfig-paths/register", "api/src/main.ts"], ROOT / "apps", self.url + "/health", 180)
            for name, key, health in (("registry-proxy", "REGISTRY_PROXY", "/health"), ("runner", "RUNNER", "/"), ("proxy", "PROXY", "/health")):
                started |= self.start_process(name, [str(self.state / "bin" / name)], self.state, f"http://127.0.0.1:{p[key]}{health}", 90)
            self.wait("Runner registration", lambda: any(row.get("name") == self.prefix and row.get("state") == "ready" for row in self.request("/admin/runners")), 90)
        readiness = hashlib.sha256(json.dumps([
            load(self.state / "build.json"),
            {name: entry["config"] for name, entry in self.processes.items()},
            self.fingerprint(["apps/e2e/fixture_setup.py", "apps/e2e/cases/test_path_verification.py", "apps/e2e/lib/path_verification.py"]),
        ], sort_keys=True).encode()).hexdigest()
        ready_file = self.state / "ready.json"
        previous = load(ready_file)
        verified = previous.get("identity") == readiness
        verified_smoke = verified and bool(previous.get("smoke"))
        fixtures_needed = (started or changed or not verified
                           or not (self.state / "client-home/credentials.toml").exists())
        with self.stage("fixtures", not fixtures_needed):
            if fixtures_needed:
                ready_file.unlink(missing_ok=True)
                self.command([self.python, E2E / "fixture_setup.py"], env=self.env, timeout=60)
                save(ready_file, dict(identity=readiness, smoke=False, verified_at=utc()))
        if smoke and (fixtures_needed or not verified_smoke):
            self.pytest(["cases/test_path_verification.py"], smoke=True)
            save(ready_file, dict(identity=readiness, smoke=True, verified_at=utc()))
        print(f"[e2e] ready: {self.url}\n[e2e] logs: {self.state / 'logs'}\n[e2e] run: make test:e2e FILTER=exec_working_dir", flush=True)

    def pytest(self, extra, smoke=False):
        selection = list(extra)
        selector = os.environ.get("FILTER", "") if not smoke else ""
        if not any(arg.startswith("cases/") or arg.endswith(".py") or "::" in arg for arg in selection):
            selection.insert(0, "cases/")
        if selector:
            selection += ["-k", selector]
        self.clients()
        result_dir = self.run_dir / "smoke" if smoke else self.run_dir
        result_dir.mkdir(exist_ok=True)
        self.env["BOXLITE_E2E_RUN_DIR"] = str(result_dir)
        junit = result_dir / "junit.xml"
        args = [self.python, "-m", "pytest", *selection, "-v", "-ra", "--tb=short", "--durations=0", f"--junit-xml={junit}",
                "--timeout=180", "--timeout-method=signal", "-p", "no:cacheprovider"]
        if (E2E / "lib/reporting.py").exists():
            args += ["-p", "reporting"]
        with self.stage("smoke" if smoke else "tests"):
            self.command(args, cwd=E2E, timeout=2700, log="smoke.log" if smoke else "pytest.log")
        self.env["BOXLITE_E2E_RUN_DIR"] = str(self.run_dir)

    def status(self):
        failed = []
        names = {"api": ("API", "/api/health"), "registry-proxy": ("REGISTRY_PROXY", "/health"),
                 "runner": ("RUNNER", "/"), "proxy": ("PROXY", "/health")}
        for name, (key, path) in names.items():
            try:
                alive = self.process_matches(name) and self.http_ok(f"http://127.0.0.1:{self.ports[key]}{path}")
            except OSError:
                alive = False
            print(f"{name}: {'healthy' if alive else 'unavailable'}")
            if not alive:
                failed.append(name)
        for name in IMAGES:
            info = self.container(name, check=False)
            if info:
                self.assert_owner(info)
            alive = bool(info and info.get("State", {}).get("Running"))
            print(f"{name}: {'running' if alive else 'stopped'}")
            if not alive:
                failed.append(name)
        if failed:
            raise Failure("Unavailable: " + ", ".join(failed), 1)

    def down(self, partial=False):
        errors = []
        for name in reversed(self.new_processes if partial else ["api", "registry-proxy", "runner", "proxy"]):
            try:
                self.stop_process(name)
            except (Failure, OSError, ValueError, subprocess.TimeoutExpired) as error:
                errors.append(f"{name}: {error}")
        for name in reversed(self.new_containers if partial else list(IMAGES)):
            try:
                info = self.container(name, check=False)
                if info:
                    self.assert_owner(info)
                    self.capture(["docker", "stop", "-t", "10", f"{self.prefix}-{name}"])
            except (Failure, OSError, ValueError, subprocess.TimeoutExpired) as error:
                errors.append(f"{name}: {error}")
        if errors:
            self.record["cleanup_errors"] = errors
            if not partial:
                raise Failure("Cleanup failed: " + "; ".join(errors))
            print("[e2e] cleanup failed: " + "; ".join(errors), file=sys.stderr)

    def finish(self, code, complete):
        self.record.update(ended_at=utc(), exit_code=code, complete=complete,
                           elapsed_ms=(time.monotonic_ns() - self.started_ns) / 1e6)
        save(self.run_dir / "run.json", self.record)
        (self.run_dir / "timings.jsonl").touch(exist_ok=True)
        print(f"[e2e] exit={code}; evidence: {self.run_dir}", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["doctor", "setup", "up", "run", "down", "status", "report", "exec"])
    args, extra = parser.parse_known_args(argv)
    if extra[:1] == ["--"]:
        extra.pop(0)
    try:
        env = Environment()
    except (Failure, ValueError) as error:
        print(f"[e2e] {error}", file=sys.stderr)
        return 2
    if args.command == "report":
        return subprocess.call([sys.executable, str(ROOT / "scripts/test/rest/report.py"), "--state-dir", str(env.state), *extra])
    env.initialize(args.command)
    def stop_requested(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_requested)
    code, complete = 0, False
    try:
        with env.locked():
            try:
                if args.command == "doctor":
                    env.doctor()
                elif args.command == "status":
                    env.status()
                elif args.command == "down":
                    env.down()
                else:
                    env.up(smoke=args.command != "up")
                    env.startup_complete = True
                    if args.command == "run":
                        env.pytest([*shlex.split(os.environ.get("E2E_ARGS", "")), *extra])
                    elif args.command == "exec":
                        if not extra:
                            raise Failure("exec requires -- <program> [arguments]")
                        if env.env.get("BOXLITE_E2E_AUTH", "api-key") == "api-key":
                            env.env["BOXLITE_API_KEY"] = env.env.get("BOXLITE_E2E_API_KEY", "")
                        env.env["BOXLITE_PROFILE"] = env.env.get("BOXLITE_E2E_PROFILE", "p1")
                        env.command(extra, env=env.env, timeout=2700)
                complete = True
            finally:
                if not env.startup_complete and args.command in ("up", "setup", "run", "exec"):
                    env.down(partial=True)
    except KeyboardInterrupt:
        code = 130
        print("[e2e] interrupted", file=sys.stderr)
    except (Failure, OSError, ValueError, subprocess.TimeoutExpired) as error:
        code = error.code if isinstance(error, Failure) else 2
        complete = args.command == "run" and code in (1, 5) and (env.run_dir / "junit.xml").exists()
        print(f"[e2e] {error}", file=sys.stderr)
    finally:
        env.finish(code, complete)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
