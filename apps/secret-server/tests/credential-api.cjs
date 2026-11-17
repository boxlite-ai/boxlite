// Run the actual credential service/controller/migration from the pinned API PR.
// No API production files are copied into the Secret Server implementation.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
require('reflect-metadata')
const ts = require('typescript')
const { Test } = require('@nestjs/testing')
const { DataSource } = require('typeorm')
const express = require('express')

const apiCommit = 'bd10e984f00758222bfe6724fa3994a17c8e1329'
const repository = path.resolve(__dirname, '../../..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-credential-api-'))
const schema = `credential_fetch_${randomUUID().replaceAll('-', '')}`
let database, app

function source(relative) {
  const input = execFileSync('git', ['show', `${apiCommit}:apps/api/src/${relative}.ts`], {
    cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024,
  })
  const output = ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true, emitDecoratorMetadata: true,
  }}).outputText
  const destination = path.join(temporary, relative + '.js')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, output)
  return require(destination)
}

async function main() {
  if (!process.env.SECRET_TEST_DATABASE_URL) throw new Error('SECRET_TEST_DATABASE_URL is required')
  const { SecretCredentialService } = source('box/services/secret-credential.service')
  const { SecretCredentialController } = source('box/controllers/secret-credential.controller')
  const { AddSecretCredential1794873600000 } = source('migrations/pre-deploy/1794873600000-add-secret-credential-migration')
  database = await new DataSource({ type: 'postgres', url: process.env.SECRET_TEST_DATABASE_URL,
    extra: { options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 },
  }).initialize()
  await database.query(`CREATE SCHEMA "${schema}"`)
  await database.query('CREATE TABLE box (id varchar(64) PRIMARY KEY)')
  const runner = database.createQueryRunner()
  try { await new AddSecretCredential1794873600000().up(runner) }
  finally { await runner.release() }
  const service = new SecretCredentialService(database)
  const module = await Test.createTestingModule({
    controllers: [SecretCredentialController],
    providers: [{ provide: SecretCredentialService, useValue: service }],
  }).compile()
  app = module.createNestApplication({ logger: false })
  // Test-only issuance uses the production service; it is not an API route proposal.
  // Keep the fixture parser inside a router so Nest still registers its own
  // application-wide JSON parser for the production introspection controller.
  const issuance = express.Router()
  issuance.use(express.json())
  issuance.post('/', async (req, res) => {
    try {
      await database.query('INSERT INTO box(id) VALUES($1) ON CONFLICT DO NOTHING', [req.body.boxId])
      res.json(await service.issue(req.body))
    } catch { res.status(500).json({ error: 'test credential issuance failed' }) }
  })
  app.use('/__test/issue', issuance)
  await app.listen(0, '127.0.0.1')
  const apiURL = await app.getUrl()
  let passed = false
  const exit = await new Promise((resolve, reject) => {
    const child = spawn('make', ['test:apps:secret-server', 'GOTEST_FILTER=-run=TestCredentialAPIIntegration -json -count=1 -timeout=60s'], {
      cwd: repository, stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, SECRET_TEST_CREDENTIAL_API_URL: apiURL },
    })
    let pending = ''
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString()
      const lines = pending.split('\n'); pending = lines.pop()
      for (const line of lines) {
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.Output) process.stdout.write(event.Output)
        if (event.Test === 'TestCredentialAPIIntegration' && event.Action === 'pass') passed = true
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  if (exit !== 0 || !passed) throw new Error('Go credential integration test failed or did not run')
  console.log(`Credential API integration verified against ${apiCommit}`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 }).finally(async () => {
  try {
    await app?.close()
    if (database?.isInitialized) {
      await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await database.destroy()
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
