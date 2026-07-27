#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { BillingE2ESession, redactSecrets } from './billing-e2e-session.mjs'

const { Client } = pg
const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsRoot, '..', '..')
const DRIVER_INTERNAL_TIMEOUT_MS = 20 * 60 * 1000
const DRIVER_CLEANUP_HEADROOM_MS = 3 * 60 * 1000
const DRIVER_WATCHDOG_TIMEOUT_MS = DRIVER_INTERNAL_TIMEOUT_MS + DRIVER_CLEANUP_HEADROOM_MS
const DRIVER_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
const DRIVER_STDERR_LIMIT_BYTES = 64 * 1024
const AUTO_RELOAD_TIMEOUT_MS = 150_000
const RUNTIME_DIAGNOSTICS_DIR_NAME = 'runtime-diagnostics'
const RUNTIME_DIAGNOSTIC_BOX_FILES = ['shim.stderr', 'exit', 'exit.previous']
const RUNTIME_DIAGNOSTIC_MAX_FILE_BYTES = 4 * 1024 * 1024
const RUNTIME_DIAGNOSTIC_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const RUNTIME_DIAGNOSTIC_MAX_FILES = 256
const RUNTIME_DIAGNOSTIC_MAX_LOG_DEPTH = 4
const RUNTIME_DIAGNOSTIC_BOX_ID_PATTERN = /^[0-9A-Za-z]{12}$/
const RUNTIME_DIAGNOSTIC_STAGING_PREFIX = '.billing-runtime-diagnostics-'
const RUNTIME_DIAGNOSTIC_TEXT_FILE_PATTERN =
  /(?:\.log(?:\.[0-9A-Za-z_-]+)?|\.(?:json|jsonl|ndjson|out|stderr|stdout|txt))$/i
const EVIDENCE_READY_FILE_NAME = '.billing-golden-evidence-ready'
const RUNTIME_DIAGNOSTIC_SECRET_ENV_KEYS = [
  'ADMIN_API_KEY',
  'BILLING_E2E_DB_PASSWORD',
  'BOXLITE_E2E_DB_PASSWORD',
  'BOXLITE_E2E_LOGIN_PASSWORD',
  'BOXLITE_RUNNER_TOKEN',
  'DB_PASSWORD',
  'DEFAULT_RUNNER_API_KEY',
  'DOCKERHUB_TOKEN',
  'ENCRYPTION_KEY',
  'ENCRYPTION_SALT',
  'GHCR_TOKEN',
  'INTERNAL_REGISTRY_ADMIN',
  'INTERNAL_REGISTRY_PASSWORD',
  'PROXY_API_KEY',
]
const MANUAL_TOP_UP_CENTS = 2_500n
const AUTO_RELOAD_THRESHOLD_CENTS = 2_500n
const AUTO_RELOAD_TARGET_CENTS = 3_500n
const TEST_CASE_NAME = 'Billing golden path'

export async function runBillingGoldenE2E({ environment = process.env } = {}) {
  const startedAt = Date.now()
  const runId = new Date(startedAt).toISOString().replaceAll(/[:.]/g, '-')
  const configuredArtifactsDir =
    environment.BOXLITE_BILLING_E2E_ARTIFACTS ?? environment.BOXLITE_BILLING_GOLDEN_ARTIFACTS
  const artifactsDir =
    configuredArtifactsDir === undefined
      ? path.join(repoRoot, '.apps-local', 'logs', 'billing-golden-e2e', runId)
      : resolveConfiguredArtifactsDir(configuredArtifactsDir)
  const screenshots = []
  const secrets = RUNTIME_DIAGNOSTIC_SECRET_ENV_KEYS.map((name) => environment[name]).filter(Boolean)
  let session
  let database
  let summary
  let failure
  let runtimeDiagnostics
  let diagnosticBoxId
  let driverDiagnosticsStaging
  let safeOutputArtifact
  let hasPreparedArtifactsDir = false

  try {
    await prepareArtifactsDirectory(artifactsDir)
    hasPreparedArtifactsDir = true
    assertLocalOnly(environment)
    session = await BillingE2ESession.launch({
      artifactsDir,
      environment,
      timeoutMs: Number(environment.BILLING_E2E_TIMEOUT_MS ?? 30_000),
    })
    registerSecrets(secrets, session.loginPassword)
    database = new Client(databaseConfig(environment))
    await database.connect()

    const organizationId = await session.signInAndSelectOwner()
    registerSessionSecrets(secrets, session)
    const databaseStartedAt = await loadDatabaseTime(database)
    const baseline = await assertGoldenBaseline({ session, database, organizationId })

    await setUpPaymentMethod(session, organizationId)
    screenshots.push(await session.screenshot('01-payment-method.png'))

    const manualTopUp = await createAndReplayManualTopUp(session, database, organizationId, {
      registerSecret: (secret) => registerSecrets(secrets, secret),
    })
    screenshots.push(await session.screenshot('02-manual-top-up.png'))

    const image = environment.BOXLITE_E2E_IMAGE ?? 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'
    const boxName = `billing-golden-${Date.now()}`
    const driver = await runMeteringDriver({
      organizationId,
      image,
      name: boxName,
      dashboardUrl: session.dashboardUrl,
      accessToken: session.accessToken,
      environment,
      runnerHomeDir: environment.BOXLITE_E2E_RUNNER_HOME_DIR,
      artifactsDir,
      secrets,
    })
    driverDiagnosticsStaging = driver.runtimeDiagnosticsStaging
    diagnosticBoxId = driver.result.boxId
    assert.equal(driver.result.organizationId, organizationId, 'driver result organizationId')
    const creatingBoxStage = driver.stages.find((stage) => stage.stage === 'creating-box')
    assert.equal(creatingBoxStage?.image, image, 'driver creating-box image')
    assertDriverBusinessResult(driver.result)

    const metered = await assertMeteredApiAndUi({
      session,
      database,
      organizationId,
      manualTopUp,
      result: driver.result,
    })
    screenshots.push(await session.screenshot('03-metered-usage.png'))

    const autoReload = await enableAndVerifyAutoReload({
      session,
      database,
      organizationId,
      ratedPeriods: driver.result.ratedPeriods,
      debitCents: driver.result.debitCents,
      databaseStartedAt,
    })
    screenshots.push(await session.screenshot('04-final-usage.png'))
    screenshots.push(await assertFinalBillingSummary(session))

    session.assertNoBrowserErrors()
    summary = {
      ok: true,
      testCase: TEST_CASE_NAME,
      organizationId,
      boxId: driver.result.boxId,
      baseline,
      paymentMethod: { brand: 'visa', last4: '4242' },
      manualTopUp: {
        id: manualTopUp.id,
        status: manualTopUp.status,
        amountCents: MANUAL_TOP_UP_CENTS.toString(),
        replayMatched: true,
      },
      metering: {
        image,
        totalPreciseCents: driver.result.totalPreciseCents,
        debitCents: driver.result.debitCents,
        remainderCents: driver.result.remainderCents,
        periodCount: driver.result.periods.length,
        ratedPeriodCount: driver.result.ratedPeriods.length,
        wallet: driver.result.wallet,
        overview: metered.overview,
        boxUsage: metered.boxUsage,
        pricing: metered.pricing,
        receipts: metered.receipts,
        stages: driver.stages.map((stage) => safeStageArtifact(stage, secrets)),
      },
      autoReload,
      screenshots: screenshots.map((screenshotPath) => path.basename(screenshotPath)),
      diagnostics: session.diagnostics(),
    }
  } catch (error) {
    failure = error
    registerSessionSecrets(secrets, session)
    if (error?.diagnosticBoxId) diagnosticBoxId = error.diagnosticBoxId
    if (error?.runtimeDiagnostics) runtimeDiagnostics = error.runtimeDiagnostics
    if (session) {
      try {
        screenshots.push(await session.screenshot('failure.png'))
      } catch {
        // Preserve the original failure when the page/browser is already unavailable.
      }
    }
  } finally {
    if (database) {
      try {
        await database.end()
      } catch (error) {
        failure ??= error
      }
    }
    if (session) {
      try {
        await session.close()
      } catch (error) {
        failure ??= error
      }
    }
  }

  const artifactSafety = {
    secrets,
    pathRoots: artifactPathRoots({
      artifactsDir,
      runnerHomeDir: environment.BOXLITE_E2E_RUNNER_HOME_DIR,
    }),
  }
  if (!hasPreparedArtifactsDir) {
    const message = sanitizeArtifactText(safeMessage(failure), artifactSafety)
    throw new Error(`${TEST_CASE_NAME} failed: ${message}`)
  }

  if (!failure && driverDiagnosticsStaging) {
    try {
      await driverDiagnosticsStaging.discard()
    } catch (error) {
      failure = error
    }
  }
  if (failure && !runtimeDiagnostics && driverDiagnosticsStaging) {
    try {
      runtimeDiagnostics = await driverDiagnosticsStaging.promote()
    } catch (error) {
      runtimeDiagnostics = {
        ...runtimeDiagnosticsResult('failed'),
        error: sanitizeArtifactText(safeMessage(error), {
          secrets,
          pathRoots: artifactPathRoots({
            artifactsDir,
            runnerHomeDir: environment.BOXLITE_E2E_RUNNER_HOME_DIR,
          }),
        }),
      }
    }
  }
  if (failure && !runtimeDiagnostics) {
    runtimeDiagnostics = await captureFailureRuntimeDiagnostics({
      runnerHomeDir: environment.BOXLITE_E2E_RUNNER_HOME_DIR,
      artifactsDir,
      boxId: diagnosticBoxId,
      secrets,
    })
  }

  const durationMs = Date.now() - startedAt
  const safeFailure = failure ? diagnosticError(failure, artifactSafety) : null
  const artifact = failure
    ? {
        ok: false,
        testCase: TEST_CASE_NAME,
        error: safeFailure,
        screenshots: screenshots.map((screenshotPath) => path.basename(screenshotPath)),
        diagnostics: session?.diagnostics() ?? { browserErrors: [], expectedHttpErrors: [], externalHttpWarnings: [] },
        runtimeDiagnostics,
      }
    : summary

  try {
    safeOutputArtifact = await writeResultArtifacts({
      artifactsDir,
      artifact,
      durationMs,
      failure: safeFailure,
      artifactSafety,
    })
  } catch (artifactError) {
    if (!failure) {
      failure = artifactError
    } else {
      safeFailure.artifactWriteError = sanitizeArtifactText(safeMessage(artifactError), artifactSafety)
    }
  }

  if (failure) {
    const message = safeFailure?.message ?? sanitizeArtifactText(safeMessage(failure), artifactSafety)
    throw new Error(`${TEST_CASE_NAME} failed: ${message}`)
  }

  console.log(JSON.stringify(safeOutputArtifact, null, 2))
  return safeOutputArtifact
}

function resolveConfiguredArtifactsDir(configuredArtifactsDir) {
  if (typeof configuredArtifactsDir !== 'string' || configuredArtifactsDir.trim() === '') {
    throw new Error('Billing golden E2E artifacts directory must be a non-empty path')
  }
  return path.resolve(repoRoot, configuredArtifactsDir)
}

async function prepareArtifactsDirectory(artifactsDir) {
  await fs.mkdir(path.dirname(artifactsDir), { recursive: true, mode: 0o700 })
  try {
    await fs.mkdir(artifactsDir, { mode: 0o700 })
    return
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const artifactStat = await fs.lstat(artifactsDir)
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
    throw new Error(`Billing golden-path evidence path must be a directory: ${artifactsDir}`)
  }
  const existingEntries = await fs.readdir(artifactsDir)
  if (existingEntries.length > 0) {
    throw new Error(`Billing golden-path evidence directory must be empty: ${artifactsDir}`)
  }
  await fs.chmod(artifactsDir, 0o700)
}

