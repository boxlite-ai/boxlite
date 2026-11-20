import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ApplyEngineEvent, PulumiStack } from './pulumi.ts'
import { ALTERNATE_MACHINE, MACHINE, type AlternateRunnerMachine } from '../stack/providers/gcp/runners.ts'
import type { RunnerSize, RunnerSlot } from '../stack/runners.ts'

const INSTANCE = 'gcp:compute/instance:Instance'
const POLICY = 'gcp:osconfig/osPolicyAssignment:OsPolicyAssignment'
const REGISTER = 'command:local:Command'
const RUNNER_TOKEN = 'random:index/randomPassword:RandomPassword'

export type RunnerCapacityScope = { app: string; stage: string; project: string; zone: string }
type RunnerCandidate = {
  urn: string
  slot: RunnerSlot
  primary: string
  alternate: AlternateRunnerMachine
}
type FailedRunner = RunnerCandidate & { attachedDisks: unknown }
type RunnerAbsence = (runners: readonly RunnerCandidate[]) => Promise<void>

const urnFor = ({ app, stage }: RunnerCapacityScope, type: string, name: string) =>
  `urn:pulumi:${stage}::${app}::${type}::${name}`

export const runnerCapacityContext = (scope: RunnerCapacityScope) => ({
  scope,
  runnerMachines: new Map<string, AlternateRunnerMachine>(),
  candidates: [] as RunnerCandidate[],
  runnerRegion: 'us',
  beforeApply: undefined as (() => Promise<void>) | undefined,
})
type Recovery = ReturnType<typeof runnerCapacityContext>

export const recordRunnerCandidates = (recovery: Recovery, size: RunnerSize, fleet: readonly RunnerSlot[]) => {
  if (size === 'small' || size === 'medium') {
    recovery.candidates = []
    return
  }
  recovery.candidates = fleet.map((slot) => ({
    urn: urnFor(recovery.scope, INSTANCE, slot.resourceName),
    slot,
    primary: MACHINE[size],
    alternate: ALTERNATE_MACHINE[size],
  }))
}

// The provider formats terminal operation errors as message text. Match whole messages
// because a mixed operation can put a capacity error and a quota error in one diagnostic.
const capacityDiagnostic = (message: string, scope: RunnerCapacityScope, runner: RunnerCandidate): boolean => {
  const body = message
    .trim()
    .replace(/^sdk-v2\/provider2\.go:\d+: sdk\.helper_schema: /, '')
    .replace(/\s*: provider=google-beta@\S+$/, '')
    .replace(/^1 error occurred:\n\s*\* /, '')
    .replace(/^Error waiting for instance to create: /, '')
    .trim()
  if (body.includes('\n') || body.includes('\r')) return false
  const text = body.replace(/ {2,}/g, ' ')
  const zoneShortage = `The zone 'projects/${scope.project}/zones/${scope.zone}' does not have enough resources available to fulfill the request.`
  if (text === zoneShortage || text === `${zoneShortage} Try a different zone, or try again later.`) return true

  const details = `A ${runner.primary} VM instance is currently unavailable in the ${scope.zone} zone`
  if (!text.startsWith(details)) return false
  const reason = /^(?:,? because of (?:cpu_availability|memory_availability)(?:, ?(?:cpu_availability|memory_availability))? root cause\(s\))?\./
  const remainder = text.slice(details.length)
  const match = reason.exec(remainder)
  if (!match) return false
  const suggestion = remainder.slice(match[0].length)
  return !suggestion ||
    /^ Consider trying your request in the [a-z0-9-]+(?:, [a-z0-9-]+)* zone\(s\), which currently has capacity to accommodate your request\.$/.test(suggestion)
}

