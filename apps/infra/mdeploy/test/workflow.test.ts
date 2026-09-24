/*
 * The deploy workflow, held against what mdeploy actually does.
 *
 * A workflow is the one part of a deploy nothing else typechecks, and the
 * mistakes it makes are the expensive kind: a gate that runs after the thing it
 * was meant to refuse, a retry around an answer that will not change, a cloud
 * named in a place that has to work on both.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { parseBase } from 'mstage/config'
import { variableNameFor } from 'mstage/config-variable'

const workflow = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url)), 'utf8')
const ENV_CONFIG = fileURLToPath(new URL('../../mstage.env.json', import.meta.url))

/** What the workflow runs, with the commentary that discusses it removed. */
const commands = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

test('the cloud is read from the config rather than written into the workflow', () => {
  // Adding a stage on another cloud has to be an edit to mstage.config.json. A
  // registry host, a repository name or a region written here would be a second
  // declaration, and the one that keeps pointing at the old cloud.
  assert.match(commands, /mbuild inspect -- --stage/)
  assert.doesNotMatch(commands, /dkr\.ecr\./)
  assert.doesNotMatch(commands, /docker\.pkg\.dev/)
  assert.doesNotMatch(commands, /ap-southeast-1|asia-southeast1/)
})

test('both clouds can be federated, and each only when it is the one', () => {
  assert.match(workflow, /aws-actions\/configure-aws-credentials/)
  assert.match(workflow, /google-github-actions\/auth/)
  assert.match(workflow, /if: steps\.config\.outputs\.kind == 'ecr'/)
  assert.match(workflow, /if: steps\.config\.outputs\.kind == 'artifact-registry'/)
})

/*
 * Every workflow that federates a GCP identity and then asks mstage about it.
 *
 * `checkGcp` requires both GCP credential stores to mint — ADC, which the SDKs
 * and the Pulumi provider read, and the gcloud CLI's own, which every plain
 * `gcloud` call uses. On a workstation one sign-in writes both. A runner has no
 * sign-in at all, so the only thing that can satisfy the second one is the
 * federation step, and `google-github-actions/auth` is what does:
 * `src/main.ts:197` exports `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` — the
 * gcloud CLI's own credential — from the same block as
 * `GOOGLE_APPLICATION_CREDENTIALS` four lines below, under
 * `create_credentials_file` and `export_environment_variables`, both of which
 * default to `true` in its `action.yml`.
 *
 * That gcloud honours the variable for the credential a runner actually gets
 * was measured, not assumed: with `CLOUDSDK_CONFIG` pointed at an empty
 * directory, `auth print-access-token` reports `You do not currently have an
 * active account selected`, and setting only that variable at an
 * `external_account` file — the workload-identity shape the action writes —
 * takes gcloud all the way to a real STS token exchange. `setup-gcloud` is not
 * part of *that* mechanism — where it appears, it is there for the binary
 * itself, which `runner:build` uploads through and which the DNS-authorization
 * check reads through. What it must never do is supply a second credential:
 * two answers to "who am I" is the one that was resolved last, silently.
 *
 * So what is pinned here is our side of it: the action, and the two inputs that
 * would switch the export off. The action's own comment calls the variable
 * "subject to change", and if it goes, both GCP workflows fail at the preflight
 * with a message about a stale local session on a machine nobody signed in on
 * — far enough from the cause to be worth naming here.
 */
const GCP_FEDERATING_WORKFLOWS = ['mdeploy-all.yml', 'mbuild.yml', 'mbuild-release.yml']

test('a GCP identity is federated by the action that also gives gcloud its own credential', () => {
  for (const name of GCP_FEDERATING_WORKFLOWS) {
    const source = readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
    const runs = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    assert.match(runs, /uses: google-github-actions\/auth@v\d/, `${name} does not federate GCP`)
    assert.match(runs, /npm run --silent mstage login/, `${name} does not ask mstage, so this test is checking nothing`)
    // Installing the CLI is allowed; authenticating it a second time is not.
    for (const step of runs.split('setup-gcloud').slice(1)) {
      const inputs = step.slice(0, step.indexOf('\n      - ') >= 0 ? step.indexOf('\n      - ') : undefined)
      assert.doesNotMatch(
        inputs,
        /credentials_json|service_account_key|workload_identity_provider|service_account:/,
        `${name}: setup-gcloud must install the CLI, not answer "who am I" a second time`,
      )
    }
    // The two inputs that turn the export off. Both default to true, so the
    // only way to lose the CLI credential from here is to ask for it.
    for (const input of ['create_credentials_file', 'export_environment_variables']) {
      assert.doesNotMatch(
        runs,
        new RegExp(`${input}:\\s*'?false'?`),
        `${name} disables ${input}, which is what supplies gcloud its credential`,
      )
    }
  }
})

