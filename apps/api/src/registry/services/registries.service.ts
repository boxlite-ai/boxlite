/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { parseImageRef, upstreamRefOf } from '../../image/utils/image-ref.util'
import { CreateRegistryCredentialDto } from '../dto/registry-credential.dto'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'
import { SecretStore } from '../stores/secret.store'
import { registryProxyHost } from '../utils/registry-proxy.util'
import { RegistryCredentialService } from './registry-credential.service'

/** The injection token the module binds `createSecretStore`'s answer to. */
export const SECRET_STORE = Symbol('SECRET_STORE')

const PG_UNIQUE_VIOLATION = '23505'

/**
 * An organization's registry logins, as its members manage them.
 *
 * The password is in this process for the length of one create: from the
 * request body to the secret store, never onto an entity, a log line or an
 * answer. What comes back, and what can be listed, is the row, which has no
 * password to leave out.
 */
@Injectable()
export class RegistriesService {
  private readonly logger = new Logger(RegistriesService.name)

  constructor(
    @InjectRepository(RegistryCredential)
    private readonly credentials: Repository<RegistryCredential>,
    @InjectRepository(Box)
    private readonly boxes: Repository<Box>,
    @Inject(SECRET_STORE)
    private readonly store: SecretStore | null,
    private readonly lookup: RegistryCredentialService,
  ) {}

  list(organizationId: string): Promise<RegistryCredential[]> {
    return this.credentials.find({ where: { organizationId }, order: { createdAt: 'ASC' } })
  }

  async create(
    organizationId: string,
    createdBy: string | null,
    request: CreateRegistryCredentialDto,
  ): Promise<RegistryCredential> {
    const store = this.enabledStore()
    const id = randomUUID()
    const repositoryPrefix = request.repositoryPrefix ?? ''

    // The secret first, so no row ever names a version that was never written.
    const secretVersion = await store.put(id, request.password)
    try {
      await this.credentials.insert({
        id,
        organizationId,
        kind: RegistryCredentialKind.BASIC,
        registryHost: request.registryHost,
        repositoryPrefix,
        username: request.username,
        secretVersion,
        createdBy,
      })
    } catch (error) {
      // A password no row points at would stay readable by the proxy, so it
      // is destroyed on the way out. The empty secret it leaves is harmless:
      // the API holds no permission to delete one.
      await this.destroyQuietly(secretVersion)
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        // The code names the conflict for an SDK, which would otherwise read a
        // bare 409 as a resource in the wrong state, as a delete's refusal is.
        throw new ConflictException({
          message: `A credential for ${request.registryHost}/${repositoryPrefix} already exists; remove it before adding another`,
          code: 'already_exists',
        })
      }
      throw error
    }
    return this.credentials.findOneByOrFail({ id })
  }

  /**
   * Remove a login, unless a box still pulls through it.
   *
   * A box counts when its image goes through the proxy, on this host, and this
   * login is the one the longest-prefix match picks for it now. A shorter login
   * shadowed by a longer one can go without breaking anything.
   *
   * The version is destroyed before the row is removed: the other order, on a
   * failure between the two, would leave a password the proxy can still read
   * with nothing listing it.
   */
  async delete(organizationId: string, id: string): Promise<void> {
    const credential = await this.credentials.findOneBy({ id, organizationId })
    if (!credential) {
      throw new NotFoundException(`Registry credential ${id} not found`)
    }
    const inUse = await this.boxesPullingThrough(credential)
    if (inUse.length > 0) {
      throw new ConflictException(
        `Registry credential ${id} cannot be removed while ${inUse.length} box(es) pull through it: ${inUse.join(', ')}`,
      )
    }

    await this.enabledStore().destroy(credential.secretVersion)
    await this.credentials.delete({ id, organizationId })
  }

  private async boxesPullingThrough(credential: RegistryCredential): Promise<string[]> {
    const proxyHost = registryProxyHost()
    if (!proxyHost) {
      return []
    }
    const candidates = await this.boxes
      .createQueryBuilder('box')
      .where('box.organizationId = :organizationId', { organizationId: credential.organizationId })
      .andWhere('box.desiredState != :destroyed', { destroyed: BoxDesiredState.DESTROYED })
      .andWhere('box.image LIKE :through', {
        // The prefix a proxy ref for this organization and host starts with.
        // `_` would be a LIKE wildcard, and neither a host nor a uuid holds one.
        through: `${proxyHost}/${credential.organizationId}/${credential.registryHost}/%`,
      })
      .select(['box.id', 'box.image'])
      .getMany()

    const inUse: string[] = []
    for (const box of candidates) {
      const { host, repository } = parseImageRef(upstreamRefOf(box.image as string))
      const picked = await this.lookup.findForRepository(credential.organizationId, host, repository)
      if (picked?.id === credential.id) {
        inUse.push(box.id)
      }
    }
    return inUse
  }

  /**
   * The store, or a 501 when this deployment keeps none: without it there is
   * nowhere to put a password, and without the proxy nothing would present
   * one. The code lets an SDK read it as unsupported rather than a fault.
   */
  private enabledStore(): SecretStore {
    if (!this.store || !registryProxyHost()) {
      throw new NotImplementedException({
        message: 'Private registries are not enabled in this deployment',
        code: 'unsupported',
      })
    }
    return this.store
  }

  private async destroyQuietly(secretVersion: string): Promise<void> {
    try {
      await this.enabledStore().destroy(secretVersion)
    } catch (error) {
      this.logger.warn(
        `Could not destroy ${secretVersion} after its credential failed to save; the proxy can still read it: ${
          (error as Error)?.message ?? String(error)
        }`,
      )
    }
  }
}
