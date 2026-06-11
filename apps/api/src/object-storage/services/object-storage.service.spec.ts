/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts'
import { ObjectStorageService } from './object-storage.service'

const mockSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  AssumeRoleCommand: jest.fn().mockImplementation((input) => ({ input })),
}))

describe('ObjectStorageService', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  function buildService(values: Record<string, unknown>) {
    const configService = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        const value = values[key]
        if (value === undefined) {
          throw new Error(`Missing config: ${key}`)
        }
        return value
      }),
    }
    return new ObjectStorageService(configService as any)
  }

  const awsConfig = {
    's3.endpoint': 'https://s3.ap-southeast-1.amazonaws.com',
    's3.stsEndpoint': 'https://sts.ap-southeast-1.amazonaws.com',
    's3.defaultBucket': 'boxlite-dev-storage',
    's3.region': 'ap-southeast-1',
    's3.accountId': '123456789012',
    's3.roleName': 'boxlite-dev-s3-access',
  }

  it('vends AWS credentials via the SDK default chain when no static keys are set', async () => {
    mockSend.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'ASIA-test',
        SecretAccessKey: 'secret-test',
        SessionToken: 'token-test',
      },
    })
    const service = buildService(awsConfig)

    const access = await service.getPushAccess('org-1')

    // No `credentials` key at all → SDK default chain (ECS task role).
    expect(STSClient).toHaveBeenCalledWith({
      region: 'ap-southeast-1',
      endpoint: 'https://sts.ap-southeast-1.amazonaws.com',
      maxAttempts: 3,
    })
    expect(AssumeRoleCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        RoleArn: 'arn:aws:iam::123456789012:role/boxlite-dev-s3-access',
        DurationSeconds: 3600,
      }),
    )
    const sessionPolicy = JSON.parse((AssumeRoleCommand as unknown as jest.Mock).mock.calls[0][0].Policy)
    expect(sessionPolicy.Statement[0]).toMatchObject({
      Action: ['s3:PutObject', 's3:GetObject'],
      Resource: ['arn:aws:s3:::boxlite-dev-storage/org-1/*'],
    })
    expect(access).toMatchObject({
      accessKey: 'ASIA-test',
      secret: 'secret-test',
      sessionToken: 'token-test',
      organizationId: 'org-1',
      bucket: 'boxlite-dev-storage',
    })
  })

  it('still signs with static keys when they are configured', async () => {
    mockSend.mockResolvedValue({
      Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c' },
    })
    const service = buildService({
      ...awsConfig,
      's3.accessKey': 'static-id',
      's3.secretKey': 'static-secret',
    })

    await service.getPushAccess('org-1')

    expect(STSClient).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { accessKeyId: 'static-id', secretAccessKey: 'static-secret' },
      }),
    )
  })

  it('rejects a lone static key instead of silently using the default chain', async () => {
    const service = buildService({ ...awsConfig, 's3.accessKey': 'static-id' })

    await expect(service.getPushAccess('org-1')).rejects.toThrow(/S3_ACCESS_KEY and S3_SECRET_KEY must be set together/)
    expect(STSClient).not.toHaveBeenCalled()
  })

  it('rejects the MinIO path without static keys instead of sending an unsigned request', async () => {
    const service = buildService({
      ...awsConfig,
      's3.endpoint': 'http://minio:9000',
      's3.stsEndpoint': 'http://minio:9000/minio/v1/assume-role',
    })

    await expect(service.getPushAccess('org-1')).rejects.toThrow(BadRequestException)
    await expect(service.getPushAccess('org-1')).rejects.toThrow(/S3_ACCESS_KEY and S3_SECRET_KEY/)
    expect(AssumeRoleCommand).not.toHaveBeenCalled()
  })
})
