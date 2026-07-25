/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { TemporarySshCredentialService } from './temporary-ssh-credential.service'
import { TemporarySshCredentialStatus } from '../enums/temporary-ssh-credential-status.enum'
import { BoxAccessGrantScope } from '../enums/box-access-grant-scope.enum'
import { BoxSshIdentityStatus } from '../enums/box-ssh-identity-status.enum'
import { BoxState } from '../enums/box-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'

function lengthPrefixed(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([length, bytes])
}

function ed25519Line(comment = 'user@host'): string {
  const blob = Buffer.concat([lengthPrefixed(Buffer.from('ssh-ed25519')), lengthPrefixed(Buffer.alloc(32, 0x22))])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

const runningBox = { id: 'box-1', state: BoxState.STARTED, runnerId: 'runner-1' }
const grant = {
  id: 'grant-1',
  boxId: 'box-1',
  scopes: [BoxAccessGrantScope.SSH],
  expiresAt: new Date(Date.now() + 3600_000),
}
const runner = { id: 'runner-1', apiUrl: 'http://runner', apiKey: 'k' }
const applyStatus = {
  appliedGeneration: 1,
  listenerReady: true,
  hostPublicKey: 'ssh-ed25519 AAAA',
  hostKeyFingerprint: 'SHA256:host',
}

function makeService() {
  // `save` snapshots a shallow copy of the argument on each call: the
  // service mutates and re-saves the SAME entity object across the
  // PENDING->ACTIVE / REVOKING->REVOKED transitions, so recording the live
  // reference in `mock.calls` would make every earlier call site appear to
  // have received the final, latest-mutated status.
  const savedSnapshots: any[] = []
  const credentialRepository = {
    save: jest.fn((row) => {
      const saved = { id: 'cred-1', createdAt: new Date(), ...row }
      // Record a copy distinct from `saved` itself: the service mutates and
      // re-saves the same returned entity object across status
      // transitions, and a shared reference here would let that later
      // mutation retroactively change what this call appeared to receive.
      savedSnapshots.push({ ...saved })
      return Promise.resolve(saved)
    }),
    remove: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn().mockResolvedValue(null),
  } as any
  const identityRepository = { findOne: jest.fn().mockResolvedValue(null) } as any
  const boxService = { findOneByIdOrName: jest.fn().mockResolvedValue(runningBox) } as any
  const runnerService = { findOneOrFail: jest.fn().mockResolvedValue(runner) } as any
  const reconciliationService = {
    computeDesiredAccessSet: jest.fn().mockResolvedValue({ generation: 5, accesses: [] }),
  } as any
  const sshAccessSetAdapter = { applyAccessSet: jest.fn().mockResolvedValue(applyStatus) } as any
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('proxy.dev.boxlite.ai'),
    get: jest.fn().mockReturnValue(true),
  } as any

  const service = new TemporarySshCredentialService(
    credentialRepository,
    identityRepository,
    boxService,
    runnerService,
    reconciliationService,
    sshAccessSetAdapter,
    configService,
  )
  return {
    service,
    credentialRepository,
    identityRepository,
    boxService,
    runnerService,
    reconciliationService,
    sshAccessSetAdapter,
    configService,
    savedSnapshots,
  }
}