async function captureFailureRuntimeDiagnostics({ runnerHomeDir, artifactsDir, boxId, secrets }) {
  if (!runnerHomeDir) return runtimeDiagnosticsResult('not-configured')

  try {
    return await archiveRuntimeDiagnostics({ runnerHomeDir, artifactsDir, boxId, secrets })
  } catch (error) {
    return {
      ...runtimeDiagnosticsResult('failed'),
      error: sanitizeArtifactText(safeMessage(error), {
        secrets,
        pathRoots: artifactPathRoots({ artifactsDir, runnerHomeDir }),
      }),
    }
  }
}

export async function archiveRuntimeDiagnostics({
  runnerHomeDir,
  artifactsDir,
  boxId,
  secrets = [],
  maxFileBytes = RUNTIME_DIAGNOSTIC_MAX_FILE_BYTES,
  maxTotalBytes = RUNTIME_DIAGNOSTIC_MAX_TOTAL_BYTES,
  maxFiles = RUNTIME_DIAGNOSTIC_MAX_FILES,
}) {
  const archiver = new RuntimeDiagnosticsArchiver({
    runnerHomeDir,
    artifactsDir,
    boxId,
    secrets,
    maxFileBytes,
    maxTotalBytes,
    maxFiles,
  })
  return archiver.archive()
}

class RuntimeDiagnosticsArchiver {
  constructor({ runnerHomeDir, artifactsDir, boxId, secrets, maxFileBytes, maxTotalBytes, maxFiles }) {
    this.runnerHomeDir = resolveArchivePath(runnerHomeDir, 'runnerHomeDir')
    this.artifactsDir = resolveArchivePath(artifactsDir, 'artifactsDir')
    this.outputDir = path.join(this.artifactsDir, RUNTIME_DIAGNOSTICS_DIR_NAME)
    this.boxId = resolveArchiveBoxId(boxId)
    this.secrets = Array.isArray(secrets) ? secrets.filter((secret) => typeof secret === 'string' && secret) : []
    this.pathRoots = artifactPathRoots({
      artifactsDir: this.artifactsDir,
      runnerHomeDir: this.runnerHomeDir,
    })
    this.maxFileBytes = positiveSafeInteger(maxFileBytes, 'maxFileBytes')
    this.maxTotalBytes = positiveSafeInteger(maxTotalBytes, 'maxTotalBytes')
    this.maxFiles = positiveSafeInteger(maxFiles, 'maxFiles')
    this.result = runtimeDiagnosticsResult('archived')
    this.visitedFileCount = 0
    this.hasReachedFileCountLimit = false
    this.resolvedRunnerHomeDir = null
    this.runnerHomeDescriptorPath = null

    const outputFromRunner = path.relative(this.runnerHomeDir, this.outputDir)
    if (outputFromRunner === '' || (!outputFromRunner.startsWith('..') && !path.isAbsolute(outputFromRunner))) {
      throw new Error('runtime diagnostics output must be outside runner home')
    }
  }

  async archive() {
    let runnerHomeDirectory
    try {
      const runnerHomeStat = await lstatIfExists(this.runnerHomeDir)
      if (!runnerHomeStat) {
        this.result.status = 'source-missing'
        return this.result
      }
      if (!runnerHomeStat.isDirectory()) {
        throw new Error(`runner home is not a directory: ${this.runnerHomeDir}`)
      }
      runnerHomeDirectory = await fs.open(
        this.runnerHomeDir,
        fsConstants.O_RDONLY |
          (fsConstants.O_DIRECTORY ?? 0) |
          (fsConstants.O_NOFOLLOW ?? 0) |
          (fsConstants.O_NONBLOCK ?? 0),
      )
      const openedRunnerHomeStat = await runnerHomeDirectory.stat()
      if (!isSameFileIdentity(runnerHomeStat, openedRunnerHomeStat)) {
        throw new Error('runner home changed during diagnostics capture')
      }
      this.resolvedRunnerHomeDir = await canonicalOpenedFilePath(runnerHomeDirectory)
      this.runnerHomeDescriptorPath = openedFileDescriptorPath(runnerHomeDirectory)
      if (!this.resolvedRunnerHomeDir || !this.runnerHomeDescriptorPath) {
        throw new Error('runner home canonical descriptor path is unavailable')
      }

      await fs.mkdir(this.outputDir, { recursive: true, mode: 0o700 })
      await this.collectLogDirectory(['logs'])

      if (this.boxId && !this.hasReachedFileCountLimit) {
        const boxPath = ['boxes', this.boxId]
        for (const fileName of RUNTIME_DIAGNOSTIC_BOX_FILES) {
          await this.copyDiagnosticFile([...boxPath, fileName], { missingIsExpected: true })
        }
        await this.collectLogDirectory([...boxPath, 'logs'])
      }

      this.result.status = this.result.skippedFiles.length === 0 ? 'archived' : 'partial'
    } catch (error) {
      this.result.status = 'failed'
      this.result.error = this.safeError(error)
    } finally {
      this.runnerHomeDescriptorPath = null
      if (runnerHomeDirectory) {
        try {
          await runnerHomeDirectory.close()
        } catch (error) {
          if (this.result.status !== 'failed') {
            this.result.status = 'failed'
            this.result.error = this.safeError(error)
          }
        }
      }
    }
    return this.result
  }

  async collectLogDirectory(relativeParts, depth = 0) {
    if (this.hasReachedFileCountLimit) return
    const entries = await this.readDirectory(relativeParts)
    for (const entry of entries) {
      if (this.hasReachedFileCountLimit) return
      const entryPath = [...relativeParts, entry.name]
      if (entry.isDirectory()) {
        if (this.isSensitiveArtifactPath(entryPath)) {
          this.skip(entryPath, 'sensitive-path')
          continue
        }
        if (depth >= RUNTIME_DIAGNOSTIC_MAX_LOG_DEPTH) {
          this.skip(entryPath, 'directory-depth-limit')
          continue
        }
        await this.collectLogDirectory(entryPath, depth + 1)
        continue
      }
      if (!this.reserveFile(archiveArtifactPath(entryPath))) return
      if (this.isSensitiveArtifactPath(entryPath)) {
        this.skip(entryPath, 'sensitive-path')
        continue
      }
      if (entry.isFile()) {
        await this.copyDiagnosticFile(entryPath, { hasReservedFile: true })
        continue
      }
      this.skip(entryPath, entry.isSymbolicLink() ? 'symbolic-link' : 'unsupported-file-type')
    }
  }

  async readDirectory(relativeParts) {
    const sourceDir = this.sourcePath(relativeParts)
    const sourceStat = await lstatIfExists(sourceDir)
    if (!sourceStat) return []
    if (!sourceStat.isDirectory()) {
      this.skip(relativeParts, sourceStat.isSymbolicLink() ? 'symbolic-link' : 'not-a-directory')
      return []
    }

    let sourceDirectory
    try {
      sourceDirectory = await fs.open(
        sourceDir,
        fsConstants.O_RDONLY |
          (fsConstants.O_DIRECTORY ?? 0) |
          (fsConstants.O_NOFOLLOW ?? 0) |
          (fsConstants.O_NONBLOCK ?? 0),
      )
      const openedStat = await sourceDirectory.stat()
      if (!isSameFileIdentity(sourceStat, openedStat)) {
        this.skip(relativeParts, 'source-identity-mismatch')
        return []
      }
      if (!openedStat.isDirectory()) {
        this.skip(relativeParts, 'not-a-directory')
        return []
      }
      const openedSourcePath = await canonicalOpenedFilePath(sourceDirectory)
      const descriptorPath = openedFileDescriptorPath(sourceDirectory)
      if (!openedSourcePath || !descriptorPath) {
        this.skip(relativeParts, 'source-path-unavailable')
        return []
      }
      if (!isPathInside(this.resolvedRunnerHomeDir, openedSourcePath)) {
        this.skip(relativeParts, 'source-outside-runner-home')
        return []
      }
      const expectedSourcePath = path.join(this.resolvedRunnerHomeDir, ...relativeParts)
      if (path.normalize(openedSourcePath) !== path.normalize(expectedSourcePath)) {
        this.skip(relativeParts, 'source-path-mismatch')
        return []
      }
      const entries = await fs.readdir(descriptorPath, { withFileTypes: true })
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error) {
      this.skip(relativeParts, error?.code === 'ELOOP' ? 'symbolic-link' : 'directory-read-failed', safeMessage(error))
      return []
    } finally {
      await sourceDirectory?.close()
    }
  }

  async copyDiagnosticFile(relativeParts, { missingIsExpected = false, hasReservedFile = false } = {}) {
    if (this.hasReachedFileCountLimit) return
    const artifactPath = archiveArtifactPath(relativeParts)
    if (this.isSensitiveArtifactPath(relativeParts)) {
      if (!hasReservedFile && !this.reserveFile(artifactPath)) return
      this.skip(relativeParts, 'sensitive-path')
      return
    }

    if (!isRuntimeDiagnosticTextFile(relativeParts)) {
      if (!hasReservedFile && !this.reserveFile(artifactPath)) return
      this.skip(relativeParts, 'unsupported-text-file')
      return
    }

    const sourcePath = this.sourcePath(relativeParts)
    let sourceStat
    try {
      sourceStat = await fs.lstat(sourcePath)
    } catch (error) {
      if (missingIsExpected && error?.code === 'ENOENT') return
      this.skip(relativeParts, 'stat-failed', safeMessage(error))
      return
    }
    let contents
    try {
      // No-follow prevents a leaf symlink escape; non-blocking prevents a
      // swapped FIFO from stalling the cleanup ACK.
      const sourceFile = await fs.open(
        sourcePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      )
      try {
        if (!hasReservedFile && !this.reserveFile(artifactPath)) return
        const openedSourcePath = await canonicalOpenedFilePath(sourceFile)
        if (!openedSourcePath) {
          this.skip(relativeParts, 'source-path-unavailable')
          return
        }
        if (!isPathInside(this.resolvedRunnerHomeDir, openedSourcePath)) {
          this.skip(relativeParts, 'source-outside-runner-home')
          return
        }
        const expectedSourcePath = path.join(this.resolvedRunnerHomeDir, ...relativeParts)
        if (path.normalize(openedSourcePath) !== path.normalize(expectedSourcePath)) {
          this.skip(relativeParts, 'source-path-mismatch')
          return
        }
        const openedStat = await sourceFile.stat()
        if (!isSameFileIdentity(sourceStat, openedStat)) {
          this.skip(relativeParts, 'source-identity-mismatch')
          return
        }
        if (!openedStat.isFile()) {
          this.skip(relativeParts, 'unsupported-file-type')
          return
        }
        if (openedStat.nlink !== 1) {
          this.skip(relativeParts, 'multiple-hard-links')
          return
        }
        if (openedStat.size > this.maxFileBytes) {
          this.skip(relativeParts, 'file-too-large', undefined, openedStat.size)
          return
        }
        contents = await sourceFile.readFile()
      } finally {
        await sourceFile.close()
      }
    } catch (error) {
      if (missingIsExpected && error?.code === 'ENOENT') return
      this.skip(relativeParts, error?.code === 'ELOOP' ? 'symbolic-link' : 'copy-failed', safeMessage(error))
      return
    }

    try {
      if (contents.byteLength > this.maxFileBytes) {
        this.skip(relativeParts, 'file-too-large', undefined, contents.byteLength)
        return
      }
      if (contents.includes(0)) {
        this.skip(relativeParts, 'non-text-file', undefined, contents.byteLength)
        return
      }

      let diagnosticText
      try {
        diagnosticText = new TextDecoder('utf-8', { fatal: true }).decode(contents)
      } catch {
        this.skip(relativeParts, 'non-text-file', undefined, contents.byteLength)
        return
      }
      const redactedContents = Buffer.from(
        sanitizeArtifactText(diagnosticText, {
          secrets: this.secrets,
          pathRoots: this.pathRoots,
        }),
        'utf8',
      )
      if (redactedContents.byteLength > this.maxFileBytes) {
        this.skip(relativeParts, 'file-too-large', undefined, redactedContents.byteLength)
        return
      }
      if (this.result.copiedBytes + redactedContents.byteLength > this.maxTotalBytes) {
        this.skip(relativeParts, 'total-size-limit', undefined, redactedContents.byteLength)
        return
      }

      const destinationPath = path.join(this.outputDir, ...relativeParts)
      await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 })
      await fs.writeFile(destinationPath, redactedContents, { flag: 'wx', mode: 0o600 })
      await fs.chmod(destinationPath, 0o600)
      this.result.copiedFiles.push(artifactPath)
      this.result.copiedBytes += redactedContents.byteLength
    } catch (error) {
      this.skip(relativeParts, 'copy-failed', safeMessage(error))
    }
  }

  reserveFile(artifactPath) {
    if (this.visitedFileCount >= this.maxFiles) {
      this.reachFileCountLimit(artifactPath)
      return false
    }
    this.visitedFileCount += 1
    return true
  }

  reachFileCountLimit(artifactPath) {
    if (this.hasReachedFileCountLimit) return
    this.hasReachedFileCountLimit = true
    this.result.skippedFiles.push({ path: this.safeArtifactPath(artifactPath), reason: 'file-count-limit' })
  }

  skip(relativeParts, reason, error, sizeBytes) {
    const skipped = { path: this.safeArtifactPath(archiveArtifactPath(relativeParts)), reason }
    if (error) skipped.error = this.safeError(error)
    if (sizeBytes !== undefined) skipped.sizeBytes = sizeBytes
    this.result.skippedFiles.push(skipped)
  }

  isSensitiveArtifactPath(relativeParts) {
    const artifactPath = archiveArtifactPath(relativeParts)
    return this.safeArtifactPath(artifactPath) !== artifactPath
  }

  safeArtifactPath(artifactPath) {
    return sanitizeArtifactText(artifactPath, {
      secrets: this.secrets,
      pathRoots: this.pathRoots,
    })
  }

  sourcePath(relativeParts) {
    if (!this.runnerHomeDescriptorPath) {
      throw new Error('runner home descriptor is unavailable during diagnostics capture')
    }
    return path.join(this.runnerHomeDescriptorPath, ...relativeParts)
  }

  safeError(error) {
    return sanitizeArtifactText(safeMessage(error), {
      secrets: this.secrets,
      pathRoots: this.pathRoots,
    })
  }
}

