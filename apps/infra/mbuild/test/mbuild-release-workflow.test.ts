import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const source = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mbuild-release.yml', import.meta.url)),
  'utf8',
)

const workflow = load(source) as any

/** What the jobs run, with the commentary that discusses it removed. */
const commands = source
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

/** The two jobs that reach a registry. `resolve` and `source` reach none. */
const acting = ['publish', 'promote']

/** What a release cut from this tree would carry, and so must be accepted. */
const shippedVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version: string
  }
).version

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** An mbuild manifest declaring one version, as a released commit holds it. */
const manifestFor = (version: string): string =>
  `${JSON.stringify({ name: 'mbuild', version }, undefined, 2)}\n`

/**
 * A commit as a release sees it: whatever mbuild manifest it carries, and one
 * artifact so the step after the guard has something to read.
 *
 * `manifest` absent is a commit from before mbuild existed here at all, which
 * the oldest taggable commits are.
 */
const releasedTree = (manifest?: string): { directory: string; sha: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'mbuild-release-'))
  mkdirSync(join(directory, 'apps/infra'), { recursive: true })
  writeFileSync(join(directory, 'apps/infra/mstage.env.json'), '{"artifacts":{"api":{}}}\n')
  if (manifest !== undefined) {
    mkdirSync(join(directory, 'apps/infra/mbuild'), { recursive: true })
    writeFileSync(join(directory, 'apps/infra/mbuild/package.json'), manifest)
  }
  git(directory, 'init', '--quiet')
  git(directory, 'add', '.')
  git(
    directory,
    '-c',
    'user.name=mbuild test',
    '-c',
    'user.email=mbuild@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--message=fixture',
  )
  return { directory, sha: git(directory, 'rev-parse', 'HEAD') }
}

/**
 * Run the real resolver shell after the tag has become a commit.
 *
 * Conditional steps belong to the reusable-workflow caller agreement, so a
 * direct dispatch does not run them. Everything else must succeed before the
 * resolver can hand artifacts to a job that binds an Environment and logs in.
 */
const resolveReleasedTree = ({ directory, sha }: { directory: string; sha: string }) => {
  const steps = workflow.jobs.resolve.steps as any[]
  const start = steps.findIndex((step) => step.id === 'ref') + 1
  const end = steps.findIndex((step) => step.id === 'artifacts') + 1
  assert.ok(start > 0 && end >= start, 'resolve has no post-ref artifact path')

  const output = join(directory, 'github-output')
  writeFileSync(output, '')
  let stdout = ''
  let stderr = ''
  for (const step of steps.slice(start, end).filter((candidate) => candidate.run && !candidate.if)) {
    const stepEnvironment = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([name, value]) => [name, String(value)]),
    )
    const result = spawnSync('/usr/bin/env', ['bash', '-c', String(step.run)], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...stepEnvironment,
        GITHUB_OUTPUT: output,
        SHA: sha,
        TAG: 'v1.2.3',
      },
    })
    stdout += result.stdout
    stderr += result.stderr
    if (result.status !== 0) return { status: result.status, stdout, stderr }
  }
  return { status: 0, stdout, stderr }
}

test('a release runs from main and from nowhere else', () => {
  /*
   * Every other deploy workflow lets dev run off the branch changing it. This
   * one does not: a release is what other stages promote from, so bytes it
   * names have to come from a branch this repository will keep producing. An
   * allow-list for dev here would be the escape, so the guard must carry no
   * stage name at all.
   */
  for (const [name, job] of Object.entries<any>(workflow.jobs)) {
    const guard = String(job.if ?? '')
    assert.match(guard, /github\.ref == 'refs\/heads\/main'/, `job '${name}' is not restricted to main`)
    assert.doesNotMatch(guard, /== 'dev'/, `job '${name}' lets dev leave main, which a release line must not`)
  }
})