const failedRunnerCreates = (events: ApplyEngineEvent[], { scope, candidates }: Recovery): FailedRunner[] => {
  if (events.some(({ summaryEvent }) => summaryEvent?.maybeCorrupt)) return []
  const candidatesByUrn = new Map(candidates.map((candidate) => [candidate.urn, candidate]))
  const failures = new Map<string, FailedRunner>()
  for (const { resOpFailedEvent } of events) {
    if (!resOpFailedEvent) continue
    const { metadata } = resOpFailedEvent
    const candidate = candidatesByUrn.get(metadata.urn)
    const inputs = metadata.new?.inputs
    if (
      !candidate || failures.has(metadata.urn) || metadata.type !== INSTANCE || metadata.op !== 'create' ||
      metadata.old || !inputs || inputs.project !== scope.project || inputs.zone !== scope.zone ||
      inputs.name !== candidate.slot.nameTag || inputs.machineType !== candidate.primary ||
      !Array.isArray(inputs.attachedDisks) || inputs.attachedDisks.length !== 1 ||
      !events.some(({ resourcePreEvent }) =>
        resourcePreEvent?.metadata.urn === metadata.urn && resourcePreEvent.metadata.op === 'create')
    ) return []
    failures.set(metadata.urn, { ...candidate, attachedDisks: inputs.attachedDisks })
  }

  const diagnosed = new Set<string>()
  const stackUrn = urnFor(scope, 'pulumi:pulumi:Stack', `${scope.app}-${scope.stage}`)
  for (const { diagnosticEvent } of events) {
    if (diagnosticEvent?.severity !== 'error') continue
    const { urn, message } = diagnosticEvent
    if ((!urn || urn === stackUrn) && message.trim() === 'update failed') continue
    const runner = urn && failures.get(urn)
    if (!runner || !capacityDiagnostic(message, scope, runner)) return []
    diagnosed.add(runner.urn)
  }
  return failures.size === diagnosed.size ? [...failures.values()] : []
}

const readCheckpoint = async (stack: PulumiStack) => {
  const deployment = (await stack.exportStack()).deployment
  if (
    !Array.isArray(deployment?.resources) ||
    (deployment.pending_operations !== undefined &&
      (!Array.isArray(deployment.pending_operations) || deployment.pending_operations.length > 0))
  ) {
    throw new Error('Pulumi checkpoint is unavailable or has pending operations')
  }
  return {
    resources: deployment.resources,
    // The export may include secrets. Keep the digest in memory and never log the export.
    digest: createHash('sha256').update(JSON.stringify(deployment.resources)).digest('hex'),
  }
}

type PlanChange = { steps: string[]; goal?: { inputDiff?: { adds?: Record<string, unknown> } } }

const plannedChanges = async (file: string): Promise<Map<string, PlanChange>> => {
  const { resourcePlans } = JSON.parse(await readFile(file, 'utf8'))
  if (!resourcePlans || typeof resourcePlans !== 'object' || Array.isArray(resourcePlans)) {
    throw new Error('Unable to read Pulumi plan resource operations')
  }
  const changes = new Map<string, PlanChange>()
  for (const [urn, change] of Object.entries(resourcePlans) as [string, PlanChange][]) {
    if (!Array.isArray(change?.steps) || !change.steps.length) throw new Error('Invalid Pulumi plan operation')
    if (change.steps.some((step) => step !== 'same')) changes.set(urn, change)
  }
  return changes
}

const guardedApply = async (
  stack: PulumiStack,
  recovery: Recovery,
  expectedCheckpoint: string,
  options: Parameters<PulumiStack['up']>[0],
  preflight?: () => Promise<void>,
) => {
  // The DIY backend acquires its update lock before evaluating the inline program.
  // Check again there to reject a writer that ran between the preview and this update.
  recovery.beforeApply = async () => {
    options.signal?.throwIfAborted()
    if ((await readCheckpoint(stack)).digest !== expectedCheckpoint) {
      throw new Error('Pulumi checkpoint changed after planning Runner recovery')
    }
    await preflight?.()
    options.signal?.throwIfAborted()
  }
  try {
    options.signal?.throwIfAborted()
    await stack.up(options)
  } finally {
    recovery.beforeApply = undefined
  }
}

