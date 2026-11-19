import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { data, Lexer, Parser } from '@actions/expressions'
import { load } from 'js-yaml'
import { actionSource } from './workflow-source.js'

const common = {
  'stage-config': 'BOXLITE_MSTAGE_BOXLITE_APP_CONFIG',
  'aws-pulumi-deploy-role-arn': 'AWS_PULUMI_DEPLOY_ROLE_ARN',
  'gcp-workload-identity-provider': 'GCP_WORKLOAD_IDENTITY_PROVIDER',
}
const configuration = {
  mbuild: { ...common, 'gcp-image-publisher': 'GCP_IMAGE_PUBLISHER' },
  'build-staged-runner': { ...common, 'gcp-deployer': 'GCP_DEPLOYER' },
  mdeploy: { ...common, 'gcp-deployer': 'GCP_DEPLOYER', 'gcp-image-publisher': 'GCP_IMAGE_PUBLISHER' },
}
const workflows = ['mbuild.yml', 'mdeploy-all.yml'].map((name) => ({
  name,
  jobs: (load(readFileSync(new URL('../../../../.github/workflows/' + name, import.meta.url), 'utf8')) as any).jobs,
}))

// Runner v2.338.2 action_yaml.json's step-with contexts differ from workflow contexts.
const contexts = ['github', 'inputs', 'strategy', 'matrix', 'steps', 'job', 'runner', 'env']
const hashFiles = { name: 'hashFiles', minArgs: 1, maxArgs: 255, call: () => new data.StringData('') }

for (const [name, bindings] of Object.entries(configuration)) {
  test(`${name} loads with composite contexts and receives its target Environment configuration`, () => {
    const source = actionSource(name)
    const action = load(source) as any
    for (const step of action.runs.steps) {
      for (const value of Object.values(step.with ?? {})) {
        if (typeof value !== 'string') continue
        for (const [, expression] of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
          assert.doesNotThrow(
            () => new Parser(new Lexer(expression!).lex().tokens, contexts, [hashFiles]).parse(),
            `${name}: ${step.name ?? step.uses}: ${expression}`,
          )
        }
      }
    }

    let callers = 0
    for (const workflow of workflows) {
      for (const job of Object.values<any>(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses !== './.github/actions/' + name) continue
          callers++
          assert.equal(
            job.environment,
            workflow.name === 'mbuild.yml' ? '${{ inputs.stage || inputs.to }}' : '${{ inputs.stage }}',
          )
          for (const [input, variable] of Object.entries(bindings)) {
            assert.ok(Object.hasOwn(action.inputs, input), `${name} must declare ${input}`)
            assert.equal(step.with[input], '${{ vars.' + variable + ' }}', `${workflow.name}: ${name}.${input}`)
            assert.ok(source.includes('inputs.' + input), `${name} must consume ${input}`)
          }
        }
      }
    }
    assert.equal(callers, name === 'build-staged-runner' ? 1 : 2)
  })
}
