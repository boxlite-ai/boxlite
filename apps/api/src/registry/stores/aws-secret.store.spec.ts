// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { CreateSecretCommand, DeleteSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { AwsSecretManagerStore } from './aws-secret.store'

const id = '00000000-0000-4000-8000-000000000001'
const scope = { region: 'us-east-1', accountId: '123456789012', prefix: 'registry-credential-boxlite-app-dev-' }
const arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${scope.prefix}${id}-A1b2C3`
const version = arn + '/versions/' + id
const setup = () => {
  const send = jest.fn().mockResolvedValue({ ARN: arn, VersionId: id })
  return { send, store: new AwsSecretManagerStore(scope, { send } as any) }
}

it('writes one named immutable secret version without reading it', async () => {
  const { send, store } = setup()
  expect(await store.put(id, 'password')).toBe(version)
  expect(send.mock.calls[0][0]).toBeInstanceOf(CreateSecretCommand)
  expect(send.mock.calls[0][0].input).toEqual({
    Name: scope.prefix + id,
    ClientRequestToken: id,
    SecretString: 'password',
  })
  expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual(['constructor', 'destroy', 'put'])
})
it('retries a lost create response using the same version token and no read', async () => {
  const { send, store } = setup()
  send.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ResourceExistsException' }))
  expect(await store.put(id, 'password')).toBe(version)
  expect(send.mock.calls[1][0]).toBeInstanceOf(PutSecretValueCommand)
  expect(send.mock.calls[1][0].input).toEqual({
    SecretId: scope.prefix + id,
    ClientRequestToken: id,
    SecretString: 'password',
  })
})
it('revokes exactly its one-secret-per-write reference with recoverable deletion', async () => {
  const { send, store } = setup()
  await store.destroy(version)
  expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteSecretCommand)
  expect(send.mock.calls[0][0].input).toEqual({
    SecretId: arn,
    RecoveryWindowInDays: 7,
  })
})
it.each([
  version.replace('123456789012', '999999999999'),
  version.replace('us-east-1', 'us-west-2'),
  version.replace('boxlite-app-dev-', 'boxlite-app-prod-'),
  version.replace('/versions/' + id, '/versions/00000000-0000-4000-8000-000000000002'),
  'projects/project/secrets/name/versions/1',
])('rejects a foreign or unpinned secret before an AWS call: %s', async (reference) => {
  const { send, store } = setup()
  await expect(store.destroy(reference)).rejects.toThrow('outside')
  expect(send).not.toHaveBeenCalled()
})
it('rejects invalid writes and incomplete configuration before a cloud call', async () => {
  const { send, store } = setup()
  await expect(store.put('../escape', 'password')).rejects.toThrow('UUID')
  await expect(store.put(id, '')).rejects.toThrow('nonempty')
  expect(send).not.toHaveBeenCalled()
  expect(() => new AwsSecretManagerStore({ ...scope, prefix: '' })).toThrow('require')
})
it('refuses a response outside its store and surfaces permission failures', async () => {
  const { send, store } = setup()
  send.mockResolvedValueOnce({ ARN: arn.replace('123456789012', '999999999999'), VersionId: id })
  await expect(store.put(id, 'password')).rejects.toThrow('outside')
  send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
  await expect(store.destroy(version)).rejects.toThrow('denied')
})
it('treats missing or already revoked secrets as idempotent deletion', async () => {
  const { send, store } = setup()
  send.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }))
  await expect(store.destroy(version)).resolves.toBeUndefined()
  send.mockRejectedValueOnce(Object.assign(new Error('scheduled for deletion'), { name: 'InvalidRequestException' }))
  await expect(store.destroy(version)).resolves.toBeUndefined()
})
