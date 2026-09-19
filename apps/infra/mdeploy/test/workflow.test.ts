/*
 * The deploy workflow, held against what mdeploy actually does.
 *
 * A workflow is the one part of a deploy nothing else typechecks, and the
 * mistakes it makes are the expensive kind: a gate that runs after the thing it
 * was meant to refuse, a retry around an answer that will not change, a cloud
 * named in a place that has to work on both.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseBase } from 'mstage/config'
import { variableNameFor } from 'mstage/config-variable'

const workflow = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mdeploy.yml', import.meta.url)), 'utf8')
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
const GCP_FEDERATING_WORKFLOWS = ['mdeploy.yml', 'mbuild.yml']

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
  const mbuild = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mbuild.yml', import.meta.url)), 'utf8')
  for (const [name, source] of [
    ['mdeploy.yml', workflow],
    ['mbuild.yml', mbuild],
  ] as const) {
    assert.match(
      source,
      /role-to-assume: arn:aws:iam::\$\{\{ vars\.AWS_ACCOUNT_ID \}\}:role\/boxlite-\$\{\{ [^}]+ \}\}-github-deploy/,
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
  const mbuild = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mbuild.yml', import.meta.url)), 'utf8')
  const name = variableNameFor(parseBase('mstage.env.json', readFileSync(ENV_CONFIG, 'utf8')).app)
  const mrunner = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mrunner.yml', import.meta.url)), 'utf8')
  for (const [file, source] of [
    ['mdeploy.yml', workflow],
    ['mbuild.yml', mbuild],
    ['mrunner.yml', mrunner],
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
    const jobs = source.match(/\n  [a-z-]+:\n/g) ?? []
    const runners = jobs.filter((_, index) => {
      const body = source.split(jobs[index])[1]?.split(/\n  [a-z-]+:\n/)[0] ?? ''
      return /npm run (--silent )?(mstage|mbuild|mdeploy|runner:)/.test(body)
    })
    assert.equal(runners.length, calls.length, `${file} runs a tool in a job that never set apps/infra up`)

    // The variable is named in full, because `vars` cannot be indexed by a
    // computed key — so the name has to be the one mstage derives.
    assert.ok(source.includes(`stage-config: \${{ vars.${name} }}`), `${file} does not pass ${name}`)
  }
})

test('both mdeploy dispatches share one concurrency group, which the state requires', () => {
  // An app and stage keep one checkpoint. Two applies against one stage read
  // and write the same file, and the second to finish erases the first.
  assert.match(workflow, /group: mdeploy-\$\{\{ inputs\.stage \}\}/)
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
  const source = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url)), 'utf8')
  const checks = [...source.matchAll(/runner:build -- [^\n|]*--check[^\n|]*/g)].map((match) => match[0])
  assert.ok(checks.length >= 2, `expected both staged-runner questions, found ${checks.length}`)
  for (const call of checks) {
    assert.match(call, /--tag "\$\{\{ needs\.ref\.outputs\.sha \}\}"|--tag "\$SHA"/, `asks about the checkout: ${call}`)
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
  const workflows = ['mdeploy-all.yml', 'mdeploy.yml', 'mbuild.yml', 'mrunner.yml']
  for (const name of workflows) {
    const text = readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
    const uses = [...text.matchAll(/uses: \.\/\.github\/actions\/resolve-ref\n\s*with:\n((?:\s{10}\S[^\n]*\n)+)/g)]
    assert.ok(uses.length > 0, `${name} resolves no ref`)
    for (const [, block] of uses) {
      assert.match(block, /branch: \$\{\{ github\.ref_name \}\}/, `${name} resolves a ref against no branch:\n${block}`)
    }
  }
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
  const workflows = ['mdeploy-all.yml', 'mdeploy.yml', 'mbuild.yml', 'mrunner.yml']
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
   * Asserted as a count rather than by name: splitting them out again under any
   * name brings the second wait back.
   */
  const jobs = [...workflow.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((match) => match[1])
  assert.deepEqual(jobs, ['deploy'], 'a second job binding this Environment is a second approval')

  // And the order that makes one job equivalent to the two: every check still
  // runs before the apply it guards.
  const apply = workflow.indexOf('- name: Apply')
  for (const check of ['Verify the stage configuration', 'Verify the images', 'Confirm a protected stage']) {
    const at = workflow.indexOf(check)
    assert.notEqual(at, -1, `${check} is gone rather than moved`)
    assert.ok(at < apply, `${check} runs after the apply it guards`)
  }
})
