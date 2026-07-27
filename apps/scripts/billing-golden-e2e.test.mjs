import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { redactSecrets } from './billing-e2e-session.mjs'
import {
  archiveRuntimeDiagnostics,
  buildExpectedBillingReceipts,
  buildJUnitXml,
  buildReceiptVisibleMultiset,
  parseDriverNdjson,
  reconcileAutoReloadLedger,
  reconcileBillingPricing,
  reconcileBillingReceipts,
  reconcileMeteredUsageDebits,
  runBillingGoldenE2E,
  runMeteringDriver,
} from './billing-golden-e2e.mjs'

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptsRoot, '..', '..')

const resultEvent = {
  v: 1,
  type: 'result',
  ok: true,
  organizationId: 'f4c71d04-084c-47ba-a454-e4e468c1f7ec',
  boxId: 'ABCDEF123456',
  totalPreciseCents: '1.25',
  debitCents: '1',
  remainderCents: '0.25',
  wallet: {
    freeBalanceCents: '0',
    paidBalanceCents: '2499',
  },
  periods: [{ id: 'period-1' }],
  ratedPeriods: [{ id: 'rated-1' }],
}

test('keeps the public metering deadline aligned with the driver timeout', async () => {
  const [launcherSource, driverSource, e2eReadme] = await Promise.all([
    fs.readFile(path.join(scriptsRoot, 'billing-golden-e2e.mjs'), 'utf8'),
    fs.readFile(path.join(repositoryRoot, 'scripts', 'test', 'e2e', 'drivers', 'billing_golden_metering.py'), 'utf8'),
    fs.readFile(path.join(repositoryRoot, 'scripts', 'test', 'e2e', 'README.md'), 'utf8'),
  ])

  assert.match(launcherSource, /DRIVER_INTERNAL_TIMEOUT_MS = 20 \* 60 \* 1000/)
  assert.match(driverSource, /OVERALL_TIMEOUT = 20 \* 60\.0/)
  assert.match(launcherSource, /3 minutes of its 20-minute deadline/)
  assert.match(e2eReadme, /Metering driver has a 20-minute overall\s+deadline/)
})

test('pins and records the published Billing golden runtime image', async () => {
  const pinnedImage = 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'
  const [makefile, launcherSource] = await Promise.all([
    fs.readFile(path.join(repositoryRoot, 'make', 'test.mk'), 'utf8'),
    fs.readFile(path.join(scriptsRoot, 'billing-golden-e2e.mjs'), 'utf8'),
  ])

  assert.ok(makefile.includes(`BOXLITE_E2E_IMAGE=${pinnedImage}`))
  assert.ok(launcherSource.includes(`environment.BOXLITE_E2E_IMAGE ?? '${pinnedImage}'`))
  assert.match(launcherSource, /assert\.equal\(creatingBoxStage\?\.image, image/)
  assert.match(launcherSource, /metering:\s*{\s*image,/s)
})

test('parses one versioned staged result', () => {
  const image = 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'
  const stdout = [
    JSON.stringify({ v: 1, type: 'stage', stage: 'creating-box', status: 'started', image }),
    JSON.stringify({ v: 1, type: 'stage', stage: 'settlement', status: 'complete' }),
    JSON.stringify(resultEvent),
    '',
  ].join('\n')

  const parsed = parseDriverNdjson(stdout, {
    expectedOrganizationId: resultEvent.organizationId,
  })
  assert.equal(parsed.stages.length, 2)
  assert.equal(parsed.stages[0].image, image)
  assert.deepEqual(parsed.result, resultEvent)
})

test('rejects malformed, unversioned, and post-terminal NDJSON', () => {
  assert.throws(() => parseDriverNdjson('not-json\n'), /malformed NDJSON/)
  assert.throws(
    () =>
      parseDriverNdjson(`${JSON.stringify({ type: 'stage', stage: 'create_box' })}\n${JSON.stringify(resultEvent)}\n`),
    /unsupported protocol version/,
  )
  assert.throws(
    () =>
      parseDriverNdjson(
        [
          JSON.stringify({ v: 1, type: 'stage', stage: 'create_box' }),
          JSON.stringify(resultEvent),
          JSON.stringify(resultEvent),
          '',
        ].join('\n'),
      ),
    /after its terminal result event/,
  )
  assert.throws(
    () =>
      parseDriverNdjson(
        [
          JSON.stringify({ v: 1, type: 'stage', stage: 'create_box' }),
          JSON.stringify(resultEvent),
          JSON.stringify({ v: 1, type: 'stage', stage: 'late' }),
          '',
        ].join('\n'),
      ),
    /after its terminal result event/,
  )
})

test('requires stages and exactly one successful terminal result', () => {
  assert.throws(() => parseDriverNdjson(`${JSON.stringify(resultEvent)}\n`), /no stage events/)
  assert.throws(
    () => parseDriverNdjson(`${JSON.stringify({ v: 1, type: 'stage', stage: 'create_box' })}\n`),
    /no terminal result/,
  )
  assert.throws(
    () =>
      parseDriverNdjson(
        [
          JSON.stringify({ v: 1, type: 'stage', stage: 'create_box' }),
          JSON.stringify({
            v: 1,
            type: 'error',
            ok: false,
            error: { type: 'AssertionError', message: 'settlement mismatch' },
          }),
          '',
        ].join('\n'),
      ),
    /reported AssertionError: settlement mismatch/,
  )
  assert.throws(
    () =>
      parseDriverNdjson(
        [JSON.stringify({ v: 1, type: 'stage', stage: 'create_box' }), JSON.stringify(resultEvent), ''].join('\n'),
        { exitCode: 2, stderr: 'driver failed' },
      ),
    /exited with code 2; lastStage=create_box/,
  )
  assert.throws(
    () =>
      parseDriverNdjson(
        [
          JSON.stringify({ v: 1, type: 'stage', stage: 'create_box' }),
          JSON.stringify({ ...resultEvent, boxId: '../unsafe-box' }),
          '',
        ].join('\n'),
      ),
    /valid Box id/,
  )
})

test('redacts credentials, cookies, and idempotency keys from diagnostics', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.payload.signature'
  const key = 'top-up-secret-key'
  const diagnostic = redactSecrets(
    `Authorization: Bearer ${token}\nCookie: sid=secret\nIdempotency-Key: ${key}\n{"idempotencyKey":"${key}"}`,
    [token, key],
  )
  assert.doesNotMatch(diagnostic, /payload|sid=secret|top-up-secret-key/)
  assert.match(diagnostic, /\[REDACTED\]/)
})

test('redacts bracketed and comma-delimited absolute paths from archived diagnostics', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostic-paths-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.writeFile(
    path.join(runnerHomeDir, 'logs', 'boxlite.log'),
    [
      'failure paths=[/var/lib/private-host/evidence.log,/opt/private-host/backup.log]',
      'double-root=//var/lib/private-host/double-root.log',
      'file-url=file://localhost/opt/private-host/file-url.log',
      'host-path=/api/private-host/evidence.log',
      'ansi-path=\u001b[31m/tmp/private-host/ansi.log',
      'ansi-file-url=\u001b[31mfile:///tmp/private-host/ansi-url.log',
      '',
    ].join('\n'),
  )

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })
  const archivedRunnerLog = await fs.readFile(
    path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'boxlite.log'),
    'utf8',
  )

  assert.equal(result.status, 'archived')
  assert.doesNotMatch(archivedRunnerLog, /(?:file:\/\/localhost)?\/{1,2}(?:var\/lib|opt)\/private-host/)
  assert.match(archivedRunnerLog, /paths=\[\[ABSOLUTE_PATH\],\[ABSOLUTE_PATH\]\]/)
  assert.match(archivedRunnerLog, /double-root=\[ABSOLUTE_PATH\]/)
  assert.match(archivedRunnerLog, /file-url=\[ABSOLUTE_PATH\]/)
  assert.match(archivedRunnerLog, /host-path=\[ABSOLUTE_PATH\]/)
  assert.match(archivedRunnerLog, /ansi-path=\[ABSOLUTE_PATH\]/)
  assert.match(archivedRunnerLog, /ansi-file-url=\[ABSOLUTE_PATH\]/)
  assert.equal(archivedRunnerLog.includes('\u001b'), false)
})

