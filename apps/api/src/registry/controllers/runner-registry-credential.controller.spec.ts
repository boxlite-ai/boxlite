/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'
import { RegistryCredentialService } from '../services/registry-credential.service'
import { RunnerRegistryCredentialController } from './runner-registry-credential.controller'

const LOOKUP = { organizationId: '00000000-0000-4000-8000-000000000001', host: 'ghcr.io', repository: 'acme/app' }
const RUNNER = { role: 'runner', runnerId: 'runner-7' } as RunnerContext

function controllerFinding(credential: RegistryCredential | null, { serves = true } = {}) {
  const findForRepository = jest.fn(async () => credential)
  const runnerServes = jest.fn(async () => serves)
  const controller = new RunnerRegistryCredentialController({
    findForRepository,
    runnerServes,
  } as unknown as RegistryCredentialService)
  return { controller, findForRepository, runnerServes }
}

describe('RunnerRegistryCredentialController', () => {
  it('answers with where the password is, and nothing else from the row', async () => {
    const { controller, findForRepository } = controllerFinding({
      id: 'credential-1',
      organizationId: LOOKUP.organizationId,
      kind: RegistryCredentialKind.BASIC,
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: 'acme-bot',
      secretVersion: 'projects/1/secrets/registry-credential-credential-1/versions/1',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const answer = await controller.find(RUNNER, LOOKUP)

    expect(findForRepository).toHaveBeenCalledWith(LOOKUP.organizationId, 'ghcr.io', 'acme/app')
    expect(answer).toEqual({
      kind: 'basic',
      username: 'acme-bot',
      secretVersion: 'projects/1/secrets/registry-credential-credential-1/versions/1',
    })
  })

  it('answers 404 when there is no credential, which the proxy reads as an anonymous pull', async () => {
    const { controller } = controllerFinding(null)

    await expect(controller.find(RUNNER, LOOKUP)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('refuses a runner that hosts no box of the organization, before looking anything up', async () => {
    const { controller, findForRepository, runnerServes } = controllerFinding(null, { serves: false })

    await expect(controller.find(RUNNER, LOOKUP)).rejects.toBeInstanceOf(ForbiddenException)
    expect(runnerServes).toHaveBeenCalledWith('runner-7', LOOKUP.organizationId)
    // Not even whether a credential exists: that is itself about the other
    // organization.
    expect(findForRepository).not.toHaveBeenCalled()
  })
})
