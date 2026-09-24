/*
 * The one dispatch, and the only one: `mdeploy-all.yml` is how a stage is
 * rolled out, and `mdeploy.yml` and `mrunner.yml` are gone into it.
 *
 * What it owns is not work but sequence, and the two mistakes a sequence makes
 * are invisible in a diff: a job that changes something before the reads that
 * decide whether it should, and a dependency that skips its dependents when it
 * had nothing to do. Both are asserted here as ordering rather than presence.
 *
 * The third thing it owns is which line a run is on. A commit rollout builds
 * for dev; a release rollout moves the bytes a version was cut from, and is the
 * only thing prod accepts.
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

/** Every job that acts on the answer the plan gave. */
const ACTING = ['release-publish', 'release-promote', 'build-images', 'build-runner', 'deploy']

test('everything that decides is a read, and every read comes first', () => {
  // The plan asks two questions and answers four ways; nothing it runs changes
  // anything, which is what makes it safe to run before the confirm gates below.
  const plan = jobAt('plan')
  assert.match(plan, /mbuild verify/, 'the images are not asked about')
  assert.match(plan, /runner:build -- --stage "\$STAGE" --check/, 'the runner is asked about by building it')
  assert.doesNotMatch(plan, /mbuild publish|mbuild promote|npm run mdeploy/, 'the plan must not change anything')

  for (const job of ACTING) {
    assert.match(jobAt(job), /needs: \[[^\]]*plan[^\]]*\]/, `${job} runs without a plan`)
  }
})

test('the ref is refused before a single Environment is bound', () => {
  /*
   * Every refusal about the ref — a shape that is neither a tag nor a commit, a
   * commit aimed at prod, a tag nobody released — is about this repository's
   * own refs. A job that bound a stage's Environment to ask them would cost an
   * approval before the run could say the input was a typo.
   */
  const resolve = jobAt('resolve')
  assert.doesNotMatch(resolve, /^ {4}environment:/m, 'a typo must not cost an approval to report')
  assert.match(resolve, /gh release view/, 'a tag is taken as a release')
  for (const job of ACTING) {
    assert.match(jobAt(job), /needs: \[[^\]]*resolve[^\]]*\]/, `${job} acts on a ref nothing resolved`)
  }
})

test('each component takes exactly one of the plan’s answers', () => {
  // The three image routes are the same artifact by three means; a component
  // that could take two would publish over what it had just promoted.
  assert.match(jobAt('release-publish'), /needs\.plan\.outputs\.api == 'release-publish'/)
  assert.match(jobAt('release-promote'), /needs\.plan\.outputs\.api == 'release-promote'/)
  assert.match(jobAt('build-images'), /needs\.plan\.outputs\.api == 'build'/)
  assert.match(jobAt('build-runner'), /needs\.plan\.outputs\.runner == 'build'/)
})

test('the release line goes through the workflow that refuses a version twice', () => {
  // `mbuild.yml` skips an artifact already in the registry, which is right for
  // a commit and wrong for a release. Both release routes call the workflow
  // that refuses instead, and the commit route is the only caller of the other.
  assert.match(jobAt('release-publish'), /uses: \.\/\.github\/workflows\/mbuild-release\.yml/)
  assert.match(jobAt('release-promote'), /uses: \.\/\.github\/workflows\/mbuild-release\.yml/)
  assert.match(jobAt('build-images'), /uses: \.\/\.github\/workflows\/mbuild\.yml/)
  // And each is handed the version it is about, plus the commit this run
  // already resolved it to — mbuild-release compares the two rather than
  // resolving the tag a second time and hoping they agree.
  for (const job of ['release-publish', 'release-promote']) {
    assert.match(jobAt(job), /tag: \$\{\{ needs\.resolve\.outputs\.version \}\}/, `${job} names no version`)
    assert.match(jobAt(job), /sha: \$\{\{ needs\.resolve\.outputs\.sha \}\}/, `${job} hands over no commit to agree on`)
  }
})

test('a registry that could not be read is not a stage holding nothing', () => {
  /*
   * `plan` decides between skipping and building on one question: does this
   * stage already hold these images. `mbuild verify` fails both for "it does
   * not" and for a read that never landed — a deploy identity missing a
   * registry grant is the one this repository has actually hit — and the two
   * answers decide opposite things. Taken alike, a denied read spends a build
   * job and its stage's approval on a question nobody answered: `mbuild.yml`'s
   * publish asks again and either skips what it finds or throws naming the
   * same unreadable registry, an hour later and one approval in.
   *
   * The code comes from the CLI that exits with it, not from a literal here.
   */
  const cli = readFileSync(fileURLToPath(new URL('../../mbuild/bin/mbuild.ts', import.meta.url)), 'utf8')
  const absent = cli.match(/^const NOT_PUBLISHED_EXIT = (\d+)$/m)?.[1]
  assert.ok(absent, 'the CLI declares no exit code of its own for absence')

  const plan = jobAt('plan')
  assert.match(plan, /mbuild verify -- --tag "\$IMAGE_TAG" --stage "\$STAGE" \|\| held=\$\?/, 'the status is thrown away')
  assert.match(plan, new RegExp(`elif \\[ "\\$held" -ne ${absent} \\]; then`), 'absence is not told apart')
  assert.match(plan, /::error title=registry::/, 'a read that never landed decides the plan silently')
})

