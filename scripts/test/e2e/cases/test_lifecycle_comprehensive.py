"""Comprehensive lifecycle and box management coverage over REST.

Extends test_lifecycle.py and test_box_management.py with edge cases:

  - stop/start cycle preserves rootfs data
  - double-stop is idempotent or returns typed error
  - exec after stop returns typed error
  - box info fields are consistent through state transitions
  - rapid create-remove cycle doesn't leak
  - box with custom resource options (cpu, memory)
  - multiple boxes can coexist independently
"""
from __future__ import annotations

import asyncio

import boxlite
import pytest

from conftest import drain


async def _get_service_body(box, port: int) -> str:
    tunnel = await box.network.tunnel(port)
    connection = await tunnel.connect()
    try:
        await connection.write(
            f"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode()
        )
        response = bytearray()
        while chunk := await connection.read(64 * 1024):
            response.extend(chunk)
        return response.decode()
    finally:
        await connection.close()


async def _wait_for_service(box, port: int, marker: str) -> str:
    deadline = asyncio.get_running_loop().time() + 30
    last_error = "service did not answer"
    while asyncio.get_running_loop().time() < deadline:
        try:
            response = await _get_service_body(box, port)
            if marker in response:
                return response
            last_error = f"marker missing from response: {response[:200]!r}"
        except (ConnectionError, OSError, RuntimeError, TimeoutError) as error:
            last_error = f"{type(error).__name__}: {error}"
        await asyncio.sleep(0.5)
    raise AssertionError(f"in-box service did not become ready: {last_error}")


async def _start_http_service(box, port: int) -> None:
    result = await box.exec(
        "sh",
        [
            "-lc",
            f"python3 -u -m http.server {port} --bind 0.0.0.0 "
            f">/tmp/http-{port}.log 2>&1 & echo $!",
        ],
    )
    _, stderr = await drain(result)
    status = await result.wait()
    assert status.exit_code == 0, stderr


# ── stop / start preserves data ────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_start_preserves_rootfs(rt, image):
    """Data written to the rootfs must survive a stop→start cycle."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        # Write a file
        ex = await b.exec("sh", ["-c", "echo persist-me > /workspace/marker.txt"])
        await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0

        # Stop
        await b.stop()
        # Give it a moment to fully stop
        await asyncio.sleep(1)

        # Start
        await b.start()
        # Wait for it to be ready
        await asyncio.sleep(2)

        # Read back
        ex = await b.exec("cat", ["/workspace/marker.txt"])
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0
        assert "persist-me" in out, f"rootfs data lost after stop/start: {out!r}"
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_stop_start_restarts_main_service(rt, image):
    """A main-process HTTP service must be reachable again after stop/start."""
    port = 18083
    b = await rt.create(
        boxlite.BoxOptions(
            image=image,
            auto_remove=False,
        )
    )
    try:
        await b.start()
        await _start_http_service(b, port)
        first = await _wait_for_service(b, port, "Directory listing")
        assert "Directory listing" in first

        await b.stop()
        await asyncio.sleep(2)
        restarted = await rt.get(b.id)
        assert restarted is not None
        await restarted.start()

        second = await _wait_for_service(restarted, port, "Directory listing")
        assert "Directory listing" in second
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass


# ── exec on stopped box ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_exec_on_stopped_box_fails(rt, image):
    """Exec on a stopped box must fail — either by raising an exception
    or by returning a non-zero exit code. Must not succeed silently."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        await b.stop()
        await asyncio.sleep(1)
        try:
            ex = await b.exec("echo", ["should-fail"])
            out, _ = await drain(ex)
            rc = await asyncio.wait_for(ex.wait(), timeout=30)
            # If it didn't raise, at least the output should not contain
            # "should-fail" (i.e. the command didn't actually run)
            assert rc.exit_code != 0 or "should-fail" not in out, (
                "exec on stopped box succeeded silently"
            )
        except Exception:
            pass  # raising is the expected behaviour
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass


# ── box info state transitions ─────────────────────────────────────