test('redacts URL-encoded evidence paths from diagnostic contents and filenames', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostic-encoded-paths-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const encodedArtifactsDir = encodeURIComponent(artifactsDir)
  const encodedFileName = `${encodedArtifactsDir}.log`

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.writeFile(path.join(runnerHomeDir, 'logs', 'boxlite.log'), `encoded-evidence-path=${encodedArtifactsDir}\n`)
  await fs.writeFile(path.join(runnerHomeDir, 'logs', encodedFileName), 'encoded path in the filename\n')

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })
  const archivedRunnerLog = await fs.readFile(
    path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'boxlite.log'),
    'utf8',
  )

  assert.doesNotMatch(archivedRunnerLog, new RegExp(encodedArtifactsDir, 'i'))
  assert.match(archivedRunnerLog, /encoded-evidence-path=\[ABSOLUTE_PATH\]/)
  assert.ok(!result.copiedFiles.includes(`logs/${encodedFileName}`))
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'logs', encodedFileName)), {
    code: 'ENOENT',
  })
})

test('archives redacted diagnostics for only the isolated runner and target box', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const boxId = 'ABCDEF123456'
  const otherBoxId = 'ZYXWVUT98765'
  const token = 'runner-diagnostic-token'
  const idempotencyKey = 'runner-diagnostic-idempotency-key'

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.mkdir(path.join(runnerHomeDir, 'boxes', boxId, 'logs'), { recursive: true })
  await fs.mkdir(path.join(runnerHomeDir, 'boxes', boxId, 'disks'), { recursive: true })
  await fs.mkdir(path.join(runnerHomeDir, 'boxes', otherBoxId, 'logs'), { recursive: true })
  await fs.mkdir(path.join(runnerHomeDir, 'images', 'disk-images'), { recursive: true })
  await fs.writeFile(
    path.join(runnerHomeDir, 'logs', 'boxlite.log'),
    `Authorization: Bearer ${token}\nrunner/core log\n`,
  )
  await fs.writeFile(path.join(runnerHomeDir, 'logs', 'oversized.log'), 'x'.repeat(129))
  await fs.writeFile(path.join(runnerHomeDir, 'logs', 'binary.log'), Buffer.from([0xff, 0xfe, 0xfd]))
  await fs.writeFile(path.join(runnerHomeDir, 'logs', 'memory.bin'), Buffer.from([0xff, 0xfe, 0xfd]))
  await fs.writeFile(
    path.join(runnerHomeDir, 'boxes', boxId, 'logs', 'console.log'),
    `Cookie: sid=${token}\nIdempotency-Key: ${idempotencyKey}\nguest console\n`,
  )
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', boxId, 'shim.stderr'), `shim failed: ${token}\n`)
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', boxId, 'exit'), '1\ncrash\n')
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', boxId, 'exit.previous'), '0\n')
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', boxId, 'shim.pid'), '1234\n')
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', boxId, 'disks', 'guest-rootfs.qcow2'), 'not really small')
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', otherBoxId, 'logs', 'guest.log'), 'second guest\n')
  await fs.writeFile(path.join(runnerHomeDir, 'images', 'disk-images', 'rootfs.qcow2'), 'not really an image')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir,
    artifactsDir,
    boxId,
    secrets: [token, idempotencyKey],
    maxFileBytes: 128,
    maxTotalBytes: 1_024,
  })

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.copiedFiles.toSorted(), [
    `boxes/${boxId}/exit`,
    `boxes/${boxId}/exit.previous`,
    `boxes/${boxId}/logs/console.log`,
    `boxes/${boxId}/shim.stderr`,
    'logs/boxlite.log',
  ])
  assert.ok(
    result.skippedFiles.some((entry) => entry.path === 'logs/oversized.log' && entry.reason === 'file-too-large'),
  )
  assert.ok(
    result.skippedFiles.some((entry) => entry.path === 'logs/memory.bin' && entry.reason === 'unsupported-text-file'),
  )
  assert.ok(result.skippedFiles.some((entry) => entry.path === 'logs/binary.log' && entry.reason === 'non-text-file'))
  const archivedRunnerLog = await fs.readFile(
    path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'boxlite.log'),
    'utf8',
  )
  const archivedBoxLog = await fs.readFile(
    path.join(artifactsDir, 'runtime-diagnostics', 'boxes', boxId, 'logs', 'console.log'),
    'utf8',
  )
  assert.doesNotMatch(archivedRunnerLog, new RegExp(token))
  assert.doesNotMatch(archivedBoxLog, new RegExp(`${token}|${idempotencyKey}`))
  assert.match(archivedRunnerLog, /\[REDACTED\]/)
  assert.match(archivedBoxLog, /\[REDACTED\]/)
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'boxes', boxId, 'shim.pid')), {
    code: 'ENOENT',
  })
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'boxes', boxId, 'disks')), {
    code: 'ENOENT',
  })
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'boxes', otherBoxId)), {
    code: 'ENOENT',
  })
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'images')), { code: 'ENOENT' })
})

test('does not archive a sibling Box through a target Box directory symlink', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-box-symlink-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const targetBoxId = 'ABCDEF123456'
  const siblingBoxId = 'ZYXWVUT98765'
  const siblingSecret = 'sibling-box-private-log'
  const siblingLogName = 'SIBLING-BOX-CONFIDENTIAL-NAME.log'
  const siblingLogsDir = path.join(runnerHomeDir, 'boxes', siblingBoxId, 'logs')
  const targetBoxDir = path.join(runnerHomeDir, 'boxes', targetBoxId)

  await fs.mkdir(siblingLogsDir, { recursive: true })
  await fs.writeFile(path.join(siblingLogsDir, siblingLogName), `${siblingSecret}\n`)
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', siblingBoxId, 'shim.stderr'), 'x'.repeat(129))
  await fs.symlink(siblingBoxId, targetBoxDir, 'dir')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir,
    artifactsDir,
    boxId: targetBoxId,
    maxFileBytes: 128,
  })

  assert.ok(!result.copiedFiles.includes(`boxes/${targetBoxId}/logs/${siblingLogName}`))
  assert.doesNotMatch(JSON.stringify(result), new RegExp(siblingLogName))
  const shimSkip = result.skippedFiles.find((entry) => entry.path === `boxes/${targetBoxId}/shim.stderr`)
  assert.equal(shimSkip?.reason, 'source-path-mismatch')
  assert.equal(Object.hasOwn(shimSkip ?? {}, 'sizeBytes'), false)
  const archivedPath = path.join(artifactsDir, 'runtime-diagnostics', 'boxes', targetBoxId, 'logs', siblingLogName)
  const archivedContents = await fs.readFile(archivedPath, 'utf8').catch(() => '')
  assert.doesNotMatch(archivedContents, new RegExp(siblingSecret))
})

test('does not archive a file hard-linked from outside the isolated runner', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-hard-link-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const outsidePath = path.join(tempDir, 'outside-private.log')
  const linkedPath = path.join(runnerHomeDir, 'logs', 'linked.log')
  const outsideSecret = 'outside-hard-link-private-content'

  await fs.mkdir(path.dirname(linkedPath), { recursive: true })
  await fs.writeFile(outsidePath, `${outsideSecret}\n`)
  await fs.link(outsidePath, linkedPath)

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })

  assert.ok(!result.copiedFiles.includes('logs/linked.log'))
  const archivedContents = await fs
    .readFile(path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'linked.log'), 'utf8')
    .catch(() => '')
  assert.doesNotMatch(archivedContents, new RegExp(outsideSecret))
})

