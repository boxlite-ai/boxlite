import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { RunnerArtifact } from '../stack/runner-binary.ts'
import { PROTECTED_RELEASE_RUNTIME_USER } from '../stack/providers/gcp/protected-release.ts'
import {
  createOrdinaryCutoverBox,
  protectedRunnerArtifactDigest,
  readRunnerProcess,
  recordCompatibleRunner,
  runReleaseDatabaseJob,
  servingApiRevision,
  waitForServingApiRevision,
  verifyRunnerEnrollment,
  verifyRunnerProcess,
  verifyServingApiLogin,
  verifyServingRunnerCompletion,
  type ProtectedEnrollment,
} from './protected-runner-release.ts'
import { sleepSeconds, spawnWith, waitForRunnerPolicyCompliance } from './upgrade-runners.ts'

const {
  API_URL, ADMIN_API_KEY, RELEASE_SLOTS, RELEASE_ARTIFACT, RELEASE_DIGEST,
  RELEASE_PROJECT, RELEASE_REGION, RELEASE_ZONE, RELEASE_API_SERVICE, RELEASE_DB_JOB,
  RELEASE_COMPLIANCE,
  RELEASE_TEST_KEY,
} = process.env

const phase = process.argv[2]
if (phase === 'prepare-database') {
  if (!RELEASE_PROJECT || !RELEASE_REGION || !RELEASE_DB_JOB) {
    throw new Error('Protected Runner release database inputs are incomplete')
  }
  runReleaseDatabaseJob({
    phase: 'prepare', project: RELEASE_PROJECT, region: RELEASE_REGION, job: RELEASE_DB_JOB,
    run: spawnWith(process.env, 150_000),
  })
  process.exit(0)
}
if (!API_URL || !ADMIN_API_KEY || !RELEASE_SLOTS || !RELEASE_PROJECT || !RELEASE_ZONE || !RELEASE_API_SERVICE) {
  throw new Error('Protected Runner release inputs are incomplete')
}

const slots: (ProtectedEnrollment & { host: string })[] = JSON.parse(RELEASE_SLOTS)
if (!Array.isArray(slots)) throw new Error('Invalid protected Runner release slots')
const run = spawnWith(process.env, 40_000)
const service = {
  project: RELEASE_PROJECT,
  region: RELEASE_REGION ?? RELEASE_ZONE.slice(0, -2),
  service: RELEASE_API_SERVICE,
  run,
}

if (phase === 'enrollment' && RELEASE_ARTIFACT && RELEASE_DB_JOB) {
  if (slots.length > 0 && !RELEASE_TEST_KEY) throw new Error('Protected cutover requires the stage test API key')
  await verifyRunnerEnrollment(API_URL, ADMIN_API_KEY, slots)
  const digest = await protectedRunnerArtifactDigest(JSON.parse(RELEASE_ARTIFACT) as RunnerArtifact)
  const version = (await readFile(new URL('../../../box-images/VERSION', import.meta.url), 'utf8')).trim()
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('Invalid ordinary release Box image version')
  const image = `ghcr.io/boxlite-ai/boxlite-agent-base:${version.startsWith('v') ? version : `v${version}`}`
  const name = `e2e-v2-cutover-${randomUUID()}`
  let probe: Awaited<ReturnType<typeof createOrdinaryCutoverBox>> | undefined
  try {
    await waitForServingApiRevision(
      (timeout) => servingApiRevision({ ...service, run: spawnWith(process.env, timeout) }),
      async (revision, timeout) => {
        const deadline = performance.now() + timeout
        await verifyServingApiLogin({
          apiUrl: API_URL, adminApiKey: ADMIN_API_KEY, revision, timeout: Math.min(timeout, 10_000),
          expectedLogin: PROTECTED_RELEASE_RUNTIME_USER,
        })
        if (!slots.length || !RELEASE_TEST_KEY) return
        const budget = Math.floor(deadline - performance.now())
        if (budget <= 0) throw new Error('No time remains for the ordinary Box probe')
        probe ??= await createOrdinaryCutoverBox({
          apiUrl: API_URL, adminApiKey: ADMIN_API_KEY, testApiKey: RELEASE_TEST_KEY, image, name,
          signal: AbortSignal.timeout(budget),
        })
        const remaining = Math.floor(deadline - performance.now())
        if (remaining <= 0) throw new Error('No time remains to read the ordinary V2 job receipt')
        await verifyServingRunnerCompletion({
          apiUrl: API_URL, adminApiKey: ADMIN_API_KEY, revision, boxId: probe.boxId, timeout: remaining,
        })
      },
    )
  } finally {
    await probe?.cleanup().catch(() => console.warn('The ordinary release Box will expire under its bounded lifetime'))
  }
  runReleaseDatabaseJob({
    ...service, job: RELEASE_DB_JOB, phase: 'fence', run: spawnWith(process.env, 150_000),
  })
  console.log(digest)
} else if (phase === 'proof' && RELEASE_DIGEST && RELEASE_DB_JOB && slots.length) {
  const batches: { assignment: string; targets: string[]; revision: string; policies: string[] }[] = JSON.parse(
    RELEASE_COMPLIANCE ?? '[]',
  )
  const hosts = batches.flatMap(({ targets }) => targets)
  if (new Set(hosts).size !== hosts.length || slots.some(({ host }) => !hosts.includes(host))) {
    throw new Error('Final OS Config compliance must cover every enrolled Runner exactly once')
  }
  for (const batch of batches) {
    waitForRunnerPolicyCompliance({
      ...batch, identity: 'the declared Runner policy', project: RELEASE_PROJECT, zone: RELEASE_ZONE,
      run, sleep: sleepSeconds, log: console.log,
    })
  }
  const revision = servingApiRevision(service)
  const expectedDigest = RELEASE_DIGEST.trim()
  const witnesses = []
  for (const slot of slots) {
    const host = { target: slot.host, project: RELEASE_PROJECT, zone: RELEASE_ZONE }
    const witness = await verifyRunnerProcess({
      sample: () => readRunnerProcess(host, run),
      runnerId: slot.runnerId,
      expectedDigest,
      apiUrl: API_URL,
      adminApiKey: ADMIN_API_KEY,
      revision,
    })
    recordCompatibleRunner(host, witness, run)
    witnesses.push({ runnerId: slot.runnerId, ...witness })
  }
  if (servingApiRevision(service) !== revision) throw new Error('API traffic changed during Runner verification')
  runReleaseDatabaseJob({
    ...service, job: RELEASE_DB_JOB, phase: 'approve', run: spawnWith(process.env, 150_000),
    evidence: { key: 'PROTECTED_RELEASE_WITNESSES', value: witnesses },
  })
  console.log(JSON.stringify({ revision, witnesses }))
} else {
  throw new Error('Unknown protected Runner release phase')
}
