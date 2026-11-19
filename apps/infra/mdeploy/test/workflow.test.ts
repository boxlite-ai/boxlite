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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { actionSteps, expandedSteps, workflowSource } from './workflow-source.js'
import { parseBase } from 'mstage/config'
import { variableNameFor } from 'mstage/config-variable'

const rawWorkflow = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url)),
  'utf8',
)
const workflow = workflowSource('mdeploy-all.yml')
const ENV_CONFIG = fileURLToPath(new URL('../../mstage.env.json', import.meta.url))

test('the public workflow forwards every component selection through preview and apply', () => {
  const parsed = load(rawWorkflow) as any
  for (const job of [parsed.jobs.plan, parsed.jobs.deploy]) {
    const deploy = job.steps.find((step: any) => step.uses === './.github/actions/mdeploy')
    assert.equal(deploy.with.components, '${{ inputs.components }}')
  }
  const apply = actionSteps('mdeploy').find((step: any) => step.name === 'Apply')
  assert.equal(apply.env?.COMPONENTS, '${{ inputs.components }}')
  const directory = mkdtempSync(join(tmpdir(), 'mdeploy-components-'))
  try {
    const trace = join(directory, 'arguments')
    const npm = join(directory, 'npm')
    writeFileSync(npm, '#!/bin/bash\nprintf "%s\\n" "$@" > "$TRACE"\n')
    chmodSync(npm, 0o755)
    for (const components of ['api', 'runner', 'api+runner'])
      for (const applying of [false, true]) {
        const script = apply.run.replace(/\$\{\{([^}]+)\}\}/g, (_match: string, expression: string) => {
          if (expression.trim() === 'inputs.stage') return 'dev'
          if (expression.trim() === 'inputs.apply') return String(applying)
          if (expression.includes('inputs.confirm')) return '--confirm'
          throw new Error(`Unexpected workflow expression: ${expression}`)
        })
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: { PATH: `${directory}:${process.env.PATH}`, COMPONENTS: components, TRACE: trace },
        })
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), [
          'run',
          'mdeploy',
          '--',
          '--stage',
          'dev',
          '--components',
          components,
          applying ? '--confirm' : '--diff',
        ])
      }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('component-specific artifact and cloud checks stay aligned with the public selection', () => {
  const parsed = load(rawWorkflow) as any
  const steps = parsed.jobs.plan.steps
  assert.equal(
    steps.some((step: any) => step.name === 'Check component deployment support'),
    false,
  )
  const images = actionSteps('mdeploy').find((step: any) => step.name === 'Verify the images')
  assert.equal(images.if, "inputs.components != 'runner'")
  const release = parsed.jobs.resolve.steps.find((step: any) => step.name === 'Require the release this tag names')
  assert.equal(release.env.COMPONENTS, '${{ inputs.components }}')
  assert.ok(release.run.indexOf('"$COMPONENTS" = \'api\'') < release.run.indexOf('tarball='))
})

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
const GCP_FEDERATING_WORKFLOWS = ['mdeploy-all.yml', 'mbuild.yml']

