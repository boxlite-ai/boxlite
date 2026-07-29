/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/*
 * Holds (or releases) the per-box usage lock so the ledger write for one box
 * parks while its box row commits — the window a crashing API dies in. Uses the
 * key UsageService itself waits on (`usage-period-<boxId>`), so nothing about
 * the API's behaviour is faked.
 *
 *   node apps/scripts/usage-period-chaos/park-handler.mjs hold <boxId> [--ttl 600] [--port 26379]
 *   node apps/scripts/usage-period-chaos/park-handler.mjs release <boxId>
 */
import Redis from 'ioredis'

const [action, boxId] = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : fallback
}

if (!['hold', 'release'].includes(action) || !boxId) {
  console.error('usage: park-handler.mjs <hold|release> <boxId> [--ttl 600] [--host 127.0.0.1] [--port 26379] [--db 0]')
  process.exit(2)
}

const redis = new Redis({
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', 26379)),
  db: Number(arg('db', 0)),
})
const key = `usage-period-${boxId}`

try {
  if (action === 'hold') {
    const ttl = Number(arg('ttl', 600))
    await redis.set(key, 'parked-by-chaos-runbook', 'EX', ttl)
    console.log(`held ${key} for ${ttl}s — the usage handler for ${boxId} will block at its first await`)
  } else {
    await redis.del(key)
    console.log(`released ${key}`)
  }
} finally {
  await redis.quit()
}
