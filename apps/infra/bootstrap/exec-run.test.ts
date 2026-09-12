/*
 * Which credential a bootstrap's cloud CLI calls actually run as.
 *
 * Asserted from the child's side — a real subprocess reporting its own
 * environment — because the question is what `gcloud` sees, and every way of
 * getting that wrong looks identical from in here. The GCP bootstrap used to
 * inherit this shell's environment, so it acted as whatever account gcloud was
 * last pointed at rather than as the credential `mstage login` had just
 * verified, and the failure arrived one call later as a reauth error about a
 * project.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { execRun, runAs } from './exec-run.js'

/** A child whose whole job is to report what it was handed. */
const reportEnvironment = async (exec = execRun) => {
  const result = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'])
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as Record<string, string>
}

test('a call with no credential named inherits this process’s environment', async () => {
  process.env.BOOTSTRAP_EXEC_MARKER = 'inherited'
  try {
    assert.equal((await reportEnvironment()).BOOTSTRAP_EXEC_MARKER, 'inherited')
  } finally {
    delete process.env.BOOTSTRAP_EXEC_MARKER
  }
})

test('a call bound to a credential set runs as it, and as nothing this shell holds', async () => {
  /*
   * The AWS variables are the point. mstage's identity produces a complete
   * environment for one cloud and leaves the other cloud's out, so binding to
   * it is what stops a stale key triple in an operator's shell from sending a
   * GCP bootstrap at AWS. A merge would have kept them, and the run would have
   * looked fine.
   */
  process.env.AWS_ACCESS_KEY_ID = 'AKIAstale'
  process.env.AWS_SESSION_TOKEN = 'stale-token'
  try {
    const child = await reportEnvironment(
      runAs({ PATH: process.env.PATH ?? '', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json', CLOUDSDK_CORE_PROJECT: 'boxlite-gcp-dev' }),
    )
    assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, '/tmp/adc.json')
    assert.equal(child.CLOUDSDK_CORE_PROJECT, 'boxlite-gcp-dev')
    assert.ok(!('AWS_ACCESS_KEY_ID' in child), 'the shell’s AWS credential reached a GCP bootstrap')
    assert.ok(!('AWS_SESSION_TOKEN' in child), 'the shell’s AWS session reached a GCP bootstrap')
  } finally {
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SESSION_TOKEN
  }
})

test('a non-zero exit is a result to reconcile against, carrying what the tool said', async () => {
  // Absence of a resource is an answer gcloud gives with a non-zero exit, so
  // this must not throw — every caller in gcp.ts branches on `code`.
  const result = await execRun(process.execPath, ['-e', 'process.stderr.write("NOT_FOUND"); process.exit(2)'])
  assert.deepEqual(result, { code: 2, stdout: '', stderr: 'NOT_FOUND' })
})

test('the credential is passed through, not consulted, so options still reach the child', async () => {
  const result = await runAs({ PATH: process.env.PATH ?? '' })(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    stdin: 'piped',
  })
  assert.equal(result.stdout, 'piped')
})

test('an environment too narrow to run a CLI in is refused where it is composed', () => {
  // Not at the first call, which is a stack frame away from the mistake and
  // reads as `gcloud` being absent.
  assert.throws(() => runAs({ GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json' }), /has no PATH/)
})
