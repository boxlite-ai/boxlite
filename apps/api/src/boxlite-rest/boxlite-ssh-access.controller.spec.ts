/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteSshAccessController } from './boxlite-ssh-access.controller'
import { SshCertificateError, SshCertificateErrorCode } from '../box/services/ssh-certificate/ssh-certificate.errors'
import { SshCertificateCredential } from '../box/entities/ssh-certificate-credential.entity'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { buildKnownHosts } from './mappers/ssh-certificate.mapper'

const TUNNEL_URI = 'https://22-d-6162632d626f78.proxy.example.com'

function authContext(organizationId = 'org-1'): OrganizationAuthContext {
  return { organizationId, organization: { id: organizationId } } as OrganizationAuthContext
}

function credential(overrides: Partial<SshCertificateCredential> = {}): SshCertificateCredential {
  return {
    id: 'cred-1',
    boxId: 'box-1',
    organizationId: 'org-1',
    certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA',
    publicKey: 'ssh-ed25519 AAAA',
    fingerprint: 'SHA256:abc',
    serial: '1234567890123456789',
    caKeyId: 'ca-key-1',
    validAfter: new Date('2026-07-25T11:59:30Z'),
    expiresAt: new Date('2026-07-25T12:05:00Z'),
    revokedAt: null,
    createdAt: new Date('2026-07-25T12:00:00Z'),
    updatedAt: new Date('2026-07-25T12:00:00Z'),
    ...overrides,
  } as SshCertificateCredential
}

function makeController() {
  const boxService = { getNetworkTunnelUrl: jest.fn().mockResolvedValue(TUNNEL_URI) }
  const sshCertificateService = {
    issue: jest.fn().mockResolvedValue(credential()),
    listActive: jest.fn().mockResolvedValue([credential()]),
    revoke: jest.fn().mockResolvedValue(credential({ revokedAt: new Date('2026-07-25T12:01:00Z') })),
  }
  const controller = new BoxliteSshAccessController(boxService as never, sshCertificateService as never)
  return { controller, boxService, sshCertificateService }
}