function runtimeDiagnosticsResult(status) {
  return {
    status,
    directory: RUNTIME_DIAGNOSTICS_DIR_NAME,
    copiedFiles: [],
    skippedFiles: [],
    copiedBytes: 0,
  }
}

function resolveArchivePath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`runtime diagnostics ${label} must be a non-empty path`)
  }
  return path.resolve(value)
}

function resolveArchiveBoxId(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !RUNTIME_DIAGNOSTIC_BOX_ID_PATTERN.test(value)) {
    throw new Error('runtime diagnostics boxId must be a 12-character alphanumeric Box id')
  }
  return value
}

function isRuntimeDiagnosticTextFile(relativeParts) {
  const fileName = relativeParts.at(-1)
  return RUNTIME_DIAGNOSTIC_BOX_FILES.includes(fileName) || RUNTIME_DIAGNOSTIC_TEXT_FILE_PATTERN.test(fileName)
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`runtime diagnostics ${label} must be a positive safe integer`)
  }
  return value
}

function archiveArtifactPath(relativeParts) {
  return relativeParts.join('/')
}

async function lstatIfExists(targetPath) {
  try {
    return await fs.lstat(targetPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function canonicalOpenedFilePath(sourceFile) {
  const descriptorPath = openedFileDescriptorPath(sourceFile)
  if (!descriptorPath) return null

  try {
    return await fs.realpath(descriptorPath)
  } catch (error) {
    if (['EINVAL', 'ENOENT', 'ENOSYS', 'EOPNOTSUPP'].includes(error?.code)) return null
    throw error
  }
}

function openedFileDescriptorPath(sourceFile) {
  if (process.platform === 'linux') return `/proc/self/fd/${sourceFile.fd}`
  if (process.platform === 'darwin') return `/dev/fd/${sourceFile.fd}`
  return null
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath)
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
  )
}

function isSameFileIdentity(leftStat, rightStat) {
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

async function assertGoldenBaseline({ session, database, organizationId }) {
  const overview = await session.apiJson('GET', `/organization/${organizationId}/billing/overview`)
  const payment = await session.apiJson('GET', `/organization/${organizationId}/billing/payment`)
  const state = await loadOrganizationBillingState(database, organizationId)

  assert.equal(overview.wallet.freeBalanceCents, '0', 'API baseline free balance')
  assert.equal(overview.wallet.paidBalanceCents, '0', 'API baseline paid balance')
  assert.equal(overview.wallet.totalBalanceCents, '0', 'API baseline total balance')
  assert.equal(overview.usage.periodCount, 0, 'API baseline rated period count')
  assert.equal(overview.spentThisMonthCents, '0', 'API baseline monthly spend')
  assert.equal(payment.providerMode, 'fake', 'golden path requires the fake payment provider')
  assert.equal(payment.paymentMethod, null, 'API baseline payment method')
  assert.deepEqual(payment.autoReload, { enabled: false, thresholdCents: null, targetCents: null })

  assert.equal(state.wallet.freeBalanceCents, '0', 'database baseline free balance')
  assert.equal(state.wallet.paidBalanceCents, '0', 'database baseline paid balance')
  assertDecimalEqual(state.wallet.settlementRemainderCents, '0', 'database baseline remainder')
  assert.equal(state.wallet.paymentProviderCustomerId, null, 'database baseline payment customer')
  assert.equal(state.wallet.paymentProviderMethodId, null, 'database baseline payment method')
  assert.equal(state.wallet.autoReloadEnabled, false, 'database baseline auto-reload')
  assert.equal(state.topUps.length, 0, 'database baseline top-ups')
  assert.equal(state.ratedPeriodCount, 0, 'database baseline rated periods')
  assert.equal(state.usageDebitCount, 0, 'database baseline usage debits')

  return {
    freeBalanceCents: '0',
    paidBalanceCents: '0',
    settlementRemainderCents: '0',
    topUpCount: 0,
    ratedPeriodCount: 0,
  }
}

async function setUpPaymentMethod(session, organizationId) {
  const { page } = session
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  const setupButton = page.getByRole('button', { name: 'Set up payment method', exact: true })
  await setupButton.waitFor()
  await setupButton.click()
  await page.getByRole('heading', { name: 'Confirm payment method setup', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm setup', exact: true }).click()

  const payment = await session.waitFor(
    async () => {
      const current = await session.apiJson('GET', `/organization/${organizationId}/billing/payment`)
      return current.paymentMethod ? current : null
    },
    session.timeoutMs,
    'the fake payment method to become ready',
  )
  assert.deepEqual(payment.paymentMethod, { brand: 'visa', last4: '4242' })

  const paymentRow = page.getByTestId('billing-payment-method-row')
  await paymentRow.getByText('VISA', { exact: true }).waitFor()
  await paymentRow.getByText('···· 4242', { exact: true }).waitFor()
}

async function createAndReplayManualTopUp(session, database, organizationId, { registerSecret } = {}) {
  const { page } = session
  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  const topUpPanel = page.getByTestId('billing-top-up-panel')
  await topUpPanel.waitFor()
  await topUpPanel.getByRole('button', { name: '$25', exact: true }).click()
  await topUpPanel.getByRole('button', { name: /^Top up/ }).click()
  await page.getByRole('heading', { name: 'Confirm $25.00 top-up', exact: true }).waitFor()

  const topUpPath = `/api/organization/${organizationId}/billing/top-ups`
  const registerRequestSecret = (request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== topUpPath) return
    registerSecret?.(request.headers()['idempotency-key'])
  }
  page.on('request', registerRequestSecret)
  let captured
  try {
    captured = await session.captureDashboardRequest({
      method: 'POST',
      apiPath: `/organization/${organizationId}/billing/top-ups`,
      action: () => page.getByRole('button', { name: 'Confirm top-up', exact: true }).click(),
    })
  } finally {
    page.off('request', registerRequestSecret)
  }
  registerSecret?.(captured.idempotencyKey)
  assert.equal(captured.status, 201, 'manual top-up HTTP status')
  assert.deepEqual(captured.body, { amountCents: MANUAL_TOP_UP_CENTS.toString() })
  if (!captured.idempotencyKey || captured.idempotencyKey.length > 128) {
    throw new Error('manual top-up did not send a valid Idempotency-Key')
  }
  assertTopUpView(captured.responseBody, 'manual top-up response')

  const replay = await session.apiJson('POST', `/organization/${organizationId}/billing/top-ups`, {
    rawBody: captured.rawBody,
    headers: {
      'Content-Type': captured.contentType,
      'Idempotency-Key': captured.idempotencyKey,
    },
    expectedStatus: 201,
  })
  assertTopUpView(replay, 'manual top-up replay')
  assert.equal(replay.id, captured.responseBody.id, 'idempotent replay top-up id')
  assert.equal(replay.status, captured.responseBody.status, 'idempotent replay top-up status')
  assert.equal(replay.status, 'paid', 'fake-provider manual top-up status')

  const state = await session.waitFor(
    async () => {
      const overview = await session.apiJson('GET', `/organization/${organizationId}/billing/overview`)
      return overview.wallet.paidBalanceCents === MANUAL_TOP_UP_CENTS.toString() ? overview : null
    },
    session.timeoutMs,
    'the manual top-up balance',
  )
  assert.equal(state.wallet.freeBalanceCents, '0')

  const databaseState = await loadOrganizationBillingState(database, organizationId)
  assert.equal(databaseState.topUps.length, 1, 'one database top-up after idempotent replay')
  assert.deepEqual(
    {
      id: databaseState.topUps[0].id,
      amountCents: databaseState.topUps[0].amountCents,
      source: databaseState.topUps[0].source,
      status: databaseState.topUps[0].status,
    },
    {
      id: replay.id,
      amountCents: MANUAL_TOP_UP_CENTS.toString(),
      source: 'manual',
      status: 'paid',
    },
  )
  if (databaseState.topUps[0].idempotencyKey !== captured.idempotencyKey) {
    throw new Error('database top-up did not preserve the captured Idempotency-Key')
  }

  return {
    id: replay.id,
    status: replay.status,
    idempotencyKey: captured.idempotencyKey,
  }
}

class DriverRuntimeDiagnosticsStaging {
  constructor({ child, runnerHomeDir, artifactsDir, secrets }) {
    this.child = child
    this.runnerHomeDir = typeof runnerHomeDir === 'string' && runnerHomeDir.trim() ? path.resolve(runnerHomeDir) : null
    this.artifactsDir = typeof artifactsDir === 'string' && artifactsDir.trim() ? path.resolve(artifactsDir) : null
    this.secrets = Array.isArray(secrets) ? [...secrets] : []
    this.pathRoots = artifactPathRoots({ artifactsDir: this.artifactsDir, runnerHomeDir: this.runnerHomeDir })
    this.boxId = null
    this.protocolError = null
    this.stdoutBuffer = ''
    this.capturePromise = null
    this.captureResult = null
    this.stagingRoot = null
    this.acknowledgementChain = Promise.resolve()
    this.isPromoted = false
    this.isDiscarded = false
    child.stdin?.on('error', () => {
      // The child can close stdin immediately after reading an ACK.
    })
  }

  observe(output) {
    this.stdoutBuffer += output
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.observeLine(line)
    }
  }

  observeLine(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (
      !isPlainObject(event) ||
      event.v !== 1 ||
      event.type !== 'stage' ||
      !['box-created', 'cleanup-diagnostics-ready'].includes(event.stage)
    ) {
      return
    }
    if (typeof event.boxId !== 'string' || !RUNTIME_DIAGNOSTIC_BOX_ID_PATTERN.test(event.boxId)) {
      this.protocolError ??= new Error(`metering driver ${event.stage} stage has an invalid Box id`)
      return
    }
    if (this.boxId && this.boxId !== event.boxId) {
      this.protocolError ??= new Error('metering driver changed Box id during diagnostics staging')
      return
    }
    this.boxId = event.boxId
    if (event.stage === 'cleanup-diagnostics-ready') this.queueArchiveAcknowledgement(event.boxId)
  }

  queueArchiveAcknowledgement(boxId) {
    this.acknowledgementChain = this.acknowledgementChain
      .catch(() => {})
      .then(async () => {
        const result = await this.ensureCapture(boxId)
        const acknowledgement = {
          v: 1,
          type: 'diagnostics-archived',
          boxId,
          status: result.status,
        }
        await this.writeAcknowledgement(`${JSON.stringify(acknowledgement)}\n`)
      })
  }

  async writeAcknowledgement(payload) {
    const input = this.child.stdin
    if (!input || input.destroyed || !input.writable) {
      throw new Error('metering driver stdin closed before diagnostics archive ACK')
    }
    await new Promise((resolve, reject) => {
      input.write(payload, 'utf8', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async ensureCapture(boxId = this.boxId) {
    if (this.capturePromise) return this.capturePromise
    if (!boxId || !RUNTIME_DIAGNOSTIC_BOX_ID_PATTERN.test(boxId)) {
      return runtimeDiagnosticsResult('not-configured')
    }
    this.capturePromise = this.capture(boxId)
    this.captureResult = await this.capturePromise
    return this.captureResult
  }

  async capture(boxId) {
    if (!this.runnerHomeDir || !this.artifactsDir) return runtimeDiagnosticsResult('not-configured')
    try {
      await fs.mkdir(this.artifactsDir, { recursive: true, mode: 0o700 })
      this.stagingRoot = await fs.mkdtemp(path.join(this.artifactsDir, RUNTIME_DIAGNOSTIC_STAGING_PREFIX))
      await fs.chmod(this.stagingRoot, 0o700)
      return await captureFailureRuntimeDiagnostics({
        runnerHomeDir: this.runnerHomeDir,
        artifactsDir: this.stagingRoot,
        boxId,
        secrets: this.secrets,
      })
    } catch (error) {
      return {
        ...runtimeDiagnosticsResult('failed'),
        error: sanitizeArtifactText(safeMessage(error), {
          secrets: this.secrets,
          pathRoots: this.pathRoots,
        }),
      }
    }
  }

  async captureBeforeTermination() {
    if (!this.boxId) return
    await this.ensureCapture(this.boxId)
  }

  async waitForPendingWork() {
    await this.acknowledgementChain.catch(() => {})
    if (this.capturePromise) await this.capturePromise
  }

  async promote() {
    if (this.isPromoted) return this.captureResult
    if (this.isDiscarded) return this.captureResult
    await this.waitForPendingWork()
    if (!this.captureResult) return undefined

    if (this.stagingRoot) {
      const sourceDir = path.join(this.stagingRoot, RUNTIME_DIAGNOSTICS_DIR_NAME)
      const sourceStat = await lstatIfExists(sourceDir)
      if (sourceStat) {
        const destinationDir = path.join(this.artifactsDir, RUNTIME_DIAGNOSTICS_DIR_NAME)
        await fs.mkdir(this.artifactsDir, { recursive: true, mode: 0o700 })
        if (await lstatIfExists(destinationDir)) {
          throw new Error('runtime diagnostics destination already exists')
        }
        await fs.rename(sourceDir, destinationDir)
      }
      await this.removeStagingRoot()
    }
    this.isPromoted = true
    return this.captureResult
  }

  async discard() {
    if (this.isDiscarded || this.isPromoted) return
    await this.waitForPendingWork()
    await this.removeStagingRoot()
    this.isDiscarded = true
  }

  async removeStagingRoot() {
    if (!this.stagingRoot) return
    const stagingRoot = this.stagingRoot
    await fs.rm(stagingRoot, { recursive: true, force: true })
    this.stagingRoot = null
  }

  async decorateFailure(error) {
    if (this.boxId) error.diagnosticBoxId = this.boxId
    try {
      const diagnostics = await this.promote()
      if (diagnostics) error.runtimeDiagnostics = diagnostics
    } catch (promotionError) {
      error.runtimeDiagnostics = {
        ...runtimeDiagnosticsResult('failed'),
        error: sanitizeArtifactText(safeMessage(promotionError), {
          secrets: this.secrets,
          pathRoots: this.pathRoots,
        }),
      }
      await this.discard().catch(() => {})
    }
    return error
  }
}

export async function runMeteringDriver({
  organizationId,
  image,
  name,
  dashboardUrl,
  accessToken,
  environment = process.env,
  spawnProcess = spawn,
  runnerHomeDir = environment.BOXLITE_E2E_RUNNER_HOME_DIR,
  artifactsDir = environment.BOXLITE_BILLING_E2E_ARTIFACTS ?? environment.BOXLITE_BILLING_GOLDEN_ARTIFACTS,
  secrets = [],
}) {
  const driverSecrets = []
  registerSecrets(
    driverSecrets,
    ...secrets,
    accessToken,
    ...RUNTIME_DIAGNOSTIC_SECRET_ENV_KEYS.map((name) => environment[name]),
  )
  const pythonPath = path.join(repoRoot, '.venv', 'bin', 'python')
  const driverPath = path.join(repoRoot, 'scripts', 'test', 'e2e', 'drivers', 'billing_golden_metering.py')
  const child = spawnProcess(
    pythonPath,
    ['-u', driverPath, '--organization-id', organizationId, '--image', image, '--name', name],
    {
      cwd: repoRoot,
      env: {
        ...environment,
        BOXLITE_E2E_API_URL: environment.BOXLITE_E2E_API_URL ?? `${dashboardUrl}/api`,
        BOXLITE_E2E_AUTH: 'oidc',
        BOXLITE_E2E_OIDC_TOKEN: accessToken,
        BOXLITE_E2E_PREFIX: organizationId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const diagnosticsStaging = new DriverRuntimeDiagnosticsStaging({
    child,
    runnerHomeDir,
    artifactsDir,
    secrets: driverSecrets,
  })

  let stdout = ''
  let stderr = ''
  let stdoutBytes = 0
  let outputLimitExceeded = false
  let timedOut = false
  let forceKillTimeout
  let terminationPromise

  const terminateAfterDiagnostics = () => {
    if (terminationPromise) return
    terminationPromise = diagnosticsStaging
      .captureBeforeTermination()
      .catch(() => {})
      .finally(() => {
        forceKillTimeout = terminateChild(child, forceKillTimeout)
      })
  }

  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > DRIVER_OUTPUT_LIMIT_BYTES) {
      outputLimitExceeded = true
      terminateAfterDiagnostics()
      return
    }
    const output = chunk.toString('utf8')
    stdout += output
    diagnosticsStaging.observe(output)
  })
  child.stderr.on('data', (chunk) => {
    if (Buffer.byteLength(stderr) < DRIVER_STDERR_LIMIT_BYTES) stderr += chunk.toString('utf8')
  })

  const timeout = setTimeout(() => {
    timedOut = true
    terminateAfterDiagnostics()
  }, DRIVER_WATCHDOG_TIMEOUT_MS)
  timeout.unref?.()

  let exit
  try {
    exit = await waitForChild(child)
  } finally {
    clearTimeout(timeout)
    if (terminationPromise) await terminationPromise
    await diagnosticsStaging.waitForPendingWork()
    clearTimeout(forceKillTimeout)
  }

  const safeStderr = sanitizeArtifactText(stderr.slice(0, DRIVER_STDERR_LIMIT_BYTES), {
    secrets: driverSecrets,
    pathRoots: artifactPathRoots({ artifactsDir, runnerHomeDir }),
  })
  const driverFailure = async (message) => diagnosticsStaging.decorateFailure(new Error(message))
  if (diagnosticsStaging.protocolError) {
    throw await diagnosticsStaging.decorateFailure(diagnosticsStaging.protocolError)
  }
  if (timedOut) {
    throw await driverFailure(
      'metering driver did not exit within 3 minutes of its 20-minute deadline; ' + `stderr=${safeStderr}`,
    )
  }
  if (outputLimitExceeded) {
    throw await driverFailure(
      `metering driver exceeded ${DRIVER_OUTPUT_LIMIT_BYTES} stdout bytes; stderr=${safeStderr}`,
    )
  }
  if (exit.error)
    throw await driverFailure(
      `could not start metering driver: ${sanitizeArtifactText(safeMessage(exit.error), {
        secrets: driverSecrets,
        pathRoots: artifactPathRoots({ artifactsDir, runnerHomeDir }),
      })}`,
    )

  try {
    const parsed = parseDriverNdjson(stdout, {
      exitCode: exit.code,
      signal: exit.signal,
      expectedOrganizationId: organizationId,
      stderr: safeStderr,
    })
    return { ...parsed, runtimeDiagnosticsStaging: diagnosticsStaging }
  } catch (error) {
    throw await driverFailure(
      sanitizeArtifactText(safeMessage(error), {
        secrets: driverSecrets,
        pathRoots: artifactPathRoots({ artifactsDir, runnerHomeDir }),
      }),
    )
  }
}

export function parseDriverNdjson(
  stdout,
  { exitCode = 0, signal = null, expectedOrganizationId = null, stderr = '' } = {},
) {
  if (typeof stdout !== 'string') throw new Error('metering driver stdout must be a string')
  const lines = stdout.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const stages = []
  let terminal = null
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index]
    if (!line.trim()) throw new Error(`metering driver emitted a blank NDJSON line at ${lineNumber}`)

    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`metering driver emitted malformed NDJSON at line ${lineNumber}: ${safeMessage(error)}`)
    }
    if (!isPlainObject(event)) throw new Error(`metering driver line ${lineNumber} must be a JSON object`)
    if (event.v !== 1) throw new Error(`metering driver line ${lineNumber} has unsupported protocol version`)
    if (!['stage', 'result', 'error'].includes(event.type)) {
      throw new Error(`metering driver line ${lineNumber} has unknown event type`)
    }
    if (terminal) throw new Error(`metering driver emitted an event after its terminal ${terminal.type} event`)

    if (event.type === 'stage') {
      if (typeof event.stage !== 'string' || event.stage.length === 0) {
        throw new Error(`metering driver stage at line ${lineNumber} must include a non-empty stage`)
      }
      stages.push(event)
      continue
    }

    if (event.type === 'error') validateDriverError(event, lineNumber)
    terminal = event
  }

  if (signal) throw new Error(`metering driver exited from signal ${signal}; stderr=${stderr}`)
  if (exitCode !== 0) {
    const lastStageMessage = stages.length > 0 ? `; lastStage=${stages.at(-1).stage}` : ''
    const terminalMessage =
      terminal?.type === 'error' && typeof terminal.error?.message === 'string'
        ? `; driver=${terminal.error.message}`
        : ''
    throw new Error(
      `metering driver exited with code ${exitCode}${lastStageMessage}${terminalMessage}; stderr=${stderr}`,
    )
  }
  if (terminal?.type === 'error') {
    const errorType = typeof terminal.error?.type === 'string' ? terminal.error.type : 'DriverError'
    const errorMessage = typeof terminal.error?.message === 'string' ? terminal.error.message : 'unknown driver error'
    throw new Error(`metering driver reported ${errorType}: ${errorMessage}`)
  }
  if (terminal?.type !== 'result') throw new Error('metering driver emitted no terminal result')
  if (stages.length === 0) throw new Error('metering driver emitted no stage events')

  validateDriverResult(terminal)
  if (expectedOrganizationId && terminal.organizationId !== expectedOrganizationId) {
    throw new Error('metering driver result organizationId does not match the requested organization')
  }
  return { stages, result: terminal }
}

function validateDriverResult(result) {
  if (result.ok !== true) throw new Error('metering driver result must set ok=true')
  if (typeof result.organizationId !== 'string' || result.organizationId.length === 0) {
    throw new Error('metering driver result requires organizationId')
  }
  if (typeof result.boxId !== 'string' || !RUNTIME_DIAGNOSTIC_BOX_ID_PATTERN.test(result.boxId)) {
    throw new Error('metering driver result requires a valid Box id')
  }
  for (const field of ['totalPreciseCents', 'debitCents', 'remainderCents']) {
    if (!isDecimalString(result[field])) throw new Error(`metering driver result requires decimal string ${field}`)
  }
  if (!isPlainObject(result.wallet)) throw new Error('metering driver result requires wallet')
  for (const field of ['freeBalanceCents', 'paidBalanceCents']) {
    if (!isIntegerString(result.wallet[field])) {
      throw new Error(`metering driver result wallet requires integer string ${field}`)
    }
  }
  if (!Array.isArray(result.periods)) throw new Error('metering driver result periods must be an array')
  if (!Array.isArray(result.ratedPeriods)) throw new Error('metering driver result ratedPeriods must be an array')
}

function validateDriverError(event, lineNumber) {
  if (event.ok !== false) throw new Error(`metering driver error at line ${lineNumber} must set ok=false`)
  if (
    !isPlainObject(event.error) ||
    typeof event.error.type !== 'string' ||
    event.error.type.length === 0 ||
    typeof event.error.message !== 'string' ||
    event.error.message.length === 0
  ) {
    throw new Error(`metering driver error at line ${lineNumber} requires error type and message`)
  }
}

function assertDriverBusinessResult(result) {
  assert.equal(result.periods.length, 4, 'driver usage-period count')
  assert.equal(result.ratedPeriods.length, 4, 'driver rated-period count')
  const expectedModes = ['FULL', 'DISK', 'FULL', 'DISK']
  for (const [index, expectedMode] of expectedModes.entries()) {
    const period = result.periods[index]
    const ratedPeriod = result.ratedPeriods[index]
    assert.equal(period.mode, expectedMode, `driver period ${index + 1} mode`)
    assert.ok(
      new Date(period.endAt).getTime() > new Date(period.startAt).getTime(),
      `driver period ${index + 1} duration must be positive`,
    )
    assertPositiveDecimal(period.preciseCents, `driver period ${index + 1} preciseCents`)
    assert.equal(ratedPeriod.usagePeriodArchiveId, period.id, `driver rated period ${index + 1} archived period`)
    assertDecimalEqual(ratedPeriod.preciseCents, period.preciseCents, `driver rated period ${index + 1} precise cost`)
  }
  assertDecimalConservation(
    result.periods.map((period) => period.preciseCents),
    [result.totalPreciseCents],
    'driver period precise-cost total',
  )
  assert.ok(BigInt(result.debitCents) > 0n, 'driver debit must be positive')
  assert.ok(BigInt(result.debitCents) < MANUAL_TOP_UP_CENTS, 'driver debit must remain below the manual top-up')
  assert.equal(result.wallet.freeBalanceCents, '0', 'driver final free balance')
  assert.equal(
    result.wallet.paidBalanceCents,
    (MANUAL_TOP_UP_CENTS - BigInt(result.debitCents)).toString(),
    'driver final paid balance',
  )
  const remainder = Number(result.remainderCents)
  assert.ok(Number.isFinite(remainder) && remainder >= 0 && remainder < 1, 'driver settlement remainder range')
}

async function assertMeteredApiAndUi({ session, database, organizationId, manualTopUp, result }) {
  const now = Date.now()
  const query = new URLSearchParams({
    from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now + 60_000).toISOString(),
  })
  const [overview, boxUsage, pricing, receipts, databaseState, activePricing] = await Promise.all([
    session.apiJson('GET', `/organization/${organizationId}/billing/overview?${query.toString()}`),
    session.apiJson('GET', `/organization/${organizationId}/billing/boxes/${encodeURIComponent(result.boxId)}`),
    session.apiJson('GET', `/organization/${organizationId}/billing/pricing`),
    session.apiJson('GET', `/organization/${organizationId}/billing/receipts?page=1&pageSize=100`),
    loadOrganizationBillingState(database, organizationId),
    loadActivePricingPlan(database),
  ])

  for (const [label, usage] of [
    ['overview', overview.usage],
    ['box usage', boxUsage],
  ]) {
    assert.equal(usage.periodCount, 4, `${label} period count`)
    assertDecimalEqual(usage.costPreciseCents, result.totalPreciseCents, `${label} precise cost`)
  }
  assert.equal(overview.wallet.freeBalanceCents, result.wallet.freeBalanceCents, 'overview free balance')
  assert.equal(overview.wallet.paidBalanceCents, result.wallet.paidBalanceCents, 'overview paid balance')
  assert.equal(
    overview.wallet.totalBalanceCents,
    (BigInt(result.wallet.freeBalanceCents) + BigInt(result.wallet.paidBalanceCents)).toString(),
    'overview total balance',
  )
  assert.equal(overview.spentThisMonthCents, result.debitCents, 'overview monthly spend')

  const pricingSummary = reconcileBillingPricing(pricing, activePricing)
  const manualDatabaseTopUps = databaseState.topUps.filter((topUp) => topUp.id === manualTopUp.id)
  assert.equal(manualDatabaseTopUps.length, 1, 'metered ledger contains the manual top-up by stable id')
  assert.deepEqual(
    {
      id: manualDatabaseTopUps[0].id,
      amountCents: manualDatabaseTopUps[0].amountCents,
      source: manualDatabaseTopUps[0].source,
      status: manualDatabaseTopUps[0].status,
    },
    {
      id: manualTopUp.id,
      amountCents: MANUAL_TOP_UP_CENTS.toString(),
      source: 'manual',
      status: 'paid',
    },
  )
  assert.equal(databaseState.topUps.length, 1, 'metered ledger contains no top-up beyond the manual top-up')

  assertDecimalEqual(
    databaseState.wallet.settlementRemainderCents,
    result.remainderCents,
    'metered database settlement remainder',
  )
  const usageDebits = reconcileMeteredUsageDebits(databaseState.transactions, result.ratedPeriods, {
    expectedRemainderCents: result.remainderCents,
  })
  const expectedReceipts = buildExpectedBillingReceipts({
    topUps: manualDatabaseTopUps,
    usageDebits,
  })
  assert.equal(expectedReceipts.length, 5, 'manual top-up plus four metered usage receipts')
  const receiptSummary = reconcileBillingReceipts(receipts, expectedReceipts)

  await assertUsageBalanceUi(session, {
    totalBalanceCents: overview.wallet.totalBalanceCents,
    paidBalanceCents: overview.wallet.paidBalanceCents,
    spentThisMonthCents: result.debitCents,
  })
  // Raw pricing rates are intentionally not rendered. Usage Cost is the UI's
  // pricing-derived value, while version/rates are reconciled above at API/DB boundaries.
  await assertUsageCostUi(session, result.totalPreciseCents)
  await assertBillingReceiptsUi(session, expectedReceipts)
  await session.page.getByRole('tab', { name: 'Usage', exact: true }).click()
  return {
    overview: {
      totalBalanceCents: overview.wallet.totalBalanceCents,
      paidBalanceCents: overview.wallet.paidBalanceCents,
      spentThisMonthCents: overview.spentThisMonthCents,
      costPreciseCents: overview.usage.costPreciseCents,
      periodCount: overview.usage.periodCount,
    },
    boxUsage: {
      costPreciseCents: boxUsage.costPreciseCents,
      costCents: boxUsage.costCents,
      periodCount: boxUsage.periodCount,
    },
    pricing: pricingSummary,
    receipts: receiptSummary,
  }
}

async function enableAndVerifyAutoReload({
  session,
  database,
  organizationId,
  debitCents,
  ratedPeriods,
  databaseStartedAt,
}) {
  const { page } = session
  const beforeAutoReload = await loadOrganizationBillingState(database, organizationId)
  const baselineTransactionIds = beforeAutoReload.transactions.map((transaction) => transaction.id)
  assert.equal(
    beforeAutoReload.topUps.filter(
      (topUp) => topUp.source === 'auto_reload' && new Date(topUp.createdAt) >= databaseStartedAt,
    ).length,
    0,
    'auto-reload record baseline',
  )
  assert.equal(
    beforeAutoReload.transactions.filter((transaction) => transaction.source === 'auto_reload').length,
    0,
    'auto-reload wallet transaction baseline',
  )
  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  const panel = page.getByTestId('billing-top-up-panel')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const autoReloadSwitch = page.getByRole('switch', { name: 'Enable auto-reload', exact: true })
  if ((await autoReloadSwitch.getAttribute('aria-checked')) !== 'true') await autoReloadSwitch.click()
  await page.getByRole('textbox', { name: 'Auto-reload threshold', exact: true }).fill('25.00')
  await page.getByRole('textbox', { name: 'Auto-reload target', exact: true }).fill('35.00')

  const savedResponse = page.waitForResponse((response) => {
    return (
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/organization/${organizationId}/billing/auto-reload`
    )
  })
  await page.getByRole('button', { name: 'Save auto-reload', exact: true }).click()
  const response = await savedResponse
  assert.equal(response.status(), 200, 'save auto-reload HTTP status')

  const expectedAmountCents = (1_000n + BigInt(debitCents)).toString()
  const completed = await session.waitFor(
    async () => {
      const [overview, state] = await Promise.all([
        session.apiJson('GET', `/organization/${organizationId}/billing/overview`),
        loadOrganizationBillingState(database, organizationId),
      ])
      const autoTopUps = state.topUps.filter(
        (topUp) => topUp.source === 'auto_reload' && new Date(topUp.createdAt) >= databaseStartedAt,
      )
      const newAutoTransactions = state.transactions.filter(
        (transaction) =>
          !baselineTransactionIds.includes(transaction.id) &&
          transaction.kind === 'top_up' &&
          transaction.source === 'auto_reload',
      )
      if (
        overview.wallet.freeBalanceCents !== '0' ||
        overview.wallet.paidBalanceCents !== AUTO_RELOAD_TARGET_CENTS.toString() ||
        state.wallet.paidBalanceCents !== AUTO_RELOAD_TARGET_CENTS.toString() ||
        state.wallet.autoReloadEnabled !== true ||
        state.wallet.autoReloadThresholdCents !== AUTO_RELOAD_THRESHOLD_CENTS.toString() ||
        state.wallet.autoReloadTargetCents !== AUTO_RELOAD_TARGET_CENTS.toString() ||
        autoTopUps.length !== 1 ||
        newAutoTransactions.length !== 1 ||
        autoTopUps[0].amountCents !== expectedAmountCents ||
        autoTopUps[0].status !== 'paid'
      ) {
        return null
      }
      const autoTransaction = reconcileAutoReloadLedger({
        autoTopUp: autoTopUps[0],
        transactions: state.transactions,
        baselineTransactions: beforeAutoReload.transactions,
        baselineWallet: beforeAutoReload.wallet,
        wallet: state.wallet,
        organizationId,
        expectedAmountCents,
      })
      return { overview, state, autoTopUps, autoTransaction }
    },
    AUTO_RELOAD_TIMEOUT_MS,
    'one paid auto-reload and the $35.00 API/database balance',
    1_000,
  )

  const targetBalanceObservationDeadline = Math.floor(Date.now() / 60_000) * 60_000 + 65_000
  await waitUntil(targetBalanceObservationDeadline)

  const [stableOverview, stableState, stableReceipts] = await Promise.all([
    session.apiJson('GET', `/organization/${organizationId}/billing/overview`),
    loadOrganizationBillingState(database, organizationId),
    session.apiJson('GET', `/organization/${organizationId}/billing/receipts?page=1&pageSize=100`),
  ])
  const stableAutoTopUps = stableState.topUps.filter(
    (topUp) => topUp.source === 'auto_reload' && new Date(topUp.createdAt) >= databaseStartedAt,
  )
  assert.equal(stableOverview.wallet.paidBalanceCents, AUTO_RELOAD_TARGET_CENTS.toString())
  assert.equal(stableState.wallet.paidBalanceCents, AUTO_RELOAD_TARGET_CENTS.toString())
  assert.equal(
    BigInt(stableState.wallet.freeBalanceCents) + BigInt(stableState.wallet.paidBalanceCents),
    AUTO_RELOAD_TARGET_CENTS,
    'wallet remains at the configured auto-reload target',
  )
  assert.equal(stableAutoTopUps.length, 1, 'one auto-reload record while the balance remains at target')
  assert.equal(stableAutoTopUps[0].id, completed.autoTopUps[0].id)
  assert.equal(stableAutoTopUps[0].amountCents, expectedAmountCents)
  const stableAutoTransaction = reconcileAutoReloadLedger({
    autoTopUp: stableAutoTopUps[0],
    transactions: stableState.transactions,
    baselineTransactions: beforeAutoReload.transactions,
    baselineWallet: beforeAutoReload.wallet,
    wallet: stableState.wallet,
    organizationId,
    expectedAmountCents,
  })
  assert.equal(stableAutoTransaction.id, completed.autoTransaction.id, 'auto-reload transaction stable id')
  assert.deepEqual(
    stableState.transactions,
    completed.state.transactions,
    'wallet ledger remains unchanged while the balance is at the auto-reload target',
  )
  assert.deepEqual(
    stableState.topUps,
    completed.state.topUps,
    'top-up records remain unchanged while the balance is at the auto-reload target',
  )
  assertDecimalEqual(
    stableState.wallet.settlementRemainderCents,
    completed.state.wallet.settlementRemainderCents,
    'target-balance observation preserves settlement remainder',
  )

  const finalUsageDebits = reconcileMeteredUsageDebits(stableState.transactions, ratedPeriods, {
    expectedRemainderCents: stableState.wallet.settlementRemainderCents,
  })
  assert.equal(stableState.topUps.length, 2, 'final ledger contains manual and auto top-ups only')
  const finalExpectedReceipts = buildExpectedBillingReceipts({
    topUps: stableState.topUps,
    usageDebits: finalUsageDebits,
  })
  assert.equal(finalExpectedReceipts.length, 6, 'manual and auto top-ups plus four usage receipts')
  const finalReceiptSummary = reconcileBillingReceipts(stableReceipts, finalExpectedReceipts)

  await assertUsageBalanceUi(session, {
    totalBalanceCents: AUTO_RELOAD_TARGET_CENTS.toString(),
    paidBalanceCents: AUTO_RELOAD_TARGET_CENTS.toString(),
    spentThisMonthCents: debitCents,
  })
  await assertBillingReceiptsUi(session, finalExpectedReceipts)
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  return {
    enabled: true,
    thresholdCents: AUTO_RELOAD_THRESHOLD_CENTS.toString(),
    targetCents: AUTO_RELOAD_TARGET_CENTS.toString(),
    amountCents: expectedAmountCents,
    status: stableAutoTopUps[0].status,
    paidBalanceCents: stableState.wallet.paidBalanceCents,
    countAtTargetBalance: stableAutoTopUps.length,
    transactionId: stableAutoTransaction.id,
    receipts: finalReceiptSummary,
  }
}

async function assertUsageBalanceUi(session, { totalBalanceCents, paidBalanceCents, spentThisMonthCents }) {
  const { page } = session
  await page.goto(`${session.dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  const card = page.getByTestId('billing-balance-overview')
  await card.waitFor()

  const currentBalanceMetric = card.getByText(/Current balance$/).locator('..')
  const spentThisMonthMetric = card.getByText(/Spent this month$/).locator('..')
  await currentBalanceMetric.locator(`[aria-label="${formatCentsValue(totalBalanceCents)}"]`).waitFor()
  await spentThisMonthMetric.locator(`[aria-label="${formatCentsValue(spentThisMonthCents)}"]`).waitFor()
  await card.getByText(`Paid balance $${formatCentsValue(paidBalanceCents)}`, { exact: true }).waitFor()
}

async function assertUsageCostUi(session, costPreciseCents) {
  const usageSummary = session.page.getByTestId('billing-usage-summary')
  await usageSummary.waitFor()
  const costCards = usageSummary.locator('[data-usage-card]').filter({ hasText: 'Usage Cost' })
  assert.equal(await costCards.count(), 1, 'one visible Usage Cost card')
  await costCards.locator(`[aria-label="${formatUsageCostValue(costPreciseCents)}"]`).waitFor()
}

async function assertBillingReceiptsUi(session, expectedReceipts) {
  const { page } = session
  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  const receiptSection = page.getByTestId('billing-receipts')
  await receiptSection.waitFor()
  const recordLabel = `${expectedReceipts.length.toLocaleString('en-US')} records`
  await receiptSection.getByText(recordLabel, { exact: true }).waitFor()
  await receiptSection.getByText(`Page 1 of 1 / ${recordLabel}`, { exact: true }).waitFor()

  const rows = receiptSection.getByTestId('billing-receipt-row')
  const actualRowKeys = []
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index)
    const fields = await Promise.all(
      ['date', 'type', 'status', 'amount'].map(async (field) => {
        const text = await row.locator(`[data-receipt-field="${field}"]`).textContent()
        return text ?? ''
      }),
    )
    const [date, type, status, amount] = fields.map((field) => field.trim())
    actualRowKeys.push(receiptRowKey({ date, type, status, amount }))
  }
  assert.deepEqual(
    frequencyEntries(actualRowKeys),
    buildReceiptVisibleMultiset(expectedReceipts),
    'visible receipt row tuples',
  )
}

async function assertFinalBillingSummary(session) {
  const { page } = session
  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  await page
    .getByText('when balance < $25.00 → top up to $35.00', {
      exact: true,
    })
    .waitFor()
  return session.screenshot('05-final-billing.png')
}

async function loadOrganizationBillingState(database, organizationId) {
  const [walletResult, topUpsResult, ratedPeriodsResult, transactionsResult] = await Promise.all([
    database.query(
      `SELECT id::text, "organizationId"::text AS "organizationId",
              "freeBalanceCents"::text AS "freeBalanceCents",
              "paidBalanceCents"::text AS "paidBalanceCents",
              "settlementRemainderCents"::text AS "settlementRemainderCents",
              "paymentProviderCustomerId",
              "paymentProviderMethodId",
              "paymentMethodBrand",
              "paymentMethodLast4",
              "autoReloadEnabled",
              "autoReloadThresholdCents"::text AS "autoReloadThresholdCents",
              "autoReloadTargetCents"::text AS "autoReloadTargetCents"
         FROM wallet WHERE "organizationId" = $1`,
      [organizationId],
    ),
    database.query(
      `SELECT id::text, "walletId"::text AS "walletId", "organizationId"::text AS "organizationId",
              "amountCents"::text AS "amountCents", source, status, "providerReference",
              "idempotencyKey", "createdAt"
         FROM top_up_record
        WHERE "organizationId" = $1
           OR "walletId" = (SELECT id FROM wallet WHERE "organizationId" = $1)
        ORDER BY "createdAt", id`,
      [organizationId],
    ),
    database.query(
      `SELECT COUNT(*)::int AS "ratedPeriodCount"
         FROM rated_period
        WHERE "organizationId" = $1`,
      [organizationId],
    ),
    database.query(
      `SELECT id::text, "walletId"::text AS "walletId", "organizationId"::text AS "organizationId",
              kind, "amountCents"::text AS "amountCents", source,
              "ratedPeriodId"::text AS "ratedPeriodId", "providerActionId", metadata, "createdAt"
         FROM wallet_transaction
        WHERE "organizationId" = $1
           OR "walletId" = (SELECT id FROM wallet WHERE "organizationId" = $1)
        ORDER BY "createdAt", id`,
      [organizationId],
    ),
  ])
  if (walletResult.rowCount !== 1) throw new Error(`Expected one wallet for organization ${organizationId}`)
  const transactions = transactionsResult.rows
  return {
    wallet: walletResult.rows[0],
    topUps: topUpsResult.rows,
    transactions,
    ratedPeriodCount: Number(ratedPeriodsResult.rows[0]?.ratedPeriodCount ?? 0),
    usageDebitCount: transactions.filter((transaction) => transaction.kind === 'usage_debit').length,
  }
}

async function loadActivePricingPlan(database) {
  const result = await database.query(
    `WITH reference AS (SELECT clock_timestamp() AS now)
     SELECT p.version, p."effectiveFrom",
            (p."cpuRateCentsPerSec" * 3600)::text AS "cpuRateCentsPerHour",
            (p."memRateCentsPerSec" * 3600)::text AS "memRateCentsPerHour",
            (p."diskRateCentsPerSec" * 3600)::text AS "diskRateCentsPerHour",
            (p."gpuRateCentsPerSec" * 3600)::text AS "gpuRateCentsPerHour"
       FROM pricing_plan p
       CROSS JOIN reference
      WHERE p."effectiveFrom" <= reference.now
        AND (p."effectiveTo" IS NULL OR p."effectiveTo" > reference.now)
      ORDER BY p."effectiveFrom" DESC`,
  )
  if (result.rowCount !== 1) throw new Error(`Expected one active pricing plan, found ${result.rowCount}`)
  return result.rows[0]
}

async function loadDatabaseTime(database) {
  const result = await database.query('SELECT clock_timestamp() AS now')
  return new Date(result.rows[0].now)
}

function databaseConfig(environment) {
  return {
    host: environment.BILLING_E2E_DB_HOST ?? '127.0.0.1',
    port: Number(environment.BILLING_E2E_DB_PORT ?? 25432),
    user: environment.BILLING_E2E_DB_USERNAME ?? 'boxlite',
    password: environment.BILLING_E2E_DB_PASSWORD ?? 'boxlite',
    database: environment.BILLING_E2E_DB_DATABASE ?? 'boxlite',
  }
}

function assertLocalOnly(environment) {
  const dashboard = new URL(environment.BOXLITE_E2E_BASE_URL ?? 'http://localhost:3000')
  if (!isLoopbackHost(dashboard.hostname)) {
    throw new Error(`Billing golden E2E refuses non-loopback dashboard URL: ${dashboard.origin}`)
  }
  const databaseHost = environment.BILLING_E2E_DB_HOST ?? '127.0.0.1'
  if (!isLoopbackHost(databaseHost)) {
    throw new Error(`Billing golden E2E refuses non-loopback database host: ${databaseHost}`)
  }
}

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
}

function assertTopUpView(value, label) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.status !== 'string') {
    throw new Error(`${label} did not contain a top-up id and status`)
  }
}

