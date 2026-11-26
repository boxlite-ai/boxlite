import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunCommand } from './upgrade-runners.ts'

export async function verifyDevProtectedAcceptance({
  runId,
  repository,
  commit,
  executableDigest,
  run,
}: {
  runId: string
  repository: string
  commit: string
  executableDigest: string
  run: RunCommand
}): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
      !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(executableDigest)) {
    throw new Error('Protected activation requires the exact dev acceptance run, commit and executable SHA-256')
  }
  const result = run('gh', ['api', `repos/${repository}/actions/runs/${runId}`])
  if (!result.ok) throw new Error('Could not verify the dev acceptance workflow')
  const workflow = JSON.parse(result.stdout)
  if (
    workflow.conclusion !== 'success' || workflow.path !== '.github/workflows/e2e-cloud.yml' ||
    workflow.head_sha !== commit || workflow.head_repository?.full_name !== repository
  ) {
    throw new Error('The dev acceptance run did not pass on the exact release commit')
  }

  const directory = await mkdtemp(join(tmpdir(), 'boxlite-dev-acceptance-'))
  try {
    const artifact = run('gh', [
      'run', 'download', runId, '--repo', repository,
      '--name', 'protected-v2-dev-acceptance', '--dir', directory,
    ])
    if (!artifact.ok) throw new Error('The dev acceptance run did not publish protected release evidence')
    const evidence = JSON.parse(await readFile(join(directory, 'protected-v2-dev-acceptance.json'), 'utf8'))
    if (
      evidence.version !== 1 || evidence.stage !== 'dev' || evidence.commit !== commit ||
      evidence.executableDigest !== executableDigest || evidence.abnormalExitRollback !== 'passed' ||
      evidence.finalRestartAdmission !== 'passed'
    ) {
      throw new Error('The dev acceptance evidence does not cover this artifact and both protected checks')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
