"""Pure tests for the billing golden-path oracle."""

from __future__ import annotations

import asyncio
import copy
import os
import subprocess
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from scripts.test.e2e.drivers import billing_golden_metering
from scripts.test.e2e.drivers.billing_golden_metering import (
    _assert_final_settlement_target,
    _assert_p1_settlement_target,
    _await_with_timeout,
    _cleanup_failed_box,
    _close_runtime,
    _destruction_confirmed,
    _exec_exact,
    _force_remove_and_verify,
    _run,
    _wait_for_diagnostics_archive,
)
from scripts.test.e2e.lib.billing_oracle import (
    BillingOracle,
    DerivedRating,
    validate_box_id,
    validate_uuid,
)

ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111"
BOX_ID = "Ab12Cd34Ef56"
WALLET_ID = "22222222-2222-4222-8222-222222222222"
UTC = timezone.utc


def oracle() -> BillingOracle:
    return BillingOracle(ORGANIZATION_ID, query=lambda _sql, _variables: None)


def test_psql_transport_sends_sql_on_stdin_for_variable_substitution(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["input"] = kwargs.get("input")
        return subprocess.CompletedProcess(command, 0, stdout="[]\n", stderr="")

    monkeypatch.setattr(
        "scripts.test.e2e.lib.billing_oracle.subprocess.run",
        fake_run,
    )
    database_oracle = BillingOracle(
        ORGANIZATION_ID,
        environ={
            "BILLING_E2E_DB_HOST": "localhost",
            "BILLING_E2E_DB_PORT": "15432",
            "BILLING_E2E_DB_USERNAME": "postgres",
            "BILLING_E2E_DB_PASSWORD": "postgres",
            "BILLING_E2E_DB_DATABASE": "boxlite_bg_111111111111",
        },
    )

    assert database_oracle.runner_readiness(10) == []
    assert "-c" not in captured["command"]
    assert "--set=availability_threshold=10" in captured["command"]
    assert isinstance(captured["input"], str)
    assert "availability_threshold" in captured["input"]


def test_psql_transport_preserves_database_error(monkeypatch) -> None:
    def fake_run(command, **_kwargs):
        raise subprocess.CalledProcessError(
            3,
            command,
            stderr="ERROR: relation wallet does not exist\n",
        )

    monkeypatch.setattr(
        "scripts.test.e2e.lib.billing_oracle.subprocess.run",
        fake_run,
    )
    database_oracle = BillingOracle(
        ORGANIZATION_ID,
        environ={
            "BILLING_E2E_DB_HOST": "localhost",
            "BILLING_E2E_DB_PORT": "15432",
            "BILLING_E2E_DB_USERNAME": "postgres",
            "BILLING_E2E_DB_PASSWORD": "postgres",
            "BILLING_E2E_DB_DATABASE": "boxlite_bg_111111111111",
        },
    )

    with pytest.raises(RuntimeError, match="relation wallet does not exist"):
        database_oracle.wallet()


def test_usage_period_queries_match_varchar_organization_ids() -> None:
    queries: list[str] = []

    def capture_query(sql, _variables):
        queries.append(sql)
        return []

    database_oracle = BillingOracle(ORGANIZATION_ID, query=capture_query)
    database_oracle.organization_usage_counts()
    database_oracle.periods(BOX_ID)

    assert queries[0].count("::uuid") == 1
    assert queries[1].count("::uuid") == 0


def test_ownership_queries_do_not_filter_out_rows_linked_to_the_target() -> None:
    queries: list[str] = []

    def capture_query(sql, _variables):
        queries.append(" ".join(sql.split()))
        return []

    database_oracle = BillingOracle(ORGANIZATION_ID, query=capture_query)
    database_oracle.top_ups()
    database_oracle.periods(BOX_ID)
    database_oracle.rated_periods(BOX_ID)

    assert 'OR t."walletId" = (' in queries[0]
    assert (
        "SELECT w.id FROM wallet w WHERE "
        "w.\"organizationId\" = (:'organization_id')::uuid" in queries[0]
    )
    assert "AND \"organizationId\" = (:'organization_id')" not in queries[1]
    assert "AND rp.\"organizationId\" = (:'organization_id')::uuid" not in queries[2]


def plan(
    version: int,
    start: datetime,
    end: datetime | None,
    *,
    cpu: str,
    mem: str = "0",
    disk: str = "0",
    gpu: str = "0",
) -> dict[str, object]:
    return {
        "version": version,
        "effectiveFrom": start.isoformat(),
        "effectiveTo": None if end is None else end.isoformat(),
        "cpuRateCentsPerSec": cpu,
        "memRateCentsPerSec": mem,
        "diskRateCentsPerSec": disk,
        "gpuRateCentsPerSec": gpu,
    }


def period(start: datetime, end: datetime, **overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "30000000-0000-4000-8000-000000000001",
        "boxId": BOX_ID,
        "organizationId": ORGANIZATION_ID,
        "startAt": start.isoformat(),
        "endAt": end.isoformat(),
        "computeBillableUntil": end.isoformat(),
        "runtimeGeneration": "1",
        "runnerEpoch": "40000000-0000-4000-8000-000000000001",
        "cpu": "1",
        "mem": "0",
        "disk": "0",
        "gpu": "0",
        "archived": True,
    }
    row.update(overrides)
    return row


def rated_from(period_row: dict[str, object], rating) -> dict[str, object]:
    summary = rating.summary()
    return {
        "id": "50000000-0000-4000-8000-000000000001",
        "usagePeriodArchiveId": period_row["id"],
        "organizationId": ORGANIZATION_ID,
        "boxId": BOX_ID,
        "startAt": period_row["startAt"],
        "endAt": period_row["endAt"],
        "cpu": period_row["cpu"],
        "mem": period_row["mem"],
        "disk": period_row["disk"],
        "gpu": period_row["gpu"],
        **summary,
    }


def test_rate_period_splits_exactly_at_adjacent_plan_boundary() -> None:
    start = datetime(2026, 7, 8, tzinfo=UTC)
    boundary = start + timedelta(seconds=30)
    end = start + timedelta(seconds=60)
    rating = oracle().rate_period(
        period(start, end),
        [
            plan(1, start - timedelta(days=1), boundary, cpu="0.01"),
            plan(2, boundary, None, cpu="0.02"),
        ],
    )
    assert [segment.pricing_version for segment in rating.segments] == [1, 2]
    assert [segment.billed_seconds for segment in rating.segments] == [30, 30]
    assert [segment.precise_cents for segment in rating.segments] == [
        Decimal("0.3"),
        Decimal("0.6"),
    ]
    assert rating.precise_cents == Decimal("0.9")
    assert rating.rated_cents == 1


@pytest.mark.parametrize(
    ("plans", "message"),
    [
        (
            lambda start: [
                plan(
                    1,
                    start - timedelta(days=1),
                    start + timedelta(seconds=20),
                    cpu="0.01",
                ),
                plan(2, start + timedelta(seconds=30), None, cpu="0.02"),
            ],
            "pricing gap",
        ),
        (
            lambda start: [
                plan(
                    1,
                    start - timedelta(days=1),
                    start + timedelta(seconds=40),
                    cpu="0.01",
                ),
                plan(2, start + timedelta(seconds=30), None, cpu="0.02"),
            ],
            "pricing overlap",
        ),
    ],
)
def test_rate_period_rejects_plan_gap_and_overlap(plans, message: str) -> None:
    start = datetime(2026, 7, 8, tzinfo=UTC)
    with pytest.raises(AssertionError, match=message):
        oracle().rate_period(period(start, start + timedelta(seconds=60)), plans(start))


def test_assert_rated_period_rejects_tampered_persisted_segment_boundary() -> None:
    start = datetime(2026, 7, 8, tzinfo=UTC)
    boundary = start + timedelta(seconds=30)
    end = start + timedelta(seconds=60)
    plans = [
        plan(1, start - timedelta(days=1), boundary, cpu="0.01"),
        plan(2, boundary, None, cpu="0.02"),
    ]
    raw = period(start, end)
    expected = oracle().rate_period(raw, plans)
    persisted = rated_from(raw, expected)
    persisted["pricingSegments"] = copy.deepcopy(persisted["pricingSegments"])
    persisted["pricingSegments"][0]["endAt"] = (
        boundary + timedelta(seconds=1)
    ).isoformat()
    with pytest.raises(AssertionError, match=r"segment\[0\]\.endAt mismatch"):
        oracle().assert_rated_period(raw, persisted, plans)


def test_assert_rated_period_rejects_zero_independently_derived_charge() -> None:
    start = datetime(2026, 7, 8, tzinfo=UTC)
    end = start + timedelta(seconds=10)
    raw = period(
        start,
        end,
        cpu="0",
        mem="0",
        disk="10",
        gpu="0",
        computeBillableUntil=None,
        runtimeGeneration=None,
        runnerEpoch=None,
    )
    pricing = [plan(1, start - timedelta(days=1), None, cpu="0", disk="0")]
    persisted = rated_from(raw, oracle().rate_period(raw, pricing))

    with pytest.raises(
        AssertionError, match=r"independently derived precise charge must be positive"
    ):
        oracle().assert_rated_period(raw, persisted, pricing)


@pytest.mark.parametrize(("rate", "expected"), [("0.5", 1), ("0.499", 0), ("1.5", 2)])
def test_rate_period_rounds_aggregate_half_up(rate: str, expected: int) -> None:
    start = datetime(2026, 7, 8, tzinfo=UTC)
    rating = oracle().rate_period(
        period(start, start + timedelta(seconds=1)),
        [plan(1, start - timedelta(days=1), None, cpu=rate)],
    )
    assert rating.rated_cents == expected


def transaction(
    transaction_id: str,
    created_at: datetime,
    *,
    kind: str,
    amount: str,
    source: str,
    rated_id: str | None = None,
    metadata: dict[str, str] | None = None,
) -> dict[str, object]:
    return {
        "id": transaction_id,
        "walletId": WALLET_ID,
        "organizationId": ORGANIZATION_ID,
        "kind": kind,
        "amountCents": amount,
        "source": source,
        "ratedPeriodId": rated_id,
        "metadata": metadata,
        "createdAt": created_at.isoformat(),
    }


def test_wallet_ledger_carries_point_six_twice_and_spends_free_before_paid() -> None:
    created = datetime(2026, 7, 8, tzinfo=UTC)
    rated_one = "60000000-0000-4000-8000-000000000001"
    rated_two = "60000000-0000-4000-8000-000000000002"
    debit_one = "70000000-0000-4000-8000-000000000003"
    debit_two = "70000000-0000-4000-8000-000000000004"
    transactions = [
        transaction(
            "70000000-0000-4000-8000-000000000001",
            created,
            kind="free_grant",
            amount="1",
            source="trial_grant",
        ),
        transaction(
            "70000000-0000-4000-8000-000000000002",
            created + timedelta(seconds=1),
            kind="top_up",
            amount="1",
            source="manual_top_up",
        ),
        transaction(
            debit_one,
            created + timedelta(seconds=2),
            kind="usage_debit",
            amount="0",
            source="rated_period",
            rated_id=rated_one,
            metadata={
                "preciseCents": "0.6",
                "remainderBeforeCents": "0",
                "remainderAfterCents": "0.6",
                "freeDebitCents": "0",
                "paidDebitCents": "0",
            },
        ),
        transaction(
            debit_two,
            created + timedelta(seconds=3),
            kind="usage_debit",
            amount="-1",
            source="rated_period",
            rated_id=rated_two,
            metadata={
                "preciseCents": "0.6",
                "remainderBeforeCents": "0.6",
                "remainderAfterCents": "0.2",
                "freeDebitCents": "1",
                "paidDebitCents": "0",
            },
        ),
    ]
    wallet = {
        "id": WALLET_ID,
        "organizationId": ORGANIZATION_ID,
        "freeBalanceCents": "0",
        "paidBalanceCents": "1",
        "settlementRemainderCents": "0.2",
        "transactions": transactions,
    }
    rated = [
        {
            "id": rated_one,
            "preciseCents": "0.6",
            "transactionId": debit_one,
            "transactionAmountCents": "0",
        },
        {
            "id": rated_two,
            "preciseCents": "0.6",
            "transactionId": debit_two,
            "transactionAmountCents": "-1",
        },
    ]
    result = oracle().assert_wallet_ledger(wallet, rated)
    assert result["debitCents"] == 1
    assert result["remainderCents"] == Decimal("0.2")
    assert result["freeBalanceCents"] == 0
    assert result["paidBalanceCents"] == 1


def test_wallet_ledger_rejects_usage_debits_out_of_rated_period_order() -> None:
    created = datetime(2026, 7, 8, tzinfo=UTC)
    rated_one = "60000000-0000-4000-8000-000000000001"
    rated_two = "60000000-0000-4000-8000-000000000002"
    debit_one = "70000000-0000-4000-8000-000000000001"
    debit_two = "70000000-0000-4000-8000-000000000002"
    transactions = [
        transaction(
            "70000000-0000-4000-8000-000000000000",
            created,
            kind="top_up",
            amount="2",
            source="manual_top_up",
        ),
        transaction(
            debit_one,
            created + timedelta(seconds=1),
            kind="usage_debit",
            amount="0",
            source="rated_period",
            rated_id=rated_one,
            metadata={
                "preciseCents": "0.6",
                "remainderBeforeCents": "0",
                "remainderAfterCents": "0.6",
                "freeDebitCents": "0",
                "paidDebitCents": "0",
            },
        ),
        transaction(
            debit_two,
            created + timedelta(seconds=2),
            kind="usage_debit",
            amount="-1",
            source="rated_period",
            rated_id=rated_two,
            metadata={
                "preciseCents": "0.6",
                "remainderBeforeCents": "0.6",
                "remainderAfterCents": "0.2",
                "freeDebitCents": "0",
                "paidDebitCents": "1",
            },
        ),
    ]
    wallet = {
        "id": WALLET_ID,
        "organizationId": ORGANIZATION_ID,
        "freeBalanceCents": "0",
        "paidBalanceCents": "1",
        "settlementRemainderCents": "0.2",
        "transactions": transactions,
    }
    rated = [
        {
            "id": rated_two,
            "preciseCents": "0.6",
            "transactionId": debit_two,
            "transactionAmountCents": "-1",
        },
        {
            "id": rated_one,
            "preciseCents": "0.6",
            "transactionId": debit_one,
            "transactionAmountCents": "0",
        },
    ]

    with pytest.raises(AssertionError, match=r"usage debit order"):
        oracle().assert_wallet_ledger(wallet, rated)


def four_periods() -> list[dict[str, object]]:
    start = datetime(2026, 7, 8, tzinfo=UTC)
    rows: list[dict[str, object]] = []
    modes = ("FULL", "DISK", "FULL", "DISK")
    for index, mode in enumerate(modes):
        row = period(
            start + timedelta(seconds=index * 10),
            start + timedelta(seconds=(index + 1) * 10),
            id=f"30000000-0000-4000-8000-00000000000{index + 1}",
            cpu="2" if mode == "FULL" else "0",
            mem="2" if mode == "FULL" else "0",
            gpu="0",
            disk="10",
            runtimeGeneration=str(1 + index // 2) if mode == "FULL" else None,
            runnerEpoch=f"40000000-0000-4000-8000-00000000000{1 + index // 2}"
            if mode == "FULL"
            else None,
            computeBillableUntil=(
                start + timedelta(seconds=(index + 1) * 10)
            ).isoformat()
            if mode == "FULL"
            else None,
        )
        rows.append(row)
    return rows


def test_four_period_topology_accepts_strict_adjacent_full_disk_cycle() -> None:
    ordered = oracle().assert_four_period_topology(four_periods())
    assert [row["runtimeGeneration"] for row in ordered] == ["1", None, "2", None]


@pytest.mark.parametrize("period_index", range(4))
def test_four_period_topology_rejects_zero_duration(period_index: int) -> None:
    rows = four_periods()
    boundaries = [
        datetime.fromisoformat(str(rows[0]["startAt"])),
        *(datetime.fromisoformat(str(row["endAt"])) for row in rows),
    ]
    boundaries[period_index + 1] = boundaries[period_index]
    for index, row in enumerate(rows):
        row["startAt"] = boundaries[index].isoformat()
        row["endAt"] = boundaries[index + 1].isoformat()
        if row["runtimeGeneration"] is not None:
            row["computeBillableUntil"] = boundaries[index + 1].isoformat()

    with pytest.raises(AssertionError, match=r"positive duration"):
        oracle().assert_four_period_topology(rows)


@pytest.mark.parametrize("mutation", ["gap", "wrong_mode", "stale_generation"])
def test_four_period_topology_rejects_structural_tampering(mutation: str) -> None:
    rows = four_periods()
    if mutation == "gap":
        rows[1]["startAt"] = (
            datetime(2026, 7, 8, tzinfo=UTC) + timedelta(seconds=11)
        ).isoformat()
    elif mutation == "wrong_mode":
        rows[1]["cpu"] = "2"
        rows[1]["mem"] = "2"
        rows[1]["runtimeGeneration"] = "1"
        rows[1]["runnerEpoch"] = "40000000-0000-4000-8000-000000000001"
        rows[1]["computeBillableUntil"] = rows[1]["endAt"]
    else:
        rows[2]["runtimeGeneration"] = "1"
    with pytest.raises(AssertionError):
        oracle().assert_four_period_topology(rows)


def test_identifier_validation_rejects_noncanonical_uuid_and_unsafe_box_id() -> None:
    assert validate_uuid(ORGANIZATION_ID) == ORGANIZATION_ID
    assert validate_box_id(BOX_ID) == BOX_ID
    with pytest.raises(ValueError):
        validate_uuid("{11111111-1111-4111-8111-111111111111}")
    with pytest.raises(ValueError):
        validate_box_id("abc'; DROP--")


@pytest.mark.parametrize(
    "precise_cents", [Decimal("0.55"), Decimal("0.60"), Decimal("0.65")]
)
def test_p1_settlement_target_accepts_inclusive_persisted_window(
    precise_cents: Decimal,
) -> None:
    _assert_p1_settlement_target(precise_cents)


@pytest.mark.parametrize("precise_cents", [Decimal("0.549999"), Decimal("0.650001")])
def test_p1_settlement_target_rejects_charge_outside_persisted_window(
    precise_cents: Decimal,
) -> None:
    with pytest.raises(AssertionError, match=r"persisted P1 precise charge"):
        _assert_p1_settlement_target(precise_cents)


@pytest.mark.parametrize("total_precise_cents", [Decimal("1.2"), Decimal("1.200001")])
def test_final_settlement_target_accepts_minimum_or_greater(
    total_precise_cents: Decimal,
) -> None:
    _assert_final_settlement_target(total_precise_cents)


def test_final_settlement_target_rejects_persisted_total_below_minimum() -> None:
    with pytest.raises(AssertionError, match=r"persisted total precise charge"):
        _assert_final_settlement_target(Decimal("1.199999"))


@pytest.mark.parametrize(
    ("snapshot", "expected"),
    [
        (None, True),
        ({"desiredState": "destroyed", "periodId": None}, True),
        ({"desiredState": "destroyed", "periodId": "period-1"}, False),
        ({"desiredState": "stopped", "periodId": None}, False),
    ],
)
def test_destruction_confirmation_requires_destroyed_none_state(
    snapshot: dict[str, object] | None,
    expected: bool,
) -> None:
    assert _destruction_confirmed(snapshot) is expected


def test_force_remove_cleanup_retries_rpc_and_verifies_destroyed_state() -> None:
    class Runtime:
        def __init__(self) -> None:
            self.removed: list[tuple[str, bool]] = []

        async def remove(self, box_id: str, *, force: bool) -> None:
            self.removed.append((box_id, force))

    class Oracle:
        def box_snapshot(self, box_id: str) -> dict[str, object]:
            assert box_id == BOX_ID
            return {"desiredState": "destroyed", "periodId": None}

    runtime = Runtime()
    snapshot = asyncio.run(
        _force_remove_and_verify(runtime, Oracle(), BOX_ID, verify_timeout=0.01)
    )

    assert runtime.removed == [(BOX_ID, True)]
    assert snapshot == {"desiredState": "destroyed", "periodId": None}


def test_force_remove_cleanup_rejects_unconfirmed_destruction() -> None:
    class Runtime:
        async def remove(self, _box_id: str, *, force: bool) -> None:
            assert force is True

    class Oracle:
        def box_snapshot(self, _box_id: str) -> dict[str, object]:
            return {"desiredState": "stopped", "periodId": None}

    with pytest.raises(
        AssertionError, match=r"timed out waiting for force-remove cleanup"
    ):
        asyncio.run(
            _force_remove_and_verify(Runtime(), Oracle(), BOX_ID, verify_timeout=0.001)
        )


def test_runtime_close_can_be_bounded_by_wait_for() -> None:
    class Runtime:
        async def close(self) -> None:
            await asyncio.sleep(1)

    async def close_with_timeout() -> None:
        await asyncio.wait_for(_close_runtime(Runtime()), timeout=0.001)

    with pytest.raises(TimeoutError):
        asyncio.run(close_with_timeout())


def test_await_with_timeout_reports_the_blocked_action() -> None:
    async def never_finishes() -> None:
        await asyncio.sleep(1)

    with pytest.raises(
        TimeoutError, match=r"timed out after 0.001s waiting for guest exec"
    ):
        asyncio.run(_await_with_timeout("guest exec", never_finishes(), timeout=0.001))


def test_await_with_timeout_preserves_nested_timeout_context() -> None:
    async def nested_timeout() -> None:
        raise TimeoutError("timed out waiting for the real nested action")

    with pytest.raises(
        TimeoutError, match=r"^timed out waiting for the real nested action$"
    ):
        asyncio.run(_await_with_timeout("outer operation", nested_timeout(), timeout=1))


def test_diagnostics_archive_ack_matches_the_target_box(monkeypatch) -> None:
    read_descriptor, write_descriptor = os.pipe()
    with (
        os.fdopen(read_descriptor, "r", encoding="utf-8") as input_stream,
        os.fdopen(write_descriptor, "w", encoding="utf-8") as output_stream,
    ):
        output_stream.write(
            f'{{"v":1,"type":"diagnostics-archived","boxId":"{BOX_ID}",'
            '"status":"archived"}\n'
        )
        output_stream.flush()
        monkeypatch.setattr(billing_golden_metering.sys, "stdin", input_stream)
        acknowledgement = asyncio.run(_wait_for_diagnostics_archive(BOX_ID))

    assert acknowledgement["status"] == "archived"


def test_cleanup_failure_is_primary_only_without_a_business_failure(
    monkeypatch,
) -> None:
    stages: list[str] = []

    async def acknowledge(_box_id: str) -> None:
        return None

    async def fail_cleanup(*_args, **_kwargs) -> None:
        raise RuntimeError("cleanup failed")

    monkeypatch.setattr(
        billing_golden_metering,
        "_wait_for_diagnostics_archive",
        acknowledge,
    )
    monkeypatch.setattr(
        billing_golden_metering,
        "_force_remove_and_verify",
        fail_cleanup,
    )
    emitter = SimpleNamespace(stage=lambda stage, **_fields: stages.append(stage))

    with pytest.raises(RuntimeError, match=r"cleanup failed"):
        asyncio.run(
            _cleanup_failed_box(
                object(),
                object(),
                BOX_ID,
                emitter,
                active_failure=None,
            )
        )

    asyncio.run(
        _cleanup_failed_box(
            object(),
            object(),
            BOX_ID,
            emitter,
            active_failure=AssertionError("business failed"),
        )
    )
    assert stages.count("cleanup-diagnostics-ready") == 2
    assert stages.count("cleanup-force-remove") == 2


def test_exec_exact_reports_exit_status_timeout(monkeypatch) -> None:
    async def empty_stream():
        if False:
            yield ""

    class Execution:
        def stdout(self):
            return empty_stream()

        def stderr(self):
            return empty_stream()

        async def wait(self):
            await asyncio.Event().wait()

    class Box:
        async def exec(self, command, args):
            assert command == "sh"
            assert args == ["-c", "printf golden-1"]
            return Execution()

    monkeypatch.setattr(
        "scripts.test.e2e.drivers.billing_golden_metering.ACTION_TIMEOUT", 0.001
    )
    with pytest.raises(
        TimeoutError, match=r"timed out after 0.001s waiting for guest exec exit status"
    ):
        asyncio.run(_exec_exact(Box(), "golden-1"))


def test_driver_requests_diagnostics_archive_before_force_remove(monkeypatch) -> None:
    lifecycle: list[str] = []

    class FakeOracle:
        def runner_readiness(self, _threshold):
            return [
                {
                    "id": "80000000-0000-4000-8000-000000000001",
                    "name": "runner",
                    "state": "ready",
                    "apiVersion": "2",
                    "unschedulable": False,
                    "draining": False,
                    "availabilityScore": "10",
                    "cpu": "2",
                    "memoryGiB": "2",
                    "diskGiB": "10",
                    "lastChecked": datetime(2026, 7, 8, tzinfo=UTC).isoformat(),
                    "runtimeEpoch": "90000000-0000-4000-8000-000000000001",
                    "schedulable": True,
                }
            ]

        def assert_pristine_baseline(self):
            return {
                "wallet": {
                    "freeBalanceCents": "0",
                    "paidBalanceCents": "2500",
                    "settlementRemainderCents": "0",
                }
            }

        def pricing_plans(self):
            return [{"version": 1}]

        def box_snapshot(self, _box_id):
            return {"desiredState": "destroyed", "periodId": None}

    class FakeBox:
        id = BOX_ID

    class FakeRuntime:
        async def create(self, *_args, **_kwargs):
            return FakeBox()

        async def remove(self, box_id, *, force):
            assert box_id == BOX_ID
            assert force is True
            lifecycle.append("force-remove")

        async def close(self):
            return None

    fake_runtime = FakeRuntime()
    fake_boxlite = SimpleNamespace(
        ApiKeyCredential=lambda token: token,
        BoxliteRestOptions=lambda **options: options,
        BoxOptions=lambda **options: options,
        Boxlite=SimpleNamespace(rest=lambda _options: fake_runtime),
    )

    async def controlled_poll(description, reader, predicate, *, timeout):
        del timeout
        if description.startswith("a ready, schedulable"):
            value = reader()
            assert predicate(value)
            return value
        raise AssertionError("synthetic failure after Box creation")

    async def acknowledge_diagnostics(box_id: str) -> None:
        assert box_id == BOX_ID
        lifecycle.append("archive-ack")

    def emit_stage(stage: str, **_fields) -> None:
        if stage == "cleanup-diagnostics-ready":
            lifecycle.append("diagnostics-ready")

    monkeypatch.setenv("BOXLITE_E2E_API_URL", "http://localhost:3000/api")
    monkeypatch.setenv("BOXLITE_E2E_OIDC_TOKEN", "token")
    monkeypatch.setattr(
        billing_golden_metering,
        "BillingOracle",
        lambda _organization_id: FakeOracle(),
    )
    monkeypatch.setattr(billing_golden_metering, "_poll", controlled_poll)
    monkeypatch.setattr(
        billing_golden_metering,
        "_wait_for_diagnostics_archive",
        acknowledge_diagnostics,
        raising=False,
    )
    monkeypatch.setattr(
        billing_golden_metering.importlib,
        "import_module",
        lambda _name: fake_boxlite,
    )

    args = SimpleNamespace(
        organization_id=ORGANIZATION_ID,
        image="example.test/image",
        name="diagnostics-cleanup-order",
    )
    with pytest.raises(AssertionError, match=r"synthetic failure after Box creation"):
        asyncio.run(_run(args, SimpleNamespace(stage=emit_stage)))

    assert lifecycle == ["diagnostics-ready", "archive-ack", "force-remove"]


@pytest.mark.parametrize("replacement_stage", ["full1", "disk1", "full2", "disk2"])
def test_driver_rejects_period_identity_replacement_between_lifecycle_stages(
    monkeypatch, replacement_stage: str
) -> None:
    diagnostics_lifecycle: list[str] = []
    start = datetime(2026, 7, 8, tzinfo=UTC)
    runner_id = "80000000-0000-4000-8000-000000000001"
    runner_epoch_one = "90000000-0000-4000-8000-000000000001"
    runner_epoch_two = "90000000-0000-4000-8000-000000000002"
    period_ids = {
        "full1": "30000000-0000-4000-8000-000000000001",
        "full1_replacement": "30000000-0000-4000-8000-000000000011",
        "disk1": "30000000-0000-4000-8000-000000000002",
        "disk1_replacement": "30000000-0000-4000-8000-000000000012",
        "full2": "30000000-0000-4000-8000-000000000003",
        "full2_replacement": "30000000-0000-4000-8000-000000000013",
        "disk2": "30000000-0000-4000-8000-000000000004",
        "disk2_replacement": "30000000-0000-4000-8000-000000000014",
    }

    def period_row(
        lifecycle_stage: str,
        index: int,
        mode: str,
        *,
        is_open: bool,
    ) -> dict[str, object]:
        replacement_is_visible = {
            "full1": fake_oracle.phase in {"stopped1", "full2", "stopped2", "removed"},
            "disk1": fake_oracle.phase in {"full2", "stopped2", "removed"},
            "full2": fake_oracle.phase in {"stopped2", "removed"},
            "disk2": fake_oracle.phase == "removed",
        }[lifecycle_stage]
        period_id = period_ids[
            f"{lifecycle_stage}_replacement"
            if replacement_stage == lifecycle_stage and replacement_is_visible
            else lifecycle_stage
        ]
        period_start = start + timedelta(seconds=index * 10)
        period_end = None if is_open else start + timedelta(seconds=(index + 1) * 10)
        is_full = mode == "FULL"
        return {
            "id": period_id,
            "boxId": BOX_ID,
            "organizationId": ORGANIZATION_ID,
            "archived": not is_open,
            "startAt": period_start.isoformat(),
            "endAt": None if period_end is None else period_end.isoformat(),
            "computeBillableUntil": (start + timedelta(minutes=5)).isoformat()
            if is_full
            else None,
            "runtimeGeneration": ("1" if lifecycle_stage == "full1" else "2")
            if is_full
            else None,
            "runnerEpoch": (
                runner_epoch_one if lifecycle_stage == "full1" else runner_epoch_two
            )
            if is_full
            else None,
            "cpu": "2" if is_full else "0",
            "mem": "2" if is_full else "0",
            "gpu": "0",
            "disk": "10",
        }

    class FakeOracle:
        def __init__(self) -> None:
            self.phase = "full1"
            self.full_snapshot_reads = 0

        def runner_readiness(self, _threshold):
            return [
                {
                    "id": runner_id,
                    "name": "runner",
                    "state": "ready",
                    "apiVersion": "2",
                    "unschedulable": False,
                    "draining": False,
                    "availabilityScore": "10",
                    "cpu": "2",
                    "memoryGiB": "2",
                    "diskGiB": "10",
                    "lastChecked": start.isoformat(),
                    "runtimeEpoch": runner_epoch_one,
                    "schedulable": True,
                }
            ]

        def assert_pristine_baseline(self):
            return {
                "wallet": {
                    "freeBalanceCents": "0",
                    "paidBalanceCents": "2500",
                    "settlementRemainderCents": "0",
                }
            }

        def pricing_plans(self):
            return [{"version": 1}]

        def box_snapshot(self, _box_id):
            if self.phase == "removed":
                return None
            if self.phase in {"stopped1", "stopped2"}:
                return {
                    "state": "stopped",
                    "desiredState": "stopped",
                    "pending": False,
                    "periodId": period_ids[
                        "disk1" if self.phase == "stopped1" else "disk2"
                    ],
                }
            generation = 1 if self.phase == "full1" else 2
            lifecycle_stage = "full1" if generation == 1 else "full2"
            self.full_snapshot_reads += 1
            observed_at = start + timedelta(seconds=self.full_snapshot_reads)
            expires_at = start + timedelta(minutes=5, seconds=self.full_snapshot_reads)
            return {
                "state": "started",
                "desiredState": "started",
                "pending": False,
                "runtimeAuthorized": True,
                "runtimeUnavailable": False,
                "periodId": period_ids[lifecycle_stage],
                "leaseActualState": "started",
                "periodCpu": "2",
                "periodMem": "2",
                "periodGpu": "0",
                "periodDisk": "10",
                "periodRuntimeGeneration": str(generation),
                "leaseRuntimeGeneration": str(generation),
                "runtimeGeneration": str(generation),
                "periodRunnerEpoch": (
                    runner_epoch_one if generation == 1 else runner_epoch_two
                ),
                "leaseRunnerEpoch": (
                    runner_epoch_one if generation == 1 else runner_epoch_two
                ),
                "runnerId": runner_id,
                "leaseRunnerId": runner_id,
                "computeBillableUntil": expires_at.isoformat(),
                "leaseExpiresAt": expires_at.isoformat(),
                "leaseObservedAt": observed_at.isoformat(),
            }

        def periods(self, _box_id):
            if self.phase == "stopped1":
                return [
                    period_row("full1", 0, "FULL", is_open=False),
                    period_row("disk1", 1, "DISK", is_open=True),
                ]
            if self.phase == "full2":
                return [
                    period_row("full1", 0, "FULL", is_open=False),
                    period_row("disk1", 1, "DISK", is_open=False),
                    period_row("full2", 2, "FULL", is_open=True),
                ]
            return [
                period_row("full1", 0, "FULL", is_open=False),
                period_row("disk1", 1, "DISK", is_open=False),
                period_row("full2", 2, "FULL", is_open=False),
                period_row("disk2", 3, "DISK", is_open=self.phase != "removed"),
            ]

        def rated_periods(self, _box_id):
            periods = self.periods(BOX_ID)
            if self.phase == "stopped1":
                periods = periods[:1]
            return [
                {
                    "id": f"50000000-0000-4000-8000-{index + 1:012d}",
                    "usagePeriodArchiveId": row["id"],
                    "preciseCents": "0.6",
                    "ratedCents": "1",
                    "transactionId": f"70000000-0000-4000-8000-{index + 1:012d}",
                    "transactionAmountCents": ["0", "-1", "0", "-1"][index],
                    "transactionMetadata": {
                        "remainderBeforeCents": ["0", "0.6", "0.2", "0.8"][index],
                        "remainderAfterCents": ["0.6", "0.2", "0.8", "0.4"][index],
                    },
                    "pricingSegments": [{"pricingVersion": 1}],
                }
                for index, row in enumerate(periods)
            ]

        def wallet(self):
            return {"id": WALLET_ID}

        def assert_rated_period(self, _period, _rated, _plans):
            return rating

        def assert_wallet_ledger(self, _wallet, _rated):
            return {
                "freeBalanceCents": Decimal("0"),
                "paidBalanceCents": Decimal("2500"),
                "remainderCents": Decimal("0.6"),
                "debitCents": Decimal("0"),
            }

        def assert_four_period_topology(self, periods):
            return periods

        def assert_exact_settlement(self, _box_id):
            periods = self.periods(BOX_ID)
            return {
                "periods": periods,
                "ratedPeriods": self.rated_periods(BOX_ID),
                "derived": [rating] * 4,
                "wallet": {
                    "freeBalanceCents": "0",
                    "paidBalanceCents": "2498",
                },
                "totalPreciseCents": Decimal("2.4"),
                "debitCents": Decimal("2"),
                "remainderCents": Decimal("0.4"),
            }

    fake_oracle = FakeOracle()
    rating = DerivedRating(
        segments=(),
        billed_seconds=Decimal("10"),
        usage_totals={},
        precise_cents=Decimal("0.6"),
        rated_cents=Decimal("1"),
    )

    class FakeBox:
        id = BOX_ID

        async def stop(self):
            fake_oracle.phase = (
                "stopped1" if fake_oracle.phase == "full1" else "stopped2"
            )

        async def start(self):
            fake_oracle.phase = "full2"

    class FakeRuntime:
        async def create(self, *_args, **_kwargs):
            return FakeBox()

        async def remove(self, _box_id, *, force):
            assert force is True
            diagnostics_lifecycle.append("force-remove")
            fake_oracle.phase = "removed"

        async def close(self):
            return None

    fake_runtime = FakeRuntime()
    fake_boxlite = SimpleNamespace(
        ApiKeyCredential=lambda token: token,
        BoxliteRestOptions=lambda **options: options,
        BoxOptions=lambda **options: options,
        Boxlite=SimpleNamespace(rest=lambda _options: fake_runtime),
    )

    async def immediate_poll(description, reader, predicate, *, timeout):
        del timeout
        value = reader()
        assert predicate(value), description
        return value

    async def no_op_exec(_box, _expected):
        return None

    async def charge_window(_oracle, _box_id, _plans):
        return period_row("full1", 0, "FULL", is_open=True), rating

    async def cumulative_target(_oracle, _box_id, _plans):
        return [], [rating, rating, rating]

    monkeypatch.setenv("BOXLITE_E2E_API_URL", "http://localhost:3000/api")
    monkeypatch.setenv("BOXLITE_E2E_OIDC_TOKEN", "token")
    monkeypatch.setattr(
        billing_golden_metering,
        "BillingOracle",
        lambda _organization_id: fake_oracle,
    )
    monkeypatch.setattr(billing_golden_metering, "_poll", immediate_poll)
    monkeypatch.setattr(billing_golden_metering, "_exec_exact", no_op_exec)
    monkeypatch.setattr(
        billing_golden_metering, "_wait_for_charge_window", charge_window
    )
    monkeypatch.setattr(
        billing_golden_metering,
        "_wait_for_cumulative_target",
        cumulative_target,
    )
    monkeypatch.setattr(
        billing_golden_metering.importlib,
        "import_module",
        lambda _name: fake_boxlite,
    )

    async def acknowledge_diagnostics(box_id: str) -> None:
        assert box_id == BOX_ID
        diagnostics_lifecycle.append("archive-ack")

    monkeypatch.setattr(
        billing_golden_metering,
        "_wait_for_diagnostics_archive",
        acknowledge_diagnostics,
        raising=False,
    )

    def emit_stage(stage: str, **_fields) -> None:
        if stage == "cleanup-diagnostics-ready":
            diagnostics_lifecycle.append("diagnostics-ready")

    emitter = SimpleNamespace(stage=emit_stage)
    args = SimpleNamespace(
        organization_id=ORGANIZATION_ID,
        image="example.test/image",
        name="period-identity",
    )
    with pytest.raises(AssertionError, match=r"period identity"):
        asyncio.run(_run(args, emitter))
    if replacement_stage == "disk2":
        assert diagnostics_lifecycle[:3] == [
            "diagnostics-ready",
            "archive-ack",
            "force-remove",
        ]
