import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, lstat, readFile, readlink, symlink, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const apps = fileURLToPath(new URL('..', import.meta.url))
const artifacts = process.env.REFERRAL_ARTIFACTS_DIR
if (!artifacts || !path.isAbsolute(artifacts))
  throw new Error('Set REFERRAL_ARTIFACTS_DIR to an absolute artifact directory')
const runId = process.env.REFERRAL_RUN_ID ?? new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid
if (!/^[A-Za-z0-9_-]+$/.test(runId))
  throw new Error('REFERRAL_RUN_ID must contain only letters, digits, underscore or hyphen')
const runDirectory = path.join(artifacts, 'runs', runId)
for (const dir of ['cache', 'tmp', 'dist', 'browsers', 'runs'])
  await mkdir(path.join(artifacts, dir), { recursive: true })
await mkdir(runDirectory, { recursive: true })
const dist = path.join(apps, 'dist')
try {
  const stat = await lstat(dist)
  if (!stat.isSymbolicLink() || path.resolve(apps, await readlink(dist)) !== path.join(artifacts, 'dist')) {
    throw new Error(
      'apps/dist must be absent or point to REFERRAL_ARTIFACTS_DIR/dist; existing artifacts were preserved',
    )
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await symlink(path.join(artifacts, 'dist'), dist, 'dir')
}
const env = {
  ...process.env,
  BUSINESS_EVENTS_ENABLED: process.env.BUSINESS_EVENTS_ENABLED ?? 'false',
  REFERRAL_RUN_ID: runId,
  REFERRAL_REPORT_DIR: runDirectory,
  TMPDIR: path.join(artifacts, 'tmp'),
  NX_DAEMON: 'false',
  NX_CACHE_DIRECTORY: path.join(artifacts, 'cache', 'nx'),
  NX_WORKSPACE_DATA_DIRECTORY: path.join(artifacts, 'cache', 'nx-workspace'),
  VITE_CACHE_DIR: path.join(artifacts, 'cache', 'vite'),
  PLAYWRIGHT_BROWSERS_PATH: path.join(artifacts, 'browsers'),
  YARN_GLOBAL_FOLDER: path.join(artifacts, 'cache', 'yarn'),
  HUSKY: '0',
}
const mode = process.argv[2]
const changed = [
  ...execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB'], { cwd: apps, encoding: 'utf8' })
    .trim()
    .split('\n'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--full-name'], { cwd: apps, encoding: 'utf8' })
    .trim()
    .split('\n'),
]
  .filter(
    (file) =>
      file.startsWith('apps/') &&
      !file.includes('/libs/') &&
      !file.includes('/infra-local/') &&
      /\.(ts|tsx|mts|mjs|cjs|json)$/.test(file),
  )
  .map((file) => file.slice(5))
let commandIndex = 0
const startedAt = new Date().toISOString()
const commands = []
const sourceHash = createHash('sha256')
for (const file of [...new Set(changed)].sort()) sourceHash.update(file).update(await readFile(path.join(apps, file)))
const sourceSha256 = sourceHash.digest('hex')
const generatedClients = [
  { project: 'api-client', directory: 'libs/api-client/src' },
  { project: 'api-client-go', directory: 'libs/api-client-go' },
  { project: 'analytics-api-client', directory: 'libs/analytics-api-client/src' },
]
async function generatedHash() {
  const hash = createHash('sha256')
  for (const { directory } of generatedClients) {
    const root = path.join(apps, directory)
    hash.update(directory)
    for (const file of (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((f) => f.isFile())
      .map((f) => path.relative(root, path.join(f.parentPath, f.name)))
      .sort()) {
      hash.update(file).update(await readFile(path.join(root, file)))
    }
  }
  return hash.digest('hex')
}
async function generateClients() {
  for (const { project } of generatedClients)
    await run('yarn', ['nx', 'run', project + ':generate:api-client', '--skip-nx-cache'])
}
async function run(command, args) {
  const outputIndex = args.indexOf('--outputFile')
  if (outputIndex >= 0) args[outputIndex + 1] = path.join(runDirectory, mode + '-' + (commandIndex + 1) + '.json')
  console.log('>', command, ...args)
  const log = createWriteStream(path.join(runDirectory, String(++commandIndex) + '-' + mode + '.log'))
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: apps, env, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      log.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      log.write(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      log.end()
      commands.push({ command, args, exitCode: code, signal, log: path.basename(log.path) })
      if (code === 0) resolve()
      else reject(new Error(command + ' failed: ' + (signal ?? code)))
    })
  })
}
const jest = [
  'jest',
  '--config',
  'api/jest.config.ts',
  '--runInBand',
  '--cacheDirectory',
  path.join(artifacts, 'cache', 'jest'),
  '--coverageDirectory',
  path.join(runDirectory, 'coverage'),
  '--json',
  '--outputFile',
  path.join(runDirectory, mode + '.json'),
]
let succeeded = false
try {
  switch (mode) {
    case 'format':
      await run('yarn', ['prettier', '--write', ...changed, '--config', '../.prettierrc'])
      break
    case 'unit':
      await run('yarn', [
        ...jest,
        '--testPathPatterns',
        '(organization-referral|business-events)/.*\\.spec\\.ts$',
        '--testPathIgnorePatterns',
        'integration|acceptance',
      ])
      await run('yarn', [
        ...jest,
        '--testPathPatterns',
        '(auth/(jwt.strategy|combined-auth.guard)|user/user.service.default-organization-compat|organization/(controllers/organization.controller|services/organization.service))\\.spec\\.ts$',
      ])
      break
    case 'dashboard':
      await run('yarn', [
        'vitest',
        'run',
        '--config',
        'dashboard/vite.config.mts',
        'referral',
        '--maxWorkers=1',
        '--reporter=default',
        '--reporter=json',
        '--outputFile=' + path.join(runDirectory, 'dashboard.json'),
      ])
      break
    case 'generate':
      await generateClients()
      break
    case 'typecheck':
      await run('yarn', ['tsc', '-p', 'api/tsconfig.app.json', '--noEmit', '--incremental', 'false'])
      await run('yarn', [
        'nx',
        'run-many',
        '--target=build',
        '--projects=api-client,analytics-api-client',
        '--parallel=1',
      ])
      await run('yarn', ['tsc', '-p', 'dashboard/tsconfig.app.json', '--noEmit', '--incremental', 'false'])
      break
    case 'check': {
      const before = await generatedHash()
      await generateClients()
      if ((await generatedHash()) !== before)
        throw new Error('Generated API clients changed; review generation and rerun the check')
      await run('yarn', ['tsc', '-p', 'api/tsconfig.app.json', '--noEmit', '--incremental', 'false'])
      await run('yarn', [
        'nx',
        'run-many',
        '--target=build',
        '--projects=api-client,analytics-api-client',
        '--parallel=1',
      ])
      await run('yarn', ['tsc', '-p', 'dashboard/tsconfig.app.json', '--noEmit', '--incremental', 'false'])
      await run('yarn', ['nx', 'run', 'api:build:production', '--skip-nx-cache'])
      await run('yarn', ['nx', 'run', 'dashboard:build:production', '--skip-nx-cache'])
      await run('yarn', ['nx', 'run', 'api:lint'])
      await run('yarn', ['eslint', ...changed.filter((file) => /\.(ts|tsx|mts|mjs|cjs)$/.test(file))])
      await run('yarn', ['prettier', '--check', ...changed, '--config', '../.prettierrc'])
      break
    }
    default:
      throw new Error('Unknown referral task: ' + mode)
  }
  succeeded = true
} finally {
  await writeFile(
    path.join(runDirectory, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: succeeded ? 'passed' : 'failed',
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: apps, encoding: 'utf8' }).trim(),
        sourceSha256,
        sourceFiles: [...new Set(changed)].sort(),
        node: process.version,
        environment: {
          databaseHost: env.DB_HOST,
          databasePort: env.DB_PORT,
          redisHost: env.REDIS_HOST,
          redisPort: env.REDIS_PORT,
          artifactDirectory: artifacts,
        },
        commands,
      },
      null,
      2,
    ),
  )
}
console.log('Referral artifacts:', runDirectory)