export async function deployWithRunnerCapacityFallback({
  stack, recovery, onOutput, log, assertAbsent, verifyRecovered,
}: {
  stack: PulumiStack
  recovery: Recovery
  onOutput: (output: string) => void
  log: (line: string) => void
  assertAbsent: RunnerAbsence
  verifyRecovered: (runners: readonly RunnerCandidate[], signal: AbortSignal) => Promise<void>
}) {
  const events: ApplyEngineEvent[] = []
  try {
    await stack.up({
      onOutput,
      onEvent: (event) => {
        if (event.resourcePreEvent?.metadata.type === INSTANCE || event.resOpFailedEvent ||
          event.diagnosticEvent?.severity === 'error' || event.summaryEvent?.maybeCorrupt) events.push(event)
      },
    })
  } catch (original) {
    const runners = failedRunnerCreates(events, recovery)
    if (!runners.length) throw original
    try {
      const checkpoint = await readCheckpoint(stack)
      if (runners.some((runner) => checkpoint.resources.some((resource) => resource.urn === runner.urn))) {
        throw new Error('A failed Runner already exists in the Pulumi checkpoint')
      }
      await assertAbsent(runners)
      const directory = await mkdtemp(join(tmpdir(), 'mdeploy-runner-capacity-'))
      const cancellation = new AbortController()
      const { signal } = cancellation
      const abort = () => cancellation.abort()
      process.on('SIGINT', abort)
      process.on('SIGTERM', abort)
      try {
        const plan = join(directory, 'runner-create.json')
        const target = runners.map((runner) => runner.urn)
        const options = { onOutput, plan, target, targetDependents: false, signal }
        for (const runner of runners) recovery.runnerMachines.set(runner.slot.resourceName, runner.alternate)
        await stack.preview(options)
        signal.throwIfAborted()
        const changes = await plannedChanges(plan)
        const { scope } = recovery
        if (
          changes.size !== runners.length ||
          runners.some((runner) => {
            const change = changes.get(runner.urn)
            const inputs = change?.goal?.inputDiff?.adds
            return !isDeepStrictEqual(change?.steps, ['create']) || !inputs ||
              inputs.machineType !== runner.alternate || inputs.name !== runner.slot.nameTag ||
              inputs.project !== scope.project || inputs.zone !== scope.zone ||
              !isDeepStrictEqual(inputs.attachedDisks, runner.attachedDisks)
          })
        ) throw new Error('Saved plan contains unexpected Runner creation changes')

        signal.throwIfAborted()
        log(`GCP N4 capacity exhausted; trying N4D for ${runners.map(({ slot }) => slot.nameTag).join(', ')}`)
        await guardedApply(stack, recovery, checkpoint.digest, options, () => assertAbsent(runners))
        signal.throwIfAborted()
        recovery.runnerMachines.clear()

        // Finish the deferred fleet work using the original inputs and a separate checked plan.
        const continuation = join(directory, 'runner-continuation.json')
        const afterRetry = await readCheckpoint(stack)
        const continuationOptions = { onOutput, plan: continuation, signal }
        signal.throwIfAborted()
        await stack.preview(continuationOptions)
        signal.throwIfAborted()
        const remaining = await plannedChanges(continuation)
        if (!remaining.size) {
          await verifyRecovered(runners, signal)
          return
        }
        const permitted = new Set([
          urnFor(scope, POLICY, 'RunnerBinary'),
          urnFor(scope, POLICY, 'RunnerBinaryFleet'),
          urnFor(scope, REGISTER, 'RegisterExtraRunners'),
        ])
        if ([...remaining].some(([urn, change]) =>
          !permitted.has(urn) || change.steps.length !== 1 || !['create', 'update'].includes(change.steps[0]!),
        )) throw new Error('Full deployment has other pending changes after Runner recovery')
        await guardedApply(stack, recovery, afterRetry.digest, continuationOptions)
        signal.throwIfAborted()

        await stack.preview(continuationOptions)
        signal.throwIfAborted()
        if ((await plannedChanges(continuation)).size) throw new Error('Full deployment has pending changes')
        await verifyRecovered(runners, signal)
      } finally {
        recovery.runnerMachines.clear()
        try {
          await rm(directory, { recursive: true, force: true })
        } finally {
          process.off('SIGINT', abort)
          process.off('SIGTERM', abort)
        }
      }
    } catch {
      log('GCP Runner capacity recovery stopped; retaining the original deployment failure')
      throw original
    }
  }
}

const computeTargetPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !URL.canParse(value)) return
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
    (url.origin !== 'https://compute.googleapis.com' && url.origin !== 'https://www.googleapis.com')) return
  const resourcePath = /^\/compute\/(?:v1|beta|alpha)\/projects\/[^/]+\/(?:zones\/[^/]+|regions\/[^/]+|global)\/[a-zA-Z]+\/[a-z0-9._:-]+$/
  if (resourcePath.test(url.pathname)) return url.pathname
}

type ComputeReader = (url: string, params?: Record<string, string>) => Promise<{ status: number; data?: unknown }>