export function reconcileBillingPricing(apiPricing, activePlan) {
  if (!isPlainObject(apiPricing) || !isPlainObject(activePlan)) {
    throw new Error('pricing reconciliation requires API pricing and an active database plan')
  }
  assert.ok(Number.isInteger(apiPricing.version), 'pricing API version')
  assert.ok(Number.isInteger(activePlan.version), 'active database pricing version')
  assert.equal(apiPricing.version, activePlan.version, 'active pricing version')

  if (typeof apiPricing.effectiveFrom !== 'string') throw new Error('pricing API effectiveFrom must be a string')
  const effectiveFrom = isoTimestamp(activePlan.effectiveFrom, 'active pricing effectiveFrom')
  assert.equal(apiPricing.effectiveFrom, effectiveFrom, 'active pricing effectiveFrom')

  const rateFields = ['cpuRateCentsPerHour', 'memRateCentsPerHour', 'diskRateCentsPerHour', 'gpuRateCentsPerHour']
  const summary = { version: apiPricing.version, effectiveFrom }
  for (const field of rateFields) {
    assertDecimalEqual(apiPricing[field], activePlan[field], `active pricing ${field}`)
    summary[field] = normalizeDecimal(apiPricing[field])
  }
  return summary
}

export function reconcileMeteredUsageDebits(transactions, ratedPeriods, { expectedRemainderCents = null } = {}) {
  if (!Array.isArray(transactions) || !Array.isArray(ratedPeriods)) {
    throw new Error('usage-debit reconciliation requires transaction and rated-period arrays')
  }
  const expectedTransactionIds = new Set()
  for (const ratedPeriod of ratedPeriods) {
    if (!isPlainObject(ratedPeriod) || typeof ratedPeriod.transactionId !== 'string') {
      throw new Error('rated period requires a transactionId')
    }
    if (expectedTransactionIds.has(ratedPeriod.transactionId)) {
      throw new Error(`duplicate rated-period transactionId ${ratedPeriod.transactionId}`)
    }
    expectedTransactionIds.add(ratedPeriod.transactionId)
    if (typeof ratedPeriod.id !== 'string' || ratedPeriod.id.length === 0) {
      throw new Error('rated period requires an id')
    }
  }

  const usageDebits = transactions.filter((transaction) => transaction.kind === 'usage_debit')
  assert.equal(usageDebits.length, ratedPeriods.length, 'usage-debit transaction count')
  uniqueById(usageDebits, 'usage-debit transaction')
  let previousRemainder = '0'
  for (const [index, ratedPeriod] of ratedPeriods.entries()) {
    const transaction = usageDebits[index]
    assert.equal(transaction.id, ratedPeriod.transactionId, `usage-debit rated-period order at stage ${index + 1}`)
    assert.equal(transaction.source, 'rated_period', `usage debit ${transaction.id} source`)
    assert.equal(transaction.ratedPeriodId, ratedPeriod.id, `usage debit ${transaction.id} rated period`)
    const debitCents = canonicalInteger(ratedPeriod.debitCents, `rated period ${ratedPeriod.id} debitCents`)
    assert.ok(BigInt(debitCents) >= 0n, `rated period ${ratedPeriod.id} debit must be non-negative`)
    assert.equal(
      canonicalInteger(transaction.amountCents, `usage debit ${transaction.id} amountCents`),
      (-BigInt(debitCents)).toString(),
      `usage debit ${transaction.id} signed amount`,
    )
    if (!isPlainObject(transaction.metadata)) {
      throw new Error(`usage debit ${transaction.id} requires settlement metadata`)
    }
    assertPositiveDecimal(ratedPeriod.preciseCents, `rated period ${ratedPeriod.id} preciseCents`)
    assertDecimalEqual(
      transaction.metadata.preciseCents,
      ratedPeriod.preciseCents,
      `usage debit ${transaction.id} precise cost`,
    )
    assertDecimalEqual(
      ratedPeriod.remainderBeforeCents,
      previousRemainder,
      `rated period ${ratedPeriod.id} remainder before`,
    )
    assertDecimalEqual(
      transaction.metadata.remainderBeforeCents,
      ratedPeriod.remainderBeforeCents,
      `usage debit ${transaction.id} remainder before`,
    )
    assertDecimalEqual(
      transaction.metadata.remainderAfterCents,
      ratedPeriod.remainderAfterCents,
      `usage debit ${transaction.id} remainder after`,
    )
    assertDecimalConservation(
      [ratedPeriod.remainderBeforeCents, ratedPeriod.preciseCents],
      [debitCents, ratedPeriod.remainderAfterCents],
      `rated period ${ratedPeriod.id} stage settlement`,
    )
    previousRemainder = ratedPeriod.remainderAfterCents
  }
  if (expectedRemainderCents !== null) {
    assertDecimalEqual(previousRemainder, expectedRemainderCents, 'usage-debit final settlement remainder')
  }
  return usageDebits
}