/*
 * The AWS role is composed, not looked up in a repository variable.
 *
 * Every other deploy workflow here builds it from `vars.AWS_ACCOUNT_ID` and the
 * fixed per-stage role name. A workflow that read `vars.AWS_DEPLOY_ROLE_ARN`
 * instead would federate against a variable this repository does not define —
 * the OIDC step fails with an empty role, which reads as an auth problem rather
 * than as a missing setting.
 *
 * Both new workflows are checked here so the two cannot drift apart.
 */
test('the AWS role is composed from the account id, as every other workflow does', () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
  for (const [name, source] of [
    ['mdeploy-all.yml', workflow],
    ['mbuild.yml', read('mbuild.yml')],
    ['mbuild-release.yml', read('mbuild-release.yml')],
  ] as const) {
    // The stage half may be an expression or a literal — mbuild-release's two
    // jobs each serve one fixed stage, and naming it is clearer there than
    // threading an input through. What must not vary is the rest: the account
    // from `vars.AWS_ACCOUNT_ID`, and the role name bootstrap actually creates.
    assert.match(
      source,
      /role-to-assume: arn:aws:iam::\$\{\{ vars\.AWS_ACCOUNT_ID \}\}:role\/boxlite-(?:\$\{\{ [^}]+ \}\}|[a-z0-9-]+)-github-deploy/,
      `${name} does not compose the role ARN`,
    )
    assert.doesNotMatch(source, /vars\.AWS_DEPLOY_ROLE_ARN|vars\.AWS_ECR_PUSH_ROLE_ARN/, `${name} reads an undefined variable`)
  }
})

test('every gate runs before the apply, because a refusal afterwards is not a gate', () => {
  const digest = commands.indexOf('mstage env digest')
  const images = commands.indexOf('mbuild verify')
  const apply = commands.indexOf('npm run mdeploy -- --stage')
  for (const [name, index] of [
    ['the digest check', digest],
    ['the image check', images],
  ] as const) {
    assert.notEqual(index, -1, `${name} is missing`)
    assert.ok(index < apply, `${name} runs after the apply`)
  }
})

test('the image check comes before anything that changes a shared resource', () => {
  // A deploy dispatched while its commit is still being published used to fail
  // minutes in, on a task that could not pull, after the apply had already
  // created resources.
  assert.ok(commands.indexOf('mbuild verify') < commands.indexOf('npm run mdeploy -- --stage'))
})

