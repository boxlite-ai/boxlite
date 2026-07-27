"""Independent PostgreSQL oracle for the billing golden-path smoke test.

The oracle deliberately reconstructs pricing from raw usage periods and pricing
plan effective intervals.  Persisted ``pricingSegments`` are evidence to check,
not inputs to the expected charge calculation.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, localcontext
from typing import Any
from uuid import UUID

_BOX_ID = re.compile(r"^[0-9A-Za-z]{12}$", re.ASCII)
_ZERO = Decimal("0")
_ONE = Decimal("1")
_RATE_FIELDS = (
    "cpuRateCentsPerSec",
    "memRateCentsPerSec",
    "diskRateCentsPerSec",
    "gpuRateCentsPerSec",
)
_RESOURCE_TO_USAGE = {
    "cpu": "cpuSeconds",
    "mem": "memGibSeconds",
    "disk": "diskGibSeconds",
    "gpu": "gpuSeconds",
}
_RESOURCE_TO_RATE = {
    "cpu": "cpuRateCentsPerSec",
    "mem": "memRateCentsPerSec",
    "disk": "diskRateCentsPerSec",
    "gpu": "gpuRateCentsPerSec",
}


def validate_uuid(value: str, field: str = "UUID") -> str:
    """Return the canonical form of a UUID or reject it at the boundary."""

    if not isinstance(value, str):
        raise ValueError(f"{field} must be a UUID string")
    try:
        parsed = UUID(value)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a valid UUID") from exc
    if value.lower() != str(parsed):
        raise ValueError(f"{field} must use canonical UUID form")
    return str(parsed)


def validate_box_id(value: str) -> str:
    """Reject identifiers that cannot be safely used as a Box ID."""

    if not isinstance(value, str) or _BOX_ID.fullmatch(value) is None:
        raise ValueError("box_id must be exactly 12 ASCII letters or digits")
    return value


def decimal_text(value: Decimal | str | int) -> str:
    """Render a Decimal without exponent notation or insignificant zeros."""

    number = value if isinstance(value, Decimal) else _decimal(value, "decimal")
    if number == 0:
        return "0"
    return format(number.normalize(), "f")


def _decimal(value: Any, field: str) -> Decimal:
    try:
        number = Decimal(str(value))
    except Exception as exc:
        raise AssertionError(f"{field} is not a decimal: {value!r}") from exc
    if not number.is_finite():
        raise AssertionError(f"{field} must be finite, got {value!r}")
    return number


def _integer(value: Any, field: str) -> int:
    number = _decimal(value, field)
    integral = number.to_integral_value()
    if number != integral:
        raise AssertionError(f"{field} must be an integer, got {value!r}")
    return int(integral)


def _timestamp(value: Any, field: str = "timestamp") -> datetime:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AssertionError(
                f"{field} is not an ISO-8601 timestamp: {value!r}"
            ) from exc
    else:
        raise AssertionError(f"{field} is not an ISO-8601 timestamp: {value!r}")
    if result.tzinfo is None or result.utcoffset() is None:
        raise AssertionError(f"{field} must include a timezone")
    return result.astimezone(timezone.utc)


def _timestamp_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _elapsed_seconds(start_at: datetime, end_at: datetime) -> Decimal:
    if end_at < start_at:
        raise AssertionError(
            f"usage period ends before it starts: {_timestamp_text(start_at)} - {_timestamp_text(end_at)}"
        )
    elapsed = end_at - start_at
    return Decimal(elapsed.days * 86_400 + elapsed.seconds) + Decimal(
        elapsed.microseconds
    ) / Decimal(1_000_000)


def _assert_decimal_equal(actual: Any, expected: Decimal, field: str) -> None:
    actual_decimal = _decimal(actual, field)
    if actual_decimal != expected:
        raise AssertionError(
            f"{field} mismatch: expected {decimal_text(expected)}, got {decimal_text(actual_decimal)}"
        )


@dataclass(frozen=True)
class DerivedPricingSegment:
    pricing_version: int
    start_at: datetime
    end_at: datetime
    billed_seconds: Decimal
    unit_rates: Mapping[str, Decimal]
    usage_totals: Mapping[str, Decimal]
    precise_cents: Decimal

    def summary(self) -> dict[str, Any]:
        return {
            "pricingVersion": self.pricing_version,
            "startAt": _timestamp_text(self.start_at),
            "endAt": _timestamp_text(self.end_at),
            "billedSeconds": decimal_text(self.billed_seconds),
            "unitRates": {
                key: decimal_text(value) for key, value in self.unit_rates.items()
            },
            "usageTotals": {
                key: decimal_text(value) for key, value in self.usage_totals.items()
            },
            "preciseCents": decimal_text(self.precise_cents),
        }


@dataclass(frozen=True)
class DerivedRating:
    segments: tuple[DerivedPricingSegment, ...]
    billed_seconds: Decimal
    usage_totals: Mapping[str, Decimal]
    precise_cents: Decimal
    rated_cents: Decimal

    def summary(self) -> dict[str, Any]:
        return {
            "pricingSegments": [segment.summary() for segment in self.segments],
            "billedSeconds": decimal_text(self.billed_seconds),
            "usageTotals": {
                key: decimal_text(value) for key, value in self.usage_totals.items()
            },
            "preciseCents": decimal_text(self.precise_cents),
            "ratedCents": decimal_text(self.rated_cents),
        }


class BillingOracle:
    """Facade over billing persistence and its independent accounting rules."""

    def __init__(
        self,
        organization_id: str,
        *,
        environ: Mapping[str, str] | None = None,
        query: Callable[[str, Mapping[str, str]], Any] | None = None,
    ) -> None:
        self.organization_id = validate_uuid(organization_id, "organization_id")
        self._environ = dict(os.environ if environ is None else environ)
        self._query_override = query

    # ---- authoritative reads -------------------------------------------------

    def wallet(self) -> dict[str, Any] | None:
        return self._query_json(
            """
            SELECT json_build_object(
              'id', w.id::text,
              'organizationId', w."organizationId"::text,
              'freeBalanceCents', w."freeBalanceCents"::text,
              'paidBalanceCents', w."paidBalanceCents"::text,
              'settlementRemainderCents', w."settlementRemainderCents"::text,
              'billingStatus', w."billingStatus",
              'createdAt', w."createdAt",
              'updatedAt', w."updatedAt",
              'transactions', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'id', wt.id::text,
                    'walletId', wt."walletId"::text,
                    'organizationId', wt."organizationId"::text,
                    'kind', wt.kind,
                    'amountCents', wt."amountCents"::text,
                    'source', wt.source,
                    'ratedPeriodId', wt."ratedPeriodId"::text,
                    'providerActionId', wt."providerActionId",
                    'metadata', wt.metadata,
                    'createdAt', wt."createdAt"
                  ) ORDER BY wt."createdAt", wt.id
                )
                FROM wallet_transaction wt
                WHERE wt."walletId" = w.id
              ), '[]'::json)
            )
            FROM wallet w
            WHERE w."organizationId" = (:'organization_id')::uuid
            """,
            organization_id=self.organization_id,
        )

    def top_ups(self) -> list[dict[str, Any]]:
        rows = self._query_json(
            """
            SELECT COALESCE(json_agg(
              json_build_object(
                'id', t.id::text,
                'walletId', t."walletId"::text,
                'organizationId', t."organizationId"::text,
                'amountCents', t."amountCents"::text,
                'source', t.source,
                'status', t.status,
                'providerReference', t."providerReference",
                'completedAt', t."completedAt",
                'createdAt', t."createdAt",
                'updatedAt', t."updatedAt"
              ) ORDER BY t."createdAt", t.id
            ), '[]'::json)
            FROM top_up_record t
            WHERE t."organizationId" = (:'organization_id')::uuid
               OR t."walletId" = (
                 SELECT w.id
                 FROM wallet w
                 WHERE w."organizationId" = (:'organization_id')::uuid
               )
            """,
            organization_id=self.organization_id,
        )
        return list(rows or [])

    def organization_usage_counts(self) -> dict[str, Any]:
        return self._query_json(
            """
            SELECT json_build_object(
              'activePeriods', (
                SELECT count(*)::text FROM box_usage_period
                WHERE "organizationId" = (:'organization_id')
              ),
              'archivedPeriods', (
                SELECT count(*)::text FROM box_usage_period_archive
                WHERE "organizationId" = (:'organization_id')
              ),
              'ratedPeriods', (
                SELECT count(*)::text FROM rated_period
                WHERE "organizationId" = (:'organization_id')::uuid
              )
            )
            """,
            organization_id=self.organization_id,
        )

    def runner_readiness(
        self, availability_threshold: int = 10
    ) -> list[dict[str, Any]]:
        if isinstance(availability_threshold, bool) or availability_threshold < 0:
            raise ValueError("availability_threshold must be a non-negative integer")
        rows = self._query_json(
            """
            SELECT COALESCE(json_agg(
              json_build_object(
                'id', r.id::text,
                'name', r.name,
                'state', r.state::text,
                'apiVersion', r."apiVersion",
                'unschedulable', r.unschedulable,
                'draining', r.draining,
                'availabilityScore', r."availabilityScore"::text,
                'availabilityThreshold', (:'availability_threshold')::integer,
                'cpu', r.cpu::text,
                'memoryGiB', r."memoryGiB"::text,
                'diskGiB', r."diskGiB"::text,
                'lastChecked', r."lastChecked",
                'runtimeEpoch', r."runtimeEpoch"::text,
                'schedulable', (
                  r.state::text = 'ready'
                  AND r."apiVersion" = '2'
                  AND r.unschedulable = false
                  AND r.draining = false
                  AND r."availabilityScore" >= (:'availability_threshold')::integer
                )
              ) ORDER BY r."createdAt", r.id
            ), '[]'::json)
            FROM runner r
            """,
            availability_threshold=str(availability_threshold),
        )
        return list(rows or [])

    def box_snapshot(self, box_id: str) -> dict[str, Any] | None:
        box_id = validate_box_id(box_id)
        return self._query_json(
            """
            SELECT json_build_object(
              'id', b.id,
              'organizationId', b."organizationId"::text,
              'state', b.state::text,
              'desiredState', b."desiredState"::text,
              'pending', b.pending,
              'runtimeAuthorized', b."runtimeAuthorized",
              'runtimeUnavailable', b."runtimeUnavailable",
              'runtimeGeneration', b."runtimeGeneration"::text,
              'runnerId', b."runnerId"::text,
              'cpu', b.cpu::text,
              'mem', b.mem::text,
              'gpu', b.gpu::text,
              'disk', b.disk::text,
              'periodId', p.id::text,
              'periodStartAt', p."startAt",
              'periodEndAt', p."endAt",
              'periodCpu', p.cpu::text,
              'periodMem', p.mem::text,
              'periodGpu', p.gpu::text,
              'periodDisk', p.disk::text,
              'computeBillableUntil', p."computeBillableUntil",
              'periodRuntimeGeneration', p."runtimeGeneration"::text,
              'periodRunnerEpoch', p."runnerEpoch"::text,
              'leaseRunnerId', l."runnerId"::text,
              'leaseObservedAt', l."observedAt",
              'leaseExpiresAt', l."leaseExpiresAt",
              'leaseRuntimeGeneration', l."runtimeGeneration"::text,
              'leaseRunnerEpoch', l."runnerEpoch"::text,
              'leaseActualState', l."actualState"::text,
              'leaseSequence', l.sequence::text
            )
            FROM box b
            LEFT JOIN LATERAL (
              SELECT * FROM box_usage_period
              WHERE "boxId" = b.id AND "endAt" IS NULL
              ORDER BY "startAt" DESC, id DESC
              LIMIT 1
            ) p ON true
            LEFT JOIN box_runtime_lease l ON l."boxId" = b.id
            WHERE b.id = :'box_id'
              AND b."organizationId" = (:'organization_id')::uuid
            """,
            box_id=box_id,
            organization_id=self.organization_id,
        )

    def periods(self, box_id: str) -> list[dict[str, Any]]:
        box_id = validate_box_id(box_id)
        rows = self._query_json(
            """
            SELECT COALESCE(json_agg(
              json_build_object(
                'id', p.id::text,
                'boxId', p."boxId",
                'organizationId', p."organizationId"::text,
                'archived', p.archived,
                'startAt', p."startAt",
                'endAt', p."endAt",
                'computeBillableUntil', p."computeBillableUntil",
                'runtimeGeneration', p."runtimeGeneration"::text,
                'runnerEpoch', p."runnerEpoch"::text,
                'cpu', p.cpu::text,
                'mem', p.mem::text,
                'gpu', p.gpu::text,
                'disk', p.disk::text,
                'region', p.region,
                'boxClass', p."boxClass",
                'regionType', p."regionType"
              ) ORDER BY p."startAt", p.id
            ), '[]'::json)
            FROM (
              SELECT id, "boxId", "organizationId", "startAt", "endAt",
                     "computeBillableUntil", "runtimeGeneration", "runnerEpoch",
                     cpu, mem, gpu, disk, region, "boxClass", "regionType", false AS archived
              FROM box_usage_period
              WHERE "boxId" = :'box_id'
              UNION ALL
              SELECT id, "boxId", "organizationId", "startAt", "endAt",
                     "computeBillableUntil", "runtimeGeneration", "runnerEpoch",
                     cpu, mem, gpu, disk, region, "boxClass", "regionType", true AS archived
              FROM box_usage_period_archive
              WHERE "boxId" = :'box_id'
            ) p
            """,
            box_id=box_id,
            organization_id=self.organization_id,
        )
        return list(rows or [])

    def rated_periods(self, box_id: str) -> list[dict[str, Any]]:
        box_id = validate_box_id(box_id)
        rows = self._query_json(
            """
            SELECT COALESCE(json_agg(
              json_build_object(
                'id', rp.id::text,
                'usagePeriodArchiveId', rp."usagePeriodArchiveId"::text,
                'organizationId', rp."organizationId"::text,
                'boxId', rp."boxId",
                'pricingSegments', rp."pricingSegments",
                'usageTotals', rp."usageTotals",
                'billedSeconds', rp."billedSeconds"::text,
                'preciseCents', rp."preciseCents"::text,
                'ratedCents', rp."ratedCents"::text,
                'ratedAt', rp."ratedAt",
                'startAt', a."startAt",
                'endAt', a."endAt",
                'computeBillableUntil', a."computeBillableUntil",
                'runtimeGeneration', a."runtimeGeneration"::text,
                'runnerEpoch', a."runnerEpoch"::text,
                'cpu', a.cpu::text,
                'mem', a.mem::text,
                'gpu', a.gpu::text,
                'disk', a.disk::text,
                'transactionId', wt.id::text,
                'transactionKind', wt.kind,
                'transactionAmountCents', wt."amountCents"::text,
                'transactionSource', wt.source,
                'transactionRatedPeriodId', wt."ratedPeriodId"::text,
                'transactionMetadata', wt.metadata,
                'transactionCreatedAt', wt."createdAt"
              ) ORDER BY a."startAt", rp.id
            ), '[]'::json)
            FROM rated_period rp
            JOIN box_usage_period_archive a ON a.id = rp."usagePeriodArchiveId"
            LEFT JOIN wallet_transaction wt ON wt."ratedPeriodId" = rp.id
            WHERE rp."boxId" = :'box_id'
            """,
            box_id=box_id,
            organization_id=self.organization_id,
        )
        return list(rows or [])

    def pricing_plans(self) -> list[dict[str, Any]]:
        rows = self._query_json(
            """
            SELECT COALESCE(json_agg(
              json_build_object(
                'id', p.id::text,
                'version', p.version,
                'cpuRateCentsPerSec', p."cpuRateCentsPerSec"::text,
                'memRateCentsPerSec', p."memRateCentsPerSec"::text,
                'diskRateCentsPerSec', p."diskRateCentsPerSec"::text,
                'gpuRateCentsPerSec', p."gpuRateCentsPerSec"::text,
                'effectiveFrom', p."effectiveFrom",
                'effectiveTo', p."effectiveTo"
              ) ORDER BY p."effectiveFrom", p.version
            ), '[]'::json)
            FROM pricing_plan p
            """
        )
        return list(rows or [])

    # ---- independent pricing -------------------------------------------------

    def rate_period(
        self,
        period: Mapping[str, Any],
        plans: Sequence[Mapping[str, Any]],
        *,
        end_at: datetime | str | None = None,
    ) -> DerivedRating:
        start = _timestamp(period.get("startAt"), "period.startAt")
        raw_end = end_at if end_at is not None else period.get("endAt")
        if raw_end is None:
            raise AssertionError("open usage period requires an explicit end_at")
        end = _timestamp(raw_end, "period.endAt")
        resources = {
            name: _decimal(period.get(name), f"period.{name}")
            for name in _RESOURCE_TO_USAGE
        }
        for name, value in resources.items():
            if value < 0:
                raise AssertionError(f"period.{name} must be non-negative")

        normalized_plans: list[dict[str, Any]] = []
        versions: set[int] = set()
        for index, plan in enumerate(plans):
            version = _integer(plan.get("version"), f"plans[{index}].version")
            if version in versions:
                raise AssertionError(f"duplicate pricing version {version}")
            versions.add(version)
            effective_from = _timestamp(
                plan.get("effectiveFrom"), f"plans[{index}].effectiveFrom"
            )
            effective_to_value = plan.get("effectiveTo")
            effective_to = (
                None
                if effective_to_value is None
                else _timestamp(effective_to_value, f"plans[{index}].effectiveTo")
            )
            if effective_to is not None and effective_to <= effective_from:
                raise AssertionError(
                    f"pricing version {version} has a non-positive interval"
                )
            rates = {
                field: _decimal(plan.get(field), f"plans[{index}].{field}")
                for field in _RATE_FIELDS
            }
            if any(rate < 0 for rate in rates.values()):
                raise AssertionError(f"pricing version {version} has a negative rate")
            normalized_plans.append(
                {
                    "version": version,
                    "effectiveFrom": effective_from,
                    "effectiveTo": effective_to,
                    "rates": rates,
                }
            )
        normalized_plans.sort(key=lambda plan: (plan["effectiveFrom"], plan["version"]))

        cursor = start
        segments: list[DerivedPricingSegment] = []
        with localcontext() as context:
            context.prec = 80
            while cursor < end:
                active = [
                    plan
                    for plan in normalized_plans
                    if plan["effectiveFrom"] <= cursor
                    and (plan["effectiveTo"] is None or cursor < plan["effectiveTo"])
                ]
                if not active:
                    raise AssertionError(f"pricing gap at {_timestamp_text(cursor)}")
                if len(active) > 1:
                    raise AssertionError(
                        f"pricing overlap at {_timestamp_text(cursor)}"
                    )
                plan = active[0]
                boundaries = [end]
                if plan["effectiveTo"] is not None:
                    boundaries.append(plan["effectiveTo"])
                boundaries.extend(
                    candidate["effectiveFrom"]
                    for candidate in normalized_plans
                    if candidate["effectiveFrom"] > cursor
                )
                segment_end = min(boundaries)
                if segment_end <= cursor:
                    raise AssertionError(
                        f"pricing interval does not advance at {_timestamp_text(cursor)}"
                    )
                seconds = _elapsed_seconds(cursor, segment_end)
                usage_totals = {
                    usage_field: resources[resource] * seconds
                    for resource, usage_field in _RESOURCE_TO_USAGE.items()
                }
                precise = sum(
                    (
                        usage_totals[_RESOURCE_TO_USAGE[resource]]
                        * plan["rates"][_RESOURCE_TO_RATE[resource]]
                        for resource in _RESOURCE_TO_USAGE
                    ),
                    _ZERO,
                )
                segments.append(
                    DerivedPricingSegment(
                        pricing_version=plan["version"],
                        start_at=cursor,
                        end_at=segment_end,
                        billed_seconds=seconds,
                        unit_rates=dict(plan["rates"]),
                        usage_totals=usage_totals,
                        precise_cents=precise,
                    )
                )
                cursor = segment_end

            usage_totals = {
                usage_field: sum(
                    (segment.usage_totals[usage_field] for segment in segments), _ZERO
                )
                for usage_field in _RESOURCE_TO_USAGE.values()
            }
            billed_seconds = sum(
                (segment.billed_seconds for segment in segments), _ZERO
            )
            precise_cents = sum((segment.precise_cents for segment in segments), _ZERO)
            rated_cents = precise_cents.quantize(_ONE, rounding=ROUND_HALF_UP)
        return DerivedRating(
            segments=tuple(segments),
            billed_seconds=billed_seconds,
            usage_totals=usage_totals,
            precise_cents=precise_cents,
            rated_cents=rated_cents,
        )

    def project_period(
        self,
        period: Mapping[str, Any],
        plans: Sequence[Mapping[str, Any]],
        at: datetime | str,
    ) -> DerivedRating:
        """Project an open period only through independently billable wall time."""

        projected_end = _timestamp(at, "projection.at")
        cap = period.get("computeBillableUntil")
        has_compute = any(
            _decimal(period.get(name), f"period.{name}") > 0
            for name in ("cpu", "mem", "gpu")
        )
        if has_compute:
            if cap is None:
                raise AssertionError("FULL period is missing computeBillableUntil")
            projected_end = min(
                projected_end, _timestamp(cap, "period.computeBillableUntil")
            )
        return self.rate_period(period, plans, end_at=projected_end)

    def assert_rated_period(
        self,
        period: Mapping[str, Any],
        rated: Mapping[str, Any],
        plans: Sequence[Mapping[str, Any]],
    ) -> DerivedRating:
        if rated.get("usagePeriodArchiveId") != period.get("id"):
            raise AssertionError(
                "rated period references the wrong archived usage period"
            )
        if rated.get("boxId") != period.get("boxId"):
            raise AssertionError("rated period boxId does not match its usage period")
        if rated.get("organizationId") != self.organization_id:
            raise AssertionError(
                "rated period organizationId does not match the oracle"
            )
        for field in ("startAt", "endAt"):
            if _timestamp(rated.get(field), f"rated.{field}") != _timestamp(
                period.get(field), f"period.{field}"
            ):
                raise AssertionError(f"rated.{field} does not match its usage period")
        for field in _RESOURCE_TO_USAGE:
            _assert_decimal_equal(
                rated.get(field),
                _decimal(period.get(field), f"period.{field}"),
                f"rated.{field}",
            )

        expected = self.rate_period(period, plans)
        if expected.precise_cents <= _ZERO:
            raise AssertionError(
                "independently derived precise charge must be positive, "
                f"got {decimal_text(expected.precise_cents)}"
            )
        actual_segments = rated.get("pricingSegments")
        if not isinstance(actual_segments, list):
            raise AssertionError("rated.pricingSegments must be a list")
        if len(actual_segments) != len(expected.segments):
            raise AssertionError(
                f"pricing segment count mismatch: expected {len(expected.segments)}, got {len(actual_segments)}"
            )
        for index, (actual, derived) in enumerate(
            zip(actual_segments, expected.segments, strict=True)
        ):
            if (
                _integer(
                    actual.get("pricingVersion"), f"segment[{index}].pricingVersion"
                )
                != derived.pricing_version
            ):
                raise AssertionError(f"segment[{index}].pricingVersion mismatch")
            if (
                _timestamp(actual.get("startAt"), f"segment[{index}].startAt")
                != derived.start_at
            ):
                raise AssertionError(f"segment[{index}].startAt mismatch")
            if (
                _timestamp(actual.get("endAt"), f"segment[{index}].endAt")
                != derived.end_at
            ):
                raise AssertionError(f"segment[{index}].endAt mismatch")
            _assert_decimal_equal(
                actual.get("billedSeconds"),
                derived.billed_seconds,
                f"segment[{index}].billedSeconds",
            )
            actual_rates = actual.get("unitRates")
            actual_usage = actual.get("usageTotals")
            if not isinstance(actual_rates, Mapping) or not isinstance(
                actual_usage, Mapping
            ):
                raise AssertionError(
                    f"segment[{index}] rates and usageTotals must be objects"
                )
            for field, value in derived.unit_rates.items():
                _assert_decimal_equal(
                    actual_rates.get(field),
                    value,
                    f"segment[{index}].unitRates.{field}",
                )
            for field, value in derived.usage_totals.items():
                _assert_decimal_equal(
                    actual_usage.get(field),
                    value,
                    f"segment[{index}].usageTotals.{field}",
                )
            _assert_decimal_equal(
                actual.get("preciseCents"),
                derived.precise_cents,
                f"segment[{index}].preciseCents",
            )

        _assert_decimal_equal(
            rated.get("billedSeconds"), expected.billed_seconds, "rated.billedSeconds"
        )
        actual_totals = rated.get("usageTotals")
        if not isinstance(actual_totals, Mapping):
            raise AssertionError("rated.usageTotals must be an object")
        for field, value in expected.usage_totals.items():
            _assert_decimal_equal(
                actual_totals.get(field), value, f"rated.usageTotals.{field}"
            )
        _assert_decimal_equal(
            rated.get("preciseCents"), expected.precise_cents, "rated.preciseCents"
        )
        _assert_decimal_equal(
            rated.get("ratedCents"), expected.rated_cents, "rated.ratedCents"
        )
        return expected

    # ---- topology and ledger -------------------------------------------------

    def assert_four_period_topology(
        self, periods: Sequence[Mapping[str, Any]]
    ) -> list[Mapping[str, Any]]:
        if len(periods) != 4:
            raise AssertionError(
                f"expected exactly four usage periods, got {len(periods)}"
            )
        ordered = sorted(
            periods,
            key=lambda row: (_timestamp(row.get("startAt")), str(row.get("id"))),
        )
        expected_modes = ("FULL", "DISK", "FULL", "DISK")
        for index, (period, expected_mode) in enumerate(
            zip(ordered, expected_modes, strict=True)
        ):
            if period.get("boxId") is None:
                raise AssertionError(f"period[{index}] is missing boxId")
            validate_box_id(str(period["boxId"]))
            if period.get("organizationId") != self.organization_id:
                raise AssertionError(f"period[{index}] organizationId mismatch")
            if period.get("endAt") is None:
                raise AssertionError(f"period[{index}] is still open")
            start = _timestamp(period.get("startAt"), f"period[{index}].startAt")
            end = _timestamp(period.get("endAt"), f"period[{index}].endAt")
            if end <= start:
                raise AssertionError(f"period[{index}] must have a positive duration")
            resources = {
                name: _decimal(period.get(name), f"period[{index}].{name}")
                for name in _RESOURCE_TO_USAGE
            }
            mode = (
                "DISK"
                if resources["cpu"] == resources["mem"] == resources["gpu"] == 0
                else "FULL"
            )
            if mode != expected_mode:
                raise AssertionError(
                    f"period[{index}] expected {expected_mode}, got {mode}"
                )
            if resources["disk"] != Decimal("10"):
                raise AssertionError(f"period[{index}] disk must remain exactly 10 GiB")
            if mode == "FULL":
                if resources != {
                    "cpu": Decimal("2"),
                    "mem": Decimal("2"),
                    "disk": Decimal("10"),
                    "gpu": _ZERO,
                }:
                    raise AssertionError(
                        f"period[{index}] FULL resources are not 2 CPU / 2 GiB / 10 GiB"
                    )
                cap = period.get("computeBillableUntil")
                if (
                    cap is None
                    or _timestamp(cap, f"period[{index}].computeBillableUntil") < end
                ):
                    raise AssertionError(
                        f"period[{index}] FULL compute cap does not cover its end"
                    )
                generation = _integer(
                    period.get("runtimeGeneration"),
                    f"period[{index}].runtimeGeneration",
                )
                if generation <= 0:
                    raise AssertionError(
                        f"period[{index}] runtimeGeneration must be positive"
                    )
                validate_uuid(
                    str(period.get("runnerEpoch")), f"period[{index}].runnerEpoch"
                )
            else:
                if resources != {
                    "cpu": _ZERO,
                    "mem": _ZERO,
                    "disk": Decimal("10"),
                    "gpu": _ZERO,
                }:
                    raise AssertionError(f"period[{index}] DISK resources are invalid")
                for field in (
                    "computeBillableUntil",
                    "runtimeGeneration",
                    "runnerEpoch",
                ):
                    if period.get(field) is not None:
                        raise AssertionError(
                            f"period[{index}] DISK {field} must be null"
                        )
            if index > 0:
                previous_end = _timestamp(
                    ordered[index - 1].get("endAt"), f"period[{index - 1}].endAt"
                )
                if previous_end != start:
                    raise AssertionError(
                        f"period[{index - 1}] and period[{index}] are not adjacent"
                    )
        first_generation = _integer(
            ordered[0].get("runtimeGeneration"), "period[0].runtimeGeneration"
        )
        second_generation = _integer(
            ordered[2].get("runtimeGeneration"), "period[2].runtimeGeneration"
        )
        if second_generation <= first_generation:
            raise AssertionError(
                "restarted FULL period must use a newer runtime generation"
            )
        return ordered

    def assert_wallet_ledger(
        self,
        wallet: Mapping[str, Any],
        rated_periods: Sequence[Mapping[str, Any]],
    ) -> dict[str, Decimal]:
        transactions = wallet.get("transactions")
        if not isinstance(transactions, list):
            raise AssertionError("wallet.transactions must be a list")
        ordered_transactions = sorted(
            transactions,
            key=lambda row: (
                _timestamp(row.get("createdAt"), "transaction.createdAt"),
                str(row.get("id")),
            ),
        )
        if transactions != ordered_transactions:
            raise AssertionError("wallet ledger is not ordered by createdAt,id")
        rated_order = [str(row.get("id")) for row in rated_periods]
        rated_by_id = {
            rated_id: row
            for rated_id, row in zip(rated_order, rated_periods, strict=True)
        }
        if len(rated_by_id) != len(rated_periods):
            raise AssertionError("rated period IDs are not unique")

        free = _ZERO
        paid = _ZERO
        remainder = _ZERO
        total_precise = _ZERO
        total_debit = _ZERO
        seen_rated: set[str] = set()
        with localcontext() as context:
            context.prec = 80
            for index, transaction in enumerate(transactions):
                if transaction.get("walletId") != wallet.get("id"):
                    raise AssertionError(f"transaction[{index}] walletId mismatch")
                if transaction.get("organizationId") != self.organization_id:
                    raise AssertionError(
                        f"transaction[{index}] organizationId mismatch"
                    )
                amount = _decimal(
                    transaction.get("amountCents"), f"transaction[{index}].amountCents"
                )
                if amount != amount.to_integral_value():
                    raise AssertionError(
                        f"transaction[{index}] amountCents must be an integer"
                    )
                kind = transaction.get("kind")
                if kind == "free_grant":
                    if amount < 0 or transaction.get("ratedPeriodId") is not None:
                        raise AssertionError("free_grant transaction is malformed")
                    free += amount
                    continue
                if kind == "top_up":
                    if amount <= 0 or transaction.get("source") != "manual_top_up":
                        raise AssertionError(
                            "golden-path top_up transaction is malformed"
                        )
                    if transaction.get("ratedPeriodId") is not None:
                        raise AssertionError(
                            "top_up transaction must not reference a rated period"
                        )
                    paid += amount
                    continue
                if kind != "usage_debit":
                    raise AssertionError(f"unexpected wallet transaction kind {kind!r}")

                rated_id = str(transaction.get("ratedPeriodId"))
                usage_index = len(seen_rated)
                if usage_index >= len(rated_order) or rated_id != rated_order[usage_index]:
                    expected_rated_id = (
                        rated_order[usage_index]
                        if usage_index < len(rated_order)
                        else "<none>"
                    )
                    raise AssertionError(
                        "usage debit order mismatch: "
                        f"expected rated period {expected_rated_id}, got {rated_id}"
                    )
                if rated_id not in rated_by_id:
                    raise AssertionError(
                        f"usage debit references unknown rated period {rated_id}"
                    )
                if rated_id in seen_rated:
                    raise AssertionError(
                        f"rated period {rated_id} has more than one usage debit"
                    )
                seen_rated.add(rated_id)
                rated = rated_by_id[rated_id]
                precise = _decimal(
                    rated.get("preciseCents"), f"rated[{rated_id}].preciseCents"
                )
                unsettled = remainder + precise
                debit = unsettled.to_integral_value(rounding=ROUND_FLOOR)
                expected_amount = -debit
                if amount != expected_amount:
                    raise AssertionError(
                        f"usage debit for {rated_id} expected {decimal_text(expected_amount)}, got {decimal_text(amount)}"
                    )
                free_debit = min(debit, max(free, _ZERO))
                paid_debit = debit - free_debit
                remainder_after = unsettled - debit
                metadata = transaction.get("metadata")
                if not isinstance(metadata, Mapping):
                    raise AssertionError(
                        f"usage debit for {rated_id} is missing metadata"
                    )
                expected_metadata = {
                    "preciseCents": precise,
                    "remainderBeforeCents": remainder,
                    "remainderAfterCents": remainder_after,
                    "freeDebitCents": free_debit,
                    "paidDebitCents": paid_debit,
                }
                for field, expected in expected_metadata.items():
                    _assert_decimal_equal(
                        metadata.get(field),
                        expected,
                        f"transaction[{index}].metadata.{field}",
                    )
                if transaction.get("source") != "rated_period":
                    raise AssertionError(
                        f"usage debit for {rated_id} has the wrong source"
                    )
                if rated.get("transactionId") is not None and rated.get(
                    "transactionId"
                ) != transaction.get("id"):
                    raise AssertionError(
                        f"rated period {rated_id} points at the wrong transaction"
                    )
                if rated.get("transactionAmountCents") is not None:
                    _assert_decimal_equal(
                        rated.get("transactionAmountCents"),
                        amount,
                        "rated.transactionAmountCents",
                    )
                free -= free_debit
                paid -= paid_debit
                remainder = remainder_after
                total_precise += precise
                total_debit += debit

        missing = set(rated_by_id) - seen_rated
        if missing:
            raise AssertionError(
                f"rated periods missing usage debit transactions: {sorted(missing)}"
            )
        if not (_ZERO <= remainder < _ONE):
            raise AssertionError("settlement remainder must stay in [0, 1)")
        _assert_decimal_equal(
            wallet.get("freeBalanceCents"), free, "wallet.freeBalanceCents"
        )
        _assert_decimal_equal(
            wallet.get("paidBalanceCents"), paid, "wallet.paidBalanceCents"
        )
        _assert_decimal_equal(
            wallet.get("settlementRemainderCents"),
            remainder,
            "wallet.settlementRemainderCents",
        )
        ledger_total = sum(
            (
                _decimal(row.get("amountCents"), "transaction.amountCents")
                for row in transactions
            ),
            _ZERO,
        )
        if ledger_total != free + paid:
            raise AssertionError("wallet balances do not conserve the immutable ledger")
        if total_precise != total_debit + remainder:
            raise AssertionError(
                "precise usage, whole-cent debits, and remainder do not conserve globally"
            )
        return {
            "freeBalanceCents": free,
            "paidBalanceCents": paid,
            "remainderCents": remainder,
            "totalPreciseCents": total_precise,
            "debitCents": total_debit,
        }

    # ---- golden assertions ---------------------------------------------------

    def assert_pristine_baseline(self) -> dict[str, Any]:
        wallet = self.wallet()
        if wallet is None:
            raise AssertionError(f"organization {self.organization_id} has no wallet")
        _assert_decimal_equal(
            wallet.get("freeBalanceCents"), _ZERO, "wallet.freeBalanceCents"
        )
        _assert_decimal_equal(
            wallet.get("paidBalanceCents"), Decimal("2500"), "wallet.paidBalanceCents"
        )
        _assert_decimal_equal(
            wallet.get("settlementRemainderCents"),
            _ZERO,
            "wallet.settlementRemainderCents",
        )
        top_ups = self.top_ups()
        if len(top_ups) != 1:
            raise AssertionError(
                f"expected one manual top-up record, got {len(top_ups)}"
            )
        top_up = top_ups[0]
        if (
            top_up.get("walletId") != wallet.get("id")
            or top_up.get("organizationId") != self.organization_id
            or _integer(top_up.get("amountCents"), "top_up.amountCents") != 2500
            or top_up.get("source") != "manual"
            or top_up.get("status") != "paid"
            or top_up.get("completedAt") is None
        ):
            raise AssertionError(
                "manual top-up record does not match the golden fixture"
            )
        transactions = wallet.get("transactions")
        if not isinstance(transactions, list) or len(transactions) != 1:
            raise AssertionError(
                "baseline wallet must contain exactly one ledger transaction"
            )
        transaction = transactions[0]
        metadata = transaction.get("metadata")
        if (
            transaction.get("kind") != "top_up"
            or transaction.get("source") != "manual_top_up"
            or _integer(
                transaction.get("amountCents"), "top_up_transaction.amountCents"
            )
            != 2500
            or transaction.get("ratedPeriodId") is not None
            or not isinstance(metadata, Mapping)
            or metadata.get("topUpId") != top_up.get("id")
        ):
            raise AssertionError(
                "manual top-up ledger row does not match its top-up record"
            )
        counts = self.organization_usage_counts()
        for field in ("activePeriods", "archivedPeriods", "ratedPeriods"):
            if _integer(counts.get(field), f"usage_counts.{field}") != 0:
                raise AssertionError(
                    f"organization has historical billing usage in {field}"
                )
        return {"wallet": wallet, "topUp": top_up, "usageCounts": counts}

    def assert_exact_settlement(self, box_id: str) -> dict[str, Any]:
        box_id = validate_box_id(box_id)
        periods = self.assert_four_period_topology(self.periods(box_id))
        if not all(period.get("archived") is True for period in periods):
            raise AssertionError(
                "all four closed usage periods must be archived before strict settlement"
            )
        rated = self.rated_periods(box_id)
        if len(rated) != 4:
            raise AssertionError(
                f"expected exactly four rated periods, got {len(rated)}"
            )
        rated_by_archive = {str(row.get("usagePeriodArchiveId")): row for row in rated}
        if len(rated_by_archive) != 4 or set(rated_by_archive) != {
            str(row.get("id")) for row in periods
        }:
            raise AssertionError(
                "rated periods are not a one-to-one match for the four archived periods"
            )
        plans = self.pricing_plans()
        if not plans:
            raise AssertionError("no pricing plans are persisted")
        derived: list[DerivedRating] = []
        for period in periods:
            derived.append(
                self.assert_rated_period(
                    period, rated_by_archive[str(period["id"])], plans
                )
            )
        wallet = self.wallet()
        if wallet is None:
            raise AssertionError("wallet disappeared during settlement")
        ledger = self.assert_wallet_ledger(wallet, rated)
        if ledger["debitCents"] < 1:
            raise AssertionError("golden path must debit at least one whole cent")
        return {
            "periods": periods,
            "ratedPeriods": [rated_by_archive[str(period["id"])] for period in periods],
            "derived": derived,
            "wallet": wallet,
            **ledger,
        }

    # ---- psql transport ------------------------------------------------------

    def _query_json(self, sql: str, **variables: str) -> Any:
        variables = {"organization_id": self.organization_id, **variables}
        if self._query_override is not None:
            return self._query_override(sql, variables)
        environment = {
            **self._environ,
            "PGPASSWORD": self._environ.get("BILLING_E2E_DB_PASSWORD", "boxlite"),
            "PGCONNECT_TIMEOUT": self._environ.get(
                "BILLING_E2E_DB_CONNECT_TIMEOUT", "5"
            ),
            "PGOPTIONS": self._environ.get("PGOPTIONS", "-c statement_timeout=5000"),
        }
        command = [
            "psql",
            "-X",
            "-qAt",
            "--set=ON_ERROR_STOP=1",
            "-h",
            self._environ.get("BILLING_E2E_DB_HOST", "127.0.0.1"),
            "-p",
            self._environ.get("BILLING_E2E_DB_PORT", "5432"),
            "-U",
            self._environ.get("BILLING_E2E_DB_USERNAME", "boxlite"),
            "-d",
            self._environ.get("BILLING_E2E_DB_DATABASE", "boxlite_dev"),
        ]
        for key, value in sorted(variables.items()):
            command.append(f"--set={key}={value}")
        try:
            timeout = float(self._environ.get("BILLING_E2E_DB_COMMAND_TIMEOUT", "10"))
        except ValueError as exc:
            raise ValueError("BILLING_E2E_DB_COMMAND_TIMEOUT must be numeric") from exc
        if timeout <= 0:
            raise ValueError("BILLING_E2E_DB_COMMAND_TIMEOUT must be positive")
        try:
            result = subprocess.run(
                command,
                check=True,
                input=sql,
                capture_output=True,
                env=environment,
                text=True,
                timeout=timeout,
            )
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or "").strip()
            if not detail:
                detail = "no stderr"
            raise RuntimeError(
                f"psql query failed with exit code {exc.returncode}: {detail}"
            ) from exc
        output = result.stdout.strip()
        if not output:
            return None
        try:
            return json.loads(output)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                "psql returned invalid JSON for a billing oracle query"
            ) from exc
