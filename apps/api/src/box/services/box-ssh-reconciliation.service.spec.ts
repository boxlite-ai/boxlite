/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxSshReconciliationService } from './box-ssh-reconciliation.service'
import { TemporarySshCredentialStatus } from '../enums/temporary-ssh-credential-status.enum'
import { BoxAccessGrantStatus } from '../enums/box-access-grant-status.enum'
import { BoxSshIdentityStatus } from '../enums/box-ssh-identity-status.enum'

// A chainable SELECT query-builder stub whose terminal getMany() is supplied
// per-test, mirroring box.repository.spec.ts's makeQueryBuilder pattern.
function makeQueryBuilder(getMany: jest.Mock) {
  const qb: any = {}
  qb.innerJoin = jest.fn(() => qb)
  qb.where = jest.fn(() => qb)
  qb.andWhere = jest.fn(() => qb)
  qb.getMany = getMany
  return qb
}

function makeService(credentialRows: unknown[], generationRow: { generation: number }) {
  const getMany = jest.fn().mockResolvedValue(credentialRows)
  const queryBuilder = makeQueryBuilder(getMany)
  const credentialRepository = { createQueryBuilder: jest.fn(() => queryBuilder) } as any

  const query = jest.fn().mockResolvedValue([generationRow])
  const generationRepository = { manager: { query } } as any

  const sshAccessSetAdapter = {
    applyAccessSet: jest.fn().mockResolvedValue({
      appliedGeneration: generationRow.generation,
      listenerReady: true,
      hostPublicKey: 'ssh-ed25519 HOST',
      hostKeyFingerprint: 'SHA256:host',
    }),
  } as any

  const grantRepository = { delete: jest.fn() } as any
  const identityRepository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(), delete: jest.fn() } as any

  const service = new BoxSshReconciliationService(
    credentialRepository,
    generationRepository,
    sshAccessSetAdapter,
    grantRepository,
    identityRepository,
  )
  return {
    service,
    credentialRepository,
    queryBuilder,
    generationRepository,
    query,
    sshAccessSetAdapter,
    grantRepository,
    identityRepository,
  }
}

const boxId = 'box-1'
const credentialRow = {
  id: 'cred-1',
  grantId: 'grant-1',
  boxId,
  publicKey: 'ssh-ed25519 AAAA',
  publicKeyFingerprint: 'SHA256:abc',
  unixUser: 'root',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
}

