// Run Commerce with its own dependencies and TypeORM version; never import it into the BoxLite container.
const { createRequire } = require('node:module')
const { join } = require('node:path')
const commerce = createRequire(join(process.env.COMMERCE_WORKSPACE, 'package.json'))
commerce('ts-node').register({ project: join(process.env.COMMERCE_WORKSPACE, 'tsconfig.json'), transpileOnly: true })
commerce('reflect-metadata')
const { NestFactory } = commerce('@nestjs/core')
const { AppModule } = commerce('./src/app.module.ts')
const { COMMERCE_CONFIG } = commerce('./src/config.ts')
const { configureHttp } = commerce('./src/common/support/http.ts')

let app
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  try {
    await app?.close()
    process.exit(0)
  } catch {
    process.exit(1)
  }
}
process.on('message', (message) => {
  if (message === 'stop') void stop()
})
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('disconnect', stop)
async function start() {
  app = await NestFactory.create(AppModule, { logger: false, rawBody: true, abortOnError: false })
  configureHttp(app, app.get(COMMERCE_CONFIG))
  await app.listen(0, '127.0.0.1')
  process.send({ type: 'ready', url: await app.getUrl() })
}
start().catch(async (error) => {
  // Connection objects may include credentials. Report only the error class/code to the parent.
  process.send?.({ type: 'error', name: error.name, code: error.code })
  await stop()
  process.exit(1)
})
