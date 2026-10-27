/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, NotFoundException, type INestApplication } from '@nestjs/common'
import { SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { getOpenApiConfig } from '../../openapi.config'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'
import { RegistryCredentialService } from '../services/registry-credential.service'
import { RegistriesController } from './registries.controller'
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

describe('Registry OpenAPI boundary', () => {
  let app: INestApplication
  const credential = { kind: RegistryCredentialKind.BASIC, username: 'acme-bot', secretVersion: 'secret-version-1' }
  const credentials = {
    runnerServes: jest.fn().mockResolvedValue(true),
    findForRepository: jest.fn().mockResolvedValue(credential),
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RegistriesController, RunnerRegistryCredentialController],
      providers: [{ provide: RegistryCredentialService, useValue: credentials }],
    })
      .useMocker(() => ({}))
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = RUNNER
          return true
        },
      })
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await app?.close()
  })

  it('exports tenant registry operations without the internal lookup or its schemas', () => {
    const document = SwaggerModule.createDocument(app, getOpenApiConfig('http://localhost'))

    expect(document.paths['/api/images/registries']?.get?.operationId).toBe('listRegistryCredentials')
    expect(document.paths['/api/images/registries']?.post?.operationId).toBe('createRegistryCredential')
    expect(document.paths['/api/images/registries/{id}']?.delete?.operationId).toBe('deleteRegistryCredential')
    expect(document.paths['/api/runners/me/images/registry-credentials']).toBeUndefined()
    expect(document.components?.schemas?.RunnerRegistryCredential).toBeUndefined()
    expect(document.components?.schemas?.RegistryCredentialLookup).toBeUndefined()
  })

  it('still serves the internal lookup to the registry proxy', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/api/runners/me/images/registry-credentials?${new URLSearchParams(LOOKUP)}`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(credential)
    expect(credentials.runnerServes).toHaveBeenCalledWith(RUNNER.runnerId, LOOKUP.organizationId)
    expect(credentials.findForRepository).toHaveBeenCalledWith(LOOKUP.organizationId, LOOKUP.host, LOOKUP.repository)
  })
})