describe('BoxSshReconciliationService', () => {
  describe('computeDesiredAccessSet', () => {
    it('queries active, non-expired credentials joined to an active, non-expired grant', async () => {
      const { service, credentialRepository, queryBuilder, query } = makeService([credentialRow], { generation: 5 })

      const result = await service.computeDesiredAccessSet(boxId)

      expect(credentialRepository.createQueryBuilder).toHaveBeenCalledWith('credential')
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('credential.grant', 'grant')
      expect(queryBuilder.where).toHaveBeenCalledWith('credential.boxId = :boxId', { boxId })
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('credential.status = :credentialStatus', {
        credentialStatus: TemporarySshCredentialStatus.ACTIVE,
      })
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('grant.status = :grantStatus', {
        grantStatus: BoxAccessGrantStatus.ACTIVE,
      })
      // Both expiry filters use the same `now` value passed to `getMany`; we
      // only assert the parameter keys since the exact Date instance is
      // incidental to the query shape under test.
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('credential.expiresAt > :now', expect.any(Object))
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('grant.expiresAt > :now', expect.any(Object))

      // Generation comes from the atomic upsert, not from the row count.
      expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [boxId])

      expect(result).toEqual({
        generation: 5,
        accesses: [
          {
            id: 'cred-1',
            grantId: 'grant-1',
            publicKey: 'ssh-ed25519 AAAA',
            fingerprint: 'SHA256:abc',
            unixUser: 'root',
            expiresAt: credentialRow.expiresAt,
          },
        ],
      })
    })

    it('returns an empty access list when no credential rows are active/current', async () => {
      const { service } = makeService([], { generation: 1 })

      const result = await service.computeDesiredAccessSet(boxId)

      expect(result).toEqual({ generation: 1, accesses: [] })
    })

    it('allocates a new generation on every call so retries observe monotonic values', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ generation: 1 }])
        .mockResolvedValueOnce([{ generation: 2 }])
      const getMany = jest.fn().mockResolvedValue([])
      const queryBuilder = makeQueryBuilder(getMany)
      const credentialRepository = { createQueryBuilder: jest.fn(() => queryBuilder) } as any
      const generationRepository = { manager: { query } } as any
      const service = new BoxSshReconciliationService(
        credentialRepository,
        generationRepository,
        {} as any,
        {} as any,
        {} as any,
      )

      const first = await service.computeDesiredAccessSet(boxId)
      const second = await service.computeDesiredAccessSet(boxId)

      expect(first.generation).toBe(1)
      expect(second.generation).toBe(2)
    })
  })

  describe('reconcile', () => {
    it('computes the desired snapshot and applies it through the Runner adapter', async () => {
      const { service, sshAccessSetAdapter } = makeService([credentialRow], { generation: 2 })
      const runner = { apiUrl: 'https://runner.example', apiKey: 'runner-key' } as any

      const status = await service.reconcile(runner, boxId)

      expect(sshAccessSetAdapter.applyAccessSet).toHaveBeenCalledWith(runner, boxId, 2, [
        expect.objectContaining({ id: 'cred-1', unixUser: 'root' }),
      ])
      expect(status.appliedGeneration).toBe(2)
    })
  })

  describe('reconcileOnStart', () => {
    const runner = { apiUrl: 'https://runner.example', apiKey: 'runner-key' } as any

    it('records a first-seen identity when none exists yet', async () => {
      const { service, identityRepository } = makeService([], { generation: 1 })

      await service.reconcileOnStart(runner, boxId, false)

      expect(identityRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          boxId,
          fingerprint: 'SHA256:host',
          identityGeneration: 1,
          status: BoxSshIdentityStatus.READY,
        }),
      )
    })

    it('refreshes lastSeenAt and stays READY when the fingerprint matches', async () => {
      const { service, identityRepository } = makeService([], { generation: 1 })
      identityRepository.findOne.mockResolvedValue({
        boxId,
        fingerprint: 'SHA256:host',
        identityGeneration: 1,
        status: BoxSshIdentityStatus.READY,
      })

      await service.reconcileOnStart(runner, boxId, false)

      expect(identityRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fingerprint: 'SHA256:host',
          identityGeneration: 1,
          status: BoxSshIdentityStatus.READY,
        }),
      )
    })

    it('accepts a mismatched fingerprint and bumps the generation during an approved restore', async () => {
      const { service, identityRepository } = makeService([], { generation: 1 })
      identityRepository.findOne.mockResolvedValue({
        boxId,
        fingerprint: 'SHA256:old',
        identityGeneration: 3,
        status: BoxSshIdentityStatus.READY,
      })

      await service.reconcileOnStart(runner, boxId, true)

      expect(identityRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fingerprint: 'SHA256:host',
          identityGeneration: 4,
          status: BoxSshIdentityStatus.READY,
        }),
      )
    })

    it('marks DEGRADED on an unexplained fingerprint mismatch outside a restore', async () => {
      const { service, identityRepository } = makeService([], { generation: 1 })
      identityRepository.findOne.mockResolvedValue({
        boxId,
        fingerprint: 'SHA256:old',
        identityGeneration: 1,
        status: BoxSshIdentityStatus.READY,
      })

      await service.reconcileOnStart(runner, boxId, false)

      expect(identityRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fingerprint: 'SHA256:old',
          identityGeneration: 1,
          status: BoxSshIdentityStatus.DEGRADED,
        }),
      )
    })

    it('does not throw when the Runner apply fails -- box start must not be blocked by SSH', async () => {
      const { service, sshAccessSetAdapter, identityRepository } = makeService([], { generation: 1 })
      sshAccessSetAdapter.applyAccessSet.mockRejectedValue(new Error('guest unreachable'))

      await expect(service.reconcileOnStart(runner, boxId, false)).resolves.toBeUndefined()
      expect(identityRepository.save).not.toHaveBeenCalled()
    })
  })

  describe('cleanupForDestroyedBox', () => {
    it('deletes credentials, grants, identity, and generation rows for the box', async () => {
      const { service, credentialRepository, grantRepository, identityRepository, generationRepository } = makeService(
        [],
        { generation: 1 },
      )
      credentialRepository.delete = jest.fn()
      generationRepository.delete = jest.fn()

      await service.cleanupForDestroyedBox(boxId)

      expect(credentialRepository.delete).toHaveBeenCalledWith({ boxId })
      expect(grantRepository.delete).toHaveBeenCalledWith({ boxId })
      expect(identityRepository.delete).toHaveBeenCalledWith({ boxId })
      expect(generationRepository.delete).toHaveBeenCalledWith({ boxId })
    })
  })
})