test('the run title names the command and the version', () => {
  // An Actions list of four `mbuild-release` rows says nothing about which one
  // moved prod. Both halves have to be in the title the list renders.
  assert.ok(workflow['run-name'], 'the workflow sets no run-name')
  assert.match(workflow['run-name'], /publish/)
  assert.match(workflow['run-name'], /promote/)
  assert.match(workflow['run-name'], /inputs\.tag/)
})

test('the version is refused before a registry is asked about it', () => {
  /*
   * Three refusals, all in `resolve`, all before any Environment is bound: a
   * commit SHA (this workflow releases a tagged version), anything that is not
   * a stable X.Y.Z, and a version nobody tagged. The tag is checked under
   * `refs/tags/` rather than by bare name, because `git rev-parse v1.2.3`
   * answers for a branch of that name too.
   */
  const resolve = workflow.jobs.resolve
  assert.equal(resolve.environment, undefined, 'a typo must not cost an approval to report')
  const step = resolve.steps.find((one: any) => /^\s*set -Eeuo/.test(String(one.run ?? '')) && /TAG/.test(String(one.run)))
  assert.ok(step, 'resolve validates no version')
  assert.match(step.run, /looks like a commit/, 'a commit SHA is not refused by name')
  // `v` and a stable X.Y.Z — the shape this repository's tags actually carry,
  // and the one mbuild's RELEASE_VERSION accepts, so what passes the workflow
  // is what `--version` will take.
  assert.match(step.run, /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/)
  assert.match(step.run, /refs\/tags\/\$\{TAG\}/, 'the tag is not required under refs/tags/')
  assert.match(step.run, /git rev-parse --verify --quiet/, 'the tag existence is not proved')
})

test('every job that binds an Environment waits for resolve first', () => {
  // The refusals live in `resolve`, and a job that bound a stage beside it
  // would start that stage's reviewer wait on a tag about to be refused —
  // spending the approval the checks above exist to save. `source` binds dev
  // to read one variable and is the easy one to forget.
  for (const [name, job] of Object.entries(workflow.jobs as Record<string, any>)) {
    if (job.environment === undefined) continue
    assert.ok(
      (job.needs ?? []).includes('resolve'),
      `${name} binds ${job.environment} without waiting for resolve`,
    )
  }
})

test('the commit a version names must be on the branch that dispatched it', () => {
  // resolve-ref's branch check. Without it a tag on a force-pushed branch
  // still resolves and still names bytes.
  const uses = [...source.matchAll(/uses: \.\/\.github\/actions\/resolve-ref\n\s*with:\n((?:\s{10}\S[^\n]*\n)+)/g)]
  assert.equal(uses.length, 1, 'a version becomes a commit in exactly one place')
  assert.match(uses[0]![1]!, /branch: \$\{\{ github\.ref_name \}\}/)
})

test('a release refuses a commit whose mbuild ignores the flags it will be given', (context) => {
  // 0.0.1 is what every commit before those flags existed actually carries,
  // and such an mbuild takes them as unknown and publishes commit images at
  // the commit address while reporting success.
  const released = releasedTree(manifestFor('0.0.1'))
  context.after(() => rmSync(released.directory, { recursive: true, force: true }))

  const result = resolveReleasedTree(released)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1, `mbuild 0.0.1 was not refused with the gate's own status:\n${output}`)
  // The refusal names the version it read and what that version cannot do, so
  // an operator reads why the tag was refused rather than that it was.
  assert.match(output, /mbuild 0\.0\.1/)
  assert.match(output, /--artifact and --version/)
})

