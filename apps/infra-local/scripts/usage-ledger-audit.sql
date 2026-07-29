-- Audit the box usage ledger against the box table. Read-only; safe on any
-- environment (local / dev / prod).
--
--   psql "postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite" \
--     --pset=border=2 -f usage-ledger-audit.sql
--
-- Deliberately one bare statement with no psql directives, so the same file can
-- be read as a report or counted for an exit code:
--
--   psql … -qtAX -f usage-ledger-audit.sql | grep -c '[^[:space:]]'
--
-- `usage-crash-scenario.sh audit` does both, and exits non-zero on any finding
-- so it can run as a cron check or a CI gate.
--
-- Every rule below mirrors one branch of UsageService
-- (apps/api/src/usage/services/usage.service.ts), which is the only writer of
-- box_usage_periods. It reacts to in-process events emitted by
-- BoxRepository.emitUpdateEvents() *after* the box row has already committed,
-- so any interruption in that window (crash, SIGKILL, restart, a handler that
-- threw) leaves the box table and the ledger disagreeing. That disagreement is
-- what this file names.
--
-- Expected open period, per box.state:
--   started                              -> exactly 1, cpu = box.cpu   (compute)
--   stopping | stopped                   -> exactly 1, cpu = 0         (disk only)
--   error|archived|destroying|destroyed  -> none
--   desiredState = destroyed             -> none  (closed on the intent, not the outcome)
--   creating|starting|restoring|resizing -> transitional; not asserted
--
-- A finding is a billing error, not a style nit: MISSING_* under-bills the
-- customer, STALE_OPEN / OVERBILLED_COMPUTE over-bills them.

