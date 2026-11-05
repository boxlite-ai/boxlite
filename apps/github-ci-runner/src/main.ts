/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Json, Listener, ListenerState } from '@boxlite-ai/ci-listener'
import { SqliteStateDatabase } from '../../libs/ci-listener/src/state/sqlite'
import { BoxLiteWorkers } from './boxlite-workers'
import { loadConfig } from './config'
import { createHttp } from './http'
import { SelfHost } from './self-host'
import { EnvironmentCapacity } from './capacity'
async function main(): Promise<void> {
  const config = loadConfig(),
    database = new SqliteStateDatabase(config.stateDir),
    namespace = 'ci-listener',
    state = new ListenerState(database, namespace),
    auth = config.github
  const github: Json =
    auth.kind === 'app'
      ? { kind: 'app', issuer: auth.issuer }
      : { kind: 'pat', owner: auth.owner.toLowerCase(), repository: auth.repository.toLowerCase() }
  const stop = new AbortController()
  let host: SelfHost | undefined, http: ReturnType<typeof createHttp> | undefined
  const shutdown = () => stop.abort()
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    const boxes = await BoxLiteWorkers.connect(state, config.endpoint, config.apiKey(), [
      { key: 'backend/github', payload: github },
    ])
    const [prior] = await state.read(['backend/github'])
    if (!prior) throw new Error('Original GitHub backend identity changed')
    if (auth.kind === 'app') {
      const root = prior.payload as { kind?: string; issuer?: string; applications?: string[] }
      const ids = (auth.applications ?? [auth]).map((app) => app.issuer)
      if (
        root.kind !== 'app' ||
        root.issuer !== auth.issuer ||
        (root.applications ?? [auth.issuer]).some((id) => !ids.includes(id))
      )
        throw new Error('Original GitHub App identities changed')
    } else if (JSON.stringify(prior.payload) !== JSON.stringify(github))
      throw new Error('Original GitHub backend identity changed')
    host = new SelfHost(config, state, database, namespace, boxes)
    const listener = new Listener({
      state,
      host,
      worker: config.worker,
      capacity: new EnvironmentCapacity(config.max),
    })
    const routes = new Map<string, { application: string; secret: Buffer }>()
    if (auth.kind === 'app')
      for (const entry of auth.applications ?? [auth]) {
        if (!(entry.webhookSecretFile || (entry.issuer === auth.issuer && config.webhookSecretFile))) continue
        const app = host.applications.get(entry.issuer)!
        const path = '/v1/ci/github/webhook' + (entry.issuer === auth.issuer ? '' : '/' + entry.issuer)
        routes.set(path, { application: app.clientId, secret: app.secret() })
      }
    http = createHttp(listener, host, routes)
    await new Promise<void>((resolve, reject) => {
      http!.server.once('error', reject)
      http!.server.listen(config.listen.port, config.listen.host, resolve)
    })
    console.log(JSON.stringify({ event: 'ci-listener-started', auth: config.github.kind, webhook: routes.size > 0 }))
    await listener.run(stop.signal)
  } finally {
    stop.abort()
    process.removeListener('SIGTERM', shutdown)
    process.removeListener('SIGINT', shutdown)
    const errors: unknown[] = []
    try {
      await http?.close()
    } catch (error) {
      errors.push(error)
    }
    try {
      await host?.close()
    } catch (error) {
      errors.push(error)
    }
    try {
      await database.close()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length) throw new AggregateError(errors, 'Listener host shutdown is incomplete')
  }
}
void main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'ci-listener-failed',
      error: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : 'Listener failed',
    }),
  )
  process.exitCode = 1
})
