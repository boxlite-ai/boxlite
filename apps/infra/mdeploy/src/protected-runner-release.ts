import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'
import type { RunnerArtifact } from '../stack/runner-binary.ts'
import { renderUpgradePayload, type UpgradeTarget } from '../stack/runner-upgrade.ts'
import { PROTECTED_RUNNER_STATE_DIR } from '../stack/runner-protected-proxy.ts'
import { iapRunnerCommandArgs, type RunCommand } from './upgrade-runners.ts'

const SHA256 = /^[0-9a-f]{64}$/
const PROCESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const sampleProcessCommand = (approved?: RunnerProcessSample, legacy = false): string => Buffer.from(`set -euo pipefail
python3 -I - <<'PY'
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

def main_pid():
    return int(subprocess.check_output(
        ["systemctl", "show", "--property=MainPID", "--value", "boxlite-runner"], timeout=5
    ))

def start_ticks(proc):
    return int((proc / "stat").read_text().rsplit(") ", 1)[1].split()[19])

pid = main_pid()
if pid <= 0:
    raise SystemExit("Runner has no main process")
proc = pathlib.Path("/proc") / str(pid)
ticks = start_ticks(proc)
digest = hashlib.sha256()
with (proc / "exe").open("rb") as binary:
    for chunk in iter(lambda: binary.read(1024 * 1024), b""):
        digest.update(chunk)
if main_pid() != pid or start_ticks(proc) != ticks:
    raise SystemExit("Runner process evidence changed during sampling")
if ${legacy ? 'True' : 'False'}:
    print(digest.hexdigest())
    raise SystemExit(0)
record = json.loads(pathlib.Path("/run/boxlite-runner/protected-process.json").read_text())
if (record.get("pid"), record.get("start_ticks"), record.get("executable_digest")) != (
    pid, ticks, digest.hexdigest()
) or main_pid() != pid or start_ticks(proc) != ticks:
    raise SystemExit("Runner process evidence changed during sampling")
expected = '${approved ? Buffer.from(JSON.stringify(approved)).toString('base64') : ''}'
if expected:
    if json.loads(base64.b64decode(expected)) != record:
        raise SystemExit("Runner process changed before recording compatible bytes")
    directory = pathlib.Path('${PROTECTED_RUNNER_STATE_DIR}')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    (directory / "enrolled").touch(mode=0o600)
    with tempfile.NamedTemporaryFile(dir=directory, mode="w", delete=False) as receipt:
        receipt.write(record["executable_digest"] + "\\n")
        receipt.flush()
        os.fsync(receipt.fileno())
    os.replace(receipt.name, directory / "compatible.sha256")
print(json.dumps(record))
PY
`).toString('base64')

export type RunnerProcessSample = {
  pid: number
  start_ticks: number
  process_id: string
  executable_digest: string
}

export type ProtectedEnrollment = { runnerId: string; name: string; apiKey: string }

export async function verifyRunnerEnrollment(
  apiUrl: string,
  adminApiKey: string,
  slots: readonly ProtectedEnrollment[],
  request = fetch,
): Promise<void> {
  if (!adminApiKey) throw new Error('Protected enrollment requires the stage admin API key')
  await Promise.all(slots.map(async ({ runnerId, name, apiKey }) => {
    const read = async (path: string, key: string): Promise<{ id: string; name: string; apiVersion: string }> => {
      const url = new URL(path, apiUrl)
      if (url.protocol !== 'https:' || !key) throw new Error('Protected enrollment requires an authenticated HTTPS API')
      const response = await request(url, {
        headers: { authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`${name}: existing Runner enrollment lookup returned HTTP ${response.status}`)
      return response.json()
    }
    const [inventory, authenticated] = await Promise.all([
      read(`/api/admin/runners/${encodeURIComponent(runnerId)}`, adminApiKey),
      read('/api/runners/me', apiKey),
    ])
    for (const runner of [inventory, authenticated]) {
      if (runner?.id !== runnerId || runner.name !== name || runner.apiVersion !== '2') {
        throw new Error(`${name}: current Runner identity and credentials do not match enrollment`)
      }
    }
  }))
}

const exec = promisify(execFile)

async function hash(stream: AsyncIterable<Buffer>): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of stream) digest.update(chunk)
  return digest.digest('hex')
}

