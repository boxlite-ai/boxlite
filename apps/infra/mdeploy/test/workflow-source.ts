import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

const github = new URL('../../../../.github/', import.meta.url)
const sharedActions = ['mbuild', 'mdeploy', 'build-staged-runner']

export const actionSource = (name: string): string =>
  readFileSync(new URL('actions/' + name + '/action.yml', github), 'utf8')

export const actionSteps = (name: string): any[] => (load(actionSource(name)) as any).runs.steps

export const withActionSources = (source: string): string =>
  source +
  sharedActions
    .filter((name) => source.includes('uses: ./.github/actions/' + name + '\n'))
    .map((name) => '\n' + actionSource(name))
    .join('')

export const workflowSource = (name: string): string =>
  withActionSources(readFileSync(new URL('workflows/' + name, github), 'utf8'))

export const expandedSteps = (steps: any[]): any[] =>
  steps.flatMap((step) => {
    const name = sharedActions.find((name) => step.uses === './.github/actions/' + name)
    return name ? expandedSteps(actionSteps(name)) : [step]
  })