test('a GCP identity is federated by the action that also gives gcloud its own credential', () => {
  for (const name of GCP_FEDERATING_WORKFLOWS) {
    const source = workflowSource(name)
    const runs = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    assert.match(runs, /uses: google-github-actions\/auth@v\d/, `${name} does not federate GCP`)
    assert.match(runs, /npm run --silent mstage login/, `${name} does not ask mstage, so this test is checking nothing`)
    // Installing the CLI is allowed; authenticating it a second time is not.
    const raw = readFileSync(new URL('../../../../.github/workflows/' + name, import.meta.url), 'utf8')
    for (const job of Object.values<any>((load(raw) as any).jobs)) {
      for (const step of expandedSteps(job.steps ?? []).filter((step) => /setup-gcloud/.test(step.uses ?? ''))) {
        assert.doesNotMatch(
          JSON.stringify(step.with ?? {}),
          /credentials_json|service_account_key|workload_identity_provider|service_account/,
        )
      }
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

/** Native entrypoints use the role whose IAM fence isolates historical SST writers. */
test('native AWS build and deploy use the distinct role wired by bootstrap', () => {
  const read = (name: string) => workflowSource(name)
  for (const [name, source] of [
    ['mdeploy-all.yml', workflow],
    ['mbuild.yml', read('mbuild.yml')],
  ] as const) {
    assert.ok(
      source.includes('role-to-assume: ${{ inputs.aws-pulumi-deploy-role-arn }}'),
      `${name} does not use the native role`,
    )
    assert.doesNotMatch(source, /role-to-assume: .*github-deploy/)
    assert.doesNotMatch(
      source,
      /vars\.AWS_DEPLOY_ROLE_ARN|vars\.AWS_ECR_PUSH_ROLE_ARN/,
      `${name} reads an undefined variable`,
    )
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
  const session = actionSteps('mdeploy').find((step) => step.name === 'Verify the session through mstage')!.run
  assert.match(session, /for attempt in 1 2 3/)

  const apply = actionSteps('mdeploy').find((step) => step.name === 'Apply')!.run
  assert.doesNotMatch(apply, /for attempt in/)
  assert.doesNotMatch(apply, /sst unlock|state unlock -- --stage "\$\{\{/, 'nothing clears the lock automatically')
})

test('the digest and the image check are not retried, because their answer is not transient', () => {
  const between = commands.slice(
    commands.indexOf('Verify the stage configuration'),
    commands.indexOf('- name: Confirm'),
  )
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
  assert.match(commands, /inputs\.confirm == 'true' && '--confirm'/)
})

test('every job or shared action restores the stage declaration before reading it', () => {
  const name = variableNameFor(parseBase('mstage.env.json', readFileSync(ENV_CONFIG, 'utf8')).app)
  for (const file of ['mdeploy-all.yml', 'mbuild.yml']) {
    const raw = readFileSync(new URL('../../../../.github/workflows/' + file, import.meta.url), 'utf8')
    for (const job of Object.values<any>((load(raw) as any).jobs)) {
      let restored = false
      for (const step of expandedSteps(job.steps ?? [])) {
        if (step.uses?.startsWith('actions/checkout@')) restored = false
        if (step.uses === './.github/actions/setup-infra') {
          assert.ok(step.with.stages, file)
          // Composite caller bindings are checked before expansion in composite-context.test.ts.
          assert.ok(
            ['${{ inputs.stage-config }}', '$' + '{{ vars.' + name + ' }}'].includes(step.with['stage-config']),
            file + ': setup must receive the target declaration',
          )
          restored = true
        }
        if (/npm run (--silent )?(mstage|mbuild|mdeploy|runner:)/.test(step.run ?? '')) {
          assert.ok(restored, file + ': tool reads a declaration before setup')
        }
      }
    }
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
    const text = workflowSource(name)
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
  const mbuild = workflowSource('mbuild.yml')
  assert.doesNotMatch(mbuild, /^ {2}workflow_dispatch:$/m, 'a dispatcher could hand it an unproved ref')
  assert.match(mbuild, /^ {2}workflow_call:$/m, 'nothing can reach it at all')
  assert.doesNotMatch(mbuild, /actions\/resolve-ref/, 'it resolves a ref its caller already resolved')
  assert.match(
    mbuild,
    /if \[\[ ! "\$TAG" =~ \^\[0-9a-f\]\{40\}\$ \]\]/,
    'it takes the caller’s tag without re-checking its shape',
  )
})

test('only dev and stage deploy workflows run off main', () => {
  /*
   * Dev and stage are shaken out from the branch that is changing them, so their jobs run
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
    const text = workflowSource(name)
    const guards = [...text.matchAll(/^\s*if: [^\n]*(?:\n\s{6}[^\n]*)*/gm)]
      .map((match) => match[0])
      .filter((guard) => guard.includes('refs/heads/main'))
    assert.ok(guards.length > 0, `${name} guards no job by branch`)
    for (const guard of guards) {
      assert.match(guard, /== 'dev'/, `${name} leaves main for a stage it does not name:\n${guard}`)
      assert.match(guard, /== 'stage'/, `${name} does not give stage the dev branch policy`)
      assert.equal(
        /!= 'prod'/.test(guard),
        false,
        `${name} denies prod instead of allowing dev, so the next stage added is admitted:\n${guard}`,
      )
    }
  }
})

test('both deployment paths reuse one ordered set of apply gates', () => {
  const parsed = load(rawWorkflow) as any
  const protectedJobs = Object.entries<any>(parsed.jobs)
    .filter(([, job]) => job.environment)
    .map(([name]) => name)
  assert.deepEqual(protectedJobs, ['plan', 'deploy'])
  for (const name of protectedJobs) {
    assert.equal(parsed.jobs[name].steps.filter((step: any) => step.uses === './.github/actions/mdeploy').length, 1)
  }
  const steps = actionSteps('mdeploy')
  const apply = steps.findIndex((step) => step.name === 'Apply')
  for (const check of [
    'Verify the stage configuration still matches its own fingerprint',
    'Verify the images',
    'Confirm a protected stage',
  ]) {
    const index = steps.findIndex((step) => step.name === check)
    assert.ok(index >= 0 && index < apply, check)
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
  const report = actionSteps('mdeploy').find((step) => step.name === 'Report')?.run
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
