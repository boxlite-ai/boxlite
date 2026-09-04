"""E2E: does an unread large stdout block concurrent execs?

Concern raised after #563 (`fold stream drain into Execution.Wait`):
the Go SDK's single drain goroutine runs the user's Stdout.Write inline.
If a caller never drains the stream (huge stdout, slow / nil sink),
does that block other executions on the same box / runtime?

The Python SDK over REST is structurally different (per-exec attach
WebSocket, no shared drain goroutine), so this isn't the cleanest probe
of the Go-SDK concern — but the REST path has its own back-pressure
points (per-exec WS buffer, runner-side per-exec goroutine), so the
same question applies at every layer.

What "huge" means here: we produce ~10 MB of stdout from one exec
(`for i in $(seq 1 200000); do echo line-$i; done`) and intentionally
never iterate the SDK's `ex.stdout()` async generator. The runner's
attach WS will fill, and the question is whether anything else gets
stuck behind it.

Two probes:
  1. Same box: producer + concurrent fast exec on the SAME box.
  2. Cross box: producer on box_a + fast exec on a different box_b.

Pass = the fast exec completes within a small budget (we use 5 s, very
generous for an `echo`) regardless of the producer's state.
"""

from __future__ import annotations

import asyncio
import time

import boxlite
import pytest

from conftest import collect_stream


# Big enough to overflow any per-exec WS buffer the runner / API holds
# in memory, small enough that draining at the end stays under 30 s on
# a healthy stack.
PRODUCER_CMD = (
    "for i in $(seq 1 200000); do echo line-$i-padding-padding-padding; done"
)
FAST_BUDGET_S = 5.0


