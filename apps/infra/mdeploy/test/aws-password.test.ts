import assert from 'node:assert/strict'
import test from 'node:test'
import { awsPassword } from '../stack/providers/aws/password.ts'

/** Model Pulumi's deferred value at the Secrets Manager read boundary. */
class FixtureOutput<T> {
  constructor(readonly value: T) {}
  apply<U>(map: (value: T) => U) {
    return new FixtureOutput(map(this.value))
  }
}

test('adopting a database or cache password preserves its value and its ECS secret reference', (t) => {
  const secretId = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:adopted'
  let stored = ''
  const reads: string[] = []
  const getSecretVersionOutput = ({ secretId }: { secretId: string }) => {
    reads.push(secretId)
    return { secretString: new FixtureOutput(stored) }
  }
  const globals = globalThis as Record<string, any>
  for (const [key, value] of Object.entries({
    aws: { secretsmanager: { getSecretVersionOutput } },
    $util: { secret: (output: FixtureOutput<string>) => ({ classified: output.value }) },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globals, key)
    Object.defineProperty(globals, key, { configurable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globals, key, previous)
      else delete globals[key]
    })
  }
  for (const field of ['password', 'authToken']) {
    stored = JSON.stringify({ [field]: 'fixture-value' })
    const adopted = awsPassword('Existing', secretId, field)
    assert.deepEqual(adopted.value, { classified: 'fixture-value' })
    assert.deepEqual(adopted.passwordRef, new FixtureOutput(secretId + ':' + field + '::'))
    assert.deepEqual(adopted.ready, [])
  }
  stored = 'plain-fixture'
  const plain = awsPassword('Existing', secretId, 'password')
  assert.deepEqual(plain.value, { classified: stored })
  assert.deepEqual(plain.passwordRef, new FixtureOutput(secretId))
  for (stored of ['{}', '{"password":false}', '{"password":""}', '']) {
    assert.throws(() => awsPassword('Existing', secretId, 'password'), /no expected field|secret is empty/)
  }
  assert.deepEqual(reads, Array(7).fill(secretId))
})