describe('TemporarySshCredentialService', () => {
  describe('create', () => {
    it('saves PENDING, applies the full snapshot including the candidate, then promotes to ACTIVE', async () => {
      const { service, sshAccessSetAdapter, reconciliationService, savedSnapshots } = makeService()

      const result = await service.create(
        'box-1',
        { grantId: 'grant-1', publicKey: ed25519Line() },
        grant as any,
        'user-1',
      )

      expect(savedSnapshots[0]).toMatchObject({ status: TemporarySshCredentialStatus.PENDING })
      expect(reconciliationService.computeDesiredAccessSet).toHaveBeenCalledWith('box-1')
      const appliedAccesses = sshAccessSetAdapter.applyAccessSet.mock.calls[0][3]
      expect(appliedAccesses).toHaveLength(1)
      expect(appliedAccesses[0].id).toBe('cred-1')
      expect(savedSnapshots[1]).toMatchObject({ status: TemporarySshCredentialStatus.ACTIVE })
      expect(result.publicKeyFingerprint).toMatch(/^SHA256:/)
      expect(result.endpoint).toBe('22-d-626f782d31.proxy.dev.boxlite.ai')
      expect(result.knownHostsEntry).toContain(applyStatus.hostPublicKey)
      expect(result).not.toHaveProperty('publicKey')
    })

    it('deletes the candidate and propagates the error when apply fails', async () => {
      const { service, credentialRepository, sshAccessSetAdapter } = makeService()
      sshAccessSetAdapter.applyAccessSet.mockRejectedValue(new Error('guest unreachable'))

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, grant as any, 'user-1'),
      ).rejects.toThrow('guest unreachable')

      expect(credentialRepository.remove).toHaveBeenCalled()
    })

    it('rejects when the grant does not belong to the box', async () => {
      const { service } = makeService()
      const mismatchedGrant = { ...grant, boxId: 'other-box' }

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, mismatchedGrant as any, 'user-1'),
      ).rejects.toThrow(ForbiddenException)
    })

    it('rejects when the grant lacks the ssh scope', async () => {
      const { service } = makeService()
      const noScopeGrant = { ...grant, scopes: [] }

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, noScopeGrant as any, 'user-1'),
      ).rejects.toThrow(ForbiddenException)
    })

    it('rejects a malformed public key before touching the repository', async () => {
      const { service, credentialRepository } = makeService()

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: 'not-a-key' }, grant as any, 'user-1'),
      ).rejects.toThrow(BadRequestError)
      expect(credentialRepository.save).not.toHaveBeenCalled()
    })

    it('rejects create when the box is not running', async () => {
      const { service, boxService, credentialRepository } = makeService()
      boxService.findOneByIdOrName.mockResolvedValue({ id: 'box-1', state: BoxState.STOPPED, runnerId: null })

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, grant as any, 'user-1'),
      ).rejects.toThrow(ConflictException)
      expect(credentialRepository.save).not.toHaveBeenCalled()
    })

    it('rejects a duplicate active credential for the same key and user', async () => {
      const { service, credentialRepository } = makeService()
      credentialRepository.findOne.mockResolvedValue({ id: 'existing', status: TemporarySshCredentialStatus.ACTIVE })

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, grant as any, 'user-1'),
      ).rejects.toThrow(ConflictException)
    })

    it('rejects create while the box SSH identity is DEGRADED', async () => {
      const { service, identityRepository, credentialRepository } = makeService()
      identityRepository.findOne.mockResolvedValue({ boxId: 'box-1', status: BoxSshIdentityStatus.DEGRADED })

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, grant as any, 'user-1'),
      ).rejects.toThrow(ConflictException)
      expect(credentialRepository.save).not.toHaveBeenCalled()
    })

    it('clamps the credential expiry to the parent grant expiry', async () => {
      const { service, credentialRepository } = makeService()
      const soonExpiringGrant = { ...grant, expiresAt: new Date(Date.now() + 60_000) }

      await service.create(
        'box-1',
        { grantId: 'grant-1', publicKey: ed25519Line(), expiresInSeconds: 3600 },
        soonExpiringGrant as any,
        'user-1',
      )

      const saved = credentialRepository.save.mock.calls[0][0]
      expect(saved.expiresAt.getTime()).toBe(soonExpiringGrant.expiresAt.getTime())
    })

    it('rejects with 503 while issuance is disabled, without touching the repository', async () => {
      const { service, configService, credentialRepository } = makeService()
      configService.get.mockReturnValue(false)

      await expect(
        service.create('box-1', { grantId: 'grant-1', publicKey: ed25519Line() }, grant as any, 'user-1'),
      ).rejects.toThrow(ServiceUnavailableException)
      expect(credentialRepository.save).not.toHaveBeenCalled()
    })
  })

  describe('revoke', () => {
    it('for a running box: marks REVOKING, applies the reduced snapshot, then REVOKED', async () => {
      const { service, credentialRepository, sshAccessSetAdapter, savedSnapshots } = makeService()
      credentialRepository.findOne.mockResolvedValue({
        id: 'cred-1',
        boxId: 'box-1',
        status: TemporarySshCredentialStatus.ACTIVE,
      })

      await service.revoke('box-1', 'cred-1', 'org-1')

      expect(savedSnapshots[0]).toMatchObject({ status: TemporarySshCredentialStatus.REVOKING })
      expect(sshAccessSetAdapter.applyAccessSet).toHaveBeenCalled()
      expect(savedSnapshots[1]).toMatchObject({ status: TemporarySshCredentialStatus.REVOKED })
    })

    it('leaves status REVOKING (not REVOKED) when apply fails', async () => {
      const { service, credentialRepository, sshAccessSetAdapter } = makeService()
      credentialRepository.findOne.mockResolvedValue({
        id: 'cred-1',
        boxId: 'box-1',
        status: TemporarySshCredentialStatus.ACTIVE,
      })
      sshAccessSetAdapter.applyAccessSet.mockRejectedValue(new Error('guest unreachable'))

      await expect(service.revoke('box-1', 'cred-1', 'org-1')).rejects.toThrow('guest unreachable')

      const savedCalls = credentialRepository.save.mock.calls
      expect(savedCalls).toHaveLength(1)
      expect(savedCalls[0][0]).toMatchObject({ status: TemporarySshCredentialStatus.REVOKING })
    })

    it('for a stopped box: persists REVOKED directly without calling the guest', async () => {
      const { service, credentialRepository, boxService, sshAccessSetAdapter } = makeService()
      boxService.findOneByIdOrName.mockResolvedValue({ id: 'box-1', state: BoxState.STOPPED, runnerId: null })
      credentialRepository.findOne.mockResolvedValue({
        id: 'cred-1',
        boxId: 'box-1',
        status: TemporarySshCredentialStatus.ACTIVE,
      })

      await service.revoke('box-1', 'cred-1', 'org-1')

      expect(sshAccessSetAdapter.applyAccessSet).not.toHaveBeenCalled()
      expect(credentialRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TemporarySshCredentialStatus.REVOKED }),
      )
    })

    it('is a no-op for an already-revoked credential', async () => {
      const { service, credentialRepository, sshAccessSetAdapter } = makeService()
      credentialRepository.findOne.mockResolvedValue({
        id: 'cred-1',
        boxId: 'box-1',
        status: TemporarySshCredentialStatus.REVOKED,
      })

      await service.revoke('box-1', 'cred-1', 'org-1')

      expect(credentialRepository.save).not.toHaveBeenCalled()
      expect(sshAccessSetAdapter.applyAccessSet).not.toHaveBeenCalled()
    })

    it('throws NotFoundException for a credential that does not belong to the box', async () => {
      const { service, credentialRepository } = makeService()
      credentialRepository.findOne.mockResolvedValue(null)

      await expect(service.revoke('box-1', 'missing', 'org-1')).rejects.toThrow(NotFoundException)
    })
  })

  describe('list', () => {
    it('never includes the public key body', async () => {
      const { service, credentialRepository } = makeService()
      credentialRepository.find.mockResolvedValue([
        {
          id: 'cred-1',
          grantId: 'grant-1',
          boxId: 'box-1',
          publicKey: ed25519Line(),
          publicKeyFingerprint: 'SHA256:abc',
          status: TemporarySshCredentialStatus.ACTIVE,
          expiresAt: new Date(),
          createdBy: 'user-1',
          createdAt: new Date(),
        },
      ])

      const result = await service.list('box-1', 'org-1')

      expect(result[0]).not.toHaveProperty('publicKey')
    })
  })
})
