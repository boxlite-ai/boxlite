/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { GuestSshTrustService } from './guest-ssh-trust.service'

function makeService(caKeys: { current?: unknown; next?: unknown } = {}) {
  const caKeyService = {
    findCurrent: jest.fn().mockResolvedValue(caKeys.current ?? null),
    findNext: jest.fn().mockResolvedValue(caKeys.next ?? null),
  }
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'sshCertificate.guestListenAddr') return '0.0.0.0:22'
      throw new Error(`unexpected config key ${key}`)
    }),
  }
  const service = new GuestSshTrustService(caKeyService as never, configService as never)
  return { service, caKeyService, configService }
}

const CURRENT = { keyId: 'ca-key-1', publicKey: 'ssh-ed25519 AAAACURRENT' }
const NEXT = { keyId: 'ca-key-2', publicKey: 'ssh-ed25519 AAAANEXT' }

describe('GuestSshTrustService', () => {
  it('returns null when the organization has no CA', async () => {
    // No CA provisioned means guest SSH is not enabled for this organization.
    // That is a normal state, not an error — the box simply boots without a
    // listener.
    const { service, caKeyService } = makeService()

    await expect(service.resolveForNewBox('org-1', 'box-1')).resolves.toBeNull()
    expect(caKeyService.findCurrent).toHaveBeenCalledWith('org-1')
  })

  it('pins the bundle to the organization and box', async () => {
    const { service } = makeService({ current: CURRENT })

    const trust = await service.resolveForNewBox('org-1', 'box-1')

    expect(trust).toEqual({
      listenAddr: '0.0.0.0:22',
      organizationId: 'org-1',
      boxId: 'box-1',
      caKeys: [CURRENT],
    })
  })

  it('includes next alongside current while a rotation is in flight', async () => {
    // A box created mid-rotation must keep authenticating after the signer
    // switches to `next`, otherwise it is locked out until it is replaced.
    const { service } = makeService({ current: CURRENT, next: NEXT })

    const trust = await service.resolveForNewBox('org-1', 'box-1')

    expect(trust?.caKeys).toEqual([CURRENT, NEXT])
  })

  it('never returns private material', async () => {
    const { service } = makeService({ current: { ...CURRENT, providerKeyRef: 'arn:aws:kms:...' } })

    const trust = await service.resolveForNewBox('org-1', 'box-1')

    const rendered = JSON.stringify(trust)
    expect(rendered).not.toContain('providerKeyRef')
    expect(rendered).not.toContain('arn:aws:kms')
    expect(Object.keys(trust!.caKeys[0]).sort()).toEqual(['keyId', 'publicKey'])
  })

  it('takes the listen address from configuration', async () => {
    const { service, configService } = makeService({ current: CURRENT })
    configService.get.mockReturnValue('127.0.0.1:2222')

    const trust = await service.resolveForNewBox('org-1', 'box-1')

    expect(trust?.listenAddr).toBe('127.0.0.1:2222')
  })
})
