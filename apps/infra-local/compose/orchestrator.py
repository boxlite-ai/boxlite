"""Top-level orchestration: topo_sort + up/down/ps + healthcheck loop.

Plain async functions with one shared runtime per call. Reuse healthy boxes;
recreate failed or unhealthy boxes without deleting their host data.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
import urllib.error
import urllib.request
from graphlib import TopologicalSorter
from pathlib import Path

from ._sdk import import_sdk
from .config import InfraConfig
from .doctor import doctor
from .services import HealthCheck, ServiceSpec


async def exec_collect(
    box,
    command: str,
    args: list[str] | None = None,
    env: list[tuple[str, str]] | None = None,
) -> tuple[int, str, str]:
    """Run `command args` inside `box`, drain stdout+stderr, return (rc, out, err).

    The SDK exposes `Execution.stdout()`/`stderr()` as async iterators; drain
    both concurrently (avoids pipe-buffer deadlock), then `wait()` for the code.
    """
    execution = await box.exec(command, args or [], env=env)
    out_parts: list[str] = []
    err_parts: list[str] = []

    async def drain(stream, sink: list[str]) -> None:
        async for chunk in stream:
            sink.append(chunk)

    await asyncio.gather(
        drain(execution.stdout(), out_parts),
        drain(execution.stderr(), err_parts),
    )
    result = await execution.wait()
    return result.exit_code, "".join(out_parts), "".join(err_parts)


def topo_sort(services: dict[str, ServiceSpec]) -> list[list[str]]:
    """Return service names grouped by topological layer.

    Each layer's members can be started in parallel; layer N must finish
    before layer N+1 begins.
    """
    ts: TopologicalSorter[str] = TopologicalSorter()
    for name, spec in services.items():
        ts.add(name, *spec.depends_on)
    ts.prepare()
    layers: list[list[str]] = []
    while ts.is_active():
        layer = sorted(ts.get_ready())
        if not layer:
            break
        layers.append(layer)
        for name in layer:
            ts.done(name)
    return layers


def _box_name(service_name: str) -> str:
    return f"boxlite-local-{service_name}"


def build_box_options(spec: ServiceSpec, config: InfraConfig):
    """Pure transform: ServiceSpec + InfraConfig → BoxOptions."""
    return _build_box_options_with_volumes(spec, config, spec.volumes(config))


def _build_box_options_with_volumes(spec: ServiceSpec, config: InfraConfig, volumes):
    """Same as build_box_options but accepts pre-computed volumes to avoid double-evaluation."""
    _, BoxOptions = import_sdk()

    cmd = spec.cmd(config) if callable(spec.cmd) else spec.cmd
    return BoxOptions(
        image=spec.image,
        cpus=spec.cpus,
        memory_mib=spec.memory_mib,
        auto_remove=spec.auto_remove,
        detach=True,
        ports=spec.ports,
        volumes=volumes,
        env=list(spec.env(config).items()),
        cmd=cmd,
        entrypoint=spec.entrypoint,
        working_dir=spec.working_dir,
        user=spec.user,
    )


def ensure_home_env(config: InfraConfig) -> None:
    """Export BOXLITE_HOME from config so the SDK uses the repo-scoped home.

    Must run before the FIRST `Boxlite.default()` anywhere in the process
    (doctor's runtime-reachable check included): the default runtime is a
    process-wide singleton that captures its home dir at construction.
    Idempotent — config already respects a pre-set BOXLITE_HOME.
    """
    os.environ["BOXLITE_HOME"] = str(config.boxlite_home)


def get_runtime():
    Boxlite, _ = import_sdk()
    # Local override: authenticate docker.io pulls when creds are supplied via
    # env, so L1 image pulls don't hit the anonymous Docker Hub rate limit.
    # The BoxLite puller does NOT read ~/.docker/config.json — auth must come
    # through the runtime's image_registries config.
    from . import _local_arm64
    user, secret = _local_arm64.dockerhub_creds()
    if user and secret:
        from boxlite import ImageRegistry, Options
        opts = Options(image_registries=[
            ImageRegistry("docker.io", username=user, password=secret, search=True),
        ])
        # Seed the PROCESS-WIDE default runtime with auth, then return that
        # shared singleton — NOT a fresh Boxlite(opts). A fresh runtime per call
        # would re-acquire the home-dir flock and collide with itself when
        # get_runtime() runs more than once in a process.
        try:
            Boxlite.init_default(opts)
        except Exception:
            pass  # default runtime already initialized in this process
    return Boxlite.default()


# ─── HTTP healthcheck ─────────────────────────────────────────────────────

def _http_probe(url: str) -> bool:
    """Sync HTTP probe — return True iff status 2xx. Runs in to_thread for async caller."""
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False
    except Exception:
        return False


# ─── start / stop / wait ──────────────────────────────────────────────────

async def probe_health(box, hc: HealthCheck, config: InfraConfig) -> bool:
    """One bounded probe for reconciliation and status, without warmup sleeps."""
    try:
        if hc.http_url is not None:
            return await asyncio.wait_for(asyncio.to_thread(_http_probe, hc.http_url), hc.timeout_s)
        if hc.exec is not None:
            command = hc.exec(config) if callable(hc.exec) else hc.exec
            rc, _, _ = await asyncio.wait_for(exec_collect(box, command[0], command[1:]), hc.timeout_s)
            return rc == 0
    except Exception:
        return False
    return False


async def start_service(runtime, spec: ServiceSpec, config: InfraConfig) -> bool:
    name = _box_name(spec.name)
    volumes = spec.volumes(config)
    opts = _build_box_options_with_volumes(spec, config, volumes)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    for host_path, _ in volumes:
        p = Path(host_path)
        # Heuristic: only auto-create directory mounts. Paths with a suffix
        # (e.g. a `.sh`/`.json` file) are likely files — caller owns them.
        if not p.suffix:
            p.mkdir(parents=True, exist_ok=True)

    box, created = await runtime.get_or_create(opts, name=name)

    if not created:
        state = (await box.info()).state.status.lower()
        if state == "running" and (spec.healthcheck is None or await probe_health(box, spec.healthcheck, config)):
            return False
        print(f"  {name}: recreating {state} or unhealthy box (host data kept)")
        await runtime.remove(name, force=True)
        box, _ = await runtime.get_or_create(opts, name=name)
    await box.start()
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck, label=spec.name, config=config)
    return True


async def stop_service(runtime, service_name: str) -> bool:
    """Stop + remove the box for service_name. Idempotent. Returns True iff a box was found.

    The SDK's `runtime.get(name)` may either raise or return None for missing
    boxes depending on version; both mean "nothing to stop" and return False.
    """
    name = _box_name(service_name)
    try:
        box = await runtime.get(name)
    except Exception:
        return False
    if box is None:
        return False
    try:
        await box.stop()
    except Exception as e:
        print(f"  {name}: stop failed ({e!r}); attempting remove anyway")
    try:
        await runtime.remove(name)
    except Exception as e:
        print(f"  {name}: remove failed ({e!r})")
    return True


async def wait_healthy(box, hc: HealthCheck, *, label: str, config: InfraConfig) -> None:
    """Dispatch to the probe type set on the healthcheck."""
    if hc.start_period_s:
        await asyncio.sleep(hc.start_period_s)
    if hc.exec is not None:
        await _wait_healthy_exec(box, hc, label=label, config=config)
    elif hc.http_url is not None:
        await _wait_healthy_http(hc, label=label)
    else:
        raise ValueError(f"{label}: HealthCheck has no probe configured")


async def _wait_healthy_exec(box, hc: HealthCheck, *, label: str, config: InfraConfig) -> None:
    raw = hc.exec
    assert raw is not None
    cmd_list: list[str] = raw(config) if callable(raw) else raw
    cmd, *args = cmd_list
    start = time.monotonic()
    last_err: str = ""
    for attempt in range(1, hc.retries + 1):
        try:
            rc, _out, _err = await asyncio.wait_for(
                exec_collect(box, cmd, args), timeout=hc.timeout_s
            )
        except asyncio.TimeoutError:
            rc = -1
            last_err = "TimeoutError"
        except Exception as e:
            # SDK exec can raise during box startup before init is ready
            # (e.g. "InitReady, expected IntermediateReady(0)"). Treat any
            # exec exception as a transient probe failure and retry.
            rc = -1
            last_err = f"{type(e).__name__}: {str(e)[:120]}"
        if rc == 0:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: healthcheck `{' '.join(cmd_list)}` failed after {hc.retries} attempts"
        + (f" (last err: {last_err})" if last_err else "")
    )


async def _wait_healthy_http(hc: HealthCheck, *, label: str) -> None:
    assert hc.http_url is not None
    start = time.monotonic()
    last_err: Exception | None = None
    for attempt in range(1, hc.retries + 1):
        try:
            ok = await asyncio.wait_for(
                asyncio.to_thread(_http_probe, hc.http_url), timeout=hc.timeout_s
            )
        except asyncio.TimeoutError as e:
            ok = False
            last_err = e
        except Exception as e:
            ok = False
            last_err = e
        if ok:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: HTTP healthcheck `{hc.http_url}` failed after {hc.retries} attempts"
        + (f" (last err: {last_err!r})" if last_err else "")
    )


# ─── top-level entry points ───────────────────────────────────────────────

async def up(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    skip_doctor: bool = False,
) -> bool:
    # Pin home before anything builds a Boxlite.default() singleton (doctor
    # below does), so box starts hit the repo-scoped home.
    ensure_home_env(config)
    if not skip_doctor:
        await doctor(config, services, strict=True)
    else:
        print("=" * 60)
        print("WARNING: --skip-doctor was passed — preflight checks bypassed")
        print("=" * 60)
    runtime = get_runtime()
    changed = False
    for layer in topo_sort(services):
        targets = [n for n in layer if only is None or n in only]
        if not targets:
            continue
        results = await asyncio.gather(*[start_service(runtime, services[n], config) for n in targets])
        changed |= any(results)
    if "minio" in services and (only is None or "minio" in only):
        from .storage import ensure_bucket
        await asyncio.to_thread(ensure_bucket, config)
    return changed


async def down(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    wipe: bool = False,
) -> None:
    ensure_home_env(config)
    runtime = get_runtime()
    for layer in reversed(topo_sort(services)):
        targets = [n for n in layer if only is None or n in only]
        if not targets:
            continue
        await asyncio.gather(*[stop_service(runtime, n) for n in targets])
    if wipe and config.data_dir.exists():
        shutil.rmtree(config.data_dir, ignore_errors=True)
        print(f"  data dir wiped: {config.data_dir}")
