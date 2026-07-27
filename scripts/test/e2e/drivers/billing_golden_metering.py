#!/usr/bin/env python3
"""Long-lived Python REST driver for the billing golden path.

Stdout is a versioned NDJSON protocol consumed by the Node orchestrator.  The
OIDC bearer token and PostgreSQL password are accepted only through the
environment and are redacted from terminal errors.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import os
import sys
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, TypeVar

LIB_DIR = Path(__file__).resolve().parents[1] / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

from billing_oracle import (
    BillingOracle,
    DerivedRating,
    decimal_text,
    validate_box_id,
    validate_uuid,
)

POLL_SECONDS = 1.0
ACTION_TIMEOUT = 60.0
STATE_TIMEOUT = 600.0
HEARTBEAT_TIMEOUT = 45.0
PHYSICAL_STOP_TIMEOUT = 90.0
SETTLEMENT_TIMEOUT = 180.0
# The default FULL rate needs about 147 seconds to reach the 0.55-cent floor.
# Keep this independent from state-transition waits so fast VM creation cannot
# consume the charge window's polling budget.
CHARGE_WINDOW_TIMEOUT = 180.0
OVERALL_TIMEOUT = 20 * 60.0
CLEANUP_VERIFY_TIMEOUT = 60.0
CLOSE_TIMEOUT = 10.0
DIAGNOSTICS_ARCHIVE_ACK_TIMEOUT = 30.0
DIAGNOSTICS_ARCHIVE_ACK_MAX_BYTES = 4096
AVAILABILITY_THRESHOLD = 10
P1_MIN_CENTS = Decimal("0.55")
P1_MAX_CENTS = Decimal("0.65")
CUMULATIVE_TARGET_CENTS = Decimal("1.2")

T = TypeVar("T")


class NdjsonEmitter:
    def __init__(self) -> None:
        self._terminal_emitted = False

    def stage(self, stage: str, **fields: Any) -> None:
        if self._terminal_emitted:
            raise RuntimeError("cannot emit a stage after the terminal event")
        if not stage:
            raise ValueError("stage must not be empty")
        self._emit({"v": 1, "type": "stage", "stage": stage, **fields})

    def result(self, result: Mapping[str, Any]) -> None:
        self._terminal({"v": 1, "type": "result", "ok": True, **result})

    def error(self, error_type: str, message: str) -> None:
        self._terminal(
            {
                "v": 1,
                "type": "error",
                "ok": False,
                "error": {"type": error_type, "message": message},
            }
        )

    def _terminal(self, event: Mapping[str, Any]) -> None:
        if self._terminal_emitted:
            raise RuntimeError("terminal NDJSON event already emitted")
        self._terminal_emitted = True
        self._emit(event)

    @staticmethod
    def _emit(event: Mapping[str, Any]) -> None:
        print(json.dumps(event, separators=(",", ":"), sort_keys=True), flush=True)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args(argv)
    args.organization_id = validate_uuid(args.organization_id, "organization_id")
    if not args.image.strip():
        parser.error("--image must not be empty")
    if not args.name.strip():
        parser.error("--name must not be empty")
    return args


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _redacted_message(exc: BaseException) -> str:
    message = str(exc) or type(exc).__name__
    secret_names = ("BOXLITE_E2E_OIDC_TOKEN", "BILLING_E2E_DB_PASSWORD", "PGPASSWORD")
    for name in secret_names:
        value = os.environ.get(name)
        if value:
            message = message.replace(value, "<redacted>")
    return message[:2000]


async def _await_with_timeout(
    description: str, awaitable: Awaitable[T], *, timeout: float
) -> T:
    task = asyncio.ensure_future(awaitable)
    try:
        completed, _ = await asyncio.wait({task}, timeout=timeout)
    except BaseException:
        task.cancel()
        try:
            await task
        except BaseException:
            pass
        raise

    if task in completed:
        return await task

    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    raise TimeoutError(f"timed out after {timeout:g}s waiting for {description}")


def _as_decimal(value: Any, field: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except Exception as exc:
        raise AssertionError(f"{field} is not decimal: {value!r}") from exc
    if not result.is_finite():
        raise AssertionError(f"{field} must be finite")
    return result


def _assert_p1_settlement_target(precise_cents: Decimal) -> None:
    if not P1_MIN_CENTS <= precise_cents <= P1_MAX_CENTS:
        raise AssertionError(
            "persisted P1 precise charge must remain in [0.55, 0.65] cents, "
            f"got {decimal_text(precise_cents)}"
        )


def _assert_final_settlement_target(total_precise_cents: Decimal) -> None:
    if total_precise_cents < CUMULATIVE_TARGET_CENTS:
        raise AssertionError(
            "persisted total precise charge must be at least 1.2 cents, "
            f"got {decimal_text(total_precise_cents)}"
        )


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise AssertionError(f"{field} must be an ISO-8601 string")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AssertionError(f"{field} is not an ISO-8601 timestamp") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise AssertionError(f"{field} must include a timezone")
    return result.astimezone(timezone.utc)


def _mode(period: Mapping[str, Any]) -> str:
    if all(
        _as_decimal(period.get(field), f"period.{field}") == 0
        for field in ("cpu", "mem", "gpu")
    ):
        return "DISK"
    return "FULL"


def _same_instant(left: Any, right: Any) -> bool:
    return (
        left is not None
        and right is not None
        and _timestamp(left, "left timestamp") == _timestamp(right, "right timestamp")
    )


async def _poll(
    description: str,
    reader: Callable[[], T],
    predicate: Callable[[T], bool],
    *,
    timeout: float,
) -> T:
    deadline = time.monotonic() + timeout
    last: T | None = None
    last_error: Exception | None = None
    while True:
        try:
            last = await asyncio.to_thread(reader)
            last_error = None
            if predicate(last):
                return last
        except Exception as exc:
            last_error = exc
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            detail = f"last={last!r}"
            if last_error is not None:
                detail += f", last_error={type(last_error).__name__}: {last_error}"
            raise AssertionError(f"timed out waiting for {description}; {detail}")
        await asyncio.sleep(min(POLL_SECONDS, remaining))


async def _wait_for_charge_window(
    oracle: BillingOracle,
    box_id: str,
    plans: Sequence[Mapping[str, Any]],
) -> tuple[Mapping[str, Any], DerivedRating]:
    deadline = time.monotonic() + CHARGE_WINDOW_TIMEOUT
    last_period: Mapping[str, Any] | None = None
    last_rating: DerivedRating | None = None
    while True:
        periods = await asyncio.to_thread(oracle.periods, box_id)
        open_periods = [period for period in periods if period.get("endAt") is None]
        if len(open_periods) == 1 and _mode(open_periods[0]) == "FULL":
            last_period = open_periods[0]
            last_rating = oracle.project_period(
                last_period, plans, datetime.now(timezone.utc)
            )
            if P1_MIN_CENTS <= last_rating.precise_cents <= P1_MAX_CENTS:
                return last_period, last_rating
            if last_rating.precise_cents > P1_MAX_CENTS:
                raise AssertionError(
                    "P1 projected charge skipped the 0.55-0.65 cent stop window: "
                    f"{decimal_text(last_rating.precise_cents)}"
                )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            precise = (
                None if last_rating is None else decimal_text(last_rating.precise_cents)
            )
            raise AssertionError(
                f"timed out waiting for P1 projected charge in [0.55, 0.65]; "
                f"lastPreciseCents={precise}, lastPeriod={last_period!r}"
            )
        await asyncio.sleep(min(POLL_SECONDS, remaining))


async def _wait_for_cumulative_target(
    oracle: BillingOracle,
    box_id: str,
    plans: Sequence[Mapping[str, Any]],
) -> tuple[list[Mapping[str, Any]], list[DerivedRating]]:
    deadline = time.monotonic() + SETTLEMENT_TIMEOUT
    last_total: Decimal | None = None
    last_periods: list[Mapping[str, Any]] = []
    while True:
        periods = await asyncio.to_thread(oracle.periods, box_id)
        ordered = sorted(
            periods,
            key=lambda row: (
                _timestamp(row.get("startAt"), "period.startAt"),
                str(row.get("id")),
            ),
        )
        if len(ordered) == 3 and [_mode(period) for period in ordered] == [
            "FULL",
            "DISK",
            "FULL",
        ]:
            ratings: list[DerivedRating] = []
            for period in ordered:
                if period.get("endAt") is None:
                    ratings.append(
                        oracle.project_period(period, plans, datetime.now(timezone.utc))
                    )
                else:
                    ratings.append(oracle.rate_period(period, plans))
            total = sum((rating.precise_cents for rating in ratings), Decimal("0"))
            last_total = total
            last_periods = ordered
            if total >= CUMULATIVE_TARGET_CENTS:
                return ordered, ratings
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            total_text = None if last_total is None else decimal_text(last_total)
            raise AssertionError(
                f"timed out waiting for P1+P2+P3 projected charge >= 1.2; "
                f"lastPreciseCents={total_text}, lastPeriods={last_periods!r}"
            )
        await asyncio.sleep(min(POLL_SECONDS, remaining))


def _runner_is_ready(row: Mapping[str, Any]) -> bool:
    return (
        row.get("schedulable") is True
        and row.get("state") == "ready"
        and row.get("apiVersion") == "2"
        and row.get("unschedulable") is False
        and row.get("draining") is False
        and _as_decimal(row.get("availabilityScore"), "runner.availabilityScore")
        >= AVAILABILITY_THRESHOLD
        and _as_decimal(row.get("cpu"), "runner.cpu") >= 2
        and _as_decimal(row.get("memoryGiB"), "runner.memoryGiB") >= 2
        and _as_decimal(row.get("diskGiB"), "runner.diskGiB") >= 10
        and row.get("lastChecked") is not None
        and row.get("runtimeEpoch") is not None
    )


def _assert_full_snapshot(snapshot: Mapping[str, Any]) -> None:
    if not (
        snapshot.get("state") == "started"
        and snapshot.get("desiredState") == "started"
        and snapshot.get("pending") is False
        and snapshot.get("runtimeAuthorized") is True
        and snapshot.get("runtimeUnavailable") is False
        and snapshot.get("periodId") is not None
        and snapshot.get("leaseActualState") == "started"
    ):
        raise AssertionError(
            f"Box does not have a confirmed FULL runtime lease: {snapshot!r}"
        )
    expected_resources = {
        "periodCpu": 2,
        "periodMem": 2,
        "periodGpu": 0,
        "periodDisk": 10,
    }
    for field, expected in expected_resources.items():
        if _as_decimal(snapshot.get(field), f"snapshot.{field}") != expected:
            raise AssertionError(f"snapshot.{field} must equal {expected}")
    if snapshot.get("periodRuntimeGeneration") != snapshot.get(
        "leaseRuntimeGeneration"
    ):
        raise AssertionError("period and lease runtime generations differ")
    if snapshot.get("runtimeGeneration") != snapshot.get("leaseRuntimeGeneration"):
        raise AssertionError("Box and lease runtime generations differ")
    if snapshot.get("periodRunnerEpoch") != snapshot.get("leaseRunnerEpoch"):
        raise AssertionError("period and lease runner epochs differ")
    validate_uuid(str(snapshot.get("leaseRunnerEpoch")), "lease.runnerEpoch")
    if snapshot.get("runnerId") != snapshot.get("leaseRunnerId"):
        raise AssertionError("Box and lease runner IDs differ")
    if not _same_instant(
        snapshot.get("computeBillableUntil"), snapshot.get("leaseExpiresAt")
    ):
        raise AssertionError(
            "period compute cap does not match the persisted lease expiry"
        )
    if _timestamp(snapshot.get("leaseExpiresAt"), "lease.expiresAt") <= _timestamp(
        snapshot.get("leaseObservedAt"), "lease.observedAt"
    ):
        raise AssertionError("runtime lease does not extend beyond its observation")


def _full_snapshot_ready(snapshot: Mapping[str, Any] | None) -> bool:
    if snapshot is None:
        return False
    try:
        _assert_full_snapshot(snapshot)
    except (AssertionError, ValueError):
        return False
    return True


def _assert_prefix(
    periods: Sequence[Mapping[str, Any]], modes: Sequence[str]
) -> list[Mapping[str, Any]]:
    if len(periods) != len(modes):
        raise AssertionError(f"expected {len(modes)} periods, got {len(periods)}")
    ordered = sorted(
        periods,
        key=lambda row: (
            _timestamp(row.get("startAt"), "period.startAt"),
            str(row.get("id")),
        ),
    )
    if [_mode(period) for period in ordered] != list(modes):
        raise AssertionError(
            f"expected period modes {list(modes)}, got {[_mode(row) for row in ordered]}"
        )
    for index, period in enumerate(ordered):
        if period.get("organizationId") is None or period.get("boxId") is None:
            raise AssertionError(f"period[{index}] is missing ownership")
        if _as_decimal(period.get("disk"), f"period[{index}].disk") != 10:
            raise AssertionError(f"period[{index}] disk must remain 10 GiB")
        if index > 0 and not _same_instant(
            ordered[index - 1].get("endAt"), period.get("startAt")
        ):
            raise AssertionError(
                f"period[{index - 1}] and period[{index}] are not adjacent"
            )
    return ordered


def _assert_period_identities(
    periods: Sequence[Mapping[str, Any]],
    expected_ids: Sequence[str],
    checkpoint: str,
) -> None:
    if len(periods) != len(expected_ids):
        raise AssertionError(
            f"{checkpoint} period identity count mismatch: "
            f"expected {len(expected_ids)}, got {len(periods)}"
        )
    for index, (period, expected_id) in enumerate(
        zip(periods, expected_ids, strict=True)
    ):
        actual_id = period.get("id")
        if actual_id != expected_id:
            raise AssertionError(
                f"{checkpoint} period identity changed at stage {index + 1}: "
                f"expected {expected_id}, got {actual_id}"
            )


def _required_period_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise AssertionError(f"{label} period identity is missing")
    return value


async def _collect_stream(stream: Any) -> str:
    if stream is None:
        return ""
    chunks: list[str] = []
    async for chunk in stream:
        chunks.append(
            chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else str(chunk)
        )
    return "".join(chunks)


async def _exec_exact(box: Any, expected: str) -> None:
    execution = await _await_with_timeout(
        "guest exec handle creation",
        box.exec("sh", ["-c", f"printf {expected}"]),
        timeout=ACTION_TIMEOUT,
    )
    stdout_task = asyncio.create_task(_collect_stream(execution.stdout()))
    stderr_task = asyncio.create_task(_collect_stream(execution.stderr()))
    try:
        status = await _await_with_timeout(
            "guest exec exit status", execution.wait(), timeout=ACTION_TIMEOUT
        )
        stdout, stderr = await _await_with_timeout(
            "guest exec output streams to close",
            asyncio.gather(stdout_task, stderr_task),
            timeout=ACTION_TIMEOUT,
        )
    finally:
        stdout_task.cancel()
        stderr_task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
    if status.exit_code != 0:
        raise AssertionError(
            f"guest exec for {expected} exited {status.exit_code}: {stderr!r}"
        )
    if stdout != expected:
        raise AssertionError(f"guest exec expected {expected!r}, got {stdout!r}")


async def _close_runtime(runtime: Any) -> None:
    close = getattr(runtime, "close", None)
    if close is None:
        return
    result = close()
    if inspect.isawaitable(result):
        await result


async def _read_stdin_line(*, timeout: float) -> str:
    file_descriptor = sys.stdin.fileno()
    loop = asyncio.get_running_loop()
    completed: asyncio.Future[bytes] = loop.create_future()
    buffer = bytearray()

    def read_available() -> None:
        if completed.done():
            return
        try:
            chunk = os.read(file_descriptor, DIAGNOSTICS_ARCHIVE_ACK_MAX_BYTES)
        except BaseException as exc:
            completed.set_exception(exc)
            return
        if not chunk:
            completed.set_exception(
                EOFError(
                    "Node orchestrator closed stdin before diagnostics archive ACK"
                )
            )
            return
        buffer.extend(chunk)
        if len(buffer) > DIAGNOSTICS_ARCHIVE_ACK_MAX_BYTES:
            completed.set_exception(
                RuntimeError("diagnostics archive ACK exceeded the protocol limit")
            )
            return
        newline = buffer.find(b"\n")
        if newline >= 0:
            completed.set_result(bytes(buffer[:newline]))

    loop.add_reader(file_descriptor, read_available)
    try:
        encoded = await _await_with_timeout(
            "Node diagnostics archive acknowledgement",
            completed,
            timeout=timeout,
        )
    finally:
        loop.remove_reader(file_descriptor)
    try:
        return encoded.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise RuntimeError("diagnostics archive ACK must be UTF-8") from exc


async def _wait_for_diagnostics_archive(box_id: str) -> Mapping[str, Any]:
    expected_box_id = validate_box_id(box_id)
    line = await _read_stdin_line(timeout=DIAGNOSTICS_ARCHIVE_ACK_TIMEOUT)
    try:
        acknowledgement = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RuntimeError("diagnostics archive ACK must be JSON") from exc
    if not isinstance(acknowledgement, Mapping):
        raise RuntimeError("diagnostics archive ACK must be an object")
    if (
        acknowledgement.get("v") != 1
        or acknowledgement.get("type") != "diagnostics-archived"
        or acknowledgement.get("boxId") != expected_box_id
    ):
        raise RuntimeError("diagnostics archive ACK does not match the target Box")
    return acknowledgement


async def _request_diagnostics_archive(
    emitter: NdjsonEmitter, box_id: str
) -> Mapping[str, Any]:
    validated_box_id = validate_box_id(box_id)
    emitter.stage("cleanup-diagnostics-ready", boxId=validated_box_id)
    return await _wait_for_diagnostics_archive(validated_box_id)


def _destruction_confirmed(snapshot: Mapping[str, Any] | None) -> bool:
    return snapshot is None or (
        snapshot.get("desiredState") == "destroyed" and snapshot.get("periodId") is None
    )


async def _force_remove_and_verify(
    runtime: Any,
    oracle: BillingOracle,
    box_id: str,
    *,
    verify_timeout: float = CLEANUP_VERIFY_TIMEOUT,
) -> Mapping[str, Any] | None:
    remove_error: Exception | None = None
    try:
        await _await_with_timeout(
            "forced box removal",
            runtime.remove(box_id, force=True),
            timeout=ACTION_TIMEOUT,
        )
    except Exception as exc:
        remove_error = exc

    try:
        return await _poll(
            "force-remove cleanup to reach destroyed NONE state",
            lambda: oracle.box_snapshot(box_id),
            _destruction_confirmed,
            timeout=verify_timeout,
        )
    except Exception as convergence_error:
        if remove_error is not None:
            raise RuntimeError(
                "force-remove RPC failed and Box destruction did not converge"
            ) from convergence_error
        raise


def _emit_cleanup_stage_safely(
    emitter: NdjsonEmitter, stage: str, **fields: Any
) -> None:
    try:
        emitter.stage(stage, **fields)
    except Exception:
        # A closed stdout consumer must not prevent the Box cleanup attempt.
        return


async def _cleanup_failed_box(
    runtime: Any,
    oracle: BillingOracle,
    box_id: str,
    emitter: NdjsonEmitter,
    *,
    active_failure: BaseException | None,
) -> None:
    diagnostics_archive_error: Exception | None = None
    try:
        await _request_diagnostics_archive(emitter, box_id)
    except Exception as archive_exc:
        diagnostics_archive_error = archive_exc
        _emit_cleanup_stage_safely(
            emitter,
            "cleanup-diagnostics-archive",
            boxId=box_id,
            acknowledged=False,
            error={
                "type": type(archive_exc).__name__,
                "message": _redacted_message(archive_exc),
            },
        )

    cleanup_error: Exception | None = None
    try:
        await _force_remove_and_verify(runtime, oracle, box_id)
        _emit_cleanup_stage_safely(
            emitter, "cleanup-force-remove", boxId=box_id, removed=True
        )
    except Exception as remove_exc:
        cleanup_error = remove_exc
        _emit_cleanup_stage_safely(
            emitter,
            "cleanup-force-remove",
            boxId=box_id,
            removed=False,
            error={
                "type": type(remove_exc).__name__,
                "message": _redacted_message(remove_exc),
            },
        )

    if active_failure is None:
        if cleanup_error is not None:
            raise cleanup_error
        if diagnostics_archive_error is not None:
            raise diagnostics_archive_error


def _period_summary(period: Mapping[str, Any], rating: DerivedRating) -> dict[str, Any]:
    return {
        "id": period.get("id"),
        "mode": _mode(period),
        "startAt": period.get("startAt"),
        "endAt": period.get("endAt"),
        "runtimeGeneration": period.get("runtimeGeneration"),
        "runnerEpoch": period.get("runnerEpoch"),
        "preciseCents": decimal_text(rating.precise_cents),
    }


def _rated_summary(rated: Mapping[str, Any]) -> dict[str, Any]:
    metadata = rated.get("transactionMetadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    amount = _as_decimal(
        rated.get("transactionAmountCents"), "rated.transactionAmountCents"
    )
    return {
        "id": rated.get("id"),
        "usagePeriodArchiveId": rated.get("usagePeriodArchiveId"),
        "preciseCents": decimal_text(
            _as_decimal(rated.get("preciseCents"), "rated.preciseCents")
        ),
        "ratedCents": decimal_text(
            _as_decimal(rated.get("ratedCents"), "rated.ratedCents")
        ),
        "transactionId": rated.get("transactionId"),
        "debitCents": decimal_text(-amount),
        "remainderBeforeCents": metadata.get("remainderBeforeCents"),
        "remainderAfterCents": metadata.get("remainderAfterCents"),
        "pricingVersions": [
            segment.get("pricingVersion")
            for segment in rated.get("pricingSegments", [])
        ],
    }


async def _run(args: argparse.Namespace, emitter: NdjsonEmitter) -> dict[str, Any]:
    api_url = _required_env("BOXLITE_E2E_API_URL")
    token = _required_env("BOXLITE_E2E_OIDC_TOKEN")
    auth_mode = os.environ.get("BOXLITE_E2E_AUTH", "oidc").replace("_", "-").lower()
    if auth_mode != "oidc":
        raise RuntimeError(f"BOXLITE_E2E_AUTH must be oidc, got {auth_mode!r}")
    configured_prefix = os.environ.get("BOXLITE_E2E_PREFIX")
    if configured_prefix is not None and configured_prefix != args.organization_id:
        raise RuntimeError("BOXLITE_E2E_PREFIX must match --organization-id")

    boxlite = importlib.import_module("boxlite")
    oracle = BillingOracle(args.organization_id)
    emitter.stage("waiting-for-runner", availabilityThreshold=AVAILABILITY_THRESHOLD)
    runners = await _poll(
        "a ready, schedulable v2 runner above the availability threshold",
        lambda: oracle.runner_readiness(AVAILABILITY_THRESHOLD),
        lambda rows: any(_runner_is_ready(row) for row in rows),
        timeout=STATE_TIMEOUT,
    )
    ready_runner = next(row for row in runners if _runner_is_ready(row))
    emitter.stage(
        "runner-ready",
        runner={
            "id": ready_runner.get("id"),
            "name": ready_runner.get("name"),
            "apiVersion": ready_runner.get("apiVersion"),
            "availabilityScore": ready_runner.get("availabilityScore"),
        },
    )

    baseline = await asyncio.to_thread(oracle.assert_pristine_baseline)
    emitter.stage(
        "baseline-verified",
        wallet={
            "freeBalanceCents": baseline["wallet"]["freeBalanceCents"],
            "paidBalanceCents": baseline["wallet"]["paidBalanceCents"],
            "remainderCents": baseline["wallet"]["settlementRemainderCents"],
        },
    )
    plans = await asyncio.to_thread(oracle.pricing_plans)
    if not plans:
        raise AssertionError("no pricing plans are persisted")

    runtime = boxlite.Boxlite.rest(
        boxlite.BoxliteRestOptions(
            url=api_url,
            credential=boxlite.ApiKeyCredential(token),
            path_prefix=args.organization_id,
        )
    )
    box: Any | None = None
    removed = False
    active_failure: BaseException | None = None
    try:
        emitter.stage("creating-box", image=args.image, name=args.name)
        box = await _await_with_timeout(
            "box creation",
            runtime.create(
                boxlite.BoxOptions(
                    image=args.image,
                    cpus=2,
                    memory_mib=2048,
                    disk_size_gb=10,
                    auto_remove=False,
                ),
                name=args.name,
            ),
            timeout=ACTION_TIMEOUT,
        )
        box_id = validate_box_id(box.id)
        emitter.stage("box-created", boxId=box_id)

        full_one = await _poll(
            "FULL1 with matching persisted runtime lease",
            lambda: oracle.box_snapshot(box_id),
            _full_snapshot_ready,
            timeout=STATE_TIMEOUT,
        )
        _assert_full_snapshot(full_one)
        full_one_period_id = _required_period_id(
            full_one.get("periodId"), "FULL1 snapshot"
        )
        emitter.stage(
            "full1-confirmed",
            boxId=box_id,
            periodId=full_one["periodId"],
            runtimeGeneration=full_one["periodRuntimeGeneration"],
        )

        heartbeat = await _poll(
            "a heartbeat extension of FULL1",
            lambda: oracle.box_snapshot(box_id),
            lambda row: bool(
                _full_snapshot_ready(row)
                and row["periodId"] == full_one["periodId"]
                and row["periodRuntimeGeneration"]
                == full_one["periodRuntimeGeneration"]
                and row["periodRunnerEpoch"] == full_one["periodRunnerEpoch"]
                and _timestamp(row["leaseObservedAt"], "lease.observedAt")
                > _timestamp(full_one["leaseObservedAt"], "initial lease.observedAt")
                and _timestamp(row["leaseExpiresAt"], "lease.expiresAt")
                > _timestamp(full_one["leaseExpiresAt"], "initial lease.expiresAt")
                and _timestamp(
                    row["computeBillableUntil"], "period.computeBillableUntil"
                )
                > _timestamp(
                    full_one["computeBillableUntil"],
                    "initial period.computeBillableUntil",
                )
            ),
            timeout=HEARTBEAT_TIMEOUT,
        )
        _assert_full_snapshot(heartbeat)
        emitter.stage("full1-heartbeat-extended", periodId=heartbeat["periodId"])
        await _exec_exact(box, "golden-1")
        emitter.stage("full1-exec-verified", output="golden-1")

        _, p1_projection = await _wait_for_charge_window(oracle, box_id, plans)
        emitter.stage(
            "full1-stop-window",
            projectedPreciseCents=decimal_text(p1_projection.precise_cents),
        )
        await _await_with_timeout("box stop", box.stop(), timeout=ACTION_TIMEOUT)

        stopped_once = await _poll(
            "FULL1 to close and DISK1 to open",
            lambda: oracle.periods(box_id),
            lambda rows: (
                len(rows) == 2
                and [
                    _mode(row)
                    for row in sorted(
                        rows, key=lambda p: _timestamp(p["startAt"], "period.startAt")
                    )
                ]
                == ["FULL", "DISK"]
                and sum(row.get("endAt") is None for row in rows) == 1
            ),
            timeout=STATE_TIMEOUT,
        )
        first_two = _assert_prefix(stopped_once, ("FULL", "DISK"))
        disk_one_period_id = _required_period_id(first_two[1].get("id"), "DISK1")
        _assert_period_identities(
            first_two, (full_one_period_id, disk_one_period_id), "DISK1 open"
        )
        if first_two[0].get("endAt") is None or first_two[1].get("endAt") is not None:
            raise AssertionError("stop must close FULL1 and leave DISK1 open")
        emitter.stage("disk1-opened", periodId=first_two[1]["id"])

        partial = await _poll(
            "FULL1 archive, rating, and zero-cent debit while DISK1 stays open",
            lambda: {
                "periods": oracle.periods(box_id),
                "rated": oracle.rated_periods(box_id),
                "wallet": oracle.wallet(),
            },
            lambda state: (
                len(state["rated"]) == 1
                and state["rated"][0].get("transactionId") is not None
                and state["rated"][0].get("transactionAmountCents") == "0"
                and any(
                    _mode(row) == "DISK" and row.get("endAt") is None
                    for row in state["periods"]
                )
            ),
            timeout=SETTLEMENT_TIMEOUT,
        )
        first_two = _assert_prefix(partial["periods"], ("FULL", "DISK"))
        _assert_period_identities(
            first_two,
            (full_one_period_id, disk_one_period_id),
            "FULL1 settlement",
        )
        if first_two[1].get("endAt") is not None:
            raise AssertionError("DISK1 closed before the first settlement checkpoint")
        full_one_period = first_two[0]
        rated_one = partial["rated"][0]
        p1_actual = oracle.assert_rated_period(full_one_period, rated_one, plans)
        _assert_p1_settlement_target(p1_actual.precise_cents)
        if partial["wallet"] is None:
            raise AssertionError("wallet disappeared during partial settlement")
        partial_ledger = oracle.assert_wallet_ledger(
            partial["wallet"], partial["rated"]
        )
        if partial_ledger["debitCents"] != 0:
            raise AssertionError("P1 must create a zero-cent usage debit")
        if partial_ledger["remainderCents"] != p1_actual.precise_cents:
            raise AssertionError(
                "P1 precise charge must be carried entirely as remainder"
            )
        if (
            partial_ledger["freeBalanceCents"] != 0
            or partial_ledger["paidBalanceCents"] != 2500
        ):
            raise AssertionError("zero-cent P1 debit changed wallet balances")
        emitter.stage(
            "full1-settled",
            preciseCents=decimal_text(p1_actual.precise_cents),
            debitCents="0",
            remainderCents=decimal_text(partial_ledger["remainderCents"]),
        )

        await _poll(
            "the first physical stop to finish",
            lambda: oracle.box_snapshot(box_id),
            lambda row: bool(
                row
                and row.get("state") == "stopped"
                and row.get("desiredState") == "stopped"
                and row.get("pending") is False
                and row.get("periodId") == disk_one_period_id
            ),
            timeout=PHYSICAL_STOP_TIMEOUT,
        )
        await _await_with_timeout("box restart", box.start(), timeout=ACTION_TIMEOUT)

        restarted = await _poll(
            "adjacent FULL2 with a newer runtime generation",
            lambda: {
                "snapshot": oracle.box_snapshot(box_id),
                "periods": oracle.periods(box_id),
            },
            lambda state: (
                _full_snapshot_ready(state["snapshot"])
                and len(state["periods"]) == 3
                and sum(row.get("endAt") is None for row in state["periods"]) == 1
            ),
            timeout=STATE_TIMEOUT,
        )
        first_three = _assert_prefix(restarted["periods"], ("FULL", "DISK", "FULL"))
        full_two_period_id = _required_period_id(
            restarted["snapshot"].get("periodId"), "FULL2 snapshot"
        )
        _assert_period_identities(
            first_three,
            (full_one_period_id, disk_one_period_id, full_two_period_id),
            "FULL2 open",
        )
        if first_three[2].get("endAt") is not None:
            raise AssertionError("FULL2 must remain open after restart")
        first_generation = int(str(first_three[0].get("runtimeGeneration")))
        second_generation = int(str(first_three[2].get("runtimeGeneration")))
        if second_generation <= first_generation:
            raise AssertionError("FULL2 must use a newer runtime generation")
        if restarted["snapshot"]["periodRuntimeGeneration"] != str(second_generation):
            raise AssertionError(
                "FULL2 period generation does not match the runtime lease"
            )
        emitter.stage(
            "full2-confirmed",
            periodId=first_three[2]["id"],
            runtimeGeneration=str(second_generation),
        )
        await _exec_exact(box, "golden-2")
        emitter.stage("full2-exec-verified", output="golden-2")

        _, projected_ratings = await _wait_for_cumulative_target(oracle, box_id, plans)
        projected_total = sum(
            (rating.precise_cents for rating in projected_ratings), Decimal("0")
        )
        emitter.stage(
            "cumulative-stop-target",
            projectedPreciseCents=decimal_text(projected_total),
        )
        await _await_with_timeout("box stop", box.stop(), timeout=ACTION_TIMEOUT)

        stopped_twice = await _poll(
            "FULL2 to close and DISK2 to open",
            lambda: oracle.periods(box_id),
            lambda rows: (
                len(rows) == 4
                and sum(row.get("endAt") is None for row in rows) == 1
                and any(
                    _mode(row) == "DISK" and row.get("endAt") is None for row in rows
                )
            ),
            timeout=STATE_TIMEOUT,
        )
        first_four = _assert_prefix(stopped_twice, ("FULL", "DISK", "FULL", "DISK"))
        disk_two_period_id = _required_period_id(first_four[3].get("id"), "DISK2")
        _assert_period_identities(
            first_four,
            (
                full_one_period_id,
                disk_one_period_id,
                full_two_period_id,
                disk_two_period_id,
            ),
            "DISK2 open",
        )
        if first_four[3].get("endAt") is not None:
            raise AssertionError("DISK2 must be open before destroy")
        emitter.stage("disk2-opened", periodId=first_four[3]["id"])
        await _poll(
            "the second physical stop to finish",
            lambda: oracle.box_snapshot(box_id),
            lambda row: bool(
                row
                and row.get("state") == "stopped"
                and row.get("desiredState") == "stopped"
                and row.get("pending") is False
                and row.get("periodId") == disk_two_period_id
            ),
            timeout=PHYSICAL_STOP_TIMEOUT,
        )

        await _request_diagnostics_archive(emitter, box_id)
        await _await_with_timeout(
            "forced box removal",
            runtime.remove(box_id, force=True),
            timeout=ACTION_TIMEOUT,
        )
        none_state = await _poll(
            "NONE state with four closed periods",
            lambda: {
                "snapshot": oracle.box_snapshot(box_id),
                "periods": oracle.periods(box_id),
            },
            lambda state: bool(
                _destruction_confirmed(state["snapshot"])
                and len(state["periods"]) == 4
                and all(row.get("endAt") is not None for row in state["periods"])
            ),
            timeout=STATE_TIMEOUT,
        )
        closed_periods = oracle.assert_four_period_topology(none_state["periods"])
        lifecycle_period_ids = (
            full_one_period_id,
            disk_one_period_id,
            full_two_period_id,
            disk_two_period_id,
        )
        _assert_period_identities(closed_periods, lifecycle_period_ids, "NONE")
        removed = True
        emitter.stage("none-confirmed", boxId=box_id, periodCount=4)

        await _poll(
            "four archived, rated, and debited periods",
            lambda: {
                "periods": oracle.periods(box_id),
                "rated": oracle.rated_periods(box_id),
            },
            lambda state: (
                len(state["periods"]) == 4
                and all(row.get("archived") is True for row in state["periods"])
                and len(state["rated"]) == 4
                and all(row.get("transactionId") is not None for row in state["rated"])
            ),
            timeout=SETTLEMENT_TIMEOUT,
        )
        settlement = await asyncio.to_thread(oracle.assert_exact_settlement, box_id)
        _assert_period_identities(
            settlement["periods"], lifecycle_period_ids, "final settlement"
        )
        derived_total = sum(
            (rating.precise_cents for rating in settlement["derived"]),
            Decimal("0"),
        )
        if derived_total != settlement["totalPreciseCents"]:
            raise AssertionError(
                "independently derived total does not match settled precise usage"
            )
        _assert_final_settlement_target(derived_total)
        emitter.stage(
            "settlement-verified",
            totalPreciseCents=decimal_text(settlement["totalPreciseCents"]),
            debitCents=decimal_text(settlement["debitCents"]),
            remainderCents=decimal_text(settlement["remainderCents"]),
        )
        wallet = settlement["wallet"]
        return {
            "organizationId": args.organization_id,
            "boxId": box_id,
            "totalPreciseCents": decimal_text(settlement["totalPreciseCents"]),
            "debitCents": decimal_text(settlement["debitCents"]),
            "remainderCents": decimal_text(settlement["remainderCents"]),
            "wallet": {
                "freeBalanceCents": decimal_text(
                    _as_decimal(wallet["freeBalanceCents"], "wallet.freeBalanceCents")
                ),
                "paidBalanceCents": decimal_text(
                    _as_decimal(wallet["paidBalanceCents"], "wallet.paidBalanceCents")
                ),
            },
            "periods": [
                _period_summary(period, rating)
                for period, rating in zip(
                    settlement["periods"], settlement["derived"], strict=True
                )
            ],
            "ratedPeriods": [
                _rated_summary(rated) for rated in settlement["ratedPeriods"]
            ],
        }
    except BaseException as exc:
        active_failure = exc
        raise
    finally:
        if box is not None and not removed:
            await _cleanup_failed_box(
                runtime,
                oracle,
                box.id,
                emitter,
                active_failure=active_failure,
            )
        try:
            await _await_with_timeout(
                "REST runtime close", _close_runtime(runtime), timeout=CLOSE_TIMEOUT
            )
        except Exception as close_exc:
            emitter.stage(
                "cleanup-runtime-close",
                closed=False,
                error={
                    "type": type(close_exc).__name__,
                    "message": _redacted_message(close_exc),
                },
            )
            if active_failure is None:
                raise


async def _bounded_run(
    args: argparse.Namespace, emitter: NdjsonEmitter
) -> dict[str, Any]:
    return await _await_with_timeout(
        "the complete billing golden path",
        _run(args, emitter),
        timeout=OVERALL_TIMEOUT,
    )


def main(argv: Sequence[str] | None = None) -> int:
    emitter = NdjsonEmitter()
    emitter.stage("starting")
    try:
        args = _parse_args(argv)
        result = asyncio.run(_bounded_run(args, emitter))
    except BaseException as exc:
        emitter.error(type(exc).__name__, _redacted_message(exc))
        return 1
    emitter.result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
