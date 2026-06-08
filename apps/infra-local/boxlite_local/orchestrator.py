"""Top-level orchestration: topo_sort + up/down/ps + healthcheck loop.

Plain async functions, no classes. Single shared Boxlite.default() runtime
per call. Reuse path of get_or_create silently keeps existing config
(parent design doc §1.7.D); we warn on observable drift but do not auto-recreate.
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

from .config import InfraConfig, resolve_runtime_dir
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
    return _build_box_options_with_volumes(spec, config, spec.volumes(config))


def _build_box_options_with_volumes(spec: ServiceSpec, config: InfraConfig, volumes):
    """Same as build_box_options but accepts pre-computed volumes to avoid double-evaluation."""
    try:
        from boxlite import BoxOptions
    except ImportError:
        from boxlite.boxlite import BoxOptions  # type: ignore

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
    )


def ensure_runtime_env() -> None:
    """Pin BOXLITE_RUNTIME_DIR to a complete extracted runtime when the SDK's own
    default resolution would otherwise fail — a stale/partial embedded cache (a
    `.complete` dir missing boxlite-guest), or an SDK installed from another
    worktree without an embedded guest. No-op if the user already set
    BOXLITE_RUNTIME_DIR or no usable cached runtime is found. Idempotent.
    """
    runtime_dir = resolve_runtime_dir()
    if runtime_dir is not None:
        os.environ["BOXLITE_RUNTIME_DIR"] = str(runtime_dir)
        print(f"  pinned BOXLITE_RUNTIME_DIR to cached runtime: {runtime_dir}")


def get_runtime():
    ensure_runtime_env()
    try:
        from boxlite import Boxlite
    except ImportError:
        from boxlite.boxlite import Boxlite  # type: ignore
    return Boxlite.default()


# ─── exception-narrowing predicate (Phase-2 debt #1) ──────────────────────

_ALREADY_RUNNING_PATTERNS = ("already running", "already started", "already exists")


def _is_already_running_error(exc: Exception) -> bool:
    """Heuristic: SDK doesn't expose a typed exception for 'box is already running'.

    Match on message substring so we can tolerate this specific case while
    letting all other SDK errors propagate.
    """
    msg = str(exc).lower()
    if not msg:
        return False
    return any(p in msg for p in _ALREADY_RUNNING_PATTERNS)


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


# ─── image-cache writable workaround ──────────────────────────────────────

_IMAGE_CACHE = Path.home() / ".boxlite" / "images" / "extracted"
_TMP_CACHE = Path.home() / ".boxlite" / "tmp"


def _ensure_image_cache_writable() -> None:
    """Workaround for SDK rootfs-merge failures on images whose layers contain
    `r-x` directories (e.g. RHEL UBI-based images like minio/minio:latest,
    minio/mc:latest).

    The SDK's per-start rootfs merge tries to write into directories whose
    owner-write bit is unset in the extracted layer cache, which produces
    `RuntimeError: storage error: Failed to ... Permission denied (os error 13)`
    and (sometimes) `RustPanic: rust future panicked: unknown error`.

    Walks `~/.boxlite/images/extracted/` AND `~/.boxlite/tmp/` adding owner-write
    to every directory. Idempotent + cheap (~10ms on a populated cache).
    Remove when the SDK relaxes dir perms at extract time.
    """
    import os, stat
    for root_path in (_IMAGE_CACHE, _TMP_CACHE):
        if not root_path.exists():
            continue
        for root, dirs, _files in os.walk(root_path):
            for d in dirs:
                p = os.path.join(root, d)
                try:
                    st = os.stat(p).st_mode
                    if not (st & stat.S_IWUSR):
                        os.chmod(p, st | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRUSR)
                except OSError:
                    pass  # best-effort


def _is_rootfs_perm_error(exc: Exception) -> bool:
    """Detect the SDK's rootfs-merge permission-denied error so we can retry after chmod."""
    msg = str(exc)
    return "Permission denied (os error 13)" in msg and "/usr/bin/" in msg


async def _start_with_perm_retry(box, label: str) -> None:
    """Call `box.start()`. If it hits the SDK's r-x rootfs-perm bug, chmod the
    image cache (which is now populated post-extract) and retry once."""
    try:
        await box.start()
    except Exception as e:
        if not _is_rootfs_perm_error(e):
            raise
        print(f"  {label}: hit SDK rootfs perm error; re-chmodding cache and retrying")
        _ensure_image_cache_writable()
        await box.start()


# ─── start / stop / wait ──────────────────────────────────────────────────