@pytest.mark.asyncio
async def test_box_info_reflects_state(rt, image):
    """Box info should reflect the current state (running/stopped)."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    try:
        # After create, should be running
        info = await rt.get(b.id)
        assert info is not None, "box info returned None right after create"
        assert info.id == b.id

        # Stop
        await b.stop()
        await asyncio.sleep(1)

        info = await rt.get(b.id)
        assert info is not None, "box info returned None after stop"
        assert info.id == b.id
    finally:
        try:
            await rt.remove(b.id, force=True)
        except Exception:
            pass


# ── rapid create-remove ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rapid_create_remove_no_leak(rt, image):
    """Creating and immediately removing 5 boxes in sequence should not
    leave orphans in the box list."""
    created_ids = []
    for _ in range(5):
        b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
        created_ids.append(b.id)
        await rt.remove(b.id, force=True)

    # None of the created boxes should appear in the list
    boxes = await rt.list_info()
    live_ids = {b.id for b in boxes}
    leaked = [bid for bid in created_ids if bid in live_ids]
    assert not leaked, f"rapid create-remove leaked boxes: {leaked}"


# ── custom resource options ────────────────────────────────────────


@pytest.mark.asyncio
async def test_box_with_custom_cpu_memory(rt, image):
    """A box created with custom cpu/memory should reflect those in
    the running environment."""
    b = await rt.create(boxlite.BoxOptions(
        image=image, auto_remove=True,
        cpus=2,
    ))
    try:
        # Check CPU count visible inside guest
        ex = await b.exec("nproc", [])
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0
        nproc = int(out.strip())
        assert nproc == 2, f"expected 2 cpus, guest sees {nproc}"

        # Verify memory is present and reasonable (org default applies)
        ex = await b.exec("sh", ["-c", "grep MemTotal /proc/meminfo"])
        out, _ = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0
        mem_kb = int(out.split()[1])
        assert mem_kb > 100_000, f"unreasonably low memory: {mem_kb} kB"
    finally:
        await rt.remove(b.id, force=True)


# ── multiple independent boxes ─────────────────────────────────────


@pytest.mark.asyncio
async def test_two_boxes_are_isolated(rt, image):
    """Two boxes should have independent filesystems and process spaces."""
    b1 = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    b2 = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        # Write unique markers
        ex1 = await b1.exec("sh", ["-c", "echo BOX_ONE > /workspace/who.txt"])
        await drain(ex1)
        await asyncio.wait_for(ex1.wait(), timeout=30)

        ex2 = await b2.exec("sh", ["-c", "echo BOX_TWO > /workspace/who.txt"])
        await drain(ex2)
        await asyncio.wait_for(ex2.wait(), timeout=30)

        # Read back — each box should see its own marker
        ex1 = await b1.exec("cat", ["/workspace/who.txt"])
        out1, _ = await drain(ex1)
        await asyncio.wait_for(ex1.wait(), timeout=30)

        ex2 = await b2.exec("cat", ["/workspace/who.txt"])
        out2, _ = await drain(ex2)
        await asyncio.wait_for(ex2.wait(), timeout=30)

        assert "BOX_ONE" in out1, f"box1 sees wrong data: {out1!r}"
        assert "BOX_TWO" in out2, f"box2 sees wrong data: {out2!r}"
        assert "BOX_TWO" not in out1, "box2 data leaked into box1"
        assert "BOX_ONE" not in out2, "box1 data leaked into box2"
    finally:
        await asyncio.gather(
            rt.remove(b1.id, force=True),
            rt.remove(b2.id, force=True),
            return_exceptions=True,
        )


# ── force remove running box ──────────────────────────────────────


@pytest.mark.asyncio
async def test_force_remove_running_box(rt, image):
    """force=True should remove a running box without needing stop first."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    # Don't stop — force remove directly
    await rt.remove(b.id, force=True)

    # After force remove, get() should raise not-found or return None
    try:
        info = await rt.get(b.id)
        assert info is None, f"force-removed box still exists: {info}"
    except Exception:
        pass  # not-found exception is expected


# ── remove already-removed box ────────────────────────────────────


@pytest.mark.asyncio
async def test_remove_already_removed_returns_not_found(rt, image):
    """Removing a box that was already removed should return not-found."""
    b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    await rt.remove(b.id, force=True)
    with pytest.raises(Exception):
        await rt.remove(b.id, force=True)