test('a release refuses the mbuild that came before the answer its gates read', (context) => {
  /*
   * 0.1.0 takes `--artifact` and `--version` and would build the right
   * images, but it does not say how it answers an artifact the registry
   * plainly does not hold: exit 66 landed under that same version, so some
   * 0.1.0 commits exit 66 and the earlier ones exit 1. The gates continue
   * only on 66, and would stop on "could not tell whether dev holds it"
   * against a registry that answered.
   *
   * A version that cannot be told apart is refused whichever it carries.
   * 0.1.1 is the first that declares the answer.
   */
  const released = releasedTree(manifestFor('0.1.0'))
  context.after(() => rmSync(released.directory, { recursive: true, force: true }))

  const result = resolveReleasedTree(released)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1, `mbuild 0.1.0 was not refused with the gate's own status:\n${output}`)
  assert.match(output, /mbuild 0\.1\.0/)
  assert.match(output, /exit 66/)
})

test('a release refuses a commit from before mbuild existed here', (context) => {
  const released = releasedTree()
  context.after(() => rmSync(released.directory, { recursive: true, force: true }))

  const result = resolveReleasedTree(released)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1, `a commit with no mbuild was not refused with the gate's own status:\n${output}`)
  assert.match(output, /no readable mbuild version/)
})

test('a manifest that will not parse is refused', (context) => {
  const released = releasedTree('not a manifest\n')
  context.after(() => rmSync(released.directory, { recursive: true, force: true }))

  const result = resolveReleasedTree(released)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1, `an unparseable manifest was not refused with the gate's own status:\n${output}`)
  assert.match(output, /no readable mbuild version/)
})

test('a version out of the manifest cannot talk to Actions on the way to the log', (context) => {
  // A declared version is a string out of an arbitrary commit, and it lands in
  // a log where `::` at the start of a line is a command to Actions. Refusing
  // it is not enough — the refusal has to be able to say what it read without
  // the manifest getting a turn.
  const released = releasedTree(manifestFor('1.0\n::error title=crafted::from the manifest'))
  context.after(() => rmSync(released.directory, { recursive: true, force: true }))

  const result = resolveReleasedTree(released)
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(result.status, 1, `a crafted version was not refused with the gate's own status:\n${output}`)
  assert.doesNotMatch(output, /^::error title=crafted/m)
})

test('a release accepts a commit carrying the mbuild this repository ships', (context) => {
  // The version on disk rather than a literal: this is also what refuses a
  // minimum raised past what main can actually cut a release from.
  const released = releasedTree(manifestFor(shippedVersion))
  context.after(() => rmSync(released.directory, { recursive: true, force: true }))

  const result = resolveReleasedTree(released)
  assert.equal(result.status, 0, `mbuild ${shippedVersion} was refused:\n${result.stdout}\n${result.stderr}`)
})

test('every artifact gets its own job, from the declaration that release carries', () => {
  // Read out of the release rather than out of main's tip: a release that
  // predates a third image should not be asked to build one.
  assert.match(commands, /git show "\$\{SHA\}:apps\/infra\/mstage\.env\.json"/)
  for (const name of acting) {
    assert.deepEqual(
      workflow.jobs[name].strategy?.matrix?.artifact,
      '${{ fromJSON(needs.resolve.outputs.artifacts) }}',
      `job '${name}' does not fan out over the declared artifacts`,
    )
    assert.equal(
      workflow.jobs[name].strategy['fail-fast'],
      false,
      `job '${name}' cancels its siblings, which leaves a partial release harder to read than three outcomes`,
    )
  }
})

test('a version already in the registry is refused rather than skipped', () => {
  /*
   * The reason this file exists beside mbuild.yml. `publish` and `promote`
   * both skip an artifact that is already there and report success, which is
   * right for a commit and wrong for a release: a dispatcher naming last
   * month's version would be told it worked.
   *
   * Per artifact, not per stage, so a half-published release names the half
   * that landed instead of resolving to one answer about the set.
   */
  const gates = [
    ...commands.matchAll(/mbuild verify -- ([^\n]+) \|\| held=\$\?\n\s*if \[ "\$held" -eq 0 \]; then\n(\s*echo[^\n]+)/g),
  ]
  assert.equal(gates.length, 2, 'one refusal per command, before it acts')
  for (const [, invocation, refusal] of gates) {
    assert.match(invocation!, /--artifact "\$ARTIFACT"/, `the gate asks about the set, not the artifact: ${invocation}`)
    assert.match(invocation!, /--version "\$TAG"/, `the gate asks about the commit build: ${invocation}`)
    assert.match(refusal!, /::error title=already (published|promoted)::/, 'a hit does not report an error')
  }
  // And the refusals actually stop the job rather than warn.
  assert.equal((commands.match(/::error title=already (published|promoted)::/g) ?? []).length, 2)
  assert.equal((commands.match(/--allow-overwrite|--force/g) ?? []).length, 0, 'nothing here can overwrite')
})

