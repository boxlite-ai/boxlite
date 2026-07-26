/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Repository } from 'typeorm'
import { OrganizationSshCaKey, OrganizationSshCaKeyStatus } from '../../entities/organization-ssh-ca-key.entity'
import { OrganizationSshCaKeyService } from './organization-ssh-ca-key.service'
import { SshCertificateErrorCode } from './ssh-certificate.errors'

const ORGANIZATION_ID = '11111111-2222-3333-4444-555555555555'

function buildService(row: OrganizationSshCaKey | null) {
  const findOne = jest.fn().mockResolvedValue(row)
  const service = new OrganizationSshCaKeyService({ findOne } as unknown as Repository<OrganizationSshCaKey>)
  return { service, findOne }
}

describe('OrganizationSshCaKeyService.getCurrent', () => {
  it('resolves the organization current CA key', async () => {
    const row = { keyId: 'org-ca-v1', providerKeyRef: 'arn:aws:kms:...' } as OrganizationSshCaKey
    const { service, findOne } = buildService(row)

    await expect(service.getCurrent(ORGANIZATION_ID)).resolves.toBe(row)
    expect(findOne).toHaveBeenCalledWith({
      where: { organizationId: ORGANIZATION_ID, status: OrganizationSshCaKeyStatus.CURRENT },
    })
  })

  it('reports SSH_CA_UNAVAILABLE when the organization has no current CA key', async () => {
    const { service } = buildService(null)

    await expect(service.getCurrent(ORGANIZATION_ID)).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
  })
})