test('a read is retried and the apply is not', () => {
  // A run killed mid-apply can leave the per-stage lock held, and the second
  // attempt then fails on the lock rather than on the cause worth reading.
  const session = commands.slice(commands.indexOf('Verify the session'), commands.indexOf('Verify the stage'))
  assert.match(session, /for attempt in 1 2 3/)

  const apply = commands.slice(commands.indexOf('- name: Apply'))
  assert.doesNotMatch(apply, /for attempt in/)
  assert.doesNotMatch(apply, /sst unlock|state unlock -- --stage "\$\{\{/, 'nothing clears the lock automatically')
})

test('the digest and the image check are not retried, because their answer is not transient', () => {
  const between = commands.slice(commands.indexOf('Verify the stage configuration'), commands.indexOf('- name: Confirm'))
  assert.doesNotMatch(between, /for attempt in/)
})

test('a preview is the default and an apply has to be asked for', () => {
  assert.match(workflow, /apply:\n\s+description:[^\n]*\n\s+required: true\n\s+type: boolean\n\s+default: false/)
  assert.match(commands, /--diff/)
})

test('a protected stage is confirmed, and the confirmation reaches mdeploy', () => {
  // Read through mstage's own loader, out of the declaration setup-infra
  // restored. The gate used to `require("./mstage.config.json")` — a filename
  // nothing writes, in a checkout that carries no declaration at all — so it
  // refused every deploy for a reason that had nothing to do with the stage.
  assert.match(commands, /require\('mstage\/config'\)/)
  assert.match(commands, /stageIn\(loadConfig\(\), process\.env\.STAGE\)\.protect/)
  assert.doesNotMatch(commands, /require\("\.\/mstage\.config\.json"\)/)
  assert.match(commands, /inputs\.confirm && '--confirm'/)
})

test('every job that reads a declaration is given one first', () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${file}`, import.meta.url)), 'utf8')
  const name = variableNameFor(parseBase('mstage.env.json', readFileSync(ENV_CONFIG, 'utf8')).app)
  for (const [file, source] of [
    ['mdeploy-all.yml', workflow],
    ['mbuild.yml', read('mbuild.yml')],
    ['mbuild-release.yml', read('mbuild-release.yml')],
  ] as const) {
    /*
     * Every tool below reads `.mstage.config.json`, and on a runner the only
     * copy is the one setup-infra writes — from a stage it was named and a
     * variable it was handed. A call site missing either is a job that fails on
     * the first mstage command, several steps after the one that was wrong.
     */
    const calls = source.split('uses: ./.github/actions/setup-infra').slice(1)
    assert.ok(calls.length > 0, `${file} never sets apps/infra up`)
    for (const call of calls) {
      const block = call.slice(0, call.indexOf('\n      - '))
      assert.match(block, /stages: /, `${file} sets up without naming a stage`)
      assert.match(block, /stage-config: /, `${file} sets up without the declaration to restore`)
    }
    // Every job that runs one of the tools has to be one of those call sites.
    const jobs = source.match(/\n {2}[a-z-]+:\n/g) ?? []
    const runners = jobs.filter((_, index) => {
      const body = source.split(jobs[index])[1]?.split(/\n {2}[a-z-]+:\n/)[0] ?? ''
      return /npm run (--silent )?(mstage|mbuild|mdeploy|runner:)/.test(body)
    })
    assert.equal(runners.length, calls.length, `${file} runs a tool in a job that never set apps/infra up`)

    // The variable is named in full, because `vars` cannot be indexed by a
    // computed key — so the name has to be the one mstage derives.
    assert.ok(source.includes(`stage-config: \${{ vars.${name} }}`), `${file} does not pass ${name}`)
  }
})

test('one rollout per stage at a time, which the state requires', () => {
  // An app and stage keep one checkpoint. Two applies against one stage read
  // and write the same file, and the second to finish erases the first. There
  // is one dispatch left to serialise, so the group is this workflow's own.
  assert.match(workflow, /group: mdeploy-all-\$\{\{ inputs\.stage \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
})

test('the apply can ask the project what it holds, which needs a CLI installed', () => {
  // `src/dns-authorization.ts` refuses an apply this project cannot converge,
  // and it asks through gcloud. The federation writes a credential and installs
  // nothing, so without this step the check reports that it could not read and
  // lets every apply through — a guard that never runs where it matters most.
  const apply = workflow.indexOf('- name: Apply')
  const install = workflow.indexOf('setup-gcloud')
  assert.notEqual(install, -1, 'nothing installs the CLI the guard reads through')
  assert.ok(install < apply, 'and it has to be there before the apply it guards')
})

test('every staged-runner question names the commit, the way the image question does', () => {
  /*
   * Two jobs in `mdeploy-all` ask whether a runner is already staged, and both
   * used to ask about whatever was checked out. The plan job checks out the
   * branch tip and deploys the commit `resolve` named, so on any branch that
   * had moved it read a staged binary as absent, scheduled a build, and the
   * build job — which does check out the resolved commit — finished in 69
   * seconds having staged nothing.
   *
   * The image question beside each of them always carried `--tag`. Asserted
   * across every call rather than at the two sites, because the next one added
   * would otherwise inherit the same default.
   */
  const checks = [...workflow.matchAll(/runner:build -- [^\n|]*--check[^\n|]*/g)].map((match) => match[0])
  assert.ok(checks.length >= 1, `expected the staged-runner question, found ${checks.length}`)
  for (const call of checks) {
    assert.match(call, /--tag "\$SHA"/, `asks about the checkout: ${call}`)
  }
})

test('every deploy-path ref is pinned to the branch it was dispatched from', () => {
  /*
   * `resolve-ref` took a 40-character string on trust: it matched the shape and
   * became the deploy's commit without anything asking whether this repository
   * had ever held it. A typo then travelled as far as the registry, which
   * answered that the images were missing — true, and about the wrong commit.
   *
   * The branch is the second half. A commit on an abandoned branch, or on one
   * force-pushed away, still resolves and still names bytes, and deploying it
   * puts a stage on something no branch here will produce again. Asserted
   * across every call in the deploy workflows, because the guard is only worth
   * as much as the call site that forgets it.
   */
  // mbuild.yml is absent deliberately: it is callee-only and no longer
  // resolves anything. Its caller hands it a SHA already resolved and already
  // proved — and for a pull request that proof cannot be a branch, because a
  // merge commit sits on none. What mbuild.yml owes instead is asserted below.
  const workflows = ['mdeploy-all.yml', 'mbuild-release.yml']
  for (const name of workflows) {
    const text = readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
    const uses = [...text.matchAll(/uses: \.\/\.github\/actions\/resolve-ref\n\s*with:\n((?:\s{10}\S[^\n]*\n)+)/g)]
    assert.ok(uses.length > 0, `${name} resolves no ref`)
    for (const [, block] of uses) {
      assert.match(block, /branch: \$\{\{ github\.ref_name \}\}/, `${name} resolves a ref against no branch:\n${block}`)
    }
  }
})

test('a callee trusts no ref it was handed, and resolves none of its own', () => {
  /*
   * What `mbuild.yml` owes now that the branch pin above cannot cover it.
   *
   * It is reachable only by call, and its one caller resolves a tag, a commit
   * or a pull request into a single SHA and refuses each shape for its own
   * reasons. Resolving again here would be a second answer to "which commit",
   * and for a pull request it could not reach the same one at all — the merge
   * commit sits on no branch, so the check would refuse the very ref the
   * caller just proved.
   *
   * So the rule is: no resolution, and no trust either. The shape is re-checked
   * where the value enters, which is what `build-apps-api-image.yml` does with
   * the same guarantee from the same caller.
   */
  const mbuild = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mbuild.yml', import.meta.url)), 'utf8')
  assert.doesNotMatch(mbuild, /^ {2}workflow_dispatch:$/m, 'a dispatcher could hand it an unproved ref')
  assert.match(mbuild, /^ {2}workflow_call:$/m, 'nothing can reach it at all')
  assert.doesNotMatch(mbuild, /actions\/resolve-ref/, 'it resolves a ref its caller already resolved')
  assert.match(
    mbuild,
    /if \[\[ ! "\$TAG" =~ \^\[0-9a-f\]\{40\}\$ \]\]/,
    'it takes the caller’s tag without re-checking its shape',
  )
})

test('the only stage a deploy workflow runs for off main is dev', () => {
  /*
   * dev is shaken out from the branch that is changing it, so its jobs run
   * wherever they were dispatched. Every other stage reaches a protected
   * Environment and the cloud role behind it, and runs from main alone.
   *
   * Written as an allow-list on the escape rather than a deny-list on prod: a
   * stage added to the choice list later is main-only until an edit here says
   * otherwise, where `!= 'prod'` would have admitted it silently.
   */
  // mbuild-release.yml is deliberately absent: a release is what prod promotes
  // from, so it has no dev escape at all and the assertion below would refuse
  // exactly the workflow that is strictest.
  const workflows = ['mdeploy-all.yml', 'mbuild.yml']
  for (const name of workflows) {
    const text = readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
    const guards = [...text.matchAll(/^\s*if: [^\n]*(?:\n\s{6}[^\n]*)*/gm)]
      .map((match) => match[0])
      .filter((guard) => guard.includes('refs/heads/main'))
    assert.ok(guards.length > 0, `${name} guards no job by branch`)
    for (const guard of guards) {
      assert.match(guard, /== 'dev'/, `${name} leaves main for a stage it does not name:\n${guard}`)
      assert.equal(
        /!= 'prod'/.test(guard),
        false,
        `${name} denies prod instead of allowing dev, so the next stage added is admitted:\n${guard}`,
      )
    }
  }
})

test('the checks that decide an apply run in the job that applies, not beside it', () => {
  /*
   * One job, because a second one costs a second approval. The reads — which
   * commit the refs name, whether the stage holds those images, whether its
   * configuration still matches its own fingerprint, whether a protected stage
   * was confirmed — used to be a `preflight` job binding the same Environment,
   * so a dispatch waited on this stage's reviewers twice to perform checks that
   * change nothing.
   *
   * Asserted as a count of the jobs that bind the target stage and act on it,
   * rather than by name: splitting the checks out again under any name brings
   * the second wait back. `plan` and `build-runner` bind it too and are counted
   * — each buys something an apply cannot do for itself, and `build-runner` is
   * skipped outright on the release line — but nothing may join the apply.
   */
  const applying = [...workflow.matchAll(/\n {2}([a-z][a-z-]*):\n([\s\S]*?)(?=\n {2}[a-z][a-z-]*:\n|$)/g)]
    .filter(([, , body]) => /npm run mdeploy -- --stage/.test(body!))
    .map(([, name]) => name)
  assert.deepEqual(applying, ['deploy'], 'a second job runs the apply, so a refusal in one cannot guard the other')

  const binding = [...workflow.matchAll(/\n {2}([a-z][a-z-]*):\n([\s\S]*?)(?=\n {2}[a-z][a-z-]*:\n|$)/g)]
    .filter(([, , body]) => /^ {4}environment: \$\{\{ inputs\.stage \}\}$/m.test(body!))
    .map(([, name]) => name)
  assert.deepEqual(
    binding.sort(),
    ['build-runner', 'deploy', 'plan'],
    'a job binding this Environment is a wait on its reviewers; this set is the reviewed one',
  )

  // And the order that makes one job equivalent to the two: every check still
  // runs before the apply it guards.
  const apply = workflow.indexOf('- name: Apply')
  for (const check of ['Verify the stage configuration', 'Verify the images', 'Confirm a protected stage']) {
    const at = workflow.indexOf(check)
    assert.notEqual(at, -1, `${check} is gone rather than moved`)
    assert.ok(at < apply, `${check} runs after the apply it guards`)
  }
})

test('the failure summary renders for a run that failed before it addressed anything', () => {
  /*
   * `Report` is `if: always()` and `set -Eeuo pipefail`, and the values it
   * prints are written to `GITHUB_ENV` by "Address what this deploy installs".
   * A checkout, a setup or the addressing step itself failing leaves them
   * unwritten, and under `set -u` a bare expansion aborts the step — the
   * summary goes missing in exactly the runs it exists for.
   *
   * Run rather than read: the abort is the shell's, so only a shell can say
   * whether it still happens. GitHub substitutes every `${{ }}` before bash
   * sees the script, and the `env:` block is applied whether or not earlier
   * steps ran, so both are stood in for here; what is deliberately absent is
   * everything the unreached step would have exported.
   */
  const jobs = (load(workflow) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> }).jobs
  const report = jobs.deploy?.steps.find((step) => step.name === 'Report')?.run
  assert.ok(report, 'the deploy job no longer reports')

  const directory = mkdtempSync(join(tmpdir(), 'mdeploy-report-'))
  try {
    const summary = join(directory, 'summary.md')
    const ran = spawnSync('bash', ['-c', report.replace(/\$\{\{[^}]*\}\}/g, 'x')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GITHUB_STEP_SUMMARY: summary, LINE: 'commit', SHA: 'a'.repeat(40) },
    })
    assert.equal(ran.status, 0, `the report aborted rather than reporting: ${ran.stderr}`)

    const rendered = readFileSync(summary, 'utf8')
    for (const row of ['| commit |', '| images |', '| runner |', '| result |']) {
      assert.ok(rendered.includes(row), `the summary dropped ${row}:\n${rendered}`)
    }
    assert.ok(rendered.includes('a'.repeat(40)), 'the rows it did know are missing from the summary')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