WITH ledger AS (
  -- The archive cron moves closed periods out of box_usage_periods, so a box's
  -- billed history is the union of both tables; reading either alone makes the
  -- answer depend on whether that cron happened to have run.
  SELECT "boxId", "startAt", "endAt", cpu, gpu, mem, disk FROM box_usage_periods
  UNION ALL
  SELECT "boxId", "startAt", "endAt", cpu, gpu, mem, disk FROM box_usage_periods_archive
),
open_period AS (
  SELECT
    "boxId",
    count(*)          AS open_count,
    max(cpu)          AS cpu,
    max(disk)         AS disk,
    min("startAt")    AS since
  FROM ledger
  WHERE "endAt" IS NULL
  GROUP BY "boxId"
),
b AS (
  SELECT
    id,
    name,
    state::text          AS state,
    "desiredState"::text AS desired_state,
    cpu,
    disk,
    "updatedAt"
  FROM box
),
-- Periods must tile a box's lifetime: each ends before the next starts (an
-- overlap bills twice) and leaves no hole behind it (a gap bills nobody).
-- Close-then-reopen is two separate `new Date()` calls, so the seam is a few
-- milliseconds wide rather than exact.
chain AS (
  SELECT
    "boxId",
    "startAt",
    "endAt",
    lag("endAt")  OVER (PARTITION BY "boxId" ORDER BY "startAt") AS prev_end,
    lag("startAt") OVER (PARTITION BY "boxId" ORDER BY "startAt") AS prev_start
  FROM ledger
),
findings AS (
  -- ---- under-billing: the box is consuming, the ledger is not counting -----
  SELECT 1 AS severity, 'MISSING_OPEN' AS finding, b.id, b.name, b.state, b.desired_state,
         format('box is started but has no open period (never billed since the handler was lost)') AS detail
  FROM b LEFT JOIN open_period o ON o."boxId" = b.id
  WHERE b.state = 'started' AND b.desired_state <> 'destroyed' AND o."boxId" IS NULL

  UNION ALL
  SELECT 1, 'MISSING_OPEN_DISK', b.id, b.name, b.state, b.desired_state,
         format('box is %s but has no open period; its disk is not being billed', b.state)
  FROM b LEFT JOIN open_period o ON o."boxId" = b.id
  WHERE b.state IN ('stopping', 'stopped') AND b.desired_state <> 'destroyed' AND o."boxId" IS NULL

  -- Same revenue impact as MISSING_OPEN — a running box billed as if parked —
  -- and it is what a lost STARTED leaves behind when the box already had a
  -- disk-only period open, so it is graded the same.
  UNION ALL
  SELECT 1, 'UNDERBILLED_COMPUTE', b.id, b.name, b.state, b.desired_state,
         format('box is started (cpu=%s) but its open period bills cpu=0 (disk only)', b.cpu)
  FROM b JOIN open_period o ON o."boxId" = b.id
  WHERE b.state = 'started' AND b.desired_state <> 'destroyed' AND o.cpu = 0

  -- ---- over-billing: the ledger is counting, the box is not consuming ------
  UNION ALL
  SELECT 1, 'STALE_OPEN', b.id, b.name, b.state, b.desired_state,
         format('box reached %s / desired %s but a period is still open since %s',
                b.state, b.desired_state, to_char(o.since, 'YYYY-MM-DD HH24:MI:SS'))
  FROM b JOIN open_period o ON o."boxId" = b.id
  WHERE b.state IN ('error', 'archived', 'destroying', 'destroyed') OR b.desired_state = 'destroyed'

  UNION ALL
  SELECT 1, 'OVERBILLED_COMPUTE', b.id, b.name, b.state, b.desired_state,
         format('box is %s but its open period still bills cpu=%s (should be 0)', b.state, o.cpu)
  FROM b JOIN open_period o ON o."boxId" = b.id
  WHERE b.state IN ('stopping', 'stopped') AND b.desired_state <> 'destroyed' AND o.cpu > 0

  UNION ALL
  SELECT 1, 'ORPHAN_OPEN', o."boxId", NULL, NULL, NULL,
         format('open period since %s but the box row is gone',
                to_char(o.since, 'YYYY-MM-DD HH24:MI:SS'))
  FROM open_period o LEFT JOIN b ON b.id = o."boxId"
  WHERE b.id IS NULL

  -- ---- wrong amount --------------------------------------------------------
  UNION ALL
  SELECT 2, 'WRONG_SIZE', b.id, b.name, b.state, b.desired_state,
         format('box is cpu=%s disk=%s but the open period bills cpu=%s disk=%s (a resize was lost)',
                b.cpu, b.disk, o.cpu, o.disk)
  FROM b JOIN open_period o ON o."boxId" = b.id
  WHERE b.state = 'started' AND o.cpu > 0 AND (o.cpu <> b.cpu OR o.disk <> b.disk)

  -- ---- structural ----------------------------------------------------------
  UNION ALL
  SELECT 1, 'MULTI_OPEN', o."boxId", b.name, b.state, b.desired_state,
         format('%s periods are open at once', o.open_count)
  FROM open_period o LEFT JOIN b ON b.id = o."boxId"
  WHERE o.open_count > 1

  UNION ALL
  SELECT 2, 'OVERLAP', c."boxId", b.name, b.state, b.desired_state,
         format('period starting %s overlaps the previous one (prev end %s)',
                to_char(c."startAt", 'YYYY-MM-DD HH24:MI:SS.MS'),
                coalesce(to_char(c.prev_end, 'YYYY-MM-DD HH24:MI:SS.MS'), 'still open'))
  FROM chain c LEFT JOIN b ON b.id = c."boxId"
  WHERE c.prev_start IS NOT NULL AND (c.prev_end IS NULL OR c."startAt" < c.prev_end)

  UNION ALL
  SELECT 2, 'GAP', c."boxId", b.name, b.state, b.desired_state,
         format('%s unbilled between %s and %s',
                justify_interval(c."startAt" - c.prev_end),
                to_char(c.prev_end, 'YYYY-MM-DD HH24:MI:SS.MS'),
                to_char(c."startAt", 'YYYY-MM-DD HH24:MI:SS.MS'))
  FROM chain c LEFT JOIN b ON b.id = c."boxId"
  WHERE c.prev_end IS NOT NULL AND c."startAt" - c.prev_end > interval '2 seconds'
)
SELECT
  CASE severity WHEN 1 THEN 'HIGH' ELSE 'MED' END AS sev,
  finding,
  id   AS box_id,
  name AS box_name,
  state,
  desired_state,
  detail
FROM findings
ORDER BY severity, finding, id;