test('a pull request is a third ref shape, told apart in the one place that classifies', () => {
  /*
   * `classify` is where a run learns what it is about; every job below reads a
   * decision rather than re-parsing the input. A bare number cannot collide
   * with `v<X.Y.Z>` or with 40 hex characters, so the third shape costs one
   * branch there and nothing anywhere else.
   */
  const resolve = jobAt('resolve')
  // `#` and digits, the way GitHub writes a pull request. A bare number would
  // be a valid abbreviated SHA somewhere, so the sigil is what keeps the
  // operator's intent explicit instead of letting the shape guess it.
  assert.match(resolve, /\[\[ "\$candidate" =~ \^#\[1-9\]\[0-9\]\*\$ \]\]/, 'a pull request is not recognised')
  assert.match(resolve, /pr="\$\{candidate#\\#\}"/, 'the sigil reaches the API call')
  assert.match(resolve, /printf 'pr=%s\\n' "\$pr"/, 'the decision does not leave classify')
  // And the refusal names all three, so an operator who typed a branch name
  // learns what the field does take.
  assert.match(resolve, /is none of a release tag[^\n]*pull request \(#<number>\)[^\n]*commit SHA/)
})

test('a pull request resolves to the commit it would merge, never its head', () => {
  /*
   * `refs/pull/N/merge` is the request's own base plus the request, which is
   * the tree that would land. A head is the same work missing whatever its
   * base gained since it was branched.
   *
   * Asked by number rather than by SHA because the API cannot name the pull
   * request a fork's head belongs to — a SHA-first lookup can never accept a
   * fork.
   */
  const resolve = jobAt('resolve')
  assert.match(resolve, /gh pr view "\$PR"/, 'the pull request is not read from the API')
  // The variable the output is written from, not merely the presence of the
  // field somewhere above it: `$head` is read in this step too, so a slice
  // taken after the printf would stay green while the printf published it.
  const published = resolve.match(/printf 'sha=%s\\n' "\$\{?(\w+)\}?"/)
  assert.ok(published, 'nothing writes the resolved commit to an output')
  assert.equal(published[1], 'sha', `the output is written from $${published[1]}, not the merge commit`)
  assert.match(resolve, /sha="\$\(jq -r '\.potentialMergeCommit\.oid \/\/ empty' <<<"\$pr_json"\)"/)
  assert.match(resolve, /head="\$\(jq -r '\.headRefOid'/, 'the head is not read, so this test guards nothing')
  // Three refusals, each naming what the operator has to do about it.
  for (const refused of [
    /is \$state, not open/,
    /conflicts with its base/,
    /has no merge commit this run can trust/,
  ]) {
    assert.match(resolve, refused, `a pull request is accepted where it should be refused: ${refused}`)
  }
  // UNKNOWN is a "not yet", not a verdict: GitHub computes it lazily and there
  // is no event to await, so this is the one place a poll is right.
  assert.match(resolve, /for attempt in 1 2 3 4 5/)
})

test('the pull request that gets deployed is the one the poll ended on', () => {
  /*
   * The loop refreshes the response, so every field the verdict rests on has
   * to be read from the refreshed one. A `state` read once above the loop
   * describes a pull request that may have been closed in the twenty seconds
   * since, and a closed request is not one to roll out.
   *
   * The other half is the verdict itself. `mergeable` comes back UNKNOWN
   * beside a `potentialMergeCommit` computed before the last push, so
   * "anything but CONFLICTING" accepts a merge of a tree neither side of the
   * request has — the positive answer is the only one worth deploying.
   */
  const resolve = jobAt('resolve')
  const polls = resolve.indexOf('for attempt in 1 2 3 4 5')
  assert.notEqual(polls, -1, 'nothing polls, so there is no refreshed response to read')
  for (const field of ['state', 'mergeable', 'sha']) {
    const read = resolve.indexOf(`${field}="$(jq -r`)
    assert.notEqual(read, -1, `${field} is never read from the response`)
    assert.ok(read > polls, `${field} is read above the poll, so the verdict is about the first response`)
  }
  assert.match(
    resolve,
    /if \[ "\$mergeable" != 'MERGEABLE' \] \|\| \[ -z "\$sha" \]; then/,
    'a merge commit is deployed without the answer that it merges cleanly',
  )
  const verdict = resolve.indexOf("!= 'MERGEABLE'")
  assert.ok(verdict < resolve.indexOf("printf 'sha=%s"), 'the commit is published before it is judged')
})

test('the branch check is replaced for a pull request, not skipped', () => {
  /*
   * A merge commit sits on no branch, so `--is-ancestor` could only ever
   * refuse it. What stands in its place is stronger for this purpose: the pull
   * request is open now and merges cleanly, and GitHub recomputes the ref
   * whenever either side moves.
   *
   * The two resolutions are mutually exclusive, and exactly one output feeds
   * every job below — a second source of "which commit" is what the whole
   * resolve-once rule exists to prevent.
   */
  const resolve = jobAt('resolve')
  assert.match(resolve, /if: steps\.classify\.outputs\.pr == ''\n\s*uses: \.\/\.github\/actions\/resolve-ref/)
  assert.match(resolve, /if: steps\.classify\.outputs\.pr != ''/, 'the pull-request resolve is unconditional')
  assert.match(resolve, /sha="\$\{RESOLVED:-\$MERGED\}"/, 'the two resolutions do not converge on one value')
  assert.match(jobAt('resolve'), /sha: \$\{\{ steps\.tag\.outputs\.sha \}\}/, 'the job publishes a different commit')
})

test('a pull request reaches dev and no further', () => {
  // prod's refusal is written on the absence of a version, so it catches a
  // pull request for the same reason it catches a bare commit — one rule, not
  // one per shape.
  const resolve = jobAt('resolve')
  assert.match(resolve, /if \[ "\$STAGE" != 'dev' \] && \[ -z "\$version" \]; then/)
  assert.match(resolve, /rather than a commit or a pull request/)
})

test('reading a pull request is all the extra permission it takes', () => {
  // Read-only, and the only job that uses it binds no Environment — so a
  // mistyped number costs an API call, not an approval.
  /*
   * On the one job that reads the API, not at workflow level. A job-level
   * block replaces the workflow-level one rather than merging with it, so
   * granting it above would hand `pull-requests: read` to `plan`,
   * `build-runner` and `deploy` — the three that bind this stage's
   * Environment and reach its cloud role — none of which declares a block of
   * its own to drop it again.
   */
  const top = workflow.slice(workflow.indexOf('\npermissions:\n') + 1)
  assert.doesNotMatch(top.slice(0, top.search(/\n[a-z]/)), /pull-requests/, 'every job would carry it')
  assert.match(jobAt('resolve'), /^ {4}permissions:\n(?: {6}[a-z-]+: [a-z]+\n)* {6}pull-requests: read$/m)
  assert.doesNotMatch(workflow, /pull-requests: write/)
  // And that job binds no Environment, so a mistyped number costs an API call
  // rather than an approval.
  assert.doesNotMatch(jobAt('resolve'), /^ {4}environment:/m)
})

test('prod deploys released versions and refuses a bare commit', () => {
  /*
   * The property the release line exists for. Written as a refusal on the
   * absence of a version rather than as a test naming prod, so a stage added to
   * the choice list later has to say for itself that a commit may reach it.
   */
  const classify = jobAt('resolve')
  assert.match(classify, /if \[ "\$STAGE" != 'dev' \] && \[ -z "\$version" \]; then/)
  assert.doesNotMatch(classify, /"\$STAGE" = 'prod'/, 'a deny-list on prod admits the next stage silently')
  // And the plan routes dev to the cut and everything else to the move.
  assert.match(jobAt('plan'), /\[ "\$STAGE" = 'dev' \] && echo release-publish \|\| echo release-promote/)
})

test('an image address carries the version when there is one', () => {
  // A release build and a commit build of one commit are different bytes, so
  // they are different addresses; prod can be narrowed to the release line only
  // because of that. Composed once, in the job that resolved the ref.
  assert.match(jobAt('resolve'), /printf 'image=%s\\n' "\$\{VERSION:\+\$\{VERSION\}-\}\$\{sha\}"/)
  assert.match(jobAt('plan'), /mbuild verify -- --tag "\$IMAGE_TAG"/, 'the plan asks about a different address')
  assert.match(jobAt('deploy'), /BOXLITE_IMAGE_TAG=%s\\n' "\$IMAGE_TAG"/, 'the apply installs a different address')
})

test('a stage that already holds everything still deploys', () => {
  /*
   * The whole point of the plan: when nothing has to be built, every artifact
   * job is skipped — and a skipped dependency skips its dependents unless the
   * condition says otherwise. Without this the common case, redeploying a ref a
   * stage already holds, would silently do nothing.
   */
  const deploy = jobAt('deploy')
  for (const job of ACTING.filter((name) => name !== 'deploy')) {
    assert.match(deploy, new RegExp(`needs: \\[[^\\]]*${job}[^\\]]*\\]`), `the deploy does not wait for ${job}`)
  }
  assert.match(deploy, /!cancelled\(\) && !failure\(\)/, 'a skipped artifact job would skip the deploy')
})
