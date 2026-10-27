/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore, SecretStore } from './secret.store'

const mockGetProjectId = jest.fn()
const mockCreateSecret = jest.fn()
const mockAddSecretVersion = jest.fn()
const mockDestroySecretVersion = jest.fn()
const mockAccessSecretVersion = jest.fn()

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    getProjectId: mockGetProjectId,
    createSecret: mockCreateSecret,
    addSecretVersion: mockAddSecretVersion,
    destroySecretVersion: mockDestroySecretVersion,
    accessSecretVersion: mockAccessSecretVersion,
  })),
}))

const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000001'
const PASSWORD = 'ghp_not-a-real-token'

function buildStore(values: Record<string, unknown>): SecretStore | null {
  const configService = { get: jest.fn((key: string) => values[key]) }
  return createSecretStore(configService as any)
}

describe('createSecretStore', () => {
  it('builds nothing when no store is configured, which leaves private registries off', () => {
    expect(buildStore({})).toBeNull()
  })

  it('refuses the file store in production', () => {
    expect(() =>
      buildStore({ 'registrySecrets.store': 'file', 'registrySecrets.directory': '/tmp/x', production: true }),
    ).toThrow('refused in production')
  })

  it('refuses the file store without a directory', () => {
    expect(() => buildStore({ 'registrySecrets.store': 'file' })).toThrow('REGISTRY_SECRET_DIR must be set')
  })

  it('refuses a store it does not know rather than falling back to none', () => {
    expect(() => buildStore({ 'registrySecrets.store': 'vault' })).toThrow('must be "gcp" or "file", got "vault"')
  })
})

describe('GcpSecretManagerStore', () => {
  const secretName = `projects/boxlite-dev/secrets/registry-credential-${CREDENTIAL_ID}`
  let store: SecretStore

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetProjectId.mockResolvedValue('boxlite-dev')
    mockCreateSecret.mockResolvedValue([{ name: secretName }])
    mockAddSecretVersion.mockResolvedValue([
      { name: `projects/123/secrets/registry-credential-${CREDENTIAL_ID}/versions/1` },
    ])
    store = buildStore({ 'registrySecrets.store': 'gcp' }) as SecretStore
  })

  it('has no way to read a secret back', () => {
    // The API's side of the split, as a shape: the only operations are the
    // two that write. The stack's IAM enforces the same thing again.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual(['constructor', 'destroy', 'put'])
  })

  it('creates a prefixed secret that destroys versions late, and returns the version it added', async () => {
    const version = await store.put(CREDENTIAL_ID, PASSWORD)

    expect(mockCreateSecret).toHaveBeenCalledWith({
      parent: 'projects/boxlite-dev',
      secretId: `registry-credential-${CREDENTIAL_ID}`,
      secret: { replication: { automatic: {} }, versionDestroyTtl: { seconds: 604800 } },
    })
    expect(mockAddSecretVersion).toHaveBeenCalledWith({
      parent: secretName,
      payload: { data: Buffer.from(PASSWORD, 'utf8') },
    })
    expect(version).toBe(`projects/123/secrets/registry-credential-${CREDENTIAL_ID}/versions/1`)
    expect(mockAccessSecretVersion).not.toHaveBeenCalled()
  })

  it('fails when the version comes back unnamed, since the row would point nowhere', async () => {
    mockAddSecretVersion.mockResolvedValue([{}])

    await expect(store.put(CREDENTIAL_ID, PASSWORD)).rejects.toThrow(
      `added a version to ${secretName} without naming it`,
    )
  })

  it('destroys exactly the version it was given', async () => {
    mockDestroySecretVersion.mockResolvedValue([{}])

    await store.destroy(`${secretName}/versions/1`)

    expect(mockDestroySecretVersion).toHaveBeenCalledWith({ name: `${secretName}/versions/1` })
  })

  it('treats a version that is already gone as destroyed', async () => {
    mockDestroySecretVersion.mockRejectedValue(Object.assign(new Error('not found'), { code: 5 }))

    await expect(store.destroy(`${secretName}/versions/1`)).resolves.toBeUndefined()
  })

  it('reports any other failure to destroy', async () => {
    mockDestroySecretVersion.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 7 }))

    await expect(store.destroy(`${secretName}/versions/1`)).rejects.toThrow('permission denied')
  })
})

describe('FileSecretStore', () => {
  let directory: string
  let store: SecretStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'registry-secrets-'))
    store = buildStore({ 'registrySecrets.store': 'file', 'registrySecrets.directory': directory }) as SecretStore
  })

  afterEach(() => rm(directory, { recursive: true, force: true }))

  it('writes the password to a file only its owner can read', async () => {
    const version = await store.put(CREDENTIAL_ID, PASSWORD)

    expect(version).toBe(`registry-credential-${CREDENTIAL_ID}`)
    expect(await readFile(join(directory, version), 'utf8')).toBe(PASSWORD)
    expect((await stat(join(directory, version))).mode & 0o777).toBe(0o600)
  })

  it('never overwrites a password an earlier put left', async () => {
    await store.put(CREDENTIAL_ID, PASSWORD)

    await expect(store.put(CREDENTIAL_ID, 'another')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(directory, `registry-credential-${CREDENTIAL_ID}`), 'utf8')).toBe(PASSWORD)
  })

  it('removes the file, and resolves when it is already gone', async () => {
    const version = await store.put(CREDENTIAL_ID, PASSWORD)

    await store.destroy(version)
    await expect(stat(join(directory, version))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.destroy(version)).resolves.toBeUndefined()
  })
})