async def start_service(runtime, spec: ServiceSpec, config: InfraConfig) -> None:
    name = _box_name(spec.name)
    volumes = spec.volumes(config)
    opts = _build_box_options_with_volumes(spec, config, volumes)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    _ensure_image_cache_writable()
    for host_path, _ in volumes:
        p = Path(host_path)
        # Heuristic: only auto-create directory mounts. Paths with a suffix
        # (e.g. init.sh) are likely files — caller is responsible for them.
        if not p.suffix:
            p.mkdir(parents=True, exist_ok=True)

    box, created = await runtime.get_or_create(opts, name=name)

    if spec.one_shot:
        # One-shot services re-run every `up` (idempotent bootstrap).
        # If an old box exists, drop it first so cmd actually re-executes.
        if not created:
            print(f"  {name}: removing stale one-shot box before re-running")
            try:
                await box.stop()
            except Exception:
                pass
            await runtime.remove(name)
            box, _ = await runtime.get_or_create(opts, name=name)
        await _start_with_perm_retry(box, label=spec.name)
        await _wait_one_shot_exit(runtime, name, label=spec.name)
        # One-shot box's VM is still "running" per SDK even after init exited;
        # force=True stops the VM as part of remove.
        try:
            await runtime.remove(name, force=True)
        except Exception as e:
            print(f"  {name}: one-shot remove failed ({e!r})")
        print(f"  {name}: one-shot completed and removed")
        return

    if created:
        await _start_with_perm_retry(box, label=spec.name)
    else:
        try:
            await _start_with_perm_retry(box, label=spec.name)
        except Exception as e:
            if not _is_already_running_error(e):
                raise
            print(f"  {name}: (already running: {e!r})")
    if spec.healthcheck:
        await wait_healthy(box, spec.healthcheck, label=spec.name, config=config)


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
    elif hc.tcp_port is not None:
        raise NotImplementedError(f"{label}: HealthCheck.tcp_port not implemented in 3a")
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


async def _wait_one_shot_exit(runtime, name: str, *, label: str, timeout_s: float = 60.0) -> None:
    """Wait until the named one-shot box's init process exits.

    SDK's `list_info().state.status` stays "running" as long as the VM is up,
    independent of whether the OCI container's init process inside has exited.
    For one-shot bootstrap services we need the init-exit signal — which the
    SDK only surfaces by failing `box.exec(...)` with a specific error message
    ("incorrect container status" / "Container init process exited").

    We probe via `box.exec("true")` every second: success means init still
    running; the specific exit-related failure means we're done.
    """
    start = time.monotonic()
    last_err: str = ""
    while time.monotonic() - start < timeout_s:
        # First, fast path: if list_info DOES update (older SDK versions did),
        # use it.
        infos = await runtime.list_info()
        info = next((i for i in infos if i.name == name), None)
        if info is None:
            return
        status = info.state.status.lower()
        if status != "running":
            print(f"  {label}: one-shot exited with state={status}")
            return

        # Slow path: probe via exec; init-exited returns a specific error.
        try:
            box = await runtime.get(name)
            if box is not None:
                exec_collect_was_ok = False
                try:
                    rc, _o, _e = await exec_collect(box, "true", [])
                    exec_collect_was_ok = (rc == 0)
                except Exception as e:
                    msg = str(e)
                    last_err = msg
                    if "Container init process exited" in msg or "incorrect container status" in msg:
                        print(f"  {label}: one-shot init process has exited")
                        return
                # If exec_collect succeeded, init is still running; loop.
                _ = exec_collect_was_ok  # quiet linter
        except Exception:
            pass

        await asyncio.sleep(1.0)
    # Don't raise — for a one-shot we'd rather force-clean than block the up().
    print(f"  {label}: one-shot did not signal exit within {timeout_s}s "
          f"(last exec err: {last_err[:120]!r}); proceeding to remove")


# ─── top-level entry points ───────────────────────────────────────────────

async def up(
    config: InfraConfig,
    services: dict[str, ServiceSpec],
    *,
    only: list[str] | None = None,
    skip_doctor: bool = False,
) -> None:
    # Pin the runtime dir before anything builds a Boxlite.default() singleton
    # (doctor below does), so box starts find boxlite-guest deterministically.
    ensure_runtime_env()
    if not skip_doctor:
        await doctor(config, services, strict=True)
    else:
        print("=" * 60)
        print("WARNING: --skip-doctor was passed — preflight checks bypassed")
        print("=" * 60)
    runtime = get_runtime()
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
    runtime = get_runtime()
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
    runtime = get_runtime()
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