/** Reads the selected archive independently of the bytes currently on a Runner. */
export async function protectedRunnerArtifactDigest(binary: RunnerArtifact): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'boxlite-protected-runner-'))
  try {
    const archive = join(directory, 'runner.tar.gz')
    const manifest = join(directory, 'runner.sha256')
    const download = async (source: string, path: string) => {
      if (binary.transport === 'gcs' && new URL(source).protocol === 'gs:') {
        await exec('gcloud', ['storage', 'cp', source, path], { timeout: 120_000 })
      } else if (binary.transport === 'https' && new URL(source).protocol === 'https:') {
        await exec('curl', [
          '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
          '--max-time', '120', '--output', path, '--', source,
        ], { timeout: 125_000 })
      } else {
        throw new Error('Protected Runner release has an unsupported artifact address')
      }
    }
    await download(binary.tarballUrl, archive)
    await download(binary.checksumUrl, manifest)
    const named = (await readFile(manifest, 'utf8')).trim().split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(([, name]) => name?.replace(/^\*/, '') === binary.tarballName)
    if (named.length !== 1 || !SHA256.test(named[0][0]) || (await hash(createReadStream(archive))) !== named[0][0]) {
      throw new Error('Protected Runner release archive does not match its checksum manifest')
    }

    const tar = spawn('tar', ['-xOzf', archive, '--', 'boxlite-runner'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    })
    const exit = new Promise<void>((resolve, reject) => {
      tar.once('error', reject)
      tar.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error('Protected Runner release archive does not contain a readable executable'))
      })
    })
    const [digest] = await Promise.all([hash(tar.stdout), exit])
    if (digest === createHash('sha256').digest('hex')) throw new Error('Protected Runner executable is empty')
    return digest
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function readRunnerProcess(
  host: { target: string; project: string; zone: string },
  run: RunCommand,
): RunnerProcessSample {
  const result = run('gcloud', iapRunnerCommandArgs({ ...host, payload: sampleProcessCommand() }))
  if (!result.ok) throw new Error(`${host.target}: could not sample the final Runner process over IAP`)
  let sample: RunnerProcessSample
  try {
    sample = JSON.parse(result.stdout)
  } catch {
    throw new Error(`${host.target}: invalid Runner process sample`)
  }
  if (
    !sample ||
    !Number.isSafeInteger(sample.pid) ||
    sample.pid <= 0 ||
    !Number.isSafeInteger(sample.start_ticks) ||
    sample.start_ticks <= 0 ||
    typeof sample.process_id !== 'string' ||
    !PROCESS_ID.test(sample.process_id) ||
    typeof sample.executable_digest !== 'string' ||
    !SHA256.test(sample.executable_digest)
  ) {
    throw new Error(`${host.target}: invalid Runner process sample`)
  }
  return sample
}

export function recordCompatibleRunner(
  host: { target: string; project: string; zone: string },
  proof: RunnerProcessSample,
  run: RunCommand,
): void {
  const result = run('gcloud', iapRunnerCommandArgs({ ...host, payload: sampleProcessCommand(proof) }))
  if (!result.ok) throw new Error(`${host.target}: could not record the verified compatible Runner`)
}

