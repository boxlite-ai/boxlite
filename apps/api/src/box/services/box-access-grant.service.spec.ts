/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { BoxAccessGrantService } from './box-access-grant.service'
import { BoxAccessGrantScope } from '../enums/box-access-grant-scope.enum'
import { BoxAccessGrantStatus } from '../enums/box-access-grant-status.enum'
import { BoxState } from '../enums/box-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'

const box = { id: 'box-1' } as any
const runningBox = { id: 'box-1', state: BoxState.STARTED, runnerId: 'runner-1' } as any
const runner = { id: 'runner-1', apiUrl: 'http://runner', apiKey: 'k' }
const applyStatus = {
  appliedGeneration: 6,
  listenerReady: true,
  hostPublicKey: 'ssh-ed25519 AAAA',
  hostKeyFingerprint: 'SHA256:host',
}

function makeService() {
  // `save` snapshots a shallow copy of the argument on each call: `revoke()`
  // mutates and re-saves the SAME grant object across the ACTIVE->REVOKING->
  // REVOKED transition, so recording the live reference in `mock.calls`
  // would make every earlier call site appear to have received the final,
  // latest-mutated status.
  const savedSnapshots: any[] = []
  const boxAccessGrantRepository = {
    save: jest.fn((row) => {
      const saved = { id: 'grant-1', createdAt: new Date('2025-01-01T00:00:00.000Z'), ...row }
      savedSnapshots.push({ ...saved })
      return Promise.resolve(saved)
    }),
    find: jest.fn(),
    findOne: jest.fn(),
  } as any
  const boxService = {
    findOneByIdOrName: jest.fn().mockResolvedValue(box),
  } as any
  const runnerService = { findOneOrFail: jest.fn().mockResolvedValue(runner) } as any
  const reconciliationService = {
    computeDesiredAccessSet: jest.fn().mockResolvedValue({ generation: 6, accesses: [] }),
  } as any
  const sshAccessSetAdapter = { applyAccessSet: jest.fn().mockResolvedValue(applyStatus) } as any
  const configService = { get: jest.fn().mockReturnValue(true) } as any
  const service = new BoxAccessGrantService(
    boxAccessGrantRepository,
    boxService,
    runnerService,
    reconciliationService,
    sshAccessSetAdapter,
    configService,
  )
  return {
    service,
    boxAccessGrantRepository,
    boxService,
    runnerService,
    reconciliationService,
    sshAccessSetAdapter,
    configService,
    savedSnapshots,
  }
}