@pytest.mark.asyncio
async def test_unread_large_stdout_does_not_block_same_box_exec(rt, image):
    """Producer (~10 MB stdout, never drained) + fast `echo` on the
    same box should not delay the fast exec."""
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    box_id = box.id
    try:
        # 1) Start the producer — intentionally never read ex_a.stdout().
        ex_a = await box.exec("sh", ["-c", PRODUCER_CMD], None)

        # Give the producer enough head start that its stdout pipe
        # / WS buffer is full and writes are back-pressured. The exact
        # buffer size varies; 0.5 s is plenty for `seq | echo` on a
        # warm VM.
        await asyncio.sleep(0.5)

        # 2) Fast exec on the same box, fully drained.
        start_b = time.monotonic()
        ex_b = await box.exec("echo", ["fast-b"], None)
        out_b = await collect_stream(ex_b.stdout())
        rc_b = await asyncio.wait_for(ex_b.wait(), timeout=FAST_BUDGET_S + 5)
        elapsed_b = time.monotonic() - start_b

        print(f"[same-box] elapsed_b={elapsed_b:.3f}s rc={rc_b.exit_code} out={out_b!r}")
        # Timing first: this test is specifically about back-pressure /
        # blocking, so check that before the (separate) stdout-race issue.
        assert elapsed_b < FAST_BUDGET_S, (
            f"exec B on the same box took {elapsed_b:.2f}s while A's huge stdout "
            f"was unread — same-box back-pressure / blocking suspected"
        )
        assert rc_b.exit_code == 0, f"B exit non-zero: {rc_b.exit_code}"
        # stdout content can drop independently due to the #563-class
        # race on short execs; pass it through but soft-warn here so
        # the back-pressure conclusion stays clean.
        if "fast-b" not in out_b:
            print(f"[same-box] WARN: B stdout dropped: {out_b!r} (separate stdout-race issue, not back-pressure)")

        # Drain A so the box can be cleaned up promptly. The producer
        # may have parked on the back-pressured pipe; collect_stream
        # unblocks it. Bound the wait — if drain takes more than 60 s
        # something else is wrong.
        _ = await collect_stream(ex_a.stdout())
        await asyncio.wait_for(ex_a.wait(), timeout=60)
    finally:
        try:
            await rt.remove(box_id, force=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_unread_large_stdout_does_not_block_cross_box_exec(rt, image):
    """Producer (~10 MB stdout, never drained) on box_a + fast `echo`
    on box_b should not delay the cross-box fast exec."""
    box_a = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    box_b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    box_a_id = box_a.id
    box_b_id = box_b.id
    try:
        ex_a = await box_a.exec("sh", ["-c", PRODUCER_CMD], None)
        await asyncio.sleep(0.5)

        start_b = time.monotonic()
        ex_b = await box_b.exec("echo", ["fast-b"], None)
        out_b = await collect_stream(ex_b.stdout())
        rc_b = await asyncio.wait_for(ex_b.wait(), timeout=FAST_BUDGET_S + 5)
        elapsed_b = time.monotonic() - start_b

        print(f"[cross-box] elapsed_b={elapsed_b:.3f}s rc={rc_b.exit_code} out={out_b!r}")
        assert elapsed_b < FAST_BUDGET_S, (
            f"exec B on box_b took {elapsed_b:.2f}s while box_a's A had an unread "
            f"large stdout — cross-box back-pressure / blocking suspected"
        )
        assert rc_b.exit_code == 0
        if "fast-b" not in out_b:
            print(f"[cross-box] WARN: B stdout dropped: {out_b!r} (separate stdout-race issue, not back-pressure)")

        _ = await collect_stream(ex_a.stdout())
        await asyncio.wait_for(ex_a.wait(), timeout=60)
    finally:
        for bid in (box_a_id, box_b_id):
            try:
                await rt.remove(bid, force=True)
            except Exception:
                pass


@pytest.mark.asyncio
async def test_slow_consumer_does_not_block_other_box_exec(rt, image):
    """Closer probe of the runner-internal Go SDK drainLoop concern:
    instead of NOT reading the stream, read it VERY slowly. The runner
    holds the chunks in its attach WebSocket send buffer; once that
    buffer fills, the runner's stream-to-WS goroutine blocks on
    `conn.Write`. If the runner's single drainLoop is what calls that
    Write (the architectural pre-refactor shape), every other exec in
    the runner stalls. After the per-execution deliverer refactor, only
    the slow consumer's own exec is affected — sibling execs keep
    dispatching."""
    box_a = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    box_b = await rt.create(boxlite.BoxOptions(image=image, auto_remove=False))
    box_a_id, box_b_id = box_a.id, box_b.id
    try:
        ex_a = await box_a.exec("sh", ["-c", PRODUCER_CMD], None)

        # Slow consumer: read a chunk every 100 ms. Iterator stalls
        # back-pressure to the runner's WS send buffer; once it fills,
        # the runner's pump-to-WS goroutine blocks.
        async def slow_drain():
            async for _chunk in ex_a.stdout():
                await asyncio.sleep(0.1)

        consumer = asyncio.create_task(slow_drain())

        # Let the slow consumer hit back-pressure (~1 s of accumulated
        # chunks vs. 100 ms reads → runner WS buffer fills fast).
        await asyncio.sleep(1.0)

        # Fast exec on box_b should be unaffected by A's stuck consumer.
        start_b = time.monotonic()
        ex_b = await box_b.exec("echo", ["fast-b"], None)
        out_b = await collect_stream(ex_b.stdout())
        rc_b = await asyncio.wait_for(ex_b.wait(), timeout=FAST_BUDGET_S + 5)
        elapsed_b = time.monotonic() - start_b

        print(f"[slow-consumer cross-box] elapsed_b={elapsed_b:.3f}s rc={rc_b.exit_code} out={out_b!r}")
        assert elapsed_b < FAST_BUDGET_S, (
            f"exec B on box_b took {elapsed_b:.2f}s while box_a's A had a slow "
            f"WS consumer — runner-side drainLoop / stream pump may be stalled"
        )
        assert rc_b.exit_code == 0
        if "fast-b" not in out_b:
            print(f"[slow-consumer cross-box] WARN: B stdout dropped: {out_b!r} (separate stdout-race issue)")

        # Clean up A
        consumer.cancel()
        try:
            await consumer
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await asyncio.wait_for(ex_a.wait(), timeout=60)
        except Exception:
            pass
    finally:
        for bid in (box_a_id, box_b_id):
            try:
                await rt.remove(bid, force=True)
            except Exception:
                pass
