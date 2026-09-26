/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TypedConfigService } from '../../config/typed-config.service'

/**
 * Where a registry password goes when a credential is added.
 *
 * Write-only on purpose: there is no `get`. The API stores a password and
 * destroys it; reading one back is the registry proxy's job alone. On GCP the
 * API's role holds no `versions.access` either, so a read method here would be
 * one that fails in every deployed stage.
 */
export interface SecretStore {
  /**
   * Stores `password` in a secret named after the credential and returns the
   * name of the version holding it, which is what the credential row records.
   */
  put(credentialId: string, password: string): Promise<string>
  /** Destroys the version `put` returned. One that is already gone resolves. */
  destroy(secretVersion: string): Promise<void>
}

/**
 * Every credential's secret starts with this. The IAM conditions on both sides
 * name the same prefix, so a secret without it is one neither can touch.
 */
export const REGISTRY_SECRET_PREFIX = 'registry-credential-'

/**
 * Seven days from destroying a version to its being gone. Secret Manager has
 * no recovery window, and this is its equivalent: a destroyed version is
 * disabled at once and can be enabled again until the delay runs out.
 */
const VERSION_DESTROY_TTL_SECONDS = 7 * 24 * 60 * 60

const GRPC_NOT_FOUND = 5

/**
 * Builds the store the configuration names, or null when it names none. Null
 * leaves private registries off, which is how an API without
 * `REGISTRY_SECRET_STORE` behaves.
 */
export function createSecretStore(configService: TypedConfigService): SecretStore | null {
  const backend = configService.get('registrySecrets.store')
  if (!backend) {
    return null
  }
  if (backend === 'gcp') {
    return new GcpSecretManagerStore()
  }
  if (backend === 'file') {
    // Plain files hold the password in the clear. That is acceptable on a
    // developer's machine and nowhere else, so production refuses to boot.
    if (configService.get('production')) {
      throw new Error('REGISTRY_SECRET_STORE "file" keeps passwords in plain files and is refused in production')
    }
    const directory = configService.get('registrySecrets.directory')
    if (!directory) {
      throw new Error('REGISTRY_SECRET_DIR must be set when REGISTRY_SECRET_STORE is "file"')
    }
    return new FileSecretStore(directory)
  }
  throw new Error(`REGISTRY_SECRET_STORE must be "gcp" or "file", got "${backend}"`)
}

class GcpSecretManagerStore implements SecretStore {
  // No credentials or project are passed. Both come from Application Default
  // Credentials: the service account Cloud Run attaches, and the project the
  // service runs in, which is where the stack binds the API's role.
  private readonly client = new SecretManagerServiceClient()

  async put(credentialId: string, password: string): Promise<string> {
    const project = await this.client.getProjectId()
    const secretId = `${REGISTRY_SECRET_PREFIX}${credentialId}`
    const [secret] = await this.client.createSecret({
      parent: `projects/${project}`,
      secretId,
      secret: {
        // Google-managed keys, replicated where Google chooses. A
        // customer-managed key would be one more key to run, and nothing here
        // requires one.
        replication: { automatic: {} },
        versionDestroyTtl: { seconds: VERSION_DESTROY_TTL_SECONDS },
      },
    })
    const [version] = await this.client.addSecretVersion({
      parent: secret.name,
      payload: { data: Buffer.from(password, 'utf8') },
    })
    if (!version.name) {
      throw new Error(`Secret Manager added a version to ${secret.name} without naming it`)
    }
    return version.name
  }

  async destroy(secretVersion: string): Promise<void> {
    try {
      await this.client.destroySecretVersion({ name: secretVersion })
    } catch (error) {
      if ((error as { code?: number })?.code === GRPC_NOT_FOUND) {
        return
      }
      throw error
    }
  }
}

/**
 * One file per credential under a directory, for a local stack that has no
 * Secret Manager. The registry proxy's file store reads the same directory.
 */
class FileSecretStore implements SecretStore {
  constructor(private readonly directory: string) {}

  async put(credentialId: string, password: string): Promise<string> {
    const name = `${REGISTRY_SECRET_PREFIX}${credentialId}`
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Readable by this user alone, and `wx` so a put never overwrites a
    // password an earlier one left.
    await writeFile(join(this.directory, name), password, { mode: 0o600, flag: 'wx' })
    return name
  }

  async destroy(secretVersion: string): Promise<void> {
    // `force` resolves when the file is already gone, as a destroyed version does.
    await rm(join(this.directory, secretVersion), { force: true })
  }
}
