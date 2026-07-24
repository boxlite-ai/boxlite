"""Deployed billing ST over REST -> API -> runner -> KVM VM -> PostgreSQL.

This suite is local-only because it inspects the authoritative PostgreSQL
ledger. Enable it explicitly with ``BOXLITE_E2E_BILLING_ST=1``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import urlparse

import boxlite
import pytest

from conftest import drain


pytestmark = pytest.mark.skipif(
    os.environ.get("BOXLITE_E2E_BILLING_ST") != "1",
    reason="local billing ST requires BOXLITE_E2E_BILLING_ST=1",
)

_BOX_ID = re.compile(r"^[0-9A-Za-z]{12}$")
_RUNTIME_ID = re.compile(r"^[0-9A-Za-z]{12}$")
_POSTGRES_UNIT = re.compile(r"^postgresql@([0-9]+)-([0-9A-Za-z_-]+)\.service$")
_RUNTIME_HOME = Path(os.environ.get("BOXLITE_E2E_RUNTIME_HOME", "/var/lib/boxlite"))

privileged_fault = pytest.mark.skipif(
    os.environ.get("BOXLITE_E2E_PRIVILEGED_FAULTS") != "1"
    or getattr(os, "geteuid", lambda: -1)() != 0,
    reason="privileged local fault injection requires root and BOXLITE_E2E_PRIVILEGED_FAULTS=1",
)


def _query_json(sql: str):
    env = {
        **os.environ,
        "PGPASSWORD": os.environ.get("BILLING_E2E_DB_PASSWORD", "boxlite"),
        "PGCONNECT_TIMEOUT": os.environ.get("BILLING_E2E_DB_CONNECT_TIMEOUT", "5"),
        "PGOPTIONS": os.environ.get("PGOPTIONS", "-c statement_timeout=5000"),
    }
    result = subprocess.run(
        [
            "psql",
            "-X",
            "-qAt",
            "--set=ON_ERROR_STOP=1",
            "-h",
            os.environ.get("BILLING_E2E_DB_HOST", "127.0.0.1"),
            "-p",
            os.environ.get("BILLING_E2E_DB_PORT", "5432"),
            "-U",
            os.environ.get("BILLING_E2E_DB_USERNAME", "boxlite"),
            "-d",
            os.environ.get("BILLING_E2E_DB_DATABASE", "boxlite_dev"),
            "-c",
            sql,
        ],
        check=True,
        capture_output=True,
        env=env,
        text=True,
        timeout=float(os.environ.get("BILLING_E2E_DB_COMMAND_TIMEOUT", "10")),
    )
    output = result.stdout.strip()
    return json.loads(output) if output else None


def _box_snapshot(box_id: str):
    assert _BOX_ID.fullmatch(box_id)
    return _query_json(
        f"""
        SELECT json_build_object(
          'state', b.state::text,
          'desiredState', b."desiredState"::text,
          'pending', b.pending,
          'runtimeAuthorized', b."runtimeAuthorized",
          'runtimeUnavailable', b."runtimeUnavailable",
          'periodId', p.id::text,
          'cpu', p.cpu::text,
          'mem', p.mem::text,
          'gpu', p.gpu::text,
          'disk', p.disk::text,
          'computeBillableUntil', p."computeBillableUntil",
          'periodRuntimeGeneration', p."runtimeGeneration"::text,
          'periodRunnerEpoch', p."runnerEpoch"::text,
          'leaseObservedAt', l."observedAt",
          'leaseExpiresAt', l."leaseExpiresAt",
          'leaseRuntimeGeneration', l."runtimeGeneration"::text,
          'leaseRunnerEpoch', l."runnerEpoch"::text,
          'leaseActualState', l."actualState"::text
        )
        FROM box b
        LEFT JOIN LATERAL (
          SELECT *
          FROM box_usage_period
          WHERE "boxId" = b.id AND "endAt" IS NULL
          ORDER BY "startAt" DESC
          LIMIT 1
        ) p ON true
        LEFT JOIN box_runtime_lease l ON l."boxId" = b.id
        WHERE b.id = '{box_id}'
        """
    )


def _periods(box_id: str):
    assert _BOX_ID.fullmatch(box_id)
    return _query_json(
        f"""
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'id', p.id::text,
              'archived', p.archived,
              'startAt', p."startAt",
              'endAt', p."endAt",
              'cpu', p.cpu::text,
              'mem', p.mem::text,
              'gpu', p.gpu::text,
              'disk', p.disk::text,
              'computeBillableUntil', p."computeBillableUntil"
            )
            ORDER BY p."startAt", p.id
          ),
          '[]'::json
        )
        FROM (
          SELECT id, "startAt", "endAt", cpu, mem, gpu, disk, "computeBillableUntil", false AS archived
          FROM box_usage_period
          WHERE "boxId" = '{box_id}'
          UNION ALL
          SELECT id, "startAt", "endAt", cpu, mem, gpu, disk, "computeBillableUntil", true AS archived
          FROM box_usage_period_archive
          WHERE "boxId" = '{box_id}'
        ) p
        """
    )


def _metering_fingerprint(periods):
    """Fields whose change would alter, extend, or reopen billable usage."""

    fields = (
        "id",
        "startAt",
        "endAt",
        "cpu",
        "mem",
        "gpu",
        "disk",
        "computeBillableUntil",
    )
    return [{field: row[field] for field in fields} for row in periods]


def _rated_periods(box_id: str):
    assert _BOX_ID.fullmatch(box_id)
    return _query_json(
        f"""
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'id', rp.id::text,
              'billedSeconds', rp."billedSeconds"::text,
              'preciseCents', rp."preciseCents"::text,
              'ratedCents', rp."ratedCents"::text,
              'usageTotals', rp."usageTotals",
              'pricingSegments', rp."pricingSegments",
              'startAt', a."startAt",
              'endAt', a."endAt",
              'cpu', a.cpu::text,
              'mem', a.mem::text,
              'gpu', a.gpu::text,
              'disk', a.disk::text,
              'computeBillableUntil', a."computeBillableUntil",
              'transactionId', wt.id::text,
              'transactionAmountCents', wt."amountCents"::text,
              'transactionMetadata', wt.metadata
            )
            ORDER BY rp."ratedAt", rp.id
          ),
          '[]'::json
        )
        FROM rated_period rp
        JOIN box_usage_period_archive a ON a.id = rp."usagePeriodArchiveId"
        LEFT JOIN wallet_transaction wt ON wt."ratedPeriodId" = rp.id
        WHERE rp."boxId" = '{box_id}'
        """
    )


def _pricing_plans():
    rows = _query_json(
        """
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'version', p.version,
              'cpuRateCentsPerSec', p."cpuRateCentsPerSec"::text,
              'memRateCentsPerSec', p."memRateCentsPerSec"::text,
              'gpuRateCentsPerSec', p."gpuRateCentsPerSec"::text,
              'diskRateCentsPerSec', p."diskRateCentsPerSec"::text,
              'effectiveFrom', p."effectiveFrom",
              'effectiveTo', p."effectiveTo"
            )
            ORDER BY p.version
          ),
          '[]'::json
        )
        FROM pricing_plan p
        """
    )
    return {int(row["version"]): row for row in rows}


def _wallet_snapshot(box_id: str):
    assert _BOX_ID.fullmatch(box_id)
    return _query_json(
        f"""
        SELECT json_build_object(
          'freeBalanceCents', w."freeBalanceCents"::text,
          'paidBalanceCents', w."paidBalanceCents"::text,
          'settlementRemainderCents', w."settlementRemainderCents"::text,
          'transactions', COALESCE((
            SELECT json_agg(
              json_build_object(
                'id', wt.id::text,
                'kind', wt.kind,
                'amountCents', wt."amountCents"::text,
                'ratedPeriodId', wt."ratedPeriodId"::text,
                'metadata', wt.metadata
              )
              ORDER BY wt."createdAt", wt.id
            )
            FROM wallet_transaction wt
            WHERE wt."walletId" = w.id
          ), '[]'::json)
        )
        FROM wallet w
        JOIN box b ON b."organizationId" = w."organizationId"
        WHERE b.id = '{box_id}'
        """
    )


async def _wait_for(description, reader, predicate, timeout=120.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = reader()
        if predicate(last):
            return last
        await asyncio.sleep(1)
    raise AssertionError(f"timed out waiting for {description}; last={last!r}")


def _timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _elapsed_seconds(start_at: str, end_at: str) -> Decimal:
    elapsed = _timestamp(end_at) - _timestamp(start_at)
    return (
        Decimal(elapsed.days * 86400 + elapsed.seconds)
        + Decimal(elapsed.microseconds) / Decimal(1_000_000)
    )


def _assert_local_target(api_url: str):
    api_host = urlparse(api_url).hostname
    db_host = os.environ.get("BILLING_E2E_DB_HOST", "127.0.0.1")
    loopback_hosts = {"127.0.0.1", "::1", "localhost"}
    assert api_host in loopback_hosts, f"billing ST requires a loopback API, got {api_url}"
    assert db_host in loopback_hosts, f"billing ST requires a loopback PostgreSQL host, got {db_host}"


def _assert_privileged_fault_target(api_url: str):
    _assert_local_target(api_url)
    assert getattr(os, "geteuid", lambda: -1)() == 0, "privileged fault ST must run as root"
    assert os.environ.get("BOXLITE_E2E_PRIVILEGED_FAULTS") == "1"
    database = os.environ.get("BILLING_E2E_DB_DATABASE", "boxlite_dev")
    assert database == "boxlite_dev", f"refusing fault injection against non-fixture database {database!r}"
    assert _RUNTIME_HOME == Path("/var/lib/boxlite"), (
        f"refusing fault injection outside the fixture runtime home: {_RUNTIME_HOME}"
    )


def _safe_box_snapshot(box_id: str):
    try:
        return _box_snapshot(box_id)
    except (json.JSONDecodeError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def _database_available():
    try:
        return _query_json("SELECT json_build_object('ready', true)") == {"ready": True}
    except (json.JSONDecodeError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def _postgres_cluster_unit():
    port = os.environ.get("BILLING_E2E_DB_PORT", "5432")
    result = subprocess.run(
        ["pg_lsclusters", "--no-header"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    matches = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[2] == port and fields[3] == "online":
            matches.append((fields[0], fields[1]))
    assert len(matches) == 1, f"expected one online local PostgreSQL cluster on port {port}, got {matches!r}"
    version, cluster = matches[0]
    unit = f"postgresql@{version}-{cluster}.service"
    assert _POSTGRES_UNIT.fullmatch(unit)
    return unit


def _postgres_service(action: str, unit: str):
    assert action in {"start", "stop"}
    assert _POSTGRES_UNIT.fullmatch(unit), f"refusing unexpected PostgreSQL unit {unit!r}"
    subprocess.run(
        ["systemctl", "--no-block", action, unit],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )


def _runner_service(action: str):
    assert action in {"start", "stop"}
    subprocess.run(
        ["systemctl", action, "boxlite-runner.service"],
        check=True,
        capture_output=True,
        text=True,
        timeout=75,
    )


def _service_active(unit: str):
    allowed = {"boxlite-api.service", "boxlite-runner.service"}
    assert unit in allowed or _POSTGRES_UNIT.fullmatch(unit)
    result = subprocess.run(
        ["systemctl", "is-active", unit],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.returncode == 0 and result.stdout.strip() == "active"


def _arm_postgres_recovery_guard(unit: str):
    assert _POSTGRES_UNIT.fullmatch(unit)
    guard = f"boxlite-e2e-postgres-recovery-{os.getpid()}"
    assert re.fullmatch(r"boxlite-e2e-postgres-recovery-[0-9]+", guard)
    subprocess.run(
        [
            "systemd-run",
            f"--unit={guard}",
            "--on-active=180s",
            "--timer-property=AccuracySec=1s",
            "--collect",
            "/usr/bin/systemctl",
            "start",
            unit,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return guard


def _cancel_postgres_recovery_guard(guard: str):
    assert re.fullmatch(r"boxlite-e2e-postgres-recovery-[0-9]+", guard)
    subprocess.run(
        ["systemctl", "stop", f"{guard}.timer"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )


def _arm_runner_recovery_guard(stage: str):
    assert stage in {"stop", "destroy"}
    guard = f"boxlite-e2e-runner-recovery-{stage}-{os.getpid()}"
    assert re.fullmatch(r"boxlite-e2e-runner-recovery-(stop|destroy)-[0-9]+", guard)
    subprocess.run(
        [
            "systemd-run",
            f"--unit={guard}",
            "--on-active=180s",
            "--timer-property=AccuracySec=1s",
            "--collect",
            "/usr/bin/systemctl",
            "start",
            "boxlite-runner.service",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return guard


def _cancel_runner_recovery_guard(guard: str):
    assert re.fullmatch(r"boxlite-e2e-runner-recovery-(stop|destroy)-[0-9]+", guard)
    subprocess.run(
        ["systemctl", "stop", f"{guard}.timer"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )


def _proc_identity(pid: int):
    assert pid > 1
    stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    close_paren = stat.rfind(")")
    assert close_paren > 0
    fields = stat[close_paren + 2 :].split()
    # fields starts at procfs field 3 (state).
    return {
        "pid": pid,
        "ppid": int(fields[1]),
        "pgrp": int(fields[2]),
        "session": int(fields[3]),
        "startTicks": int(fields[19]),
    }


def _ancestor_pids(pid: int, max_depth: int = 4):
    ancestors = []
    current = pid
    for _ in range(max_depth):
        identity = _proc_identity(current)
        parent = identity["ppid"]
        if parent <= 1:
            break
        ancestors.append(parent)
        current = parent
    return ancestors


def _runtime_record(box_id: str):
    assert _BOX_ID.fullmatch(box_id)
    database = _RUNTIME_HOME / "db" / "boxlite.db"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2) as connection:
        row = connection.execute(
            """
            SELECT c.id, c.name, s.status, s.pid
            FROM box_config c
            JOIN box_state s ON s.id = c.id
            WHERE c.name = ?
            """,
            (box_id,),
        ).fetchone()
    if row is None:
        return None
    runtime_id, name, status, pid = row
    return {
        "runtimeId": runtime_id,
        "name": name,
        "status": status,
        "pid": pid,
    }


def _validated_shim_identity(box_id: str):
    record = _runtime_record(box_id)
    if record is None or record["status"] != "running" or record["pid"] is None:
        return None

    runtime_id = record["runtimeId"]
    assert _RUNTIME_ID.fullmatch(runtime_id)
    assert record["name"] == box_id
    outer_pid = int(record["pid"])
    runtime_dir = _RUNTIME_HOME / "boxes" / runtime_id
    pid_lines = (runtime_dir / "shim.pid").read_text(encoding="utf-8").splitlines()
    assert len(pid_lines) == 2
    assert int(pid_lines[0]) == outer_pid

    outer = _proc_identity(outer_pid)
    assert outer["startTicks"] == int(pid_lines[1])
    outer_cmdline = Path(f"/proc/{outer_pid}/cmdline").read_bytes().split(b"\0")
    outer_cgroup = Path(f"/proc/{outer_pid}/cgroup").read_text(encoding="utf-8")
    expected_shim_path = runtime_dir / "bin" / "boxlite-shim"
    expected_shim = str(expected_shim_path).encode()
    expected_stat = expected_shim_path.stat()
    assert expected_shim in outer_cmdline

    children = []
    candidates = []
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        pid = int(proc_dir.name)
        if pid <= 1:
            continue
        try:
            identity = _proc_identity(pid)
            cmdline = (proc_dir / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            exe_stat = (proc_dir / "exe").stat()
            cgroup = (proc_dir / "cgroup").read_text(encoding="utf-8")
            ancestors = _ancestor_pids(pid)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        same_executable = (exe_stat.st_dev, exe_stat.st_ino) == (expected_stat.st_dev, expected_stat.st_ino)
        expected_cgroup = (
            f"/boxlite/{runtime_id}" in cgroup
            or (cgroup == outer_cgroup and "/system.slice/boxlite-runner.service" in cgroup)
        )
        launcher_matches = outer_pid in ancestors
        cmdline_matches = cmdline == [expected_shim]
        owner_matches = proc_dir.stat().st_uid == expected_stat.st_uid
        if launcher_matches or cmdline_matches or same_executable:
            candidates.append(
                {
                    "pid": identity["pid"],
                    "launcherMatches": launcher_matches,
                    "ancestors": ancestors,
                    "cmdlineMatches": cmdline_matches,
                    "inodeMatches": same_executable,
                    "cgroupMatches": expected_cgroup,
                    "ownerMatches": owner_matches,
                    "cgroup": cgroup.strip(),
                }
            )
        if (
            launcher_matches
            and cmdline_matches
            and same_executable
            and expected_cgroup
            and owner_matches
        ):
            children.append(identity)
    assert len(children) == 1, (
        f"expected one exact shim child for {box_id}, got {children!r}; candidates={candidates!r}"
    )
    shim = children[0]
    assert shim["pgrp"] in _ancestor_pids(shim["pid"])
    return {
        **record,
        "outerPid": outer_pid,
        "outerStartTicks": outer["startTicks"],
        "shimPid": shim["pid"],
        "shimStartTicks": shim["startTicks"],
    }


def _safe_validated_shim_identity(box_id: str):
    try:
        return _validated_shim_identity(box_id)
    except (AssertionError, FileNotFoundError, PermissionError, ProcessLookupError, sqlite3.Error) as error:
        return {"validationError": f"{type(error).__name__}: {error}"}


def _kill_validated_shim(identity):
    shim_pid = int(identity["shimPid"])
    current = _proc_identity(shim_pid)
    assert current["startTicks"] == identity["shimStartTicks"]
    pidfd = os.pidfd_open(shim_pid)
    try:
        current = _proc_identity(shim_pid)
        assert current["startTicks"] == identity["shimStartTicks"]
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
    finally:
        os.close(pidfd)


async def _sleep_until(deadline: datetime):
    assert deadline.tzinfo is not None
    while True:
        remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
        if remaining <= 0:
            return
        await asyncio.sleep(min(remaining, 5))


async def _hold_postgres_outage(deadline: datetime, unit: str):
    assert deadline.tzinfo is not None
    while True:
        assert not _service_active(unit), f"{unit} restarted before the lease-cap outage completed"
        assert not _database_available(), "PostgreSQL accepted a query during the intended outage"
        remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
        if remaining <= 0:
            return
        await asyncio.sleep(min(remaining, 2))


def _assert_theoretical_charge(rated, pricing_plans):
    resources = {
        "cpu": Decimal(rated["cpu"]),
        "mem": Decimal(rated["mem"]),
        "gpu": Decimal(rated["gpu"]),
        "disk": Decimal(rated["disk"]),
    }
    period_seconds = _elapsed_seconds(rated["startAt"], rated["endAt"])
    expected_precise = Decimal(0)
    expected_seconds = Decimal(0)
    for segment in rated["pricingSegments"]:
        seconds = _elapsed_seconds(segment["startAt"], segment["endAt"])
        assert Decimal(segment["billedSeconds"]) == seconds
        usage_totals = segment["usageTotals"]
        assert Decimal(usage_totals["cpuSeconds"]) == resources["cpu"] * seconds
        assert Decimal(usage_totals["memGibSeconds"]) == resources["mem"] * seconds
        assert Decimal(usage_totals["gpuSeconds"]) == resources["gpu"] * seconds
        assert Decimal(usage_totals["diskGibSeconds"]) == resources["disk"] * seconds
        pricing_version = int(segment["pricingVersion"])
        assert pricing_version in pricing_plans
        plan = pricing_plans[pricing_version]
        segment_start = _timestamp(segment["startAt"])
        segment_end = _timestamp(segment["endAt"])
        assert segment_start >= _timestamp(plan["effectiveFrom"])
        if plan["effectiveTo"] is not None:
            assert segment_end <= _timestamp(plan["effectiveTo"])
        rates = {
            "cpuRateCentsPerSec": plan["cpuRateCentsPerSec"],
            "memRateCentsPerSec": plan["memRateCentsPerSec"],
            "gpuRateCentsPerSec": plan["gpuRateCentsPerSec"],
            "diskRateCentsPerSec": plan["diskRateCentsPerSec"],
        }
        assert segment["unitRates"] == rates
        segment_expected = seconds * (
            resources["cpu"] * Decimal(rates["cpuRateCentsPerSec"])
            + resources["mem"] * Decimal(rates["memRateCentsPerSec"])
            + resources["gpu"] * Decimal(rates["gpuRateCentsPerSec"])
            + resources["disk"] * Decimal(rates["diskRateCentsPerSec"])
        )
        assert Decimal(segment["preciseCents"]) == segment_expected
        expected_precise += segment_expected
        expected_seconds += seconds

    precise = Decimal(rated["preciseCents"])
    assert expected_seconds == period_seconds
    assert Decimal(rated["billedSeconds"]) == period_seconds
    assert Decimal(rated["usageTotals"]["cpuSeconds"]) == resources["cpu"] * period_seconds
    assert Decimal(rated["usageTotals"]["memGibSeconds"]) == resources["mem"] * period_seconds
    assert Decimal(rated["usageTotals"]["gpuSeconds"]) == resources["gpu"] * period_seconds
    assert Decimal(rated["usageTotals"]["diskGibSeconds"]) == resources["disk"] * period_seconds
    assert precise == expected_precise
    assert Decimal(rated["ratedCents"]) == precise.quantize(Decimal("1"), rounding=ROUND_HALF_UP)

    metadata = rated["transactionMetadata"]
    debit = -Decimal(rated["transactionAmountCents"])
    assert Decimal(metadata["remainderBeforeCents"]) + precise == (
        debit + Decimal(metadata["remainderAfterCents"])
    )
    return precise, debit


async def _assert_settlement(box_id: str, wallet_before, expected_period_count: int):
    rated = await _wait_for(
        f"{expected_period_count} closed periods to archive, rate, and debit",
        lambda: _rated_periods(box_id),
        lambda rows: len(rows) == expected_period_count
        and all(row["transactionAmountCents"] is not None for row in rows),
        timeout=180,
    )
    pricing_plans = _pricing_plans()
    assert pricing_plans
    expected_precise = Decimal(0)
    expected_debit = Decimal(0)
    for row in rated:
        precise, debit = _assert_theoretical_charge(row, pricing_plans)
        expected_precise += precise
        expected_debit += debit

    wallet_after = _wallet_snapshot(box_id)
    assert wallet_after is not None
    balance_before = Decimal(wallet_before["freeBalanceCents"]) + Decimal(wallet_before["paidBalanceCents"])
    balance_after = Decimal(wallet_after["freeBalanceCents"]) + Decimal(wallet_after["paidBalanceCents"])

    # Wallets are organization-scoped, so a failed/retried ST can leave an
    # unrelated box settling concurrently. Reconcile every immutable ledger
    # transaction committed after this test's baseline, then separately prove
    # that all transactions for this box are included and theoretically exact.
    baseline_transaction_ids = {row["id"] for row in wallet_before["transactions"]}
    new_transactions = [
        row for row in wallet_after["transactions"] if row["id"] not in baseline_transaction_ids
    ]
    assert balance_after - balance_before == sum(
        (Decimal(row["amountCents"]) for row in new_transactions),
        Decimal(0),
    )

    new_usage_debits = [row for row in new_transactions if row["kind"] == "usage_debit"]
    new_precise = sum(
        (Decimal(row["metadata"]["preciseCents"]) for row in new_usage_debits),
        Decimal(0),
    )
    new_debit = -sum(
        (Decimal(row["amountCents"]) for row in new_usage_debits),
        Decimal(0),
    )
    assert Decimal(wallet_before["settlementRemainderCents"]) + new_precise == (
        new_debit + Decimal(wallet_after["settlementRemainderCents"])
    )

    rated_transaction_ids = {row["transactionId"] for row in rated}
    assert None not in rated_transaction_ids
    assert rated_transaction_ids <= {row["id"] for row in new_transactions}
    assert expected_precise == sum(
        (Decimal(row["transactionMetadata"]["preciseCents"]) for row in rated),
        Decimal(0),
    )
    assert expected_debit == -sum(
        (Decimal(row["transactionAmountCents"]) for row in rated),
        Decimal(0),
    )
    return rated


async def _best_effort_remove(rt, box_id: str):
    try:
        snapshot = await _wait_for(
            "box state change to finish before cleanup",
            lambda: _box_snapshot(box_id),
            lambda row: row is None or row["pending"] is False,
        )
        if snapshot is None or snapshot["desiredState"] == "destroyed":
            return
        await asyncio.wait_for(rt.remove(box_id, force=True), timeout=60)
    except Exception:
        pass


@pytest.mark.asyncio
async def test_failed_workload_keeps_full_billing_and_settles_theoretical_amount(rt, image, e2e_auth):
    """A guest process failure must not stop VM billing.

    The test then stops and destroys the Box and checks the complete persisted
    FULL -> DISK_ONLY -> NONE path through archive, rating, and wallet debit.
    """

    _assert_local_target(e2e_auth.url)
    box = await asyncio.wait_for(
        rt.create(boxlite.BoxOptions(image=image, auto_remove=False)),
        timeout=60,
    )
    removed = False
    try:
        initial = await _wait_for(
            "confirmed FULL period",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "started"
            and row["desiredState"] == "started"
            and row["runtimeAuthorized"]
            and Decimal(row["cpu"]) > 0
            and row["computeBillableUntil"] is not None,
        )
        wallet_before = _wallet_snapshot(box.id)
        assert wallet_before is not None

        async def fail_workload():
            failed = await box.exec("sh", ["-c", "kill -9 $$"])
            await drain(failed)
            return await failed.wait()

        exit_status = await asyncio.wait_for(fail_workload(), timeout=60)
        assert exit_status.exit_code in (-9, 137)

        after_failure = await _wait_for(
            "runner heartbeat to extend the same FULL period after workload failure",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "started"
            and row["desiredState"] == "started"
            and row["runtimeAuthorized"] is True
            and row["runtimeUnavailable"] is False
            and row["periodId"] == initial["periodId"]
            and Decimal(row["cpu"]) > 0
            and _timestamp(row["computeBillableUntil"]) > _timestamp(initial["computeBillableUntil"]),
            timeout=45,
        )
        assert after_failure["periodId"] == initial["periodId"]

        await asyncio.wait_for(box.stop(), timeout=60)
        stopped_periods = await _wait_for(
            "FULL to close and DISK_ONLY to open",
            lambda: _periods(box.id),
            lambda rows: len(rows) == 2
            and any(Decimal(row["cpu"]) > 0 and row["endAt"] for row in rows)
            and any(Decimal(row["cpu"]) == 0 and row["endAt"] is None for row in rows),
        )
        full = next(row for row in stopped_periods if Decimal(row["cpu"]) > 0)
        disk_only = next(row for row in stopped_periods if Decimal(row["cpu"]) == 0)
        assert full["endAt"] == disk_only["startAt"]

        await _wait_for(
            "physical stop to finish before destroy",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "stopped"
            and row["desiredState"] == "stopped"
            and row["pending"] is False,
        )
        await asyncio.wait_for(rt.remove(box.id, force=True), timeout=60)
        removed = True
        await _wait_for(
            "destroy intent to close all metering",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["desiredState"] == "destroyed"
            and row["periodId"] is None,
        )

        rated = await _assert_settlement(box.id, wallet_before, expected_period_count=2)
        assert sum(Decimal(row["cpu"]) > 0 for row in rated) == 1
        assert sum(Decimal(row["cpu"]) == 0 for row in rated) == 1
    finally:
        if not removed:
            await _best_effort_remove(rt, box.id)


@pytest.mark.asyncio
@privileged_fault
async def test_shim_crash_stops_compute_billing_and_settles_disk_only(rt, image, e2e_auth):
    """A real shim/VM crash must stop compute billing without a stop intent."""

    _assert_privileged_fault_target(e2e_auth.url)
    box = await asyncio.wait_for(
        rt.create(boxlite.BoxOptions(image=image, auto_remove=False)),
        timeout=60,
    )
    removed = False
    try:
        initial = await _wait_for(
            "confirmed FULL period and runtime lease before shim crash",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "started"
            and row["desiredState"] == "started"
            and row["runtimeAuthorized"] is True
            and row["runtimeUnavailable"] is False
            and Decimal(row["cpu"]) > 0
            and row["computeBillableUntil"] is not None
            and row["leaseActualState"] == "started"
            and row["periodRuntimeGeneration"] == row["leaseRuntimeGeneration"]
            and row["periodRunnerEpoch"] == row["leaseRunnerEpoch"],
        )
        wallet_before = _wallet_snapshot(box.id)
        assert wallet_before is not None
        shim = await _wait_for(
            "unique inode-verified shim process",
            lambda: _safe_validated_shim_identity(box.id),
            lambda identity: "shimPid" in identity,
            timeout=30,
        )

        _kill_validated_shim(shim)
        await _wait_for(
            "killed shim process to exit",
            lambda: Path(f"/proc/{shim['shimPid']}").exists(),
            lambda exists: not exists,
            timeout=15,
        )

        unavailable = await _wait_for(
            "runner inventory or lease expiry to mark runtime unavailable and open DISK_ONLY",
            lambda: _safe_box_snapshot(box.id),
            lambda row: row
            and row["state"] == "error"
            and row["desiredState"] == "started"
            and row["pending"] is False
            and row["runtimeAuthorized"] is True
            and row["runtimeUnavailable"] is True
            and Decimal(row["cpu"]) == 0
            and Decimal(row["mem"]) == 0
            and Decimal(row["gpu"]) == 0
            and Decimal(row["disk"]) > 0
            and row["computeBillableUntil"] is None,
            timeout=95,
        )
        assert unavailable["leaseActualState"] != "started"
        assert unavailable["leaseRuntimeGeneration"] == initial["leaseRuntimeGeneration"]
        assert unavailable["leaseRunnerEpoch"] == initial["leaseRunnerEpoch"]

        fault_periods = await _wait_for(
            "one closed FULL and one open DISK_ONLY period after shim crash",
            lambda: _periods(box.id),
            lambda rows: len(rows) == 2
            and sum(Decimal(row["cpu"]) > 0 and row["endAt"] is not None for row in rows) == 1
            and sum(Decimal(row["cpu"]) == 0 and row["endAt"] is None for row in rows) == 1,
        )
        full = next(row for row in fault_periods if Decimal(row["cpu"]) > 0)
        disk_only = next(row for row in fault_periods if Decimal(row["cpu"]) == 0)
        assert full["endAt"] == disk_only["startAt"]
        assert _timestamp(full["endAt"]) <= _timestamp(full["computeBillableUntil"])
        assert disk_only["computeBillableUntil"] is None
        assert Decimal(disk_only["mem"]) == 0
        assert Decimal(disk_only["gpu"]) == 0
        assert Decimal(disk_only["disk"]) == Decimal(full["disk"])

        # A stale "running" inventory must not reopen compute after the fault.
        await asyncio.sleep(18)
        stable_periods = _periods(box.id)
        assert _metering_fingerprint(stable_periods) == _metering_fingerprint(fault_periods)
        assert _box_snapshot(box.id)["runtimeUnavailable"] is True

        await asyncio.wait_for(rt.remove(box.id, force=True), timeout=60)
        removed = True
        await _wait_for(
            "destroy intent to close crash DISK_ONLY metering",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["desiredState"] == "destroyed"
            and row["periodId"] is None,
        )

        rated = await _assert_settlement(box.id, wallet_before, expected_period_count=2)
        assert sum(Decimal(row["cpu"]) > 0 for row in rated) == 1
        assert sum(Decimal(row["cpu"]) == 0 for row in rated) == 1
    finally:
        if not removed:
            await _best_effort_remove(rt, box.id)


@pytest.mark.asyncio
@privileged_fault
async def test_stop_and_destroy_intent_end_billing_while_runner_is_unavailable(rt, image, e2e_auth):
    """Control-plane stop/destroy intent must end billing before physical success."""

    _assert_privileged_fault_target(e2e_auth.url)
    assert _service_active("boxlite-runner.service")

    box = await asyncio.wait_for(
        rt.create(boxlite.BoxOptions(image=image, auto_remove=False)),
        timeout=60,
    )
    removed = False
    runner_stopped = False
    recovery_guard = None
    stop_task = None
    destroy_task = None
    try:
        initial = await _wait_for(
            "confirmed FULL period before runner outage",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "started"
            and row["desiredState"] == "started"
            and row["pending"] is False
            and Decimal(row["cpu"]) > 0
            and row["computeBillableUntil"] is not None
            and row["leaseActualState"] == "started",
        )
        wallet_before = _wallet_snapshot(box.id)
        assert wallet_before is not None

        recovery_guard = _arm_runner_recovery_guard("stop")
        _runner_service("stop")
        runner_stopped = True
        await _wait_for(
            "runner service to stop before stop intent",
            lambda: _service_active("boxlite-runner.service"),
            lambda active: not active,
            timeout=30,
        )

        stop_requested_at = datetime.now(timezone.utc)
        stop_task = asyncio.ensure_future(box.stop())
        stop_intent = await _wait_for(
            "stop intent to open DISK_ONLY while runner is unavailable",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] != "stopped"
            and row["desiredState"] == "stopped"
            and row["pending"] is True
            and Decimal(row["cpu"]) == 0
            and Decimal(row["mem"]) == 0
            and Decimal(row["gpu"]) == 0
            and Decimal(row["disk"]) > 0
            and row["computeBillableUntil"] is None,
            timeout=30,
        )
        assert stop_intent["runtimeAuthorized"] is False
        stopped_periods = await _wait_for(
            "FULL to close at failed stop intent and DISK_ONLY to open",
            lambda: _periods(box.id),
            lambda rows: len(rows) == 2
            and sum(Decimal(row["cpu"]) > 0 and row["endAt"] is not None for row in rows) == 1
            and sum(Decimal(row["cpu"]) == 0 and row["endAt"] is None for row in rows) == 1,
        )
        full = next(row for row in stopped_periods if Decimal(row["cpu"]) > 0)
        disk_only = next(row for row in stopped_periods if Decimal(row["cpu"]) == 0)
        assert full["endAt"] == disk_only["startAt"]
        assert _timestamp(full["endAt"]) <= stop_requested_at + timedelta(seconds=10)
        assert _timestamp(full["endAt"]) < _timestamp(initial["computeBillableUntil"])

        _runner_service("start")
        await _wait_for(
            "runner service recovery after failed stop",
            lambda: _service_active("boxlite-runner.service"),
            lambda active: active,
            timeout=60,
        )
        runner_stopped = False
        _cancel_runner_recovery_guard(recovery_guard)
        recovery_guard = None
        await asyncio.wait_for(stop_task, timeout=90)
        await _wait_for(
            "physical stop to complete after runner recovery",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "stopped"
            and row["desiredState"] == "stopped"
            and row["pending"] is False,
            timeout=90,
        )
        assert _metering_fingerprint(_periods(box.id)) == _metering_fingerprint(stopped_periods)

        recovery_guard = _arm_runner_recovery_guard("destroy")
        _runner_service("stop")
        runner_stopped = True
        await _wait_for(
            "runner service to stop before destroy intent",
            lambda: _service_active("boxlite-runner.service"),
            lambda active: not active,
            timeout=30,
        )

        destroy_requested_at = datetime.now(timezone.utc)
        destroy_task = asyncio.ensure_future(rt.remove(box.id, force=True))
        await _wait_for(
            "destroy intent to close DISK_ONLY while runner is unavailable",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] != "destroyed"
            and row["desiredState"] == "destroyed"
            and row["pending"] is True
            and row["periodId"] is None,
            timeout=30,
        )
        destroyed_periods = await _wait_for(
            "both periods to close at failed destroy intent",
            lambda: _periods(box.id),
            lambda rows: len(rows) == 2 and all(row["endAt"] is not None for row in rows),
        )
        destroyed_disk = next(row for row in destroyed_periods if Decimal(row["cpu"]) == 0)
        assert _timestamp(destroyed_disk["endAt"]) <= destroy_requested_at + timedelta(seconds=10)

        _runner_service("start")
        await _wait_for(
            "runner service recovery after failed destroy",
            lambda: _service_active("boxlite-runner.service"),
            lambda active: active,
            timeout=60,
        )
        runner_stopped = False
        _cancel_runner_recovery_guard(recovery_guard)
        recovery_guard = None
        await asyncio.wait_for(destroy_task, timeout=90)
        removed = True
        await _wait_for(
            "physical destroy to complete after runner recovery",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "destroyed"
            and row["desiredState"] == "destroyed"
            and row["pending"] is False
            and row["periodId"] is None,
            timeout=90,
        )
        assert _metering_fingerprint(_periods(box.id)) == _metering_fingerprint(destroyed_periods)

        rated = await _assert_settlement(box.id, wallet_before, expected_period_count=2)
        assert sum(Decimal(row["cpu"]) > 0 for row in rated) == 1
        assert sum(Decimal(row["cpu"]) == 0 for row in rated) == 1
    finally:
        if runner_stopped:
            _runner_service("start")
            await _wait_for(
                "runner service recovery in test cleanup",
                lambda: _service_active("boxlite-runner.service"),
                lambda active: active,
                timeout=60,
            )
        if recovery_guard is not None:
            _cancel_runner_recovery_guard(recovery_guard)
        for task in (stop_task, destroy_task):
            if task is None:
                continue
            if not task.done():
                task.cancel()
            try:
                await task
            except (Exception, asyncio.CancelledError):
                pass
        if not removed:
            await _best_effort_remove(rt, box.id)


@pytest.mark.asyncio
@privileged_fault
async def test_postgres_outage_past_lease_cap_does_not_backfill_compute(rt, image, e2e_auth):
    """A whole-database outage past the persisted lease cap leaves a disk-only gap."""

    _assert_privileged_fault_target(e2e_auth.url)
    postgres_unit = _postgres_cluster_unit()
    assert _service_active(postgres_unit)
    assert _service_active("boxlite-api.service")
    assert _service_active("boxlite-runner.service")
    assert _database_available()

    box = await asyncio.wait_for(
        rt.create(boxlite.BoxOptions(image=image, auto_remove=False)),
        timeout=60,
    )
    removed = False
    postgres_stopped = False
    recovery_guard = None
    try:
        initial = await _wait_for(
            "confirmed FULL period with matching persisted lease",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "started"
            and row["desiredState"] == "started"
            and row["runtimeAuthorized"] is True
            and Decimal(row["cpu"]) > 0
            and row["computeBillableUntil"] is not None
            and row["computeBillableUntil"] == row["leaseExpiresAt"]
            and row["periodRuntimeGeneration"] == row["leaseRuntimeGeneration"]
            and row["periodRunnerEpoch"] == row["leaseRunnerEpoch"]
            and row["leaseActualState"] == "started",
        )
        wallet_before = _wallet_snapshot(box.id)
        assert wallet_before is not None
        lease_seconds = (
            _timestamp(initial["leaseExpiresAt"]) - _timestamp(initial["leaseObservedAt"])
        ).total_seconds()
        assert lease_seconds == 60

        recovery_guard = _arm_postgres_recovery_guard(postgres_unit)
        _postgres_service("stop", postgres_unit)
        postgres_stopped = True
        await _wait_for(
            "PostgreSQL cluster to become unavailable",
            lambda: {
                "active": _service_active(postgres_unit),
                "queryable": _database_available(),
            },
            lambda state: not state["active"] and not state["queryable"],
            timeout=30,
        )
        outage_confirmed_at = datetime.now(timezone.utc)
        await _hold_postgres_outage(
            outage_confirmed_at + timedelta(seconds=lease_seconds + 10),
            postgres_unit,
        )

        _postgres_service("start", postgres_unit)
        await _wait_for(
            "PostgreSQL and API database pool to recover",
            lambda: {
                "active": _service_active(postgres_unit),
                "queryable": _database_available(),
                "api": _service_active("boxlite-api.service"),
                "runner": _service_active("boxlite-runner.service"),
            },
            lambda state: all(state.values()),
            timeout=60,
        )
        postgres_stopped = False
        _cancel_postgres_recovery_guard(recovery_guard)
        recovery_guard = None

        recovered_periods = await _wait_for(
            "FULL -> DISK_ONLY gap -> FULL after database recovery",
            lambda: _periods(box.id),
            lambda rows: len(rows) == 3
            and sum(Decimal(row["cpu"]) > 0 for row in rows) == 2
            and sum(Decimal(row["cpu"]) == 0 for row in rows) == 1
            and sum(row["endAt"] is None for row in rows) == 1
            and Decimal(next(row for row in rows if row["endAt"] is None)["cpu"]) > 0,
            timeout=90,
        )
        full_periods = sorted(
            (row for row in recovered_periods if Decimal(row["cpu"]) > 0),
            key=lambda row: _timestamp(row["startAt"]),
        )
        gap = next(row for row in recovered_periods if Decimal(row["cpu"]) == 0)
        first_full, recovered_full = full_periods
        assert first_full["endAt"] == first_full["computeBillableUntil"]
        assert gap["startAt"] == first_full["endAt"]
        assert gap["endAt"] == recovered_full["startAt"]
        assert _elapsed_seconds(gap["startAt"], gap["endAt"]) >= Decimal(5)
        assert gap["computeBillableUntil"] is None
        assert Decimal(gap["mem"]) == 0
        assert Decimal(gap["gpu"]) == 0
        assert Decimal(gap["disk"]) == Decimal(first_full["disk"])
        assert _timestamp(first_full["endAt"]) <= outage_confirmed_at + timedelta(seconds=lease_seconds + 2)
        assert _timestamp(recovered_full["startAt"]) > _timestamp(first_full["endAt"])

        async def prove_vm_survived():
            execution = await box.exec("sh", ["-c", "printf database-recovered"])
            stdout, _ = await drain(execution)
            status = await execution.wait()
            return stdout, status

        stdout, status = await asyncio.wait_for(prove_vm_survived(), timeout=60)
        assert status.exit_code == 0
        assert stdout == "database-recovered"

        await asyncio.wait_for(box.stop(), timeout=60)
        final_periods = await _wait_for(
            "recovered FULL to close and stopped DISK_ONLY to open",
            lambda: _periods(box.id),
            lambda rows: len(rows) == 4
            and sum(Decimal(row["cpu"]) > 0 for row in rows) == 2
            and sum(Decimal(row["cpu"]) == 0 for row in rows) == 2
            and sum(row["endAt"] is None for row in rows) == 1,
        )
        stopped_disk = next(row for row in final_periods if row["endAt"] is None)
        assert Decimal(stopped_disk["cpu"]) == 0
        assert stopped_disk["computeBillableUntil"] is None

        await _wait_for(
            "physical stop to finish after database recovery",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["state"] == "stopped"
            and row["desiredState"] == "stopped"
            and row["pending"] is False,
        )
        await asyncio.wait_for(rt.remove(box.id, force=True), timeout=60)
        removed = True
        await _wait_for(
            "destroy intent to close all post-outage metering",
            lambda: _box_snapshot(box.id),
            lambda row: row
            and row["desiredState"] == "destroyed"
            and row["periodId"] is None,
        )

        rated = await _assert_settlement(box.id, wallet_before, expected_period_count=4)
        assert sum(Decimal(row["cpu"]) > 0 for row in rated) == 2
        assert sum(Decimal(row["cpu"]) == 0 for row in rated) == 2
    finally:
        if postgres_stopped:
            _postgres_service("start", postgres_unit)
            await _wait_for(
                "PostgreSQL recovery in test cleanup",
                lambda: _service_active(postgres_unit) and _database_available(),
                lambda ready: ready,
                timeout=60,
            )
        if recovery_guard is not None:
            _cancel_postgres_recovery_guard(recovery_guard)
        if not removed:
            await _best_effort_remove(rt, box.id)
