"""Top-level orchestration: topo_sort + up/down/ps + healthcheck loop.

Plain async functions, no classes. Single shared Boxlite.default() runtime
per call. Reuse path of get_or_create silently keeps existing config
(parent design doc §1.7.D); we warn on observable drift but do not auto-recreate.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from graphlib import TopologicalSorter
from pathlib import Path

from .config import InfraConfig
from .doctor import doctor
from .execwrap import exec_collect
from .types import HealthCheck, ServiceSpec


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
    try:
        from boxlite import BoxOptions
    except ImportError:
        from boxlite.boxlite import BoxOptions  # type: ignore

    return BoxOptions(
        image=spec.image,
        cpus=spec.cpus,
        memory_mib=spec.memory_mib,
        auto_remove=spec.auto_remove,
        detach=True,
        ports=spec.ports,
        volumes=spec.volumes(config),
        env=list(spec.env(config).items()),
        cmd=spec.cmd,
    )


def _get_runtime():
    try:
        from boxlite import Boxlite
    except ImportError:
        from boxlite.boxlite import Boxlite  # type: ignore
    return Boxlite.default()


async def start_service(runtime, spec: ServiceSpec, config: InfraConfig) -> None:
    name = _box_name(spec.name)
    opts = build_box_options(spec, config)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    for host_path, _ in spec.volumes(config):
        # ensure mount source exists so the box doesn't fail to start
        Path(host_path).mkdir(parents=True, exist_ok=True)
    box, created = await runtime.get_or_create(opts, name=name)
    if created:
        await box.start()
    else:
        try:
            await box.start()
        except Exception as e:
            # already running is acceptable per SDK contract
            print(f"  {name}: (already running: {e!r})")
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck, label=spec.name)


async def stop_service(runtime, service_name: str) -> bool:
    """Stop + remove the box for `service_name`. Idempotent. Returns True iff a box was found."""
    name = _box_name(service_name)
    try:
        box = await runtime.get(name)
    except Exception:
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


async def wait_healthy(box, hc: HealthCheck, *, label: str) -> None:
    """Block until the healthcheck passes or retries exhaust.

    Walking skeleton supports only HealthCheck.exec; tcp/http variants are
    reserved for future services.
    """
    if hc.start_period_s:
        await asyncio.sleep(hc.start_period_s)
    if hc.exec is None:
        raise NotImplementedError(
            f"{label}: only HealthCheck.exec is implemented in the walking skeleton"
        )
    cmd, *args = hc.exec
    start = time.monotonic()
    for attempt in range(1, hc.retries + 1):
        rc, _out, _err = await exec_collect(box, cmd, args)
        if rc == 0:
            print(f"  {label}: healthy after {attempt} attempt(s), {time.monotonic() - start:.1f}s")
            return
        await asyncio.sleep(hc.interval_s)
    raise TimeoutError(
        f"{label}: healthcheck `{' '.join(hc.exec)}` failed after {hc.retries} attempts"
    )


async def up(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    skip_doctor: bool = False,
) -> None:
    if not skip_doctor:
        await doctor(config, services, strict=True)
    else:
        print("=" * 60)
        print("WARNING: --skip-doctor was passed — preflight checks bypassed")
        print("=" * 60)
    runtime = _get_runtime()
    for layer in topo_sort(services):
        targets = [n for n in layer if only is None or n in only]
        if not targets:
            continue
        await asyncio.gather(*[start_service(runtime, services[n], config) for n in targets])


async def down(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    wipe: bool = False,
) -> None:
    runtime = _get_runtime()
    for layer in reversed(topo_sort(services)):
        targets = [n for n in layer if only is None or n in only]
        if not targets:
            continue
        await asyncio.gather(*[stop_service(runtime, n) for n in targets])
    if wipe and config.data_dir.exists():
        shutil.rmtree(config.data_dir, ignore_errors=True)
        print(f"  data dir wiped: {config.data_dir}")


async def ps(config: InfraConfig) -> list[tuple[str, str, str]]:
    """Return list of (name, status, image) for boxlite-local-* boxes. Also prints."""
    runtime = _get_runtime()
    infos = await runtime.list_info()
    rows: list[tuple[str, str, str]] = []
    for info in infos:
        if info.name and info.name.startswith("boxlite-local-"):
            rows.append((info.name, info.state.status, info.image))
    if not rows:
        print("(no boxlite-local-* boxes)")
    else:
        for name, status, image in rows:
            print(f"  {name:<30} {status:<10} {image}")
    return rows
