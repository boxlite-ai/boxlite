import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { UsageQuery, USAGE_MAX_ITEMS, USAGE_MAX_PERIODS } from '../utils/usage-query'

// Only these fixed identifiers/expressions enter SQL. Caller values are parameters.
const dimensions = { organizationId: '"organizationId"', regionId: 'region', boxId: '"boxId"' }
const metrics = {
  computeVcpuSeconds: 'cpu::numeric',
  storageByteSeconds: 'disk::numeric * 1073741824::numeric',
  memoryGibSeconds: 'mem::numeric',
}

export const usageAggregation = (query: UsageQuery): { sql: string; parameters: unknown[] } => {
  const seconds =
    query.granularity === 'window'
      ? (Date.parse(query.to) - Date.parse(query.from)) / 1000
      : query.granularity === 'hour'
        ? 3600
        : 86400
  const parameters: unknown[] = [query.from, query.to, seconds, BOX_WARM_POOL_UNASSIGNED_ORGANIZATION]
  const predicates = [
    '"startAt" < $2::timestamptz',
    '("endAt" IS NULL OR "endAt" > $1::timestamptz)',
    '"organizationId" != $4',
  ]
  for (const dimension of ['organizationId', 'regionId', 'boxId'] as const) {
    if (query[dimension] !== undefined) {
      parameters.push(query[dimension])
      predicates.push(`${dimensions[dimension]} = $${parameters.length}`)
    }
  }
  const selectedDimensions = query.groupBy.map((key) => dimensions[key])
  const dimensionJson = query.groupBy.map((key) => `'${key}', ${dimensions[key]}`).join(', ')
  const aggregateMetrics = query.metrics.map(
    (key) => `sum((${metrics[key]}) * extract(epoch FROM overlap_end - overlap_start))::text AS "${key}"`,
  )
  const metricJson = query.metrics.map((key) => `'${key}', "${key}"`).join(', ')
  return {
    parameters,
    sql: `
      WITH candidates AS MATERIALIZED (
        SELECT "organizationId", region, "boxId", "startAt", "endAt", cpu, mem, disk
        FROM box_usage_periods WHERE ${predicates.join(' AND ')}
        UNION ALL
        SELECT "organizationId", region, "boxId", "startAt", "endAt", cpu, mem, disk
        FROM box_usage_periods_archive WHERE ${predicates.join(' AND ')}
        LIMIT ${USAGE_MAX_PERIODS + 1}
      ), budget AS MATERIALIZED (
        SELECT count(*)::integer AS "periodCount",
          coalesce(bool_or(
            cpu::text IN ('NaN','Infinity','-Infinity') OR cpu < 0 OR cpu > 1e15 OR
            mem::text IN ('NaN','Infinity','-Infinity') OR mem < 0 OR mem > 1e15 OR
            disk::text IN ('NaN','Infinity','-Infinity') OR disk < 0 OR disk > 1e15 OR
            "endAt" <= "startAt"
          ), false) AS invalid
        FROM candidates
      ), clipped AS (
        SELECT candidates.*,
          greatest("startAt", $1::timestamptz) AS start_at,
          least(coalesce("endAt", $2::timestamptz), $2::timestamptz) AS end_at
        FROM candidates, budget WHERE NOT invalid AND "periodCount" <= ${USAGE_MAX_PERIODS}
      ), segments AS (
        SELECT clipped.*, bucket,
          greatest(start_at, $1::timestamptz + bucket * $3::numeric * interval '1 second') AS overlap_start,
          least(end_at, $1::timestamptz + (bucket + 1) * $3::numeric * interval '1 second') AS overlap_end
        FROM clipped CROSS JOIN LATERAL generate_series(
          floor(extract(epoch FROM start_at - $1::timestamptz) / $3::numeric)::integer,
          ceil(extract(epoch FROM end_at - $1::timestamptz) / $3::numeric)::integer - 1
        ) AS bucket
      ), aggregated AS (
        SELECT bucket, ${selectedDimensions.join(', ')}, count(*)::integer AS "sourcePeriodCount",
          ${aggregateMetrics.join(', ')}
        FROM segments
        GROUP BY bucket, ${selectedDimensions.join(', ')}
        ORDER BY bucket, ${selectedDimensions.join(', ')}
        LIMIT ${USAGE_MAX_ITEMS + 1}
      )
      SELECT budget."periodCount", budget.invalid,
        coalesce((SELECT jsonb_agg(jsonb_build_object(
          'from', to_char(($1::timestamptz + bucket * $3::numeric * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'to', to_char(least($2::timestamptz, $1::timestamptz + (bucket + 1) * $3::numeric * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'dimensions', jsonb_build_object(${dimensionJson}),
          'values', jsonb_build_object(${metricJson}),
          'sourcePeriodCount', "sourcePeriodCount"
        ) ORDER BY bucket, ${selectedDimensions.join(', ')}) FROM aggregated), '[]'::jsonb) AS items
      FROM budget`,
  }
}
