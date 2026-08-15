// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { runSsmCommand } from './clickhouse-readiness.mjs'

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function buildWriterSmokeCommand({ region, collectorEndpoint, adminSecretArn }) {
  if (!region || !collectorEndpoint || !adminSecretArn) {
    throw new Error('region, collectorEndpoint, and adminSecretArn are required')
  }
  const marker = `boxlite-clickhouse-smoke-${randomUUID()}`
  const payload = JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'boxlite-clickhouse-readiness' } }],
        },
        scopeLogs: [
          {
            scope: { name: 'boxlite-infra' },
            logRecords: [
              {
                timeUnixNano: '__NOW_UNIX_NANO__',
                severityText: 'INFO',
                body: { stringValue: marker },
              },
            ],
          },
        ],
      },
    ],
  })
  const escapedMarker = marker.replaceAll("'", "''")
  return `set -euo pipefail
NOW_UNIX_NANO=$(date +%s%N)
PAYLOAD=${shellLiteral(payload)}
PAYLOAD="\${PAYLOAD/__NOW_UNIX_NANO__/\${NOW_UNIX_NANO}}"
curl --silent --show-error --fail --header 'content-type: application/json' --data "$PAYLOAD" ${shellLiteral(`${collectorEndpoint.replace(/\/+$/, '')}/v1/logs`)} >/dev/null
ADMIN_PASSWORD=$(aws secretsmanager get-secret-value --region ${shellLiteral(region)} --secret-id ${shellLiteral(adminSecretArn)} --query SecretString --output text)
for attempt in $(seq 1 60); do
  COUNT=$(docker exec -e CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" boxlite-clickhouse clickhouse-client --user boxlite_admin --query ${shellLiteral(`SELECT count() FROM otel.otel_logs WHERE Body = '${escapedMarker}'`)})
  [ "$COUNT" -ge 1 ] && break
  sleep 2
done
unset ADMIN_PASSWORD
[ "$COUNT" -ge 1 ] || { echo 'FATAL: synthetic OTLP log did not reach ClickHouse' >&2; exit 1; }`
}

function run() {
  const { AWS_REGION, CLICKHOUSE_INSTANCE_ID, CLICKHOUSE_ADMIN_SECRET_ARN, OTEL_COLLECTOR_ENDPOINT } =
    process.env
  const command = buildWriterSmokeCommand({
    region: AWS_REGION,
    collectorEndpoint: OTEL_COLLECTOR_ENDPOINT,
    adminSecretArn: CLICKHOUSE_ADMIN_SECRET_ARN,
  })
  runSsmCommand({
    region: AWS_REGION,
    instanceId: CLICKHOUSE_INSTANCE_ID,
    command,
    comment: 'BoxLite ClickHouse writer readiness',
  })
  console.log('clickhouse-writer-ready: synthetic OTLP log arrived')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
