/*
 * `npm run runner:promote -- --tag <commit> --from <stage> --to <stage>`
 *
 * Move a staged runner binary between two stages' artifacts buckets, bytes
 * unchanged. The images have had this since mbuild; this is the third artifact,
 * which is not an image and lives in a bucket rather than a registry.
 *
 * Copied rather than rebuilt, and that is the whole point. A rebuild of one
 * commit is not byte-identical — gzip alone stamps an mtime — while everything
 * downstream treats version+commit as an identity and looks at no content: the
 * engine's trigger, the health route's comparison, the "already serving it"
 * skip. Two stages that each built the same commit hold two sets of bytes under
 * one reported version, and no check anywhere can see it.
 *
 * No checkout, deliberately. The object's name carries the version it was built
 * from, so the source bucket is the authority on what that commit produced —
 * asking the working copy would promote whatever version happens to be checked
 * out, under someone else's commit.
 *
 * One identity, like `mbuild promote`: the session this runs under reads the
 * source and writes the destination, so the two stages have to be reachable
 * from one. Within a cloud, and refused across one — a bucket URI is not a
 * cross-cloud address and inventing a copy through this machine would move
 * bytes nobody asked to move.
 */

import { parseInvocation, type Options } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { resolveHome } from 'mstage/home'
import { run as mstage } from 'mstage/run'
import { resolveScope } from 'mstage/scope'
import { awsDestination, gcpDestination, RunnerBuildError, type Destination } from './runner-build.ts'
import { spawnWith, type RunCommand } from './upgrade-runners.ts'

const USAGE = [
  'usage: npm run runner:promote -- --tag <commit-sha> --from <stage> --to <stage>',
  '',
  'Copies the runner binary a stage already serves into another stage’s bucket,',
  'unchanged. The source must hold it; a rebuild would be different bytes under',
  'the same version+commit identity.',
].join('\n')

const COMMIT = /^[0-9a-f]{40}$/

/** One stage's bucket for this commit, named by whichever cloud it lives in. */
const destinationFor = ({
  config,
  stage,
  prefix,
  names,
  run,
  home,
}: {
  config: { app: string; stages: Record<string, { home: string; region?: string | null; project?: string | null }> }
  stage: string
  prefix: string
  names: string[]
  run: RunCommand
  home: string
}): Destination => {
  const declared = config.stages[stage]
  if (!declared) throw new RunnerBuildError(`no stage "${stage}" is declared`)
  if (declared.home !== home) {
    throw new RunnerBuildError(
      `cannot promote between clouds: this session is on ${home} and "${stage}" lives on ${declared.home}. ` +
        'A promotion copies within one cloud, using one identity.',
    )
  }
  return declared.home === 'aws'
    ? awsDestination({ run, app: config.app, stage, region: declared.region as string, prefix, names })
    : gcpDestination({ run, app: config.app, stage, project: declared.project as string, prefix, names })
}

export type PromoteInput = {
  argv: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  log?: (line: string) => void
  checkLogin?: typeof mstage
  resolveHomeWith?: typeof resolveHome
  run?: RunCommand
}

export const promoteRunner = async ({
  argv,
  environment = process.env,
  cwd = process.cwd(),
  log = console.log,
  checkLogin = mstage,
  resolveHomeWith = resolveHome,
  run: injectedRun,
}: PromoteInput): Promise<number> => {
  if (argv[0] === 'help' || argv[0] === '--help') {
    log(USAGE)
    return 0
  }

  const { options } = parseInvocation(['promote', ...argv], environment, { values: ['tag', 'from', 'to'] })
  const tag = String(options.tag ?? '')
  const from = String(options.from ?? '')
  const to = String(options.to ?? '')
  if (!COMMIT.test(tag)) throw new RunnerBuildError(`--tag must be a full commit sha; got ${JSON.stringify(tag)}\n${USAGE}`)
  if (!from || !to) throw new RunnerBuildError(`--from and --to are both required.\n${USAGE}`)
  if (from === to) throw new RunnerBuildError(`promoting "${from}" to itself would do nothing`)

  const config = loadConfig({ cwd, environment })
  // The destination's session, because that is the one that has to write. The
  // source is read with it, which is why both stages live in one account.
  const scope = resolveScope({ options: { ...(options as Options), stage: to }, config, environment })
  const signedIn = await checkLogin({ argv: ['login', '--stage', to], environment, cwd, log })
  if (signedIn !== 0) throw new RunnerBuildError('Required sign-ins are missing; run `npm run mstage login -- -f` first')

  const home = await resolveHomeWith({ scope })
  const { env: credentials } = await home.identity.childEnvironment()
  const run = injectedRun ?? spawnWith({ ...environment, ...credentials })
  const prefix = `runner/${tag}`
  const cloud = home.identity.home

  /*
   * What the source holds decides the names, so it is asked first and with no
   * names of its own. An empty prefix is the ordinary "nothing to promote"; a
   * prefix holding one of the two is the half-publication `runner:build`
   * refuses to complete, and copying half of it would move a manifest that
   * describes bytes the destination does not have.
   *
   * Listing is also the only thing asked of it, and that is a permission
   * boundary rather than a preference. This session is the destination's, so on
   * GCP the call lands in another project, where what reaches across is one
   * grant on one bucket: `roles/storage.objectViewer`, object reads and nothing
   * else. No object role carries `storage.buckets.get`, so the
   * `assertReachable` the destination gets would be refused here against a
   * bucket that is present and readable — and refused naming the destination's
   * account, which reads as the wrong bucket rather than as the wrong call.
   * Nothing is lost by leaving it out: a promotion has no build to fail ahead
   * of, and a bucket that really is unreachable fails this listing instead,
   * with what the service said.
   */
  const source = destinationFor({ config: config as never, stage: from, prefix, names: [], run, home: cloud })
  const names = source.staged().sort()
  if (names.length === 0) {
    throw new RunnerBuildError(`${source.address}/ holds nothing; ${from} has no runner staged for ${tag}`)
  }
  const archive = names.find((name) => name.endsWith('.tar.gz'))
  if (!archive || !names.includes(`${archive}.sha256`) || names.length !== 2) {
    throw new RunnerBuildError(
      `${source.address}/ holds ${names.join(', ')}, which is not a tarball and its manifest. ` +
        'A promotion copies exactly what a publication wrote.',
    )
  }

  const destination = destinationFor({ config: config as never, stage: to, prefix, names, run, home: cloud })
  destination.assertReachable()
  if (destination.publishedAlready() === 'complete') {
    log(`${destination.address}/ already holds ${archive}; leaving it untouched`)
    log(`RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=${tag} npm run mdeploy -- --stage ${to}`)
    return 0
  }

  /*
   * Checked absent above rather than refused by the write, which is where this
   * differs from a publication: `put` carries `--if-none-match '*'` and a
   * server-side copy has no such precondition to offer. What stands in for it
   * is that one stage takes one promotion at a time — the workflow holds a
   * concurrency group per stage, and a second copy of the same commit would in
   * any case write the same bytes it read.
   */
  for (const name of names) {
    log(`==> copying ${name}`)
    destination.copyFrom(source.address, name)
  }
  log(`promoted ${archive} from ${from} to ${to} at ${destination.address}/`)
  log(`RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=${tag} npm run mdeploy -- --stage ${to}`)
  return 0
}
