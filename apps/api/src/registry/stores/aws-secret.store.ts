// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import type { SecretStore } from './secret.store'

export type AwsSecretScope = { region: string; accountId: string; prefix: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function secretArn(scope: AwsSecretScope, version: string): string {
  const match =
    /^(arn:aws:secretsmanager:([a-z0-9-]+):([0-9]{12}):secret:([A-Za-z0-9_-]+))\/versions\/([0-9a-f-]{36})$/.exec(
      version,
    )
  const tail = match?.[4].slice(scope.prefix.length) ?? ''
  const storageId = tail.slice(0, -7)
  if (
    !match ||
    match[2] !== scope.region ||
    match[3] !== scope.accountId ||
    !match[4].startsWith(scope.prefix) ||
    !UUID.test(storageId) ||
    !/^[A-Za-z0-9]{6}$/.test(tail.slice(-6)) ||
    tail.at(-7) !== '-' ||
    match[5] !== storageId
  ) {
    throw new Error('Registry secret version is outside this AWS credential store')
  }
  return match[1]
}

/** Each write owns one secret; deleting it immediately revokes access and retains recovery for seven days. */
export class AwsSecretManagerStore implements SecretStore {
  private readonly client: Pick<SecretsManagerClient, 'send'>

  constructor(
    private readonly scope: AwsSecretScope,
    client?: Pick<SecretsManagerClient, 'send'>,
  ) {
    if (
      !/^[a-z]{2}-[a-z0-9-]+-\d+$/.test(scope.region) ||
      !/^\d{12}$/.test(scope.accountId) ||
      !/^registry-credential-[A-Za-z0-9_-]+-$/.test(scope.prefix)
    ) {
      throw new Error('AWS registry secrets require a region, account ID and stage credential prefix')
    }
    this.client = client ?? new SecretsManagerClient({ region: scope.region })
  }

  async put(storageId: string, password: string): Promise<string> {
    if (!UUID.test(storageId) || !password)
      throw new Error('Registry secrets require a UUID storage ID and nonempty password')
    const name = this.scope.prefix + storageId
    let result: { ARN?: string; VersionId?: string }
    try {
      result = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          ClientRequestToken: storageId,
          SecretString: password,
        }),
      )
    } catch (error) {
      if ((error as Error).name !== 'ResourceExistsException') throw error
      // Retrying a lost create response writes the same immutable version token, without reading the password.
      result = await this.client.send(
        new PutSecretValueCommand({
          SecretId: name,
          ClientRequestToken: storageId,
          SecretString: password,
        }),
      )
    }
    const version = `${result.ARN}/versions/${result.VersionId}`
    secretArn(this.scope, version)
    return version
  }

  async destroy(version: string): Promise<void> {
    const arn = secretArn(this.scope, version)
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: arn,
          RecoveryWindowInDays: 7,
          ForceDeleteWithoutRecovery: false,
        }),
      )
    } catch (error) {
      if (
        (error as Error).name === 'ResourceNotFoundException' ||
        ((error as Error).name === 'InvalidRequestException' &&
          /scheduled for deletion/i.test((error as Error).message))
      )
        return
      throw error
    }
  }
}