describe('BoxliteSshAccessController', () => {
  describe('create', () => {
    it('rejects a request with no body using the documented error code', async () => {
      const { controller, sshCertificateService } = makeController()

      await expect(
        controller.createCertificate(authContext(), 'box-1', undefined),
      ).rejects.toMatchObject({ code: SshCertificateErrorCode.SSH_PUBLIC_KEY_REQUIRED })
      expect(sshCertificateService.issue).not.toHaveBeenCalled()
    })

    it('rejects a body missing public_key without calling the signer', async () => {
      const { controller, sshCertificateService } = makeController()

      await expect(
        controller.createCertificate(authContext(), 'box-1', {} as never),
      ).rejects.toBeInstanceOf(SshCertificateError)
      expect(sshCertificateService.issue).not.toHaveBeenCalled()
    })

    it('issues scoped to the caller organization and returns public metadata only', async () => {
      const { controller, sshCertificateService } = makeController()

      const dto = await controller.createCertificate(authContext('org-1'), 'box-1', {
        public_key: 'ssh-ed25519 AAAA',
      })

      expect(sshCertificateService.issue).toHaveBeenCalledWith({
        boxId: 'box-1',
        organizationId: 'org-1',
        publicKey: 'ssh-ed25519 AAAA',
        expiresInMinutes: undefined,
      })
      expect(dto.id).toBe('cred-1')
      expect(dto.port).toBe(22)
      // No key material may appear. `ssh_command` legitimately contains the
      // literal placeholder `<private-key>`, so assert on PEM markers and on
      // the absence of any field that could carry a key.
      expect(JSON.stringify(dto)).not.toContain('PRIVATE KEY')
      expect(Object.keys(dto)).not.toContain('private_key')
    })

    it('returns a uint64 serial without precision loss', async () => {
      // Regression: `Number('1234567890123456789')` is 1234567890123456800.
      // The serial identifies the certificate to the CA, so it must survive
      // the mapping exactly.
      const { controller } = makeController()

      const dto = await controller.createCertificate(authContext(), 'box-1', { public_key: 'k' })

      expect(dto.serial).toBe('1234567890123456789')
      expect(JSON.stringify(dto)).toContain('"serial":"1234567890123456789"')
    })

    it('passes an explicit TTL through and leaves an absent one to server policy', async () => {
      const { controller, sshCertificateService } = makeController()

      await controller.createCertificate(authContext(), 'box-1', { public_key: 'k' }, '30')
      expect(sshCertificateService.issue).toHaveBeenLastCalledWith(
        expect.objectContaining({ expiresInMinutes: 30 }),
      )

      await controller.createCertificate(authContext(), 'box-1', { public_key: 'k' })
      expect(sshCertificateService.issue).toHaveBeenLastCalledWith(
        expect.objectContaining({ expiresInMinutes: undefined }),
      )
    })

    it('forwards a non-numeric TTL so the service rejects it rather than defaulting silently', async () => {
      const { controller, sshCertificateService } = makeController()

      await controller.createCertificate(authContext(), 'box-1', { public_key: 'k' }, 'soon')

      const { expiresInMinutes } = sshCertificateService.issue.mock.calls.at(-1)[0]
      expect(Number.isNaN(expiresInMinutes)).toBe(true)
    })

    it('builds the endpoint from the region-aware tunnel URL for guest port 22', async () => {
      const { controller, boxService } = makeController()

      const dto = await controller.createCertificate(authContext('org-1'), 'box-1', { public_key: 'k' })

      expect(boxService.getNetworkTunnelUrl).toHaveBeenCalledWith('box-1', 'org-1', 22)
      expect(dto.host).toBe('22-d-6162632d626f78.proxy.example.com')
      expect(dto.ssh_command).toContain(`root@${dto.host}`)
      expect(dto.proxy_command).toContain(dto.host)
    })
  })

  describe('known_hosts', () => {
    // Pins the current, honest state: the server has no path to the guest's
    // host key, so this field ships empty and the OpenAPI contract marks it
    // optional. When host-key delivery lands, this test should be replaced by
    // one asserting a real known_hosts line — not deleted.
    it('is empty because no host key reaches the API yet', async () => {
      const { controller } = makeController()

      const dto = await controller.createCertificate(authContext(), 'box-1', { public_key: 'k' })

      expect(dto.known_hosts).toBe('')
    })

    it('renders a known_hosts line once a host key is available', () => {
      // The mapper is ready for delivery; only the caller-side plumbing is
      // missing, so exercise it directly rather than pretending it is wired.
      const line = buildKnownHosts('22-d-abc.example.com', 'ssh-ed25519 AAAAHOSTKEY')

      expect(line).toBe('[22-d-abc.example.com]:22 ssh-ed25519 AAAAHOSTKEY')
    })
  })

  describe('box ownership', () => {
    // The guards authorize the organization and WRITE_BOXES but never resolve
    // boxId; getNetworkTunnelUrl's org-scoped lookup is the only box check.
    // It therefore has to run before anything irreversible.
    it('never signs a certificate for a box the caller cannot resolve', async () => {
      const { controller, boxService, sshCertificateService } = makeController()
      boxService.getNetworkTunnelUrl.mockRejectedValue(new Error('Box not found'))

      await expect(
        controller.createCertificate(authContext(), 'someone-elses-box', { public_key: 'k' }),
      ).rejects.toThrow('Box not found')

      // No KMS operation spent, no credential row persisted.
      expect(sshCertificateService.issue).not.toHaveBeenCalled()
    })

    it('checks box ownership before issuing, not after', async () => {
      const { controller, boxService, sshCertificateService } = makeController()
      const order: string[] = []
      boxService.getNetworkTunnelUrl.mockImplementation(async () => {
        order.push('resolve-box')
        return TUNNEL_URI
      })
      sshCertificateService.issue.mockImplementation(async () => {
        order.push('sign')
        return credential()
      })

      await controller.createCertificate(authContext(), 'box-1', { public_key: 'k' })

      expect(order).toEqual(['resolve-box', 'sign'])
    })

    it('does not list credentials for a box the caller cannot resolve', async () => {
      const { controller, boxService, sshCertificateService } = makeController()
      boxService.getNetworkTunnelUrl.mockRejectedValue(new Error('Box not found'))

      await expect(controller.listCertificates(authContext(), 'someone-elses-box')).rejects.toThrow(
        'Box not found',
      )
      expect(sshCertificateService.listActive).not.toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('lists this box for this organization only', async () => {
      const { controller, sshCertificateService } = makeController()

      const result = await controller.listCertificates(authContext('org-1'), 'box-1')

      expect(sshCertificateService.listActive).toHaveBeenCalledWith('box-1', 'org-1')
      expect(result.certificates).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
      expect(Object.keys(result.certificates[0])).not.toContain('private_key')
    })
  })

  describe('revoke', () => {
    it('revokes exactly the addressed credential, scoped to box and organization', async () => {
      const { controller, sshCertificateService } = makeController()

      await controller.revokeCertificate(authContext('org-1'), 'box-1', 'cred-1')

      expect(sshCertificateService.revoke).toHaveBeenCalledWith({
        boxId: 'box-1',
        organizationId: 'org-1',
        credentialId: 'cred-1',
      })
      // There is no revoke-all in this contract.
      expect(sshCertificateService.revoke).toHaveBeenCalledTimes(1)
    })
  })
})
