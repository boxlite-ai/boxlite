/*
 * The one dispatch that orders the other three.
 *
 * What it owns is not work but sequence, and the two mistakes a sequence makes
 * are invisible in a diff: a job that changes something before the reads that
 * decide whether it should, and a dependency that skips its dependents when it
 * had nothing to do. Both are asserted here as ordering rather than presence.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflow = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url)),
  'utf8',
)

/** What the jobs run, with the commentary that discusses them removed. */
const commands = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const jobAt = (name: string) => {
  const start = commands.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `there is no ${name} job`)
  const rest = commands.slice(start + 1)
  const next = rest.search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

test('everything that decides is a read, and every read comes first', () => {
  // The plan asks two questions and answers three ways; nothing it runs changes
  // anything, which is what makes it safe to run before the confirm gates below.
  const plan = jobAt('plan')
  assert.match(plan, /mbuild verify/, 'the images are not asked about')
  assert.match(plan, /runner:build -- --stage "\$STAGE" --check/, 'the runner is asked about by building it')
  assert.doesNotMatch(plan, /mbuild publish|mbuild promote|npm run mdeploy/, 'the plan must not change anything')

  for (const job of ['promote-api', 'build-api', 'build-runner', 'deploy']) {
    assert.match(jobAt(job), /needs: \[[^\]]*plan[^\]]*\]/, `${job} runs without a plan`)
  }
})

test('each component takes exactly one of the three answers', () => {
  // `promote` and `build` are the same artifact by two routes; a component that
  // could take both would publish over what it had just promoted.
  assert.match(jobAt('promote-api'), /needs\.plan\.outputs\.api == 'promote'/)
  assert.match(jobAt('build-api'), /needs\.plan\.outputs\.api == 'build'/)
  assert.match(jobAt('build-runner'), /needs\.plan\.outputs\.runner == 'build'/)
  assert.match(jobAt('promote-runner'), /needs\.plan\.outputs\.runner == 'promote'/)
})

test('a stage that already holds everything still deploys', () => {
  /*
   * The whole point of the plan: when nothing has to be built, every artifact
   * job is skipped — and a skipped dependency skips its dependents unless the
   * condition says otherwise. Without this the common case, redeploying a
   * commit a stage already holds, would silently do nothing.
   */
  const deploy = jobAt('deploy')
  assert.match(deploy, /needs: \[[^\]]*promote-api[^\]]*build-api[^\]]*promote-runner[^\]]*build-runner[^\]]*\]/)
  assert.match(deploy, /!cancelled\(\) && !failure\(\)/, 'a skipped artifact job would skip the deploy')
})

test('a staged runner is installed only when this run was about the runner', () => {
  // `runner_ref` switches the deploy into build mode for the fleet. Passing it
  // for an api-only run would install a staged binary over the release a stage
  // deliberately sits on.
  assert.match(jobAt('deploy'), /runner_ref: \$\{\{ contains\(inputs\.components, 'runner'\) && needs\.ref\.outputs\.sha \|\| '' \}\}/)
})

test('the source stage is read where its declaration and its identity live', () => {
  /*
   * `vars` resolves in the environment a job binds to, and so does the cloud
   * role behind it — so "does dev hold this commit" can only be asked by a job
   * bound to dev. The answer travels on as an output; nothing else in the run
   * can reach that stage.
   */
  const source = jobAt('source')
  assert.match(source, /environment: \$\{\{ inputs\.auto_promote_from \}\}/)
  assert.match(source, /inputs\.auto_promote_from != 'none'/, 'promotion must be switchable off')
  assert.match(source, /inputs\.auto_promote_from != inputs\.stage/, 'a stage cannot promote from itself')
  assert.match(source, /mbuild verify/, 'it must actually ask')
  assert.match(jobAt('plan'), /SOURCE_IMAGES: \$\{\{ needs\.source\.outputs\.images \}\}/)
  assert.match(jobAt('plan'), /SOURCE_RUNNER: \$\{\{ needs\.source\.outputs\.runner \}\}/)
  // Both artifacts, because both can be promoted — the runner's bytes are the
  // half a rebuild would not reproduce.
  assert.match(source, /runner:build -- --stage "\$\{\{ inputs\.auto_promote_from \}\}" --check/)
})