test('does not copy secret-bearing diagnostic filenames into evidence', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-secret-name-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const secret = 'TOP_SECRET_VALUE'
  const secretFileName = `${secret}.log`

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.writeFile(path.join(runnerHomeDir, 'logs', secretFileName), 'diagnostic content\n')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir,
    artifactsDir,
    secrets: [secret],
  })

  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'logs', secretFileName)), {
    code: 'ENOENT',
  })
})

test('rejects UTF-8-decodable binary diagnostics', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-binary-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const binaryLogPath = path.join(runnerHomeDir, 'logs', 'control-bytes.log')

  await fs.mkdir(path.dirname(binaryLogPath), { recursive: true })
  await fs.writeFile(binaryLogPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x0a]))

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })

  assert.ok(
    result.skippedFiles.some((entry) => entry.path === 'logs/control-bytes.log' && entry.reason === 'non-text-file'),
  )
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'control-bytes.log')), {
    code: 'ENOENT',
  })
})

test('does not follow a diagnostic file swapped to a symbolic link after inspection', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-symlink-race-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const sourcePath = path.join(runnerHomeDir, 'logs', 'boxlite.log')
  const outsidePath = path.join(tempDir, 'outside-secret.txt')
  const outsideSecret = 'must-not-follow-this-symlink'

  await fs.mkdir(path.dirname(sourcePath), { recursive: true })
  await fs.writeFile(sourcePath, 'safe runner log\n')
  await fs.writeFile(outsidePath, `${outsideSecret}\n`)

  const originalOpen = fs.open.bind(fs)
  let hasSwappedSource = false
  t.mock.method(fs, 'open', async (targetPath, ...args) => {
    const isSourceOpen =
      targetPath === sourcePath ||
      (typeof targetPath === 'string' && targetPath.endsWith(`${path.sep}logs${path.sep}boxlite.log`))
    if (isSourceOpen && !hasSwappedSource) {
      hasSwappedSource = true
      await fs.rm(sourcePath)
      await fs.symlink(outsidePath, sourcePath)
    }
    return originalOpen(targetPath, ...args)
  })

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })

  assert.equal(hasSwappedSource, true)
  assert.ok(!result.copiedFiles.includes('logs/boxlite.log'))
  const archivedPath = path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'boxlite.log')
  const archivedContents = await fs.readFile(archivedPath, 'utf8').catch(() => '')
  assert.doesNotMatch(archivedContents, new RegExp(outsideSecret))
})

test('does not archive a diagnostic directory replaced after inspection', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-directory-race-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const logsDir = path.join(runnerHomeDir, 'logs')
  const originalLogsDir = path.join(runnerHomeDir, 'original-logs')
  const outsideDir = path.join(tempDir, 'outside')
  const outsideSecret = 'must-not-follow-this-directory-symlink'

  await fs.mkdir(logsDir, { recursive: true })
  await fs.mkdir(outsideDir, { recursive: true })
  await fs.writeFile(path.join(logsDir, 'runner.log'), 'safe runner log\n')
  await fs.writeFile(path.join(outsideDir, 'outside.log'), `${outsideSecret}\n`)

  const originalLstat = fs.lstat.bind(fs)
  let hasSwappedDirectory = false
  t.mock.method(fs, 'lstat', async (targetPath, ...args) => {
    const sourceStat = await originalLstat(targetPath, ...args)
    if (path.basename(targetPath) === 'logs' && !hasSwappedDirectory) {
      hasSwappedDirectory = true
      await fs.rename(logsDir, originalLogsDir)
      await fs.rename(outsideDir, logsDir)
    }
    return sourceStat
  })

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })

  assert.equal(hasSwappedDirectory, true)
  assert.ok(!result.copiedFiles.includes('logs/outside.log'))
  const archivedPath = path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'outside.log')
  const archivedContents = await fs.readFile(archivedPath, 'utf8').catch(() => '')
  assert.doesNotMatch(archivedContents, new RegExp(outsideSecret))
})

test('does not archive a replacement runner root swapped in after inspection', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-runner-race-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const originalRunnerHomeDir = path.join(tempDir, 'original-runner')
  const replacementRunnerHomeDir = path.join(tempDir, 'replacement-runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const replacementSecret = 'replacement-runner-private-log'

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.writeFile(path.join(runnerHomeDir, 'logs', 'runner.log'), 'safe runner log\n')
  await fs.mkdir(path.join(replacementRunnerHomeDir, 'logs'), { recursive: true })
  await fs.writeFile(path.join(replacementRunnerHomeDir, 'logs', 'replacement.log'), `${replacementSecret}\n`)

  const originalLstat = fs.lstat.bind(fs)
  let hasSwappedRunnerHome = false
  t.mock.method(fs, 'lstat', async (targetPath, ...args) => {
    const sourceStat = await originalLstat(targetPath, ...args)
    if (targetPath === runnerHomeDir && !hasSwappedRunnerHome) {
      hasSwappedRunnerHome = true
      await fs.rename(runnerHomeDir, originalRunnerHomeDir)
      await fs.rename(replacementRunnerHomeDir, runnerHomeDir)
    }
    return sourceStat
  })

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })

  assert.equal(hasSwappedRunnerHome, true)
  assert.ok(!result.copiedFiles.includes('logs/replacement.log'))
  assert.doesNotMatch(JSON.stringify(result), new RegExp(replacementSecret))
  const archivedContents = await fs
    .readFile(path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'replacement.log'), 'utf8')
    .catch(() => '')
  assert.doesNotMatch(archivedContents, new RegExp(replacementSecret))
})

test('fails closed when an opened diagnostic path cannot be canonicalized', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-fd-path-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const sourcePath = path.join(runnerHomeDir, 'logs', 'boxlite.log')

  await fs.mkdir(path.dirname(sourcePath), { recursive: true })
  await fs.writeFile(sourcePath, 'runner log\n')

  const originalRealpath = fs.realpath.bind(fs)
  let descriptorPathAttempts = 0
  t.mock.method(fs, 'realpath', async (targetPath, ...args) => {
    if (typeof targetPath === 'string' && /^\/(?:proc\/self|dev)\/fd\//.test(targetPath)) {
      descriptorPathAttempts += 1
      if (descriptorPathAttempts > 2) {
        const error = new Error('canonical file descriptor paths are unavailable')
        error.code = 'ENOSYS'
        throw error
      }
    }
    return originalRealpath(targetPath, ...args)
  })

  const result = await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir })

  assert.ok(descriptorPathAttempts > 0)
  assert.ok(!result.copiedFiles.includes('logs/boxlite.log'))
  assert.ok(
    result.skippedFiles.some(
      (entry) => entry.path === 'logs/boxlite.log' && entry.reason === 'source-path-unavailable',
    ),
  )
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'boxlite.log')), {
    code: 'ENOENT',
  })
})

test('counts rejected diagnostic files against the examination limit', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-file-limit-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const logsDir = path.join(runnerHomeDir, 'logs')
  const symlinkTarget = path.join(tempDir, 'outside.log')

  await fs.mkdir(logsDir, { recursive: true })
  await fs.writeFile(symlinkTarget, 'outside\n')
  await fs.writeFile(path.join(logsDir, 'a.bin'), 'unsupported one\n')
  await fs.symlink(symlinkTarget, path.join(logsDir, 'b-linked.log'))
  await fs.writeFile(path.join(logsDir, 'c.log'), 'must remain beyond the limit\n')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir,
    artifactsDir,
    maxFiles: 2,
  })

  assert.deepEqual(result.copiedFiles, [])
  assert.ok(result.skippedFiles.some((entry) => entry.path === 'logs/c.log' && entry.reason === 'file-count-limit'))
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'c.log')), {
    code: 'ENOENT',
  })
})

