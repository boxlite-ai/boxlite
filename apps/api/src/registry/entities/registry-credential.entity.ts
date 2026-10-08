/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'

// A login an organization registered for a private registry: which host and
// repositories it covers, and the username. The password is not here in any
// form. It lives in Secret Manager, which the API can write but not read, and
// `secretVersion` only says where it went.
@Entity()
// One credential per (host, prefix) within an organization, so the resolver
// never has two to choose between. The leading columns also serve its lookup
// by (organization, host), which is why there is no second index for that.
@Index('registry_credential_org_host_prefix_unique', ['organizationId', 'registryHost', 'repositoryPrefix'], {
  unique: true,
})
// Whole path segments: '' for the entire host, otherwise ending in '/'.
// Without the slash, `acme` would also match `acme-other/app`, and the
// longest-prefix match would send pulls of that other namespace upstream with
// acme's login.
@Check(
  'registry_credential_prefix_shape',
  `"repositoryPrefix" = '' OR ("repositoryPrefix" LIKE '%/' AND "repositoryPrefix" NOT LIKE '/%')`,
)
export class RegistryCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  organizationId: string

  // No `enumName`: the default is already `registry_credential_kind_enum`,
  // and spelling out a name equal to it makes `migration:generate` report the
  // type as changed on every run.
  @Column({ type: 'enum', enum: RegistryCredentialKind })
  kind: RegistryCredentialKind

  @Column({ type: 'varchar', length: 255 })
  registryHost: string

  @Column({ type: 'varchar', length: 255, default: '' })
  repositoryPrefix: string

  @Column({ type: 'varchar', length: 255 })
  username: string

  // The version holding the password, as the store named it on write, e.g.
  // `projects/123/secrets/registry-credential-<id>/versions/1`. Kept whole
  // rather than rebuilt from the id: destroying a version takes its exact
  // name, and the API is not allowed to list them.
  @Column({ type: 'text' })
  secretVersion: string

  // The user's id, which is their identity provider's subject — `auth0|…`,
  // or whatever Dex issues locally — not a uuid, as on every other table.
  @Column({ type: 'varchar', nullable: true })
  createdBy: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