export function buildExpectedBillingReceipts({ topUps, usageDebits }) {
  if (!Array.isArray(topUps) || !Array.isArray(usageDebits)) {
    throw new Error('receipt construction requires top-up and usage-debit arrays')
  }
  const topUpReceipts = topUps.map((topUp) => {
    if (!isPlainObject(topUp) || typeof topUp.id !== 'string') throw new Error('top-up receipt requires an id')
    if (!['paid', 'failed'].includes(topUp.status)) {
      throw new Error(`top-up ${topUp.id} has non-receipt status ${String(topUp.status)}`)
    }
    const amountCents = canonicalInteger(topUp.amountCents, `top-up ${topUp.id} amountCents`)
    assert.ok(BigInt(amountCents) > 0n, `top-up ${topUp.id} amount must be positive`)
    return {
      id: topUp.id,
      createdAt: isoTimestamp(topUp.createdAt, `top-up ${topUp.id} createdAt`),
      amountCents,
      type: 'top_up',
      status: topUp.status,
    }
  })
  const usageReceipts = usageDebits.map((transaction) => {
    if (!isPlainObject(transaction) || typeof transaction.id !== 'string') {
      throw new Error('usage receipt requires a transaction id')
    }
    assert.equal(transaction.kind, 'usage_debit', `usage receipt ${transaction.id} transaction kind`)
    return {
      id: transaction.id,
      createdAt: isoTimestamp(transaction.createdAt, `usage debit ${transaction.id} createdAt`),
      amountCents: absoluteInteger(transaction.amountCents, `usage debit ${transaction.id} amountCents`),
      type: 'usage',
      status: 'paid',
    }
  })
  const receipts = [...topUpReceipts, ...usageReceipts]
  uniqueById(receipts, 'expected receipt')
  return receipts.sort(compareIds)
}

