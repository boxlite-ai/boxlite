/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Json, Listener, ListenerState } from '@boxlite-ai/ci-listener'
import { SqliteStateDatabase } from '../../libs/ci-listener/src/state/sqlite'
import { BoxLiteWorkers } from './boxlite-workers'
import { loadConfig, privateFile } from './config'
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
    if (!prior || JSON.stringify(prior.payload) !== JSON.stringify(github))
      throw new Error('Original GitHub backend identity changed')
    host = new SelfHost(config, state, database, namespace, boxes)
    const listener = new Listener({
      state,
      host,
      worker: config.worker,
      capacity: new EnvironmentCapacity(config.max),
    })
    const secret = config.webhookSecretFile
      ? Buffer.from(privateFile(config.webhookSecretFile).toString('utf8').trim())
      : undefined
    if (secret && secret.length < 32) throw new Error('Webhook secret requires at least 32 bytes')
    http = createHttp(listener, host, secret)
    await new Promise<void>((resolve, reject) => {
      http!.server.once('error', reject)
      http!.server.listen(config.listen.port, config.listen.host, resolve)
    })
    console.log(JSON.stringify({ event: 'ci-listener-started', auth: config.github.kind, webhook: !!secret }))
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