test('archives only runner logs when the failed run has no target box id', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-runner-only-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const unrelatedBoxId = 'ZYXWVUT98765'

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.mkdir(path.join(runnerHomeDir, 'boxes', unrelatedBoxId, 'logs'), { recursive: true })
  await fs.writeFile(path.join(runnerHomeDir, 'logs', 'boxlite.log'), 'runner log\n')
  await fs.writeFile(path.join(runnerHomeDir, 'boxes', unrelatedBoxId, 'logs', 'guest.log'), 'unrelated box\n')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir,
    artifactsDir,
  })

  assert.equal(result.status, 'archived')
  assert.deepEqual(result.copiedFiles, ['logs/boxlite.log'])
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics', 'boxes')), { code: 'ENOENT' })
})

test('reports a missing runner home without creating an empty diagnostics directory', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-missing-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const artifactsDir = path.join(tempDir, 'artifacts')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir: path.join(tempDir, 'missing-runner'),
    artifactsDir,
  })

  assert.equal(result.status, 'source-missing')
  assert.deepEqual(result.copiedFiles, [])
  assert.deepEqual(result.skippedFiles, [])
  await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics')), { code: 'ENOENT' })
})

test('sanitizes internally reported runtime diagnostics failures', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-internal-error-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const secret = 'archive-internal-error-secret'
  const runnerHomeFile = path.join(tempDir, secret)
  await fs.writeFile(runnerHomeFile, 'not a directory')

  const result = await archiveRuntimeDiagnostics({
    runnerHomeDir: runnerHomeFile,
    artifactsDir: path.join(tempDir, 'artifacts'),
    secrets: [secret],
  })

  assert.equal(result.status, 'failed')
  assert.doesNotMatch(result.error, new RegExp(secret))
  assert.ok(!result.error.includes(tempDir), 'internal archive errors must omit absolute paths')
})

test('rejects an unsafe runtime diagnostics box id', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-box-id-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))

  await assert.rejects(
    archiveRuntimeDiagnostics({
      runnerHomeDir: path.join(tempDir, 'runner'),
      artifactsDir: path.join(tempDir, 'artifacts'),
      boxId: '../other-box',
    }),
    /boxId/,
  )
})

test('preserves the original golden failure when runtime diagnostics archival fails', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-diagnostics-error-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const artifactsDir = path.join(tempDir, 'artifacts')
  const runnerHomeFile = path.join(tempDir, 'runner-is-a-file')
  await fs.writeFile(runnerHomeFile, 'not a directory')

  await assert.rejects(
    runBillingGoldenE2E({
      environment: {
        BOXLITE_BILLING_GOLDEN_ARTIFACTS: artifactsDir,
        BOXLITE_E2E_BASE_URL: 'https://billing.example.test',
        BOXLITE_E2E_RUNNER_HOME_DIR: runnerHomeFile,
      },
    }),
    /refuses non-loopback dashboard URL/,
  )

  const artifact = JSON.parse(
    await fs.readFile(path.join(artifactsDir, 'billing-golden-e2e.json'), { encoding: 'utf8' }),
  )
  assert.match(artifact.error.message, /refuses non-loopback dashboard URL/)
  assert.equal(artifact.runtimeDiagnostics.status, 'failed')
  assert.match(artifact.runtimeDiagnostics.error, /runner home is not a directory/)
  assert.equal(Object.hasOwn(artifact, 'artifactsDir'), false)

  const jsonArtifactText = JSON.stringify(artifact)
  const junitArtifactText = await fs.readFile(path.join(artifactsDir, 'billing-golden-e2e.junit.xml'), 'utf8')
  for (const artifactText of [jsonArtifactText, junitArtifactText]) {
    assert.ok(!artifactText.includes(tempDir), 'artifacts must omit temporary absolute paths')
    assert.doesNotMatch(artifactText, /file:\/\/\//, 'artifacts must omit absolute file URLs')
  }
})

test('writes a one-case JUnit model for success and failure', () => {
  const success = buildJUnitXml({ durationMs: 1_234 })
  assert.equal((success.match(/<testcase\b/g) ?? []).length, 1)
  assert.equal((success.match(/<testsuite\b/g) ?? []).length, 1)
  assert.doesNotMatch(success, /<failure\b/)

  const failure = buildJUnitXml({
    durationMs: 2_500,
    failure: { message: 'expected <one> & got "two"', stack: 'safe stack' },
  })
  assert.equal((failure.match(/<testcase\b/g) ?? []).length, 1)
  assert.equal((failure.match(/<failure\b/g) ?? []).length, 1)
  assert.match(failure, /expected &lt;one&gt; &amp; got &quot;two&quot;/)

  const routedFailure = buildJUnitXml({
    durationMs: 50,
    failure: {
      message: 'GET /organization/example/billing failed',
      stack: 'GET /api/organization/example failed at /tmp/private-e2e.log and /workspace/private-e2e.log',
    },
  })
  assert.doesNotMatch(routedFailure, /\/organization\/example\/billing/)
  assert.doesNotMatch(routedFailure, /\/api\/organization\/example/)
  assert.match(routedFailure, /GET \[ABSOLUTE_PATH\] failed/)
  assert.doesNotMatch(routedFailure, /\/tmp\/private-e2e\.log/)
  assert.doesNotMatch(routedFailure, /\/workspace\/private-e2e\.log/)
})

test('sanitizes staged result objects before they are written or logged', async () => {
  const module = await import('./billing-golden-e2e.mjs')
  assert.equal(typeof module.sanitizeArtifactForOutput, 'function')
  const secret = 'stage-secret'
  const safeArtifact = module.sanitizeArtifactForOutput(
    {
      metering: {
        stages: [{ message: `stage-sec\u001b[31mret failed at /tmp/private-stage.log` }],
      },
    },
    { secrets: [secret] },
  )
  const serialized = JSON.stringify(safeArtifact)

  assert.doesNotMatch(serialized, /stage-secret|\/tmp\/private-stage\.log/)
  assert.equal(serialized.includes('\u001b'), false)
  assert.match(serialized, /\[REDACTED\]/)
  assert.match(serialized, /\[ABSOLUTE_PATH\]/)
})