test('a promotion also proves the source holds what it is about to move', () => {
  // mbuild refuses this itself, but only after logging into both registries;
  // asking here names the version rather than the address.
  const source = commands.match(
    /mbuild verify -- ([^\n]+) \|\| held=\$\?\n\s*if \[ "\$held" -eq 66 \]; then\n\s*echo "::error title=not published::/,
  )
  assert.ok(source, 'nothing proves dev holds the artifact the promotion is about to move')
  assert.match(source[1]!, /--tag "\$SHA" --stage dev --artifact "\$ARTIFACT" --version "\$TAG"/)
})

test('a registry that could not be read is not a registry that is empty', () => {
  /*
   * `mbuild verify` fails for two reasons a shell has to tell apart: the
   * registry answered and the artifact is not there, or the read itself never
   * landed — a denied token, an expired federation, an unreachable endpoint.
   * `publish.ts` keeps them apart and `bin/mbuild.ts` carries the difference
   * out as an exit code; a gate that only asks "did it fail" throws that away
   * and takes an unreadable registry for a free slot, which is the refusal
   * gone: `publish` skips what it finds and the run reports it as done.
   *
   * The code is read from the CLI rather than written here, because a literal
   * in a test only ever agrees with itself.
   */
  const cli = readFileSync(fileURLToPath(new URL('../bin/mbuild.ts', import.meta.url)), 'utf8')
  const absent = cli.match(/^const NOT_PUBLISHED_EXIT = (\d+)$/m)?.[1]
  assert.ok(absent, 'the CLI declares no exit code of its own for absence')

  const kept = commands.match(/mbuild verify -- [^\n]*\|\| held=\$\?/g) ?? []
  assert.equal(kept.length, 3, `every verify gate has to keep the status, not a true/false: saw ${kept.length}`)
  assert.equal(
    (commands.match(/if npm run --silent mbuild verify/g) ?? []).length,
    0,
    'a gate that branches on success alone cannot tell absence from a denied read',
  )

  const asked = commands.match(/\[ "\$held" -(?:eq|ne) \d+ \]/g) ?? []
  assert.equal(asked.length, 6, `three gates, each telling apart three answers: saw ${asked.join(', ')}`)
  for (const question of asked) {
    const known = new RegExp(`-(?:eq|ne) (?:0|${absent}) `)
    assert.match(question, known, `${question} branches on a status nothing exits with`)
  }
  assert.equal(
    (commands.match(/::error title=registry::/g) ?? []).length,
    3,
    'a gate that cannot read the registry has to say so and stop',
  )
})

test('every registry command addresses the release line', () => {
  // A release that published under the commit tag would collide with whatever
  // the deploy path already put there, and prod could never be narrowed to it.
  // Five, exactly: publish's gate and its build; promote's two gates and its
  // move. The exact count rather than a floor, for the reason the sweeps in
  // release-safety.test.ts use one — a call that stops matching this pattern
  // is the drop worth catching, and one that appears is a registry command
  // nobody reviewed.
  const invocations = [...commands.matchAll(/npm run --silent mbuild (publish|promote|verify) -- ([^\n;&]+)/g)]
  assert.equal(invocations.length, 5, `expected every mbuild call swept, saw ${invocations.length}`)
  for (const [, command, flags] of invocations) {
    assert.match(flags!, /--version "\$TAG"/, `${command} addresses the commit build: ${flags}`)
    assert.match(flags!, /--artifact "\$ARTIFACT"/, `${command} is not narrowed to one artifact: ${flags}`)
  }
})