export function reconcileBillingReceipts(receiptPage, expectedReceipts) {
  if (!isPlainObject(receiptPage) || !Array.isArray(receiptPage.items) || !Array.isArray(expectedReceipts)) {
    throw new Error('receipt reconciliation requires an API page and expected receipt array')
  }
  assert.equal(receiptPage.page, 1, 'receipt API page')
  assert.equal(receiptPage.pageSize, 100, 'receipt API page size')
  assert.equal(receiptPage.total, expectedReceipts.length, 'receipt API total')
  assert.equal(receiptPage.items.length, expectedReceipts.length, 'receipt API returned item count')

  const expectedById = uniqueById(expectedReceipts, 'expected receipt')
  const actualById = uniqueById(receiptPage.items, 'API receipt')
  for (const [receiptId, expected] of expectedById) {
    const actual = actualById.get(receiptId)
    assert.ok(actual, `receipt ${receiptId} exists by stable id`)
    assert.equal(actual.type, expected.type, `receipt ${receiptId} type`)
    assert.equal(
      canonicalInteger(actual.amountCents, `receipt ${receiptId} amountCents`),
      expected.amountCents,
      `receipt ${receiptId} amount`,
    )
    assert.equal(actual.status, expected.status, `receipt ${receiptId} status`)
    assert.equal(actual.createdAt, expected.createdAt, `receipt ${receiptId} createdAt`)
  }
  return {
    total: receiptPage.total,
    items: receiptPage.items
      .map((receipt) => ({
        id: receipt.id,
        type: receipt.type,
        amountCents: canonicalInteger(receipt.amountCents, `receipt ${receipt.id} amountCents`),
        status: receipt.status,
      }))
      .sort(compareIds),
  }
}