test('archives target Box diagnostics before a failed driver removes its directory', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-driver-cleanup-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const boxId = 'ABCDEF123456'
  const accessToken = 'driver-access-token'
  const idempotencyKey = 'driver-idempotency-key'
  const fixtureScript = String.raw`
    const fs = require('node:fs/promises')
    const path = require('node:path')

    const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
    const waitForArchiveAck = () => new Promise((resolve, reject) => {
      let input = ''
      const finish = () => {
        process.stdin.removeAllListeners()
        process.stdin.destroy()
        if (input.trim()) {
          const ack = JSON.parse(input.trim().split(/\r?\n/, 1)[0])
          if (ack.v !== 1 || ack.type !== 'diagnostics-archived' || ack.boxId !== process.env.FIXTURE_BOX_ID) {
            reject(new Error('invalid diagnostics archive acknowledgement'))
            return
          }
        }
        resolve()
      }
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        input += chunk
        if (input.includes('\n')) finish()
      })
      process.stdin.on('end', finish)
      process.stdin.resume()
    })

    ;(async () => {
      const boxDir = path.join(process.env.FIXTURE_RUNNER_HOME, 'boxes', process.env.FIXTURE_BOX_ID)
      await fs.mkdir(path.join(boxDir, 'logs'), { recursive: true })
      await fs.writeFile(
        path.join(boxDir, 'logs', 'console.log'),
        process.env.FIXTURE_ACCESS_TOKEN + '\n' + process.env.FIXTURE_IDEMPOTENCY_KEY + '\n',
      )
      emit({ v: 1, type: 'stage', stage: 'box-created', boxId: process.env.FIXTURE_BOX_ID })
      emit({ v: 1, type: 'stage', stage: 'cleanup-diagnostics-ready', boxId: process.env.FIXTURE_BOX_ID })
      await waitForArchiveAck()
      await fs.rm(boxDir, { recursive: true, force: true })
      emit({
        v: 1,
        type: 'error',
        ok: false,
        error: { type: 'SyntheticDriverError', message: 'fixture failed after cleanup' },
      })
      process.exitCode = 1
    })().catch((error) => {
      process.stderr.write(String(error.stack || error))
      process.exitCode = 2
    })
  `

  let failure
  try {
    await runMeteringDriver({
      organizationId: resultEvent.organizationId,
      image: 'example.test/image',
      name: 'diagnostics-cleanup-order',
      dashboardUrl: 'http://localhost:3000',
      accessToken,
      environment: {},
      runnerHomeDir,
      artifactsDir,
      secrets: [accessToken, idempotencyKey],
      spawnProcess: (_command, _args, options) =>
        spawnChild(process.execPath, ['-e', fixtureScript], {
          ...options,
          env: {
            ...options.env,
            FIXTURE_RUNNER_HOME: runnerHomeDir,
            FIXTURE_BOX_ID: boxId,
            FIXTURE_ACCESS_TOKEN: accessToken,
            FIXTURE_IDEMPOTENCY_KEY: idempotencyKey,
          },
        }),
    })
  } catch (error) {
    failure = error
  }

  assert.ok(failure, 'fixture driver must fail')
  assert.equal(failure.diagnosticBoxId, boxId)
  assert.equal(failure.runtimeDiagnostics.status, 'archived')
  assert.deepEqual(failure.runtimeDiagnostics.copiedFiles, [`boxes/${boxId}/logs/console.log`])
  const archivedLog = await fs.readFile(
    path.join(artifactsDir, 'runtime-diagnostics', 'boxes', boxId, 'logs', 'console.log'),
    'utf8',
  )
  assert.doesNotMatch(archivedLog, new RegExp(`${accessToken}|${idempotencyKey}`))
  assert.match(archivedLog, /\[REDACTED\]/)
  await assert.rejects(fs.access(path.join(runnerHomeDir, 'boxes', boxId)), { code: 'ENOENT' })
})

test('holds one pre-remove snapshot until the outer golden-path outcome is known', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-driver-staging-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const accessToken = 'staged-driver-access-token'
  const originalRename = fs.rename.bind(fs)
  t.mock.method(fs, 'rename', async (sourcePath, destinationPath) => {
    const destinationParent = path.dirname(path.resolve(destinationPath))
    const sourceFromDestination = path.relative(destinationParent, path.resolve(sourcePath))
    if (
      sourceFromDestination === '..' ||
      sourceFromDestination.startsWith(`..${path.sep}`) ||
      path.isAbsolute(sourceFromDestination)
    ) {
      const error = new Error('EXDEV: cross-device link not permitted')
      error.code = 'EXDEV'
      throw error
    }
    return originalRename(sourcePath, destinationPath)
  })
  const fixtureScript = String.raw`
    const fs = require('node:fs/promises')
    const path = require('node:path')
    const readline = require('node:readline')

    const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
    ;(async () => {
      const boxDir = path.join(process.env.FIXTURE_RUNNER_HOME, 'boxes', process.env.FIXTURE_BOX_ID)
      await fs.mkdir(path.join(boxDir, 'logs'), { recursive: true })
      await fs.writeFile(path.join(boxDir, 'logs', 'console.log'), process.env.FIXTURE_ACCESS_TOKEN + '\n')
      emit({ v: 1, type: 'stage', stage: 'box-created', boxId: process.env.FIXTURE_BOX_ID })

      const input = readline.createInterface({ input: process.stdin })
      const lines = input[Symbol.asyncIterator]()
      for (let request = 0; request < 2; request += 1) {
        emit({ v: 1, type: 'stage', stage: 'cleanup-diagnostics-ready', boxId: process.env.FIXTURE_BOX_ID })
        const next = await lines.next()
        if (next.done) throw new Error('missing diagnostics archive acknowledgement')
        const acknowledgement = JSON.parse(next.value)
        if (
          acknowledgement.v !== 1 ||
          acknowledgement.type !== 'diagnostics-archived' ||
          acknowledgement.boxId !== process.env.FIXTURE_BOX_ID ||
          acknowledgement.status !== 'archived'
        ) {
          throw new Error('invalid diagnostics archive acknowledgement')
        }
      }
      input.close()
      await fs.rm(boxDir, { recursive: true, force: true })
      emit(JSON.parse(process.env.FIXTURE_RESULT))
    })().catch((error) => {
      process.stderr.write(String(error.stack || error))
      process.exitCode = 2
    })
  `

  const runFixture = async ({ suffix, boxId }) => {
    const runnerHomeDir = path.join(tempDir, `runner-${suffix}`)
    const artifactsDir = path.join(tempDir, `artifacts-${suffix}`)
    const result = await runMeteringDriver({
      organizationId: resultEvent.organizationId,
      image: 'example.test/image',
      name: `diagnostics-staging-${suffix}`,
      dashboardUrl: 'http://localhost:3000',
      accessToken,
      environment: {},
      runnerHomeDir,
      artifactsDir,
      secrets: [accessToken],
      spawnProcess: (_command, _args, options) =>
        spawnChild(process.execPath, ['-e', fixtureScript], {
          ...options,
          env: {
            ...options.env,
            FIXTURE_RUNNER_HOME: runnerHomeDir,
            FIXTURE_BOX_ID: boxId,
            FIXTURE_ACCESS_TOKEN: accessToken,
            FIXTURE_RESULT: JSON.stringify({ ...resultEvent, boxId }),
          },
        }),
    })
    await assert.rejects(fs.access(path.join(runnerHomeDir, 'boxes', boxId)), { code: 'ENOENT' })
    await assert.rejects(fs.access(path.join(artifactsDir, 'runtime-diagnostics')), { code: 'ENOENT' })
    return { ...result, artifactsDir, boxId }
  }

  const laterFailure = await runFixture({ suffix: 'failure', boxId: 'ABCDEF123456' })
  const promoted = await laterFailure.runtimeDiagnosticsStaging.promote()
  assert.equal(promoted.status, 'archived')
  const promotedLog = await fs.readFile(
    path.join(laterFailure.artifactsDir, 'runtime-diagnostics', 'boxes', laterFailure.boxId, 'logs', 'console.log'),
    'utf8',
  )
  assert.doesNotMatch(promotedLog, new RegExp(accessToken))
  assert.match(promotedLog, /\[REDACTED\]/)

  const successfulRun = await runFixture({ suffix: 'success', boxId: 'ZYXWVUT98765' })
  await successfulRun.runtimeDiagnosticsStaging.discard()
  await assert.rejects(fs.access(path.join(successfulRun.artifactsDir, 'runtime-diagnostics')), { code: 'ENOENT' })
  const stagingDirectories = (
    await Promise.all(
      [laterFailure.artifactsDir, successfulRun.artifactsDir].map(async (artifactsDir) =>
        (await fs.readdir(artifactsDir)).filter((entry) => entry.startsWith('.billing-runtime-diagnostics-')),
      ),
    )
  ).flat()
  assert.deepEqual(stagingDirectories, [])
})

