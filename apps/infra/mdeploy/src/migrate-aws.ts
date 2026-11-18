import { readFile, writeFile } from 'node:fs/promises'
import { parseInvocation } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { resolveScope } from 'mstage/scope'
import { resolveHome } from 'mstage/home'
import { readEnvironment } from 'mstage/env'
import { awsProgram } from '../pulumi/aws-program.ts'
import { createStack, type PulumiStack } from './pulumi.ts'
import { awsLegacyCheckpointDigests } from './aws-migration.ts'
import {
  adoptionPreview,
  assertAwsAdoptionInventory,
  assertAwsFrozenSources,
  nativeImportDocument,
} from './aws-adoption.ts'

const ACTIONS = ['status', 'snapshot', 'begin', 'import', 'refresh', 'preview', 'cutover', 'rollback', 'unlock']
/** Ownership transitions and state-only adoption work; no cloud resource apply is exposed. */
export const migrateAws = async ({
  argv,
  cwd = process.cwd(),
  environment = process.env,
  log = console.log,
  resolveHomeWith = resolveHome,
  createStackWith = createStack,
}: {
  argv: string[]
  cwd?: string
  environment?: NodeJS.ProcessEnv
  log?: (line: string) => void
  resolveHomeWith?: typeof resolveHome
  createStackWith?: typeof createStack
}): Promise<number> => {
  const { options, inner } = parseInvocation(['migration', ...argv], environment, {
    flags: ['writers-settled'],
    values: ['action', 'file'],
  })
  if (inner) throw new Error('AWS migration takes no inner command')
  const action = options.action ?? 'status'
  if (!ACTIONS.includes(String(action))) throw new Error('Migration --action must be ' + ACTIONS.join(', '))
  if (!['status', 'snapshot', 'preview'].includes(String(action)) && !options.confirm)
    throw new Error('Migration changes require --confirm')
  const config = loadConfig({ cwd, environment })
  const scope = resolveScope({ config, options, environment })
  if (scope.home !== 'aws') throw new Error('AWS migration requires an AWS stage')
  const home = await resolveHomeWith({ scope })
  const { backend, identity } = home
  const ownership = backend.ownership
  if (!ownership) throw new Error('AWS backend has no ownership guard')
  const app = scope.app!,
    stage = scope.stage!
  const coordinates = { app, stage }
  await identity.assertUsableFor(action === 'status' || action === 'snapshot' ? 60 : 1200)
  if (action === 'status') {
    log(JSON.stringify(await ownership.inspect(coordinates), null, 2))
    return 0
  }
  const file = typeof options.file === 'string' ? options.file : undefined
  if (action === 'snapshot') {
    if (!file) throw new Error('Snapshot requires --file for a private local backup')
    const snapshots: Record<string, string | null> = {}
    for (const source of new Set([app, 'boxlite']))
      snapshots[source] =
        (await backend.state.readLegacyCheckpoint!({ app: source, stage }))?.toString('base64') ?? null
    const native = await backend.state.readCheckpoint(coordinates)
    await writeFile(
      file,
      JSON.stringify({ app, stage, legacy: snapshots, native: native?.toString('base64') ?? null }),
      { mode: 0o600, flag: 'wx' },
    )
    log('Wrote private checkpoint backup')
    return 0
  }
  if (action === 'unlock') {
    if (!options['writers-settled'])
      throw new Error('Unlock requires --writers-settled after reconciling submitted cloud and SSM operations')
    await ownership.transition({ ...coordinates, action, confirmed: true })
    return 0
  }
  if (action === 'begin') {
    if (!options['writers-settled'])
      throw new Error('Begin requires --writers-settled after freezing historical workflows and external writers')
    const sourceDigests = await awsLegacyCheckpointDigests({ backend, ...coordinates })
    await ownership.transition({
      ...coordinates,
      action,
      sourceDigests,
      confirmed: true,
      validate: async () => {
        const current = await awsLegacyCheckpointDigests({ backend, ...coordinates })
        if (JSON.stringify(current) !== JSON.stringify(sourceDigests))
          throw new Error('Legacy checkpoints changed while beginning migration')
      },
    })
    log('Ownership is adopting; regular legacy and native deployments are blocked')
    return 0
  }
  if (action === 'rollback') {
    await ownership.transition({
      ...coordinates,
      action,
      confirmed: true,
      validate: () => assertAwsFrozenSources({ backend, ...coordinates }),
    })
    log('Ownership is legacy; re-enable its IAM role separately after reviewing the rollback')
    return 0
  }
  const stageEnvironment = await readEnvironment({ clients: backend, ...coordinates })
  const { env: credentials } = await identity.childEnvironment()
  const envVars = Object.fromEntries(
    Object.entries({
      ...credentials,
      ...stageEnvironment,
      AWS_REGION: scope.region,
      AWS_DEFAULT_REGION: scope.region,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (!envVars.PULUMI_CONFIG_PASSPHRASE)
    throw new Error('Migration requires the native Pulumi passphrase in the stage store')
  const migrationStack = async () => {
    const stateBucket = await home.stateBucket()
    const stack = await createStackWith({
      projectName: app,
      stackName: stage,
      backendUrl: 's3://' + stateBucket,
      envVars,
      program: awsProgram({
        stateBucket,
        app,
        stage,
        region: scope.region,
        protectedStage: scope.protect,
        environment: envVars,
        cwd: config.root,
      }),
      selectOnly: action !== 'import',
    })
    await stack.setAllConfig({
      'aws:region': { value: scope.region },
      'aws:defaultTags': { value: JSON.stringify({ tags: { 'boxlite:app': app, 'boxlite:stage': stage } }) },
    })
    return stack
  }
  const preview = async (stack: PulumiStack, signal?: AbortSignal) => {
    const check = adoptionPreview()
    await stack.preview({ refresh: true, onEvent: check.onEvent, onOutput: log, signal })
    check.assertReady()
  }
  if (action === 'cutover') {
    await ownership.transition({
      ...coordinates,
      action,
      confirmed: true,
      validate: async (signal) => {
        await assertAwsAdoptionInventory({ backend, ...coordinates, environment: envVars })
        await preview(await migrationStack(), signal)
      },
    })
    log('Ownership is ' + (await ownership.inspect(coordinates))?.phase)
    return 0
  }
  await ownership.run({ ...coordinates, action: 'migration' }, async ({ signal }) => {
    const stack = await migrationStack()
    if (action === 'import') {
      if (!file)
        throw new Error(
          'Import requires --file containing a reviewed native export; raw SST checkpoints are not importable',
        )
      const document = nativeImportDocument(await readFile(file, 'utf8'), app, stage)
      signal.throwIfAborted()
      await (stack as typeof stack & { importStack: (document: unknown) => Promise<void> }).importStack(document)
    } else if (action === 'refresh') {
      await stack.refresh({ onOutput: log, signal })
    } else {
      await preview(stack, signal)
    }
  })
  return 0
}