const computeReader = async (project: string, credentials: NodeJS.ProcessEnv): Promise<ComputeReader> => {
  const googleAuth = 'google-auth-library'
  const { GoogleAuth } = await import(googleAuth)
  const auth = new GoogleAuth({
    projectId: project,
    keyFilename: credentials.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const client = await auth.getClient()
  return (url, params) =>
    client.request({
      url, params, timeout: 10_000, retry: false,
      validateStatus: (status: number) => status === 200 || status === 404,
    })
}

export const gcpRunnerAbsence = (
  { project, zone }: RunnerCapacityScope,
  credentials: NodeJS.ProcessEnv,
  createReader = computeReader,
): RunnerAbsence => async (runners) => {
  const request = await createReader(project, credentials)
  const zonal = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}`

  for (const machine of new Set(runners.map((runner) => runner.alternate))) {
    const { status, data } = await request(`${zonal}/machineTypes/${machine}`)
    if (status !== 200 || !data || typeof data !== 'object' ||
      !('kind' in data) || data.kind !== 'compute#machineType' ||
      !('name' in data) || data.name !== machine || !('zone' in data) || data.zone !== zone
    ) {
      throw new Error('Alternate Runner machine type is unavailable in the stage zone')
    }
  }
  for (const { slot } of runners) {
    const instance = await request(`${zonal}/instances/${encodeURIComponent(slot.nameTag)}`)
    const data = instance.data as { error?: { code?: unknown } } | undefined
    if (instance.status !== 404 || data?.error?.code !== 404) {
      throw new Error('Compute Engine did not confirm the failed Runner instance is absent')
    }
  }
  // Nonterminal zonal operations are a veto, never evidence authorizing a retry.
  const operations = await request(`${zonal}/operations`, { filter: 'status != DONE', maxResults: '500' })
  const page = operations.data
  const pendingOperation = 'Unable to rule out a pending Compute Engine Runner operation'
  if (
    operations.status !== 200 || !page || typeof page !== 'object' ||
    !('kind' in page) || page.kind !== 'compute#operations'
  ) throw new Error(pendingOperation)

  const { items = [], nextPageToken, warning } = page as {
    items?: { targetLink?: unknown; status?: unknown }[]
    nextPageToken?: unknown
    warning?: { code?: unknown } | null
  }
  if (
    (nextPageToken !== undefined && nextPageToken !== '') || !Array.isArray(items) ||
    (warning !== undefined && (warning?.code !== 'NO_RESULTS_ON_PAGE' || items.length !== 0)) ||
    items.some((operation) => {
      const target = computeTargetPath(operation?.targetLink)
      return !target || (operation.status !== 'PENDING' && operation.status !== 'RUNNING') ||
        runners.some(({ slot }) => target.endsWith(`/zones/${zone}/instances/${slot.nameTag}`))
    })
  ) throw new Error(pendingOperation)
}

export const verifyGcpRunnerIdentities = async (
  stack: PulumiStack,
  recovery: Recovery,
  apiHost: string,
  runners: readonly RunnerCandidate[],
  signal: AbortSignal,
) => {
  const { resources } = await readCheckpoint(stack)
  const endpoint = new URL('https://' + apiHost + '/api/runners/me')
  for (const { slot } of runners) {
    const tokenUrn = urnFor(recovery.scope, RUNNER_TOKEN, `RunnerToken-${slot.controlPlaneRunnerName}`)
    const stored = resources.find(({ urn, type, delete: deleting }) =>
      urn === tokenUrn && type === RUNNER_TOKEN && !deleting,
    )?.outputs?.result
    // Automation exports with --show-secrets. A Pulumi secret may be wrapped
    // with a plaintext JSON value. It is used only as the bearer credential.
    const token = typeof stored === 'string' ? stored :
      stored && typeof stored === 'object' && 'plaintext' in stored && typeof stored.plaintext === 'string'
        ? JSON.parse(stored.plaintext)
        : undefined
    if (typeof token !== 'string' || !/^[a-zA-Z0-9]{64}$/.test(token)) {
      throw new Error('Unable to resolve the recovered Runner token')
    }
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) throw new Error('Recovered Runner failed authentication')
    const identity: { name?: string; region?: string } = await response.json()
    if (identity?.name !== slot.controlPlaneRunnerName || identity.region !== recovery.runnerRegion) {
      throw new Error('Recovered Runner token does not match the expected registration')
    }
  }
}
