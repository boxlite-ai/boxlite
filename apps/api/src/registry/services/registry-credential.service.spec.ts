/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Not, Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialService } from './registry-credential.service'

const ORG_ID = '00000000-0000-4000-8000-000000000001'

function serviceHolding(prefixes: string[]) {
  const rows = prefixes.map(
    (repositoryPrefix) => ({ id: `id:${repositoryPrefix}`, repositoryPrefix }) as RegistryCredential,
  )
  const find = jest.fn(async () => rows)
  const service = new RegistryCredentialService(
    { find } as unknown as Repository<RegistryCredential>,
    {} as Repository<Box>,
  )
  const prefixFor = async (repository: string) =>
    (await service.findForRepository(ORG_ID, 'ghcr.io', repository))?.repositoryPrefix ?? null
  return { find, prefixFor }
}

describe('RegistryCredentialService.findForRepository', () => {
  it('reads only the organization and host asked about', async () => {
    const { find, prefixFor } = serviceHolding([])

    await prefixFor('acme/app')

    expect(find).toHaveBeenCalledWith({ where: { organizationId: ORG_ID, registryHost: 'ghcr.io' } })
  })

  it('chooses the longest prefix that matches', async () => {
    const { prefixFor } = serviceHolding(['', 'acme/', 'acme/team/'])

    expect(await prefixFor('acme/team/app')).toBe('acme/team/')
    expect(await prefixFor('acme/app')).toBe('acme/')
    expect(await prefixFor('other/app')).toBe('')
  })

  it('matches whole path segments, so acme/ does not cover acme-other', async () => {
    const { prefixFor } = serviceHolding(['acme/'])

    expect(await prefixFor('acme-other/app')).toBeNull()
  })

  it('lets a prefix name the repository itself', async () => {
    const { prefixFor } = serviceHolding(['acme/app/'])

    expect(await prefixFor('acme/app')).toBe('acme/app/')
    expect(await prefixFor('acme/application')).toBeNull()
  })

  it('finds nothing when the organization registered nothing for the host', async () => {
    const { prefixFor } = serviceHolding([])

    expect(await prefixFor('acme/app')).toBeNull()
  })
})

describe('RegistryCredentialService.runnerServes', () => {
  it('asks for a box of that organization on that runner that is not being destroyed', async () => {
    const exists = jest.fn(async () => true)
    const service = new RegistryCredentialService(
      {} as Repository<RegistryCredential>,
      { exists } as unknown as Repository<Box>,
    )

    await expect(service.runnerServes('runner-7', ORG_ID)).resolves.toBe(true)
    expect(exists).toHaveBeenCalledWith({
      where: { runnerId: 'runner-7', organizationId: ORG_ID, desiredState: Not(BoxDesiredState.DESTROYED) },
    })
  })
})