export async function verifyRunnerProcess({
  sample,
  runnerId,
  expectedDigest,
  apiUrl,
  adminApiKey,
  revision,
  request = fetch,
}: {
  sample: () => RunnerProcessSample
  runnerId: string
  expectedDigest: string
  apiUrl: string
  adminApiKey: string
  revision: string
  request?: typeof fetch
}): Promise<RunnerProcessSample> {
  if (!SHA256.test(expectedDigest) || !adminApiKey || !revision) {
    throw new Error('Protected Runner verification requires a pinned digest and an API revision')
  }
  const first = sample()
  if (first.executable_digest !== expectedDigest) throw new Error(`${runnerId}: executable digest differs from the release`)

  const endpoint = new URL(`/api/admin/runners/${encodeURIComponent(runnerId)}/protected-release`, apiUrl)
  if (endpoint.protocol !== 'https:') throw new Error('Protected Runner verification requires HTTPS')
  endpoint.searchParams.set('processId', first.process_id)
  endpoint.searchParams.set('executableDigest', expectedDigest)
  const response = await request(endpoint, {
    headers: { authorization: `Bearer ${adminApiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok || (await response.json())?.revision !== revision) {
    throw new Error(`${runnerId}: expected API revision did not verify the running process`)
  }
  const last = sample()
  if (
    last.pid !== first.pid ||
    last.start_ticks !== first.start_ticks ||
    last.process_id !== first.process_id ||
    last.executable_digest !== first.executable_digest
  ) {
    throw new Error(`${runnerId}: Runner restarted during proxy release verification`)
  }
  return last
}

export function servingApiRevision({
  project,
  region,
  service,
  run,
}: {
  project: string
  region: string
  service: string
  run: RunCommand
}): string {
  const response = run('gcloud', ['run', 'services', 'describe', service, `--project=${project}`, `--region=${region}`, '--format=json'])
  if (!response.ok) throw new Error('Could not read the serving API revision')
  const { status } = JSON.parse(response.stdout)
  const revision = status?.latestReadyRevisionName
  const traffic = status?.traffic?.filter((target: { percent?: number }) => (target.percent ?? 0) > 0)
  if (typeof revision !== 'string' || !revision || traffic?.length !== 1 ||
      traffic[0].revisionName !== revision || traffic[0].percent !== 100) {
    throw new Error('Cloud Run does not route all traffic to the current compatible revision')
  }
  return revision
}

export async function waitForServingApiRevision(
  readRevision: (timeout: number) => string,
  verifyTraffic: (revision: string, timeout: number) => Promise<void>,
): Promise<string> {
  const deadline = performance.now() + 120_000
  const remaining = () => Math.floor(deadline - performance.now())
  while (true) {
    const readBudget = remaining()
    if (readBudget <= 0) break
    try {
      const revision = readRevision(Math.min(readBudget, 5_000))
      const budget = remaining()
      if (budget <= 0) break
      await verifyTraffic(revision, Math.min(budget, 45_000))
      if (remaining() >= 0) return revision
    } catch {
      await wait(Math.min(1_000, Math.max(0, remaining())))
    }
  }
  throw new Error('The compatible API traffic switch did not converge within 120 seconds')
}

export async function verifyServingApiLogin({
  apiUrl,
  adminApiKey,
  revision,
  expectedLogin,
  timeout,
  request = fetch,
}: {
  apiUrl: string
  adminApiKey: string
  revision: string
  expectedLogin: string
  timeout: number
  request?: typeof fetch
}): Promise<void> {
  const url = new URL('/api/admin/runners/protected-release/serving', apiUrl)
  if (url.protocol !== 'https:') throw new Error('Protected Runner release verification requires HTTPS')
  const response = await request(url, {
    headers: { authorization: `Bearer ${adminApiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error('The compatible API has no live database response')
  const result = await response.json()
  if (result?.revision !== revision || result.databaseLogin !== expectedLogin) {
    throw new Error('The serving API revision is not using the protected runtime login')
  }
}

export async function verifyServingRunnerCompletion({
  apiUrl,
  adminApiKey,
  revision,
  boxId,
  timeout,
  request = fetch,
}: {
  apiUrl: string
  adminApiKey: string
  revision: string
  boxId: string
  timeout: number
  request?: typeof fetch
}): Promise<void> {
  if (!/^[A-Za-z0-9]{12}$/.test(boxId)) throw new Error('Invalid ordinary release Box')
  const url = new URL(`/api/admin/runners/protected-release/serving/${boxId}`, apiUrl)
  if (url.protocol !== 'https:') throw new Error('Protected Runner release verification requires HTTPS')
  const response = await request(url, {
    headers: { authorization: `Bearer ${adminApiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error('The ordinary V2 create has no completion on the compatible revision')
  const receipt = await response.json()
  if (receipt?.revision !== revision || receipt.boxId !== boxId ||
      !PROCESS_ID.test(receipt.jobId) || !PROCESS_ID.test(receipt.runnerId)) {
    throw new Error('The ordinary V2 create completion does not match the release Box and revision')
  }
}

export async function createOrdinaryCutoverBox({
  apiUrl, adminApiKey, testApiKey, image, name, signal, request = fetch,
}: {
  apiUrl: string
  adminApiKey: string
  testApiKey: string
  image: string
  name: string
  signal: AbortSignal
  request?: typeof fetch
}): Promise<{ boxId: string; cleanup(): Promise<void> }> {
  const identity = new URL('/v1/me', apiUrl)
  if (identity.protocol !== 'https:' || !adminApiKey || !testApiKey) {
    throw new Error('The protected cutover probe requires the existing stage admin and test API keys over HTTPS')
  }
  const headers = { authorization: `Bearer ${testApiKey}`, 'content-type': 'application/json' }
  const who = await request(identity, { headers, signal, redirect: 'error' })
  if (!who.ok) throw new Error('Could not identify the stage test organization')
  const prefix = (await who.json())?.path_prefix
  if (typeof prefix !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(prefix)) {
    throw new Error('Invalid stage test organization prefix')
  }
  const collection = new URL(`/v1/${prefix}/boxes`, identity)
  const named = new URL(`${collection.pathname}/${encodeURIComponent(name)}`, collection)
  const existing = await request(named, { headers, signal, redirect: 'error' })
  const created = existing.status === 404
    ? await request(new URL(`${collection.pathname}/_protected-release`, collection), {
        headers: { ...headers, authorization: `Bearer ${adminApiKey}` }, signal, redirect: 'error', method: 'POST',
        body: JSON.stringify({ name, image }),
      })
    : existing
  if (![200, 201].includes(created.status)) {
    throw new Error(`Ordinary V2 cutover probe could not resolve its named Box (HTTP ${created.status})`)
  }
  const boxId = (await created.json())?.box_id
  if (typeof boxId !== 'string' || !/^[A-Za-z0-9]{12}$/.test(boxId)) throw new Error('Invalid ordinary release Box response')
  return {
    boxId,
    async cleanup() {
      const target = new URL(`${collection.pathname}/${boxId}`, collection)
      const removed = await request(target, {
        headers, redirect: 'error', method: 'DELETE', signal: AbortSignal.timeout(5_000),
      })
      if (!removed.ok && removed.status !== 404) throw new Error('Could not clean up the ordinary release Box')
    },
  }
}

export function runReleaseDatabaseJob({
  phase,
  project,
  region,
  job,
  run,
  evidence,
}: {
  phase: 'prepare' | 'fence' | 'record-proof' | 'approve' | 'reserve-restore' | 'verify-restore' | 'finish-restore'
  project: string
  region: string
  job: string
  run: RunCommand
  evidence?: { key: 'PROTECTED_RELEASE_RESTORE' | 'PROTECTED_RELEASE_WITNESSES'; value: unknown }
}): void {
  const override = evidence ? `^~^${evidence.key}=${JSON.stringify(evidence.value)}` : undefined
  const answer = run('gcloud', [
    'run', 'jobs', 'execute', job, `--project=${project}`, `--region=${region}`,
    `--args=--protected-release-db,${phase}`, '--wait', '--quiet',
    ...(override ? [`--update-env-vars=${override}`] : []),
  ])
  if (!answer.ok) throw new Error(`Protected API database ${phase} job did not complete`)
}

export function deployedProtectedReleaseKey({ project, region, job, run }: {
  project: string; region: string; job: string; run: RunCommand
}): string {
  const answer = run('gcloud', [
    'run', 'jobs', 'describe', job, `--project=${project}`, `--region=${region}`,
    '--format=json(spec.template.spec.template.spec.containers[0].env)',
  ])
  if (!answer.ok) throw new Error('Could not read the deployed protected release job')
  let key: unknown
  try {
    const job = JSON.parse(answer.stdout)
    const env = job.spec?.template?.spec?.template?.spec?.containers?.[0]?.env
    key = env?.find(({ name }: { name: string }) => name === 'PROTECTED_RELEASE_KEY')?.value
  } catch {
    throw new Error('The deployed protected release job has invalid configuration')
  }
  if (typeof key !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(key)) {
    throw new Error('The deployed protected release job has no valid release key')
  }
  return key
}

export function existingProtectedRunnerToken(state: unknown, runner: string): string {
  type Resource = { type?: string; urn?: string; delete?: boolean; outputs?: { result?: unknown } }
  const resources = (state as { deployment?: { resources?: Resource[] } })?.deployment?.resources
  const matches = Array.isArray(resources) ? resources.filter((item) =>
    item.type === 'random:index/randomPassword:RandomPassword' && !item.delete &&
    item.urn?.endsWith(`::RunnerToken-${runner}`),
  ) : []
  const value = matches.length === 1 ? matches[0].outputs?.result : undefined
  let token: unknown = value
  if (value && typeof value === 'object' && 'plaintext' in value && typeof value.plaintext === 'string') {
    try {
      token = JSON.parse(value.plaintext)
    } catch {
      token = value.plaintext
    }
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error(`No existing Runner token in the stage state for ${runner}`)
  }
  return token
}

export async function restoreProtectedRunner({
  host,
  region,
  job,
  runnerId,
  binary,
  runHost,
  runDatabase,
  log,
}: {
  host: { target: string; project: string; zone: string }
  region: string
  job: string
  runnerId: string
  binary: UpgradeTarget['binary'] & { identity: string }
  runHost: RunCommand
  runDatabase: RunCommand
  log: (line: string) => void
}): Promise<void> {
  const digest = await protectedRunnerArtifactDigest(binary)
  const releaseKey = deployedProtectedReleaseKey({ project: host.project, region, job, run: runDatabase })
  const stable = createHash('sha256')
    .update(JSON.stringify([host.project, host.zone, host.target, runnerId, digest, releaseKey]))
    .digest('hex')
  const permit = `${stable.slice(0, 8)}-${stable.slice(8, 12)}-4${stable.slice(13, 16)}-8${stable.slice(17, 20)}-${stable.slice(20, 32)}`
  const evidence = { key: 'PROTECTED_RELEASE_RESTORE' as const, value: { permit, runnerId, digest, releaseKey } }
  const database = { project: host.project, region, job, run: runDatabase, evidence }
  runReleaseDatabaseJob({ ...database, phase: 'reserve-restore' })
  log(`Protected restore permit ${permit} for Runner ${runnerId} and executable ${digest}`)
  runReleaseDatabaseJob({ ...database, phase: 'verify-restore' })
  const script = renderUpgradePayload({
    identity: binary.identity,
    binary,
    port: 3003,
    allowDowngrade: true,
    protectedRelease: { expectedDigest: digest, hosts: [host.target] },
  })
  const restore = runHost('gcloud', iapRunnerCommandArgs({ ...host, payload: Buffer.from(script).toString('base64') }))
  if (!restore.ok) throw new Error(`Protected restore ${permit} did not converge; the permit remains active`)
  const final = runHost('gcloud', iapRunnerCommandArgs({ ...host, payload: sampleProcessCommand(undefined, true) }))
  if (!final.ok || final.stdout !== digest) throw new Error(`Protected restore ${permit} has no matching final executable`)
  runReleaseDatabaseJob({ ...database, phase: 'finish-restore' })
  log(`Restored Runner ${runnerId} to ${digest}; protected admission remains closed`)
}

export async function claimStandaloneRunnerUpdate(
  apiUrl: string,
  adminApiKey: string,
  claimId: string,
  resume: boolean,
  request = fetch,
): Promise<() => Promise<void>> {
  const endpoint = new URL('/api/admin/runners/protected-release/standalone', apiUrl)
  if (endpoint.protocol !== 'https:' || !adminApiKey) {
    throw new Error('Standalone Runner updates require the stage admin API over HTTPS')
  }
  const headers = { authorization: `Bearer ${adminApiKey}`, 'content-type': 'application/json' }
  const claim = await request(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ claimId, resume }), redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (claim.status !== 204) {
    throw new Error(`Stage did not grant a standalone Runner update (HTTP ${claim.status}); use mdeploy-all for a controlled stage`)
  }
  return async () => {
    const finish = await request(new URL(`${endpoint.pathname}/${claimId}`, endpoint), {
      method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (finish.status !== 204) throw new Error(`Standalone Runner update claim ${claimId} did not clear`)
  }
}

export function standaloneUpdateClaimId(operation: string, target: ReadonlyArray<unknown>): string {
  if (!PROCESS_ID.test(operation)) throw new Error('Invalid standalone update resume token')
  const hash = createHash('sha256').update(JSON.stringify([operation, ...target])).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
