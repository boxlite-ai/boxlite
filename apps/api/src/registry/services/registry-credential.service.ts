/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Not, Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { credentialedRegistryHosts, registryProxyHost } from '../utils/registry-proxy.util'

@Injectable()
export class RegistryCredentialService {
  constructor(
    @InjectRepository(RegistryCredential)
    private readonly credentials: Repository<RegistryCredential>,
    @InjectRepository(Box)
    private readonly boxes: Repository<Box>,
  ) {}

  /**
   * Whether a runner hosts a box of the organization, which is what entitles
   * it to that organization's logins.
   *
   * A runner key alone is not enough: an organization can run runners of its
   * own in a custom region, and one of those asking for another organization's
   * login would be that organization's private images handed to a stranger.
   * A box assigned to the runner is the one thing that says the pull is for
   * work the runner was given.
   */
  async runnerServes(runnerId: string, organizationId: string): Promise<boolean> {
    return this.boxes.exists({
      where: { runnerId, organizationId, desiredState: Not(BoxDesiredState.DESTROYED) },
    })
  }

  /**
   * The credential an organization registered for a repository, or null.
   *
   * The longest prefix wins, so `acme/team/` is chosen over `acme/`, and
   * `acme/` over the whole host. An organization holds a handful of rows per
   * host, so they are read whole and matched here rather than in SQL, where
   * `LIKE` would read the `_` a repository name may carry as a wildcard.
   */
  async findForRepository(
    organizationId: string,
    registryHost: string,
    repository: string,
  ): Promise<RegistryCredential | null> {
    const candidates = await this.credentials.find({ where: { organizationId, registryHost } })

    // A prefix is whole path segments ending in '/', so the repository is
    // compared with one appended: `acme/app/` then covers `acme/app` itself,
    // and `acme/` still cannot match `acme-other/app`.
    const path = `${repository}/`
    let longest: RegistryCredential | null = null
    for (const candidate of candidates) {
      if (!path.startsWith(candidate.repositoryPrefix)) {
        continue
      }
      if (!longest || candidate.repositoryPrefix.length > longest.repositoryPrefix.length) {
        longest = candidate
      }
    }
    return longest
  }

  /**
   * Whether a pull of this repository goes through the registry proxy with the
   * organization's login: the deployment runs a proxy, the host is one a login
   * may be registered for, and one is registered for a prefix of it.
   *
   * The host list is checked before the database, so a host no login can
   * exist for — the metadata endpoint, a private address — costs no query and
   * never reaches the proxy, whatever rows someone managed to write.
   */
  async routesThroughProxy(organizationId: string, registryHost: string, repository: string): Promise<boolean> {
    if (!registryProxyHost() || !credentialedRegistryHosts().includes(registryHost)) {
      return false
    }
    return (await this.findForRepository(organizationId, registryHost, repository)) !== null
  }
}