export function reconcileAutoReloadLedger({
  autoTopUp,
  transactions,
  baselineTransactions,
  baselineWallet,
  wallet,
  organizationId,
  expectedAmountCents,
}) {
  if (
    !isPlainObject(autoTopUp) ||
    !Array.isArray(transactions) ||
    !Array.isArray(baselineTransactions) ||
    !isPlainObject(baselineWallet) ||
    !isPlainObject(wallet)
  ) {
    throw new Error('auto-reload reconciliation requires a top-up and before/after ledger state')
  }
  const baselineById = uniqueById(baselineTransactions, 'baseline wallet transaction')
  const transactionsById = uniqueById(transactions, 'wallet transaction')
  const amountCents = canonicalInteger(expectedAmountCents, 'expected auto-reload amountCents')

  assert.ok(typeof baselineWallet.id === 'string' && baselineWallet.id.length > 0, 'auto-reload baseline wallet id')
  assert.equal(wallet.id, baselineWallet.id, 'auto-reload wallet stable id')
  assert.equal(baselineWallet.organizationId, organizationId, 'auto-reload baseline wallet organization')
  assert.equal(wallet.organizationId, organizationId, 'auto-reload wallet organization')
  assert.equal(autoTopUp.organizationId, organizationId, 'auto-reload record organization')
  assert.equal(autoTopUp.source, 'auto_reload', 'auto-reload record source')
  assert.equal(autoTopUp.status, 'paid', 'auto-reload record status')
  assert.equal(canonicalInteger(autoTopUp.amountCents, 'auto-reload record amountCents'), amountCents)
  assert.equal(autoTopUp.walletId, wallet.id, 'auto-reload record wallet')
  assert.ok(
    typeof autoTopUp.providerReference === 'string' && autoTopUp.providerReference.length > 0,
    'auto-reload record provider reference',
  )

  for (const [transactionId, baselineTransaction] of baselineById) {
    assert.deepEqual(
      transactionsById.get(transactionId),
      baselineTransaction,
      `baseline wallet transaction ${transactionId} remains immutable`,
    )
  }
  const linkedTransactions = transactions.filter(
    (transaction) => isPlainObject(transaction.metadata) && transaction.metadata.topUpId === autoTopUp.id,
  )
  assert.equal(linkedTransactions.length, 1, 'one transaction linked by metadata.topUpId')
  const newTransactions = transactions.filter((transaction) => !baselineById.has(transaction.id))
  assert.equal(newTransactions.length, 1, 'exactly one transaction added after the auto-reload baseline')
  const autoTransactions = transactions.filter(
    (transaction) => transaction.kind === 'top_up' && transaction.source === 'auto_reload',
  )
  assert.equal(autoTransactions.length, 1, 'one auto-reload top-up transaction')

  const transaction = linkedTransactions[0]
  assert.equal(transaction.id, newTransactions[0].id, 'new transaction is linked to the auto-reload record')
  assert.equal(transaction.id, autoTransactions[0].id, 'linked top-up is the unique auto-reload transaction')
  assert.ok(!baselineById.has(transaction.id), 'auto-reload transaction was added after the baseline')
  assert.equal(transaction.walletId, autoTopUp.walletId, 'auto-reload transaction wallet')
  assert.equal(transaction.organizationId, organizationId, 'auto-reload transaction organization')
  assert.equal(transaction.organizationId, autoTopUp.organizationId, 'auto-reload transaction record organization')
  assert.equal(transaction.kind, 'top_up', 'auto-reload transaction kind')
  assert.equal(transaction.source, 'auto_reload', 'auto-reload transaction source')
  assert.equal(canonicalInteger(transaction.amountCents, 'auto-reload transaction amountCents'), amountCents)
  assert.equal(transaction.ratedPeriodId, null, 'auto-reload transaction rated period')
  assert.equal(
    transaction.metadata.providerReference,
    autoTopUp.providerReference,
    'auto-reload transaction provider reference',
  )
  assertDecimalEqual(
    wallet.settlementRemainderCents,
    baselineWallet.settlementRemainderCents,
    'auto-reload settlement remainder',
  )
  assert.equal(
    canonicalInteger(wallet.freeBalanceCents, 'auto-reload wallet free balance'),
    canonicalInteger(baselineWallet.freeBalanceCents, 'auto-reload baseline free balance'),
    'auto-reload leaves free balance unchanged',
  )
  assert.equal(
    BigInt(canonicalInteger(wallet.paidBalanceCents, 'auto-reload wallet paid balance')),
    BigInt(canonicalInteger(baselineWallet.paidBalanceCents, 'auto-reload baseline paid balance')) +
      BigInt(amountCents),
    'auto-reload adds its amount to paid balance',
  )
  assertWalletBalanceConservation(baselineWallet, baselineTransactions, 'auto-reload baseline')
  assertWalletBalanceConservation(wallet, transactions, 'auto-reload result')
  return {
    id: transaction.id,
    kind: transaction.kind,
    source: transaction.source,
    amountCents,
    topUpId: autoTopUp.id,
  }
}