test('the release queues against the commit publisher rather than racing it', () => {
  // A group is one namespace for the repository, so sharing mbuild.yml's names
  // is what makes the two queue instead of pushing one immutable tag at once.
  assert.match(workflow.concurrency.group, /^mbuild-\$\{\{ inputs\.command \}\}-/)
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})

test('the registry login belongs to mbuild, and the token stays out of HOME', () => {
  // Same two properties mbuild.yml holds: publish and promote log in before
  // they build or pull, and a promotion logs into both registries — which a
  // step holding only the target stage could not do.
  assert.doesNotMatch(commands, /docker login/)
  assert.doesNotMatch(commands, /get-login-password/)
  assert.doesNotMatch(commands, /configure-docker/)
  assert.match(commands, /echo "DOCKER_CONFIG=\$RUNNER_TEMP\/docker" >> "\$GITHUB_ENV"/)
})

test('a GCP stage gets the CLI that mbuild reads Artifact Registry through', () => {
  /*
   * `gcloud artifacts repositories describe` is how mbuild answers whether a
   * tag is already there, and `gcloud auth configure-docker` is its login. The
   * federation writes a credential without installing the CLI, so the gates
   * above would report that they could not read and let the publish through.
   */
  const installs = [...commands.matchAll(/uses: google-github-actions\/setup-gcloud@v\d/g)]
  assert.equal(installs.length, acting.length, 'a job that reaches Artifact Registry without the CLI')
  // Installing it is allowed; answering "who am I" a second time is not.
  for (const step of commands.split('setup-gcloud').slice(1)) {
    const inputs = step.slice(0, step.indexOf('\n      - ') >= 0 ? step.indexOf('\n      - ') : undefined)
    assert.doesNotMatch(inputs, /credentials_json|service_account_key|workload_identity_provider|service_account:/)
  }
})

test('the AWS role is composed from the account id, as every other workflow does', () => {
  // A workflow reading `vars.AWS_DEPLOY_ROLE_ARN` would federate against a
  // variable this repository does not define, and the OIDC step would fail on
  // an empty role rather than on a missing setting.
  assert.doesNotMatch(commands, /vars\.AWS_DEPLOY_ROLE_ARN/)

  /*
   * And each job's literal stage is the Environment that job binds. The stage
   * is written out rather than threaded from an input because these two jobs
   * each serve one, which costs the expression's own guarantee that the two
   * agree — a swapped pair passes every other assertion here and fails at STS,
   * with a role name that reads correct.
   */
  for (const [name, job] of Object.entries<any>(workflow.jobs)) {
    const federation = job.steps?.find((step: any) => /configure-aws-credentials/.test(String(step.uses ?? '')))
    if (!federation) continue
    assert.equal(
      federation.with['role-to-assume'],
      `arn:aws:iam::\${{ vars.AWS_ACCOUNT_ID }}:role/boxlite-${job.environment}-github-deploy`,
      `job '${name}' federates a role that is not its own Environment's`,
    )
  }
})

test('a promotion carries the source declaration from a job that bound its environment', () => {
  // `vars` resolves in the environment a job binds to, so dev's block can only
  // reach prod's job as an output. One job for it, not one per artifact: the
  // declaration belongs to the stage, not to the image.
  assert.equal(workflow.jobs.source.environment, 'dev')
  assert.equal(workflow.jobs.source.strategy, undefined)
  assert.ok(workflow.jobs.promote.needs.includes('source'))
  assert.match(commands, /stage-config-from: \$\{\{ needs\.source\.outputs\.config \}\}/)
})
