/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'
import { CreateRegistryCredentialDto, RegistryCredentialDto } from './registry-credential.dto'

const messagesFor = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(CreateRegistryCredentialDto, body))).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  )

describe('CreateRegistryCredentialDto', () => {
  const valid = { registryHost: 'ghcr.io', repositoryPrefix: 'acme/', username: 'acme-bot', password: 'ghp_x' }

  it('accepts a login for one of the four registries', async () => {
    expect(await messagesFor(valid)).toEqual([])
    expect(await messagesFor({ ...valid, repositoryPrefix: undefined })).toEqual([])
  })

  it.each(['public.ecr.aws', 'us-docker.pkg.dev', '169.254.169.254', 'registry-1.docker.io'])(
    'refuses a login for %s',
    async (registryHost) => {
      expect(await messagesFor({ ...valid, registryHost })).not.toEqual([])
    },
  )

  it.each(['acme', '/acme/', 'acme//', 'Acme/'])('refuses the prefix %j', async (repositoryPrefix) => {
    expect(await messagesFor({ ...valid, repositoryPrefix })).not.toEqual([])
  })

  /**
   * The exceptions filter joins these messages into the response body, so a
   * validator that echoed its input would put the password in a 400. Every
   * refusal a password can meet is checked against the value it was given.
   */
  it('never repeats a refused password in its messages', async () => {
    const secret = 'hunter2-'.repeat(1100)
    for (const password of [secret, 12345, '']) {
      const messages = await messagesFor({ ...valid, password })
      expect(messages).not.toEqual([])
      for (const message of messages) {
        expect(message).not.toContain('hunter2')
        expect(message).not.toContain('12345')
      }
    }
  })
})

describe('RegistryCredentialDto', () => {
  it('carries exactly the fields a caller may see, and no password in any form', () => {
    const dto = RegistryCredentialDto.from({
      id: 'credential-1',
      organizationId: 'org-1',
      kind: RegistryCredentialKind.BASIC,
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: 'acme-bot',
      secretVersion: 'projects/1/secrets/registry-credential-credential-1/versions/1',
      createdBy: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date(),
    } as RegistryCredential)

    // Not even where the password is: that is the proxy's to know.
    expect(Object.keys(dto).sort()).toEqual([
      'createdAt',
      'createdBy',
      'id',
      'kind',
      'registryHost',
      'repositoryPrefix',
      'username',
    ])
  })
})