export function buildReceiptVisibleMultiset(receipts) {
  if (!Array.isArray(receipts)) throw new Error('visible receipt multiset requires receipts')
  return frequencyEntries(
    receipts.map((receipt) =>
      receiptRowKey({
        date: receiptDateValue(receipt.createdAt),
        type: receipt.type === 'top_up' ? 'top up' : 'usage',
        status: receipt.status,
        amount: `$${formatCentsValue(receipt.amountCents)}`,
      }),
    ),
  )
}

function uniqueById(values, label) {
  const byId = new Map()
  for (const value of values) {
    if (!isPlainObject(value) || typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error(`${label} requires a stable id`)
    }
    if (byId.has(value.id)) throw new Error(`${label} has duplicate id ${value.id}`)
    byId.set(value.id, value)
  }
  return byId
}

function compareIds(left, right) {
  return left.id.localeCompare(right.id)
}

function canonicalInteger(value, label) {
  if (!isIntegerString(value)) throw new Error(`${label} must be an integer string`)
  return BigInt(value).toString()
}

function absoluteInteger(value, label) {
  const integer = BigInt(canonicalInteger(value, label))
  return (integer < 0n ? -integer : integer).toString()
}

function isoTimestamp(value, label) {
  const timestamp = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label} must be a timestamp`)
  return timestamp.toISOString()
}

function receiptDateValue(value) {
  return isoTimestamp(value, 'receipt createdAt').slice(0, 10)
}

function receiptRowKey({ date, type, status, amount }) {
  return JSON.stringify([date, type, status, amount])
}

function frequencyEntries(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function assertDecimalEqual(actual, expected, label) {
  if (!isDecimalString(actual) || !isDecimalString(expected)) {
    throw new Error(`${label} must compare decimal strings`)
  }
  assert.equal(normalizeDecimal(actual), normalizeDecimal(expected), label)
}

function assertPositiveDecimal(value, label) {
  if (!isDecimalString(value)) throw new Error(`${label} must be a decimal string`)
  const normalized = normalizeDecimal(value)
  assert.ok(!normalized.startsWith('-') && normalized !== '0', `${label} must be positive`)
}

function assertDecimalConservation(leftValues, rightValues, label) {
  const values = [...leftValues, ...rightValues]
  for (const value of values) {
    if (!isDecimalString(value)) throw new Error(`${label} must compare decimal strings`)
  }
  const scale = Math.max(
    ...values.map((value) => {
      const unsigned = value.startsWith('-') ? value.slice(1) : value
      return unsigned.split('.')[1]?.length ?? 0
    }),
  )
  const units = (value) => {
    const negative = value.startsWith('-')
    const unsigned = negative ? value.slice(1) : value
    const [whole, fraction = ''] = unsigned.split('.')
    const scaled = BigInt(`${whole}${fraction.padEnd(scale, '0')}`)
    return negative ? -scaled : scaled
  }
  const left = leftValues.reduce((sum, value) => sum + units(value), 0n)
  const right = rightValues.reduce((sum, value) => sum + units(value), 0n)
  assert.equal(left, right, label)
}

function assertWalletBalanceConservation(wallet, transactions, label) {
  if (
    typeof wallet.id !== 'string' ||
    wallet.id.length === 0 ||
    typeof wallet.organizationId !== 'string' ||
    wallet.organizationId.length === 0
  ) {
    throw new Error(`${label} wallet requires stable identity`)
  }
  const balance =
    BigInt(canonicalInteger(wallet.freeBalanceCents, `${label} free balance`)) +
    BigInt(canonicalInteger(wallet.paidBalanceCents, `${label} paid balance`))
  const ledger = transactions.reduce((sum, transaction) => {
    assert.equal(transaction.walletId, wallet.id, `${label} transaction wallet`)
    assert.equal(transaction.organizationId, wallet.organizationId, `${label} transaction organization`)
    return sum + BigInt(canonicalInteger(transaction.amountCents, `${label} transaction amountCents`))
  }, 0n)
  assert.equal(balance, ledger, `${label} wallet balance conserves the immutable ledger`)
}

function normalizeDecimal(value) {
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [wholePart, fractionPart = ''] = unsigned.split('.')
  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionPart.replace(/0+$/, '')
  const normalized = fraction ? `${whole}.${fraction}` : whole
  return negative && normalized !== '0' ? `-${normalized}` : normalized
}

function formatCentsValue(cents) {
  const value = BigInt(cents)
  const negative = value < 0n
  const absolute = negative ? -value : value
  return `${negative ? '-' : ''}${(absolute / 100n).toLocaleString('en-US')}.${(absolute % 100n)
    .toString()
    .padStart(2, '0')}`
}

function formatUsageCostValue(costPreciseCents) {
  if (!isDecimalString(costPreciseCents)) throw new Error('Usage Cost requires decimal cents')
  const amount = Number(costPreciseCents)
  if (!Number.isFinite(amount)) throw new Error('Usage Cost must be finite')
  return (amount / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

function waitUntil(timestamp) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timestamp - Date.now())))
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('error', (error) => finish({ code: null, signal: null, error }))
    child.once('close', (code, signal) => finish({ code, signal, error: null }))
  })
}

function terminateChild(child, existingTimeout) {
  if (existingTimeout) return existingTimeout
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
  timeout.unref?.()
  return timeout
}

async function writeResultArtifacts({ artifactsDir, artifact, durationMs, failure, artifactSafety = {} }) {
  const jsonPath = path.join(artifactsDir, 'billing-golden-e2e.json')
  const junitPath = path.join(artifactsDir, 'billing-golden-e2e.junit.xml')
  const readyPath = path.join(artifactsDir, EVIDENCE_READY_FILE_NAME)
  const safeArtifact = sanitizeArtifactForOutput(artifact, artifactSafety)
  const safeFailure = failure ? sanitizeArtifactValue(failure, artifactSafety) : null
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(safeArtifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(junitPath, buildJUnitXml({ durationMs, failure: safeFailure, artifactSafety }), {
      encoding: 'utf8',
      mode: 0o600,
    }),
  ])
  await fs.writeFile(readyPath, 'v1\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return safeArtifact
}

export function buildJUnitXml({ durationMs, failure = null, artifactSafety = {} }) {
  const seconds = Math.max(0, durationMs / 1_000).toFixed(3)
  const failures = failure ? 1 : 0
  const failureMessage = failure ? sanitizeArtifactText(failure.message, artifactSafety) : ''
  const failureStack = failure ? sanitizeArtifactText(failure.stack ?? failure.message, artifactSafety) : ''
  const failureElement = failure
    ? `\n    <failure message="${xmlEscape(failureMessage)}">${xmlEscape(failureStack)}</failure>`
    : ''
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="billing-golden-e2e" tests="1" failures="${failures}" errors="0" skipped="0" time="${seconds}">`,
    `  <testcase classname="billing.e2e" name="${xmlEscape(TEST_CASE_NAME)}" time="${seconds}">${failureElement}`,
    '  </testcase>',
    '</testsuite>',
    '',
  ].join('\n')
}

function diagnosticError(error, artifactSafety) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: sanitizeArtifactText(safeMessage(error), artifactSafety),
    stack: sanitizeArtifactText(
      error instanceof Error && error.stack ? error.stack : safeMessage(error),
      artifactSafety,
    )
      .split('\n')
      .slice(0, 20)
      .join('\n'),
  }
}

function safeStageArtifact(stage, secrets) {
  const artifact = { stage: stage.stage }
  for (const field of ['status', 'message', 'elapsedSeconds', 'image']) {
    if (!['string', 'number', 'boolean'].includes(typeof stage[field])) continue
    artifact[field] = typeof stage[field] === 'string' ? redactSecrets(stage[field], secrets) : stage[field]
  }
  return artifact
}

function registerSecrets(target, ...values) {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || target.includes(value)) continue
    target.push(value)
  }
}

function registerSessionSecrets(secrets, session) {
  if (!session) return
  registerSecrets(secrets, session.loginPassword, session.authorizationHeader)
  if (typeof session.authorizationHeader === 'string' && session.authorizationHeader.startsWith('Bearer ')) {
    registerSecrets(secrets, session.authorizationHeader.slice('Bearer '.length))
  }
}

function artifactPathRoots({ artifactsDir, runnerHomeDir } = {}) {
  const roots = [repoRoot, artifactsDir, runnerHomeDir]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => path.resolve(value))
    .filter((value) => value !== path.parse(value).root)
  return [...new Set(roots)].sort((left, right) => right.length - left.length)
}

function sanitizeArtifactText(value, { secrets = [], pathRoots = [] } = {}) {
  const secretVariants = secrets.flatMap((secret) => encodedArtifactVariants(secret))
  let sanitized = redactSecrets(stripTerminalEscapeSequences(String(value ?? '')), secretVariants)
  for (const root of pathRoots) {
    const resolvedRoot = path.resolve(root)
    if (resolvedRoot === path.parse(resolvedRoot).root) continue
    for (const encodedRoot of encodedArtifactVariants(resolvedRoot, pathToFileURL(resolvedRoot).href)) {
      sanitized = replaceLiteralCaseInsensitive(sanitized, encodedRoot, '[ABSOLUTE_PATH]')
    }
    sanitized = sanitized.split(pathToFileURL(resolvedRoot).href).join('[ABSOLUTE_PATH]')
    sanitized = sanitized.split(resolvedRoot).join('[ABSOLUTE_PATH]')
    const slashRoot = resolvedRoot.replaceAll('\\', '/')
    if (slashRoot !== resolvedRoot) sanitized = sanitized.split(slashRoot).join('[ABSOLUTE_PATH]')
  }
  return sanitized
    .replace(/\bfile:\/\/[^\s)"'<>\]},;]+/gi, '[ABSOLUTE_PATH]')
    .replace(/\b[A-Za-z]:[\\/][^\s)"'<>\]},;]+/g, '[ABSOLUTE_PATH]')
    .replace(/(^|[^A-Za-z0-9_/:.-])\/{2,}[^\s)"'<>\]},;]+/g, '$1[ABSOLUTE_PATH]')
    .replace(/(^|[^A-Za-z0-9_/.-])\/(?!\/)[^\s)"'<>\]},;]+/g, '$1[ABSOLUTE_PATH]')
}

function encodedArtifactVariants(...values) {
  const variants = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    variants.push(value)
    try {
      variants.push(encodeURIComponent(value))
    } catch {
      // The literal form is still redacted when a malformed surrogate cannot be URI encoded.
    }
  }
  return [...new Set(variants)]
}

function replaceLiteralCaseInsensitive(value, literal, replacement) {
  if (!literal) return value
  const escapedLiteral = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(escapedLiteral, 'gi'), replacement)
}

function stripTerminalEscapeSequences(value) {
  /* eslint-disable no-control-regex -- OSC/CSI terminal sequences are defined by ESC and BEL control bytes. */
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\|$)/g, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
  /* eslint-enable no-control-regex */
}

function sanitizeArtifactValue(value, artifactSafety) {
  if (typeof value === 'string') return sanitizeArtifactText(value, artifactSafety)
  if (Array.isArray(value)) return value.map((entry) => sanitizeArtifactValue(entry, artifactSafety))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeArtifactValue(entry, artifactSafety)]),
  )
}

export function sanitizeArtifactForOutput(value, artifactSafety = {}) {
  return sanitizeArtifactValue(value, artifactSafety)
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIntegerString(value) {
  return typeof value === 'string' && /^-?\d+$/.test(value)
}

function isDecimalString(value) {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
}

if (isMainModule()) {
  runBillingGoldenE2E().catch((error) => {
    console.error(`[billing-golden-e2e] ${safeMessage(error)}`)
    process.exitCode = 1
  })
}