describe('BoxAccessGrantService', () => {
  describe('create', () => {
    it('returns the plaintext app key once and persists only its digest', async () => {
      const { service, boxAccessGrantRepository } = makeService()

      const result = await service.create(
        'box-1',
        { scopes: [BoxAccessGrantScope.SSH], expiresInSeconds: 3600 },
        'org-1',
        'user-1',
      )

      expect(result.appKey).toEqual(expect.any(String))
      expect(result.appKey.startsWith('bag_svc_')).toBe(true)

      const savedRow = boxAccessGrantRepository.save.mock.calls[0][0]
      expect(savedRow.secretDigest).not.toBe(result.appKey)
      expect(savedRow).not.toHaveProperty('appKey')
      // Response DTO must not leak the digest either.
      expect(result).not.toHaveProperty('secretDigest')
    })

    it('rejects a scope outside the supported set', async () => {
      const { service } = makeService()

      await expect(
        service.create('box-1', { scopes: ['port:8080'] as any, expiresInSeconds: 3600 }, 'org-1', 'user-1'),
      ).rejects.toThrow(BadRequestError)
    })

    it('rejects an out-of-range TTL', async () => {
      const { service } = makeService()

      await expect(
        service.create('box-1', { scopes: [BoxAccessGrantScope.SSH], expiresInSeconds: 30 }, 'org-1', 'user-1'),
      ).rejects.toThrow(BadRequestError)
      await expect(
        service.create(
          'box-1',
          { scopes: [BoxAccessGrantScope.SSH], expiresInSeconds: 60 * 60 * 24 + 1 },
          'org-1',
          'user-1',
        ),
      ).rejects.toThrow(BadRequestError)
    })

    it('rejects with 503 while issuance is disabled, without touching the repository', async () => {
      const { service, configService, boxAccessGrantRepository } = makeService()
      configService.get.mockReturnValue(false)

      await expect(
        service.create('box-1', { scopes: [BoxAccessGrantScope.SSH], expiresInSeconds: 3600 }, 'org-1', 'user-1'),
      ).rejects.toThrow(ServiceUnavailableException)
      expect(boxAccessGrantRepository.save).not.toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('never includes the app key or its digest', async () => {
      const { service, boxAccessGrantRepository } = makeService()
      boxAccessGrantRepository.find.mockResolvedValue([
        {
          id: 'grant-1',
          boxId: 'box-1',
          scopes: [BoxAccessGrantScope.SSH],
          status: BoxAccessGrantStatus.ACTIVE,
          secretDigest: 'super-secret-digest',
          expiresAt: new Date('2025-01-01T12:00:00.000Z'),
          createdBy: 'user-1',
          createdAt: new Date('2025-01-01T11:00:00.000Z'),
        },
      ])

      const result = await service.list('box-1', 'org-1')

      expect(result).toHaveLength(1)
      expect(result[0]).not.toHaveProperty('appKey')
      expect(result[0]).not.toHaveProperty('secretDigest')
      expect(result[0]).toEqual({
        id: 'grant-1',
        boxId: 'box-1',
        scopes: [BoxAccessGrantScope.SSH],
        status: BoxAccessGrantStatus.ACTIVE,
        expiresAt: new Date('2025-01-01T12:00:00.000Z'),
        createdBy: 'user-1',
        createdAt: new Date('2025-01-01T11:00:00.000Z'),
      })
    })
  })

  describe('revoke', () => {
    it('transitions an active grant on a stopped box straight to REVOKED, without touching the guest', async () => {
      const { service, boxAccessGrantRepository, sshAccessSetAdapter } = makeService()
      const activeGrant = { id: 'grant-1', boxId: 'box-1', status: BoxAccessGrantStatus.ACTIVE }
      boxAccessGrantRepository.findOne.mockResolvedValue(activeGrant)

      await service.revoke('box-1', 'grant-1', 'org-1')

      expect(boxAccessGrantRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'grant-1', status: BoxAccessGrantStatus.REVOKED }),
      )
      expect(sshAccessSetAdapter.applyAccessSet).not.toHaveBeenCalled()
    })

    it('cascades to the guest access-set on a running box: REVOKING, apply a snapshot excluding this grant, then REVOKED', async () => {
      const { service, boxAccessGrantRepository, boxService, reconciliationService, sshAccessSetAdapter, savedSnapshots } =
        makeService()
      boxService.findOneByIdOrName.mockResolvedValue(runningBox)
      const activeGrant = { id: 'grant-1', boxId: 'box-1', status: BoxAccessGrantStatus.ACTIVE }
      boxAccessGrantRepository.findOne.mockResolvedValue(activeGrant)

      await service.revoke('box-1', 'grant-1', 'org-1')

      // computeDesiredAccessSet only includes credentials whose parent
      // grant is still ACTIVE -- by the time this call happens the grant
      // must already be REVOKING (not ACTIVE), so this credential's guest
      // access is genuinely dropped, not just a DB status flip.
      expect(savedSnapshots[0]).toMatchObject({ id: 'grant-1', status: BoxAccessGrantStatus.REVOKING })
      expect(reconciliationService.computeDesiredAccessSet).toHaveBeenCalledWith('box-1')
      expect(sshAccessSetAdapter.applyAccessSet).toHaveBeenCalledWith(runner, 'box-1', 6, [])
      expect(savedSnapshots[1]).toMatchObject({ id: 'grant-1', status: BoxAccessGrantStatus.REVOKED })
    })

    it('is a no-op for an already-revoked grant', async () => {
      const { service, boxAccessGrantRepository } = makeService()
      boxAccessGrantRepository.findOne.mockResolvedValue({
        id: 'grant-1',
        boxId: 'box-1',
        status: BoxAccessGrantStatus.REVOKED,
      })

      await service.revoke('box-1', 'grant-1', 'org-1')

      expect(boxAccessGrantRepository.save).not.toHaveBeenCalled()
    })

    it('throws NotFoundException for a grant that does not belong to the box', async () => {
      const { service, boxAccessGrantRepository } = makeService()
      boxAccessGrantRepository.findOne.mockResolvedValue(null)

      await expect(service.revoke('box-1', 'missing-grant', 'org-1')).rejects.toThrow(NotFoundException)
    })
  })
})