test('acknowledges an archive failure without replacing the driver failure', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-driver-archive-failure-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner-is-a-file')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const boxId = 'ABCDEF123456'
  await fs.writeFile(runnerHomeDir, 'not a runner directory')
  const fixtureScript = String.raw`
    const readline = require('node:readline')
    const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
    ;(async () => {
      emit({ v: 1, type: 'stage', stage: 'box-created', boxId: process.env.FIXTURE_BOX_ID })
      emit({ v: 1, type: 'stage', stage: 'cleanup-diagnostics-ready', boxId: process.env.FIXTURE_BOX_ID })
      const input = readline.createInterface({ input: process.stdin })
      const lines = input[Symbol.asyncIterator]()
      const next = await lines.next()
      if (next.done) throw new Error('missing diagnostics archive acknowledgement')
      const acknowledgement = JSON.parse(next.value)
      if (acknowledgement.status !== 'failed') throw new Error('archive failure was not acknowledged')
      input.close()
      emit({
        v: 1,
        type: 'error',
        ok: false,
        error: { type: 'SyntheticDriverError', message: 'original driver failure' },
      })
      process.exitCode = 1
    })().catch((error) => {
      process.stderr.write(String(error.stack || error))
      process.exitCode = 2
    })
  `

  let failure
  try {
    await runMeteringDriver({
      organizationId: resultEvent.organizationId,
      image: 'example.test/image',
      name: 'diagnostics-archive-failure',
      dashboardUrl: 'http://localhost:3000',
      accessToken: 'archive-failure-token',
      environment: {},
      runnerHomeDir,
      artifactsDir,
      spawnProcess: (_command, _args, options) =>
        spawnChild(process.execPath, ['-e', fixtureScript], {
          ...options,
          env: {
            ...options.env,
            FIXTURE_BOX_ID: boxId,
          },
        }),
    })
  } catch (error) {
    failure = error
  }

  assert.ok(failure)
  assert.match(failure.message, /original driver failure/)
  assert.equal(failure.runtimeDiagnostics.status, 'failed')
  assert.match(failure.runtimeDiagnostics.error, /runner home is not a directory/)
  assert.ok(!failure.runtimeDiagnostics.error.includes(tempDir))
})

test('writes a configured relative evidence directory from the repository root', async (t) => {
  const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
  const appsRoot = path.resolve(scriptsRoot, '..')
  const repositoryRoot = path.resolve(appsRoot, '..')
  const relativeArtifactsDir = path.join(
    'target',
    'e2e',
    'billing-golden',
    `path-resolution-${process.pid}-${Date.now()}`,
  )
  const repositoryArtifactsDir = path.join(repositoryRoot, relativeArtifactsDir)
  const appsArtifactsDir = path.join(appsRoot, relativeArtifactsDir)
  const originalCwd = process.cwd()
  t.after(() =>
    Promise.all([
      fs.rm(repositoryArtifactsDir, { recursive: true, force: true }),
      fs.rm(appsArtifactsDir, { recursive: true, force: true }),
    ]),
  )

  try {
    process.chdir(appsRoot)
    await assert.rejects(
      runBillingGoldenE2E({
        environment: {
          BOXLITE_BILLING_E2E_ARTIFACTS: relativeArtifactsDir,
          BOXLITE_E2E_BASE_URL: 'https://example.com',
          BILLING_E2E_DB_HOST: '127.0.0.1',
        },
      }),
      /refuses non-loopback dashboard URL/,
    )
  } finally {
    process.chdir(originalCwd)
  }

  await fs.access(path.join(repositoryArtifactsDir, 'billing-golden-e2e.json'))
  await assert.rejects(fs.access(path.join(appsArtifactsDir, 'billing-golden-e2e.json')))
})

test('prefers the workflow evidence directory over the legacy artifacts variable', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-artifact-precedence-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const workflowArtifactsDir = path.join(tempDir, 'workflow-evidence')
  const legacyArtifactsDir = path.join(tempDir, 'legacy-evidence')

  await assert.rejects(
    runBillingGoldenE2E({
      environment: {
        BOXLITE_BILLING_E2E_ARTIFACTS: workflowArtifactsDir,
        BOXLITE_BILLING_GOLDEN_ARTIFACTS: legacyArtifactsDir,
        BOXLITE_E2E_BASE_URL: 'https://example.com',
        BILLING_E2E_DB_HOST: '127.0.0.1',
      },
    }),
    /refuses non-loopback dashboard URL/,
  )

  await fs.access(path.join(workflowArtifactsDir, 'billing-golden-e2e.json'))
  await assert.rejects(fs.access(legacyArtifactsDir), { code: 'ENOENT' })
})

test('redacts the configured evidence path when directory preparation fails', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-artifact-error-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const artifactsFile = path.join(tempDir, 'evidence-is-a-file')
  await fs.writeFile(artifactsFile, 'not a directory')

  await assert.rejects(
    runBillingGoldenE2E({
      environment: {
        BOXLITE_BILLING_E2E_ARTIFACTS: artifactsFile,
      },
    }),
    (error) => {
      assert.ok(!error.message.includes(artifactsFile))
      assert.match(error.message, /\[ABSOLUTE_PATH\]/)
      return true
    },
  )
})

test('does not bless a pre-populated evidence directory for upload', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-artifact-injection-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const artifactsDir = path.join(tempDir, 'artifacts')
  const bypassPath = path.join(artifactsDir, 'bypass-raw.log')

  await fs.mkdir(artifactsDir, { recursive: true })
  await fs.writeFile(bypassPath, 'UNREDACTED_BILLING_SECRET\n')

  await assert.rejects(
    runBillingGoldenE2E({
      environment: {
        BOXLITE_BILLING_E2E_ARTIFACTS: artifactsDir,
        BOXLITE_E2E_BASE_URL: 'https://example.com',
        BILLING_E2E_DB_HOST: '127.0.0.1',
      },
    }),
    /evidence directory must be empty/,
  )

  await assert.rejects(fs.access(path.join(artifactsDir, '.billing-golden-evidence-ready')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(artifactsDir, 'billing-golden-e2e.json')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(bypassPath, 'utf8'), 'UNREDACTED_BILLING_SECRET\n')
})

test('redacts local service credentials from captured runner diagnostics', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-golden-local-service-secret-'))
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }))
  const runnerHomeDir = path.join(tempDir, 'runner')
  const artifactsDir = path.join(tempDir, 'artifacts')
  const proxyApiKey = 'boxlite-local-proxy-key'
  const registryAdmin = 'boxlite-local-registry-user'

  await fs.mkdir(path.join(runnerHomeDir, 'logs'), { recursive: true })
  await fs.writeFile(
    path.join(runnerHomeDir, 'logs', 'proxy.log'),
    `proxy-key=${proxyApiKey}\nregistry-admin=${registryAdmin}\n`,
  )

  await assert.rejects(
    runBillingGoldenE2E({
      environment: {
        BOXLITE_BILLING_E2E_ARTIFACTS: artifactsDir,
        BOXLITE_E2E_RUNNER_HOME_DIR: runnerHomeDir,
        BOXLITE_E2E_BASE_URL: 'https://example.com',
        BILLING_E2E_DB_HOST: '127.0.0.1',
        INTERNAL_REGISTRY_ADMIN: registryAdmin,
        PROXY_API_KEY: proxyApiKey,
      },
    }),
    /refuses non-loopback dashboard URL/,
  )

  const archivedRunnerLog = await fs.readFile(
    path.join(artifactsDir, 'runtime-diagnostics', 'logs', 'proxy.log'),
    'utf8',
  )
  assert.doesNotMatch(archivedRunnerLog, new RegExp(`${proxyApiKey}|${registryAdmin}`))
  assert.match(archivedRunnerLog, /\[REDACTED\]/)
})

