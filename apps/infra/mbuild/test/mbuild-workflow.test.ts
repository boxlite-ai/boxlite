import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflow = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mbuild.yml', import.meta.url)),
  'utf8',
)

/** What the job runs, with the commentary that discusses it removed. */
const commands = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

// publish() and promote() log in before they build or pull, and a promotion
// logs into both registries — which a step holding only the target stage could
// not do. A login in the workflow as well would write the same token twice.
test('leaves the registry login to mbuild', () => {
  assert.doesNotMatch(commands, /docker login/)
  assert.doesNotMatch(commands, /get-login-password/)
  assert.doesNotMatch(commands, /configure-docker/)
})

// The path has to come from RUNNER_TEMP, the default runner variable, and not
// from the `runner` context: GitHub offers that context to a step but not to
// an `env` block, where it is rejected as an unrecognized named-value.
test('takes the credential path from the runner variable, not the runner context', () => {
  assert.match(commands, /echo "DOCKER_CONFIG=\$RUNNER_TEMP\/docker" >> "\$GITHUB_ENV"/)
  assert.doesNotMatch(commands, /DOCKER_CONFIG.*\$\{\{\s*runner\./)
})

// GITHUB_ENV reaches the steps after the one that writes it, so the order is
// the whole point: a login in an earlier step would still land in HOME.
test('redirects the credentials before mbuild logs in', () => {
  const redirected = commands.indexOf('DOCKER_CONFIG=$RUNNER_TEMP/docker')
  const publishes = commands.indexOf('mbuild publish')
  const promotes = commands.indexOf('mbuild promote')

  assert.notEqual(redirected, -1, 'the job must say where docker writes its credentials')
  assert.ok(redirected < publishes, 'a publish must log in with the credentials already redirected')
  assert.ok(redirected < promotes, 'so must a promotion')
})

/*
 * The retry loop skips the one failure that is not transient.
 *
 * `mbuild publish` exits 78 when the image scan refuses a commit, and that
 * answer does not change on a second ask — it is about the image's own
 * contents. Retrying it spends three attempts and ninety seconds of backoff
 * re-reading the same findings before reporting them.
 *
 * Asserted against the workflow rather than against a constant, because the
 * shell is where the decision is made and a constant would only agree with
 * itself.
 */
test('a scan refusal stops the retry loop rather than being retried', () => {
  const recognises = commands.indexOf('-eq 78')
  const sleeps = commands.indexOf('sleep $((attempt * 15))')

  assert.notEqual(recognises, -1, 'the publish step has to recognise the scan gate’s own exit code')
  assert.notEqual(sleeps, -1, 'and it still has to back off for the failures that are transient')
  assert.ok(recognises < sleeps, 'the refusal has to be recognised before the backoff, or it is retried anyway')
})

/*
 * A promotion composes two addresses, so it reads two declarations.
 *
 * `promote` resolves the source registry as well as the destination's —
 * `bin/mbuild.ts` asks `regionOf` and `registryFor` for each stage — and on a
 * runner a declaration only exists once something has carried it in. The job is
 * bound to the destination's Environment and cannot read the source's, so both
 * blocks have to be in the one it does read; naming them here is what turns a
 * missing source into a refusal in setup rather than a promotion that resolves
 * the wrong repository.
 */
test('a promotion names both stages, a publish only the one it writes to', () => {
  const setup = /stages: \$\{\{ inputs\.command == 'promote' && format\('\{0\} \{1\}', inputs\.from, inputs\.to\) \|\| inputs\.stage \}\}/
  assert.match(commands, setup)

  const carried = commands.indexOf('setup-infra')
  for (const command of ['mbuild inspect', 'mstage login', 'mbuild publish', 'mbuild promote']) {
    const reader = commands.indexOf(command)
    assert.notEqual(reader, -1, `the job no longer runs ${command}`)
    assert.ok(carried < reader, `${command} reads the declaration before anything carries it in`)
  }
})

/*
 * A publish builds the tree it is standing on.
 *
 * `publish` hands the tag to docker as `REVISION` and builds the working
 * directory (`src/publish.ts`'s `docker build … context`), so the commit a job
 * names decides the tag and nothing else unless the job moves onto it. Publish
 * from main under somebody else's SHA and that SHA means main's bytes, for
 * good: the registry's tags are immutable and a burned one cannot be replaced.
 */
test('a publish moves onto the commit it tags before it installs or builds', () => {
  // The caller's already-resolved SHA, not one this workflow resolved for
  // itself: `mdeploy-all` turns a tag, a commit or a pull request into one
  // commit, and a pull request's merge commit sits on no branch — the branch
  // check this workflow used to make could only have refused it.
  const moved = commands.indexOf('ref: ${{ inputs.tag }}')
  assert.notEqual(moved, -1, 'nothing checks out the commit being published')
  assert.ok(moved < commands.indexOf('setup-infra'), 'the install must come from that commit, not from this ref')
  assert.ok(moved < commands.indexOf('mbuild publish'), 'and so must the build context')

  // A promotion copies a manifest and builds nothing, so it stays where it is —
  // a commit older than this tooling would otherwise leave it with no mbuild.
  const checkout = commands.slice(commands.lastIndexOf('- if:', moved), moved)
  assert.match(checkout, /inputs\.command == 'publish'/)
})

/*
 * Where a promotion's source declaration comes from.
 *
 * `vars` resolves in the environment the job bound to, and each stage's
 * variable carries only that stage's block — so the destination's job cannot
 * read the source's, and `mbuild promote` composes both addresses. A job bound
 * to the source's environment reads it there and hands it over, which keeps one
 * copy of each declaration in the environment that owns it.
 */
test('a promotion reads the source stage in a job bound to its environment', () => {
  const declaration = workflow.slice(workflow.indexOf('  declaration:'), workflow.indexOf('  mbuild:'))
  assert.notEqual(declaration, '', 'nothing reads the source stage at all')
  assert.match(declaration, /environment: \$\{\{ inputs\.from \}\}/, 'it must bind the source environment')
  assert.match(declaration, /inputs\.command == 'promote'/, 'and only a promotion needs it')
  assert.match(declaration, /config: \$\{\{ vars\.BOXLITE_MSTAGE_BOXLITE_APP_CONFIG \}\}/)

  // And the job that promotes takes it, without waiting on it when a publish
  // skipped it — a skipped dependency skips its dependents unless said otherwise.
  assert.match(commands, /stage-config-from: \$\{\{ needs\.declaration\.outputs\.config \}\}/)
  assert.match(commands, /!cancelled\(\) && !failure\(\)/)
})
