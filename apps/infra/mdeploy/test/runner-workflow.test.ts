/*
 * The runner leg of `mdeploy-all.yml`, held against what the tools actually
 * demand of the machine they run on.
 *
 * There are two legs now, and which one runs is decided by the ref. A commit
 * rollout compiles the binary and stages it in the stage's bucket, and three of
 * `runner:build`'s demands are invisible in its own tests: the tree has to be
 * the commit being staged, its submodules have to be there, and on GCP the
 * upload goes through a CLI nothing else here installs. A release rollout
 * compiles nothing — `stack/runner-binary.ts` downloads the tarball the GitHub
 * Release already carries — so the whole job is skipped.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const source = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url)),
  'utf8',
)

const workflow = load(source) as any

/** The job that compiles and stages one, with its commentary removed. */
const staging = (() => {
  const start = source.indexOf('\n  build-runner:')
  assert.notEqual(start, -1, 'mdeploy-all no longer stages a runner binary')
  const rest = source.slice(start + 1)
  const end = rest.search(/\n {2}[a-z-]+:\n/)
  return rest
    .slice(0, end === -1 ? undefined : end)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
})()

test('it stages the commit it was given, with the submodules that commit names', () => {
  // `inspectCheckout` refuses a tree whose submodules are missing or ahead: a
  // commit-keyed object that held anything else would claim bytes that commit
  // does not produce, and nothing downstream could tell.
  const moved = staging.indexOf('ref: ${{ needs.resolve.outputs.sha }}')
  assert.notEqual(moved, -1, 'nothing checks out the commit being staged')
  assert.match(staging.slice(moved, moved + 200), /submodules: recursive/)
  assert.ok(moved < staging.indexOf('runner:build'), 'the build must come from that commit')
})

test('the GCP path installs the CLI the upload goes through', () => {
  // `gcpDestination` reaches Cloud Storage with `gcloud storage`, and
  // `google-github-actions/auth` writes a credential without installing one.
  // The failure without this is at the upload, after the build has been paid.
  const install = staging.indexOf('setup-gcloud')
  assert.notEqual(install, -1, 'a GCP stage cannot upload without it')
  assert.ok(install < staging.indexOf('runner:build'), 'and it has to be there before the build')
  assert.match(
    staging.slice(staging.lastIndexOf('- name:', install), install),
    /artifact-registry/,
    'only the cloud that needs it',
  )
})

test('staging is not retried, because neither of its failures is transient', () => {
  // The destination is proved reachable before anything is compiled, so what is
  // left is the build itself and a refusal about what the bucket already holds.
  const start = staging.indexOf('- name: Build the runner')
  assert.notEqual(start, -1, 'the step this is about is not in the workflow')
  assert.doesNotMatch(staging.slice(start), /for attempt in/)
})

test('a release rollout compiles no runner at all', () => {
  /*
   * The property the release line exists for. `runnerArtifactFor` addresses
   * `boxlite-runner-v<X.Y.Z>-linux-amd64.tar.gz` on the GitHub Release, which
   * is the artifact the release was cut from; rebuilding that commit would
   * produce different bytes under the same version, because gzip alone stamps
   * an mtime into the tarball.
   */
  assert.match(
    String(workflow.jobs['build-runner'].if),
    /needs\.plan\.outputs\.runner == 'build'/,
    'the staging job runs on something other than the plan saying build',
  )
  const plan = source.slice(source.indexOf('- name: Decide'))
  assert.match(
    plan.slice(0, plan.indexOf('printf')),
    /if \[ -n "\$VERSION" \]; then\n(?:[^\n]*\n)*?\s*echo "\$VERSION installs the runner tarball from its GitHub Release"/,
    'the plan compiles a runner for a released version',
  )
})

test('the deploy names which of the two artifacts the stack installs', () => {
  // `selectRunnerBinary` defaults to `release` and reads `VERSION`, stripping
  // the leading v itself. Both modes are written explicitly so the run says
  // which one it is rather than leaving it to an absent variable.
  const addressing = source.slice(source.indexOf('- name: Address what this deploy installs'))
  assert.match(addressing, /source=release/)
  assert.match(addressing, /printf 'VERSION=%s\\n' "\$VERSION"/)
  assert.match(addressing, /source=build/)
  assert.match(addressing, /printf 'RUNNER_ARTIFACT_REF=%s\\n' "\$SHA"/)
})

test('a run that was not about the runner never installs one this run did not stage', () => {
  /*
   * `plan` leaves the runner alone for `components: api`, so build mode there
   * addresses `runner/<sha>/` in a bucket nothing wrote to. `runnerArtifactFor`
   * composes that address without asking whether it exists, so the apply
   * reports success and the host 404s at boot — the same failure the release
   * gate above exists to stop, on the other line.
   *
   * The old shape passed `runner_ref` only when the components named the
   * runner, and the workflow it called turned an empty one into release mode;
   * the components test has to survive the two becoming one job.
   */
  const addressing = source.slice(
    source.indexOf('- name: Address what this deploy installs'),
    source.indexOf('- name: Resolve the stage', source.indexOf('- name: Address what this deploy installs')),
  )
  assert.match(addressing, /COMPONENTS: \$\{\{ inputs\.components \}\}/, 'the step cannot see what this run was about')
  assert.match(
    addressing,
    /case "\$COMPONENTS" in\n\s*\*runner\*\)[^\n]*source=build/,
    'build mode is entered without asking whether this run staged a binary',
  )
  // And the plan it has to agree with: the same membership test decides
  // whether anything is staged at all.
  const plan = source.slice(source.indexOf('- name: Decide'))
  assert.match(plan.slice(0, plan.indexOf('printf')), /case "\$COMPONENTS" in\n\s*\*runner\*\)/)
})

test('a release is refused unless the tarball it will install is already attached', () => {
  /*
   * A git tag is not a release, and a release whose runner build has not
   * finished carries no tarball. Either way the download 404s on the host at
   * boot — long after the apply reported success — so both are asked for here,
   * where the answer costs one API read.
   *
   * The names are the publisher's: `build-runner-binary.yml` uploads exactly
   * these and `runnerArtifactFor` composes them, so a third spelling here would
   * pass against assets nothing installs.
   */
  const gate = source.slice(
    source.indexOf('- name: Require the release this tag names'),
    source.indexOf('- id: ref', source.indexOf('- name: Require the release this tag names')),
  )
  assert.match(gate, /gh release view "\$VERSION"/, 'a tag is taken as a release')
  assert.match(gate, /isDraft/, 'a draft release is taken as published')
  assert.match(gate, /boxlite-runner-\$\{VERSION\}-linux-amd64\.tar\.gz/)
  assert.match(gate, /"\$\{tarball\}\.sha256"/, 'the checksum is not required')

  /*
   * And asked for every release rollout, not only one whose components name
   * the runner. A version pins the whole stage: the apply exports `VERSION`
   * whatever `components` said, `selectRunnerBinary` prefers it over the
   * workspace version, and the fleet's boot URL becomes this release's
   * tarball. Skipping the check for `components: api` left exactly that
   * address unguarded.
   */
  assert.doesNotMatch(gate, /\$COMPONENTS/, 'the asset check is conditioned on components again')
  const addressing = source.slice(source.indexOf('- name: Address what this deploy installs'))
  assert.match(
    addressing.slice(0, addressing.indexOf('GITHUB_ENV')),
    /elif \[ -n "\$VERSION" \]; then\n\s*(?:#[^\n]*\n\s*)*printf 'VERSION=%s/,
    'the apply no longer exports the version the gate was widened for',
  )
})