test('uploads only the current GitHub Actions Billing evidence directory', async () => {
  const workflow = parseYaml(
    await fs.readFile(new URL('../../.github/workflows/e2e-local.yml', import.meta.url), { encoding: 'utf8' }),
  )
  const job = workflow.jobs?.['e2e-tests']
  const uploadSteps = (job?.steps ?? []).filter((step) => step.name === 'Upload Billing golden-path evidence')
  const prepareEvidenceStep = (job?.steps ?? []).find((step) => step.id === 'billing-evidence')
  const billingStep = (job?.steps ?? []).find((step) => step.name === 'Run Billing golden-path smoke')
  const validateEvidenceStep = (job?.steps ?? []).find((step) => step.id === 'billing-evidence-ready')

  assert.equal(uploadSteps.length, 1)
  assert.equal(uploadSteps[0].uses, 'actions/upload-artifact@v4')
  assert.equal(job.env?.BOXLITE_BILLING_E2E_ARTIFACTS, undefined)
  assert.ok(prepareEvidenceStep, 'run-scoped Billing evidence preparation step')
  assert.equal(
    prepareEvidenceStep.env?.BILLING_EVIDENCE_PREFIX,
    'target/e2e/billing-golden/${{ github.run_id }}-${{ github.run_attempt }}',
  )
  assert.match(String(prepareEvidenceStep.run ?? ''), /mktemp -d/)
  assert.match(String(prepareEvidenceStep.run ?? ''), /GITHUB_OUTPUT/)
  assert.ok(billingStep, 'Billing golden-path step')
  assert.equal(billingStep.env?.BOXLITE_BILLING_E2E_ARTIFACTS, '${{ steps.billing-evidence.outputs.path }}')
  assert.ok(validateEvidenceStep, 'Billing evidence completion validation step')
  assert.equal(validateEvidenceStep.env?.BOXLITE_BILLING_E2E_ARTIFACTS, '${{ steps.billing-evidence.outputs.path }}')
  assert.deepEqual(
    {
      uploadPath: uploadSteps[0].with?.path,
      condition: uploadSteps[0].if,
    },
    {
      uploadPath: '${{ steps.billing-evidence.outputs.path }}',
      condition: "always() && steps.billing-evidence-ready.outputs.ready == 'true'",
    },
  )
  assert.ok(
    !(job.steps ?? []).some(
      (step) => step.uses === 'actions/upload-artifact@v4' && step.with?.path === 'target/e2e/billing-golden/',
    ),
  )
  const failureUpload = (job.steps ?? []).find((step) => step.name === 'Upload test logs on failure or cancellation')
  assert.ok(failureUpload, 'failure log upload step')
  assert.equal(
    String(failureUpload.with?.path ?? '').trimEnd(),
    '/var/log/boxlite-ci/${{ github.run_id }}-${{ github.run_attempt }}/integration.log',
  )
  assert.doesNotMatch(
    String(billingStep.run ?? ''),
    /tee|billing-golden\.log|\/var\/log\/boxlite-ci/,
    'Billing output must not be copied into the generic raw-log artifact',
  )
  assert.ok(
    !(job.steps ?? []).some((step) => step.name === 'Upload rescued prior-run logs'),
    'untrusted prior-run logs must be purged instead of uploaded',
  )
})

test('documents the Billing CI timeout, concurrency, and trigger contract', async () => {
  const workflowUrl = new URL('../../.github/workflows/e2e-local.yml', import.meta.url)
  const [workflowSource, runbook] = await Promise.all([
    fs.readFile(workflowUrl, 'utf8'),
    fs.readFile(new URL('../../docs/ci/e2e-local.md', import.meta.url), 'utf8'),
  ])
  const workflow = parseYaml(workflowSource)
  const job = workflow.jobs?.['e2e-tests']

  assert.equal(workflow.concurrency?.['cancel-in-progress'], false)
  assert.equal(workflow.concurrency?.queue, 'max')
  assert.equal(job?.['timeout-minutes'], 70)
  assert.match(workflowSource, /70-min timeout/)
  assert.match(workflowSource, /in-progress runs continue/)
  assert.match(runbook, /queued runs wait[^.]*in-progress run continues/s)
  assert.match(runbook, /70-minute timeout/)
  assert.match(runbook, /make test:integration/)
  assert.match(runbook, /make test:e2e:billing-golden/)
  for (const triggerPath of ['apps/**', 'make/**', 'scripts/setup/**', 'scripts/test/e2e/**']) {
    assert.match(runbook, new RegExp(triggerPath.replaceAll('*', '\\*')))
  }
})

test('reconciles API pricing with the active database plan', () => {
  const activePlan = {
    version: 3,
    effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    cpuRateCentsPerHour: '5.040000000000000000',
    memRateCentsPerHour: '1.620000000000000000',
    diskRateCentsPerHour: '0.010800000000000000',
    gpuRateCentsPerHour: '0.000000000000000000',
  }
  const apiPricing = {
    version: 3,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    cpuRateCentsPerHour: '5.04',
    memRateCentsPerHour: '1.62',
    diskRateCentsPerHour: '0.0108',
    gpuRateCentsPerHour: '0',
  }

  assert.deepEqual(reconcileBillingPricing(apiPricing, activePlan), apiPricing)
  assert.throws(
    () =>
      reconcileBillingPricing(
        {
          ...apiPricing,
          cpuRateCentsPerHour: '5.05',
        },
        activePlan,
      ),
    /active pricing cpuRateCentsPerHour/,
  )
})

test('reconciles stable receipt ids and preserves duplicate visible fields as a multiset', () => {
  const createdAt = new Date('2026-07-24T08:30:00.000Z')
  const amounts = ['0', '-125', '-125', '-250']
  const transactions = amounts.map((amountCents, index) => ({
    id: `transaction-${index + 1}`,
    kind: 'usage_debit',
    source: 'rated_period',
    amountCents,
    ratedPeriodId: `rated-${index + 1}`,
    metadata: [
      {
        preciseCents: '0.6',
        remainderBeforeCents: '0',
        remainderAfterCents: '0.6',
      },
      {
        preciseCents: '124.4',
        remainderBeforeCents: '0.6',
        remainderAfterCents: '0',
      },
      {
        preciseCents: '125',
        remainderBeforeCents: '0',
        remainderAfterCents: '0',
      },
      {
        preciseCents: '250.25',
        remainderBeforeCents: '0',
        remainderAfterCents: '0.25',
      },
    ][index],
    createdAt,
  }))
  const ratedPeriods = amounts.map((amountCents, index) => ({
    id: `rated-${index + 1}`,
    transactionId: `transaction-${index + 1}`,
    debitCents: BigInt(amountCents) < 0n ? (-BigInt(amountCents)).toString() : amountCents,
    preciseCents: transactions[index].metadata.preciseCents,
    remainderBeforeCents: transactions[index].metadata.remainderBeforeCents,
    remainderAfterCents: transactions[index].metadata.remainderAfterCents,
  }))
  const usageDebits = reconcileMeteredUsageDebits(transactions, ratedPeriods)
  assert.throws(
    () =>
      reconcileMeteredUsageDebits(
        transactions.map((transaction) =>
          transaction.id === 'transaction-2' ? { ...transaction, amountCents: '125' } : transaction,
        ),
        ratedPeriods,
      ),
    /usage debit transaction-2 signed amount/,
  )
  const manualTopUp = {
    id: 'top-up-manual',
    amountCents: '2500',
    status: 'paid',
    createdAt,
  }
  const autoTopUp = {
    id: 'top-up-auto',
    amountCents: '125',
    status: 'paid',
    createdAt,
  }

  const meteredReceipts = buildExpectedBillingReceipts({
    topUps: [manualTopUp],
    usageDebits,
  })
  assert.equal(meteredReceipts.length, 5)

  const finalReceipts = buildExpectedBillingReceipts({
    topUps: [manualTopUp, autoTopUp],
    usageDebits,
  })
  const reconciled = reconcileBillingReceipts(
    {
      items: [...finalReceipts].reverse(),
      page: 1,
      pageSize: 100,
      total: 6,
    },
    finalReceipts,
  )
  assert.equal(reconciled.total, 6)
  assert.deepEqual(Object.fromEntries(buildReceiptVisibleMultiset(finalReceipts)), {
    '["2026-07-24","top up","paid","$1.25"]': 1,
    '["2026-07-24","top up","paid","$25.00"]': 1,
    '["2026-07-24","usage","paid","$0.00"]': 1,
    '["2026-07-24","usage","paid","$1.25"]': 2,
    '["2026-07-24","usage","paid","$2.50"]': 1,
  })

  const wrongAmount = finalReceipts.map((receipt) =>
    receipt.id === 'transaction-2' ? { ...receipt, amountCents: '126' } : receipt,
  )
  assert.throws(
    () =>
      reconcileBillingReceipts(
        { items: wrongAmount, page: 1, pageSize: 100, total: wrongAmount.length },
        finalReceipts,
      ),
    /receipt transaction-2 amount/,
  )
  const wrongId = finalReceipts.map((receipt) =>
    receipt.id === 'transaction-3' ? { ...receipt, id: 'transaction-replaced' } : receipt,
  )
  assert.throws(
    () => reconcileBillingReceipts({ items: wrongId, page: 1, pageSize: 100, total: wrongId.length }, finalReceipts),
    /receipt transaction-3 exists by stable id/,
  )

  const swappedRowFields = finalReceipts.map((receipt) => {
    if (receipt.id === 'transaction-1') {
      return { ...receipt, amountCents: finalReceipts.find(({ id }) => id === 'top-up-manual').amountCents }
    }
    if (receipt.id === 'top-up-manual') {
      return { ...receipt, amountCents: finalReceipts.find(({ id }) => id === 'transaction-1').amountCents }
    }
    return receipt
  })
  assert.notDeepEqual(
    buildReceiptVisibleMultiset(finalReceipts),
    buildReceiptVisibleMultiset(swappedRowFields),
    'visible receipt oracle must preserve each row tuple',
  )
})

test('reconciles one newly added auto-reload transaction through metadata.topUpId', () => {
  const organizationId = 'organization-1'
  const walletId = 'wallet-1'
  const autoTopUp = {
    id: 'top-up-auto',
    walletId,
    organizationId,
    amountCents: '1042',
    source: 'auto_reload',
    status: 'paid',
    providerReference: 'fake-top-up-reference',
  }
  const baselineTransactions = [
    {
      id: 'transaction-manual',
      walletId,
      organizationId,
      kind: 'top_up',
      amountCents: '2500',
      source: 'manual_top_up',
      ratedPeriodId: null,
      metadata: { topUpId: 'top-up-manual' },
    },
    {
      id: 'transaction-usage',
      walletId,
      organizationId,
      kind: 'usage_debit',
      amountCents: '-42',
      source: 'rated_period',
      ratedPeriodId: 'rated-1',
      metadata: {},
    },
  ]
  const autoTransaction = {
    id: 'transaction-auto',
    walletId,
    organizationId,
    kind: 'top_up',
    amountCents: '1042',
    source: 'auto_reload',
    ratedPeriodId: null,
    providerActionId: null,
    metadata: {
      topUpId: autoTopUp.id,
      providerReference: autoTopUp.providerReference,
    },
  }
  const input = {
    autoTopUp,
    transactions: [...baselineTransactions, autoTransaction],
    baselineTransactions,
    baselineWallet: {
      id: walletId,
      organizationId,
      freeBalanceCents: '0',
      paidBalanceCents: '2458',
      settlementRemainderCents: '0.4',
    },
    wallet: {
      id: walletId,
      organizationId,
      freeBalanceCents: '0',
      paidBalanceCents: '3500',
      settlementRemainderCents: '0.4',
    },
    organizationId,
    expectedAmountCents: '1042',
  }

  assert.deepEqual(reconcileAutoReloadLedger(input), {
    id: 'transaction-auto',
    kind: 'top_up',
    source: 'auto_reload',
    amountCents: '1042',
    topUpId: 'top-up-auto',
  })
  assert.throws(
    () =>
      reconcileAutoReloadLedger({
        ...input,
        transactions: [
          ...input.transactions,
          {
            ...autoTransaction,
            id: 'transaction-auto-duplicate',
          },
        ],
      }),
    /one transaction linked by metadata.topUpId/,
  )
  assert.throws(
    () =>
      reconcileAutoReloadLedger({
        ...input,
        transactions: [
          ...baselineTransactions,
          {
            ...autoTransaction,
            metadata: { ...autoTransaction.metadata, providerReference: 'wrong-reference' },
          },
        ],
      }),
    /auto-reload transaction provider reference/,
  )
  assert.throws(
    () =>
      reconcileAutoReloadLedger({
        ...input,
        baselineTransactions: [...baselineTransactions, autoTransaction],
      }),
    /exactly one transaction added after the auto-reload baseline/,
  )
  assert.throws(
    () =>
      reconcileAutoReloadLedger({
        ...input,
        transactions: [
          ...input.transactions,
          {
            id: 'transaction-adjustment',
            walletId,
            organizationId,
            kind: 'adjustment',
            amountCents: '1',
            source: 'unexpected_adjustment',
            ratedPeriodId: null,
            metadata: {},
          },
        ],
      }),
    /exactly one transaction added after the auto-reload baseline/,
  )
  assert.throws(
    () =>
      reconcileAutoReloadLedger({
        ...input,
        autoTopUp: {
          ...autoTopUp,
          walletId: 'wallet-other',
        },
        transactions: [
          ...baselineTransactions,
          {
            ...autoTransaction,
            walletId: 'wallet-other',
          },
        ],
      }),
    /auto-reload record wallet/,
  )
  assert.throws(
    () =>
      reconcileAutoReloadLedger({
        ...input,
        wallet: {
          ...input.wallet,
          freeBalanceCents: '0',
          paidBalanceCents: '3500',
          settlementRemainderCents: '0',
        },
      }),
    /auto-reload settlement remainder/,
  )
})

test('reconciles usage debits in rated-period order with stage remainder metadata', () => {
  const createdAt = new Date('2026-07-24T08:30:00.000Z')
  const ratedPeriods = [
    {
      id: 'rated-1',
      transactionId: 'transaction-1',
      preciseCents: '0.6',
      debitCents: '0',
      remainderBeforeCents: '0',
      remainderAfterCents: '0.6',
    },
    {
      id: 'rated-2',
      transactionId: 'transaction-2',
      preciseCents: '0.6',
      debitCents: '1',
      remainderBeforeCents: '0.6',
      remainderAfterCents: '0.2',
    },
  ]
  const transactions = [
    {
      id: 'transaction-2',
      kind: 'usage_debit',
      source: 'rated_period',
      amountCents: '-1',
      ratedPeriodId: 'rated-2',
      metadata: {
        preciseCents: '0.6',
        remainderBeforeCents: '0.6',
        remainderAfterCents: '0.2',
      },
      createdAt: new Date(createdAt.getTime() + 1_000),
    },
    {
      id: 'transaction-1',
      kind: 'usage_debit',
      source: 'rated_period',
      amountCents: '0',
      ratedPeriodId: 'rated-1',
      metadata: {
        preciseCents: '0.6',
        remainderBeforeCents: '0',
        remainderAfterCents: '0.6',
      },
      createdAt,
    },
  ]

  assert.throws(() => reconcileMeteredUsageDebits(transactions, ratedPeriods), /usage-debit rated-period order/)
  assert.throws(
    () =>
      reconcileMeteredUsageDebits(
        transactions.toReversed().map((transaction) =>
          transaction.id === 'transaction-2'
            ? {
                ...transaction,
                metadata: { ...transaction.metadata, remainderBeforeCents: '0.5' },
              }
            : transaction,
        ),
        ratedPeriods,
      ),
    /remainder before/,
  )
})
