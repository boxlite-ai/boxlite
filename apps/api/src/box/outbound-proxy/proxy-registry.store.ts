/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import {
  ConflictException,
  HttpException,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common'
import { DataSource, QueryRunner } from 'typeorm'
import { CredentialEnvelope, CredentialIdentity, ProxyCredentialCipher } from './proxy-credential-cipher'
import { ProxyCredential, ProxyPatch, validateProxyCredential } from './proxy-registration.input'

type RegistryVersion = CredentialIdentity & { name: string; envelope: CredentialEnvelope | null }
type PublicProxy = { name: string; url: string; revision: number; credential_configured: boolean }
type ReferenceOwner = {
  organizationId: string
  boxId: string
  runnerId: string
  runtimeEpoch: string
  attemptId: string
}
export type ProxyReservation = ReferenceOwner & { registrationId: string; revision: number }

const publicColumns = 'r.name, v.url, v.revision, v.envelope IS NOT NULL AS credential_configured'
const currentVersion = `FROM outbound_proxy_registration r JOIN outbound_proxy_revision v
  ON (v.organization_id, v.registration_id, v.revision) = (r.organization_id, r.id, r.current_revision)`
const referenceColumns = `p.organization_id AS "organizationId", p.box_id AS "boxId", p.runner_id AS "runnerId",
  p.runtime_epoch AS "runtimeEpoch", p.attempt_id AS "attemptId", p.registration_id AS "registrationId", p.revision`

const notFound = () => new NotFoundException('Proxy registration not found')
const unavailable = () => new ServiceUnavailableException('Proxy registry unavailable')
const conflict = () => new ConflictException('Proxy registration has an active reference or conflicting update')
const asPublic = ({ name, url, revision, envelope }: RegistryVersion): PublicProxy => ({
  name,
  url,
  revision,
  credential_configured: envelope !== null,
})

class ReservationCommitUnknown extends Error {
  constructor(readonly reference: ProxyReservation) {
    super('Proxy reservation commit outcome unknown')
  }
}

export class ProxyRegistryStore implements OnModuleInit {
  constructor(
    private readonly source: DataSource,
    private readonly cipher: ProxyCredentialCipher,
    private readonly enabled: boolean,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return
    await this.transaction(async (tx) => {
      const ids: { key_id: string }[] = await tx.query(`
        SELECT key_id FROM outbound_proxy_key_selector WHERE key_id IS NOT NULL
        UNION SELECT key_id FROM outbound_proxy_revision WHERE key_id IS NOT NULL
      `)
      for (const { key_id } of ids) this.cipher.requireKey(key_id)
    })
  }

  async list(organizationId: string): Promise<PublicProxy[]> {
    return this.transaction((tx) =>
      tx.query(`SELECT ${publicColumns} ${currentVersion} WHERE r.organization_id = $1 ORDER BY r.name`, [
        organizationId,
      ]),
    )
  }

  async get(organizationId: string, name: string): Promise<PublicProxy> {
    return this.transaction(async (tx) => {
      const [row] = await tx.query(
        `SELECT ${publicColumns} ${currentVersion} WHERE r.organization_id = $1 AND r.name = $2`,
        [organizationId, name],
      )
      if (!row) throw notFound()
      return row
    })
  }

  async create(
    organizationId: string,
    input: { name: string; url: string; credential?: ProxyCredential | null },
  ): Promise<PublicProxy> {
    const credential = input.credential ?? null
    validateProxyCredential(input.url, credential)
    const keyId = credential ? await this.reserveSeal() : null
    return this.transaction(async (tx) => {
      const version: RegistryVersion = {
        organizationId,
        id: randomUUID(),
        name: input.name,
        url: input.url,
        revision: 1,
        envelope: null,
      }
      if (credential) version.envelope = await this.seal(tx, keyId, version, credential)
      await tx.query(
        'INSERT INTO outbound_proxy_registration (organization_id, id, name, current_revision) VALUES ($1, $2, $3, 1)',
        [organizationId, version.id, input.name],
      )
      await this.insertVersion(tx, version)
      return asPublic(version)
    })
  }

  async update(organizationId: string, name: string, patch: ProxyPatch): Promise<PublicProxy> {
    if (patch.url === undefined && patch.credential === undefined) return this.get(organizationId, name)
    const keyId = patch.credential !== null ? await this.reserveSeal() : null
    return this.transaction(async (tx) => {
      const previous = await this.lockRegistration(tx, organizationId, name)
      const url = patch.url ?? previous.url
      let credential = patch.credential ?? null
      if (patch.credential === undefined && previous.envelope) {
        if (url !== previous.url)
          throw new ConflictException('An endpoint change requires an explicit credential choice')
        credential = this.cipher.open(previous.envelope, previous)
      }
      validateProxyCredential(url, credential)
      const version: RegistryVersion = { ...previous, revision: previous.revision + 1, url, envelope: null }
      if (credential) version.envelope = await this.seal(tx, keyId, version, credential)
      await this.insertVersion(tx, version)
      await tx.query(
        `UPDATE outbound_proxy_registration SET current_revision = $3, rollout_pending = true
        WHERE organization_id = $1 AND id = $2`,
        [organizationId, previous.id, version.revision],
      )
      return asPublic(version)
    })
  }

  async remove(organizationId: string, name: string): Promise<void> {
    await this.transaction(async (tx) => {
      const { id } = await this.lockRegistration(tx, organizationId, name)
      await tx.query('DELETE FROM outbound_proxy_registration WHERE organization_id = $1 AND id = $2', [
        organizationId,
        id,
      ])
    })
  }

  async retireRevision(organizationId: string, name: string, revision: number): Promise<void> {
    await this.transaction(async (tx) => {
      const current = await this.lockRegistration(tx, organizationId, name)
      if (revision === current.revision) throw conflict()
      const [removed] = await tx.query(
        `WITH removed AS (
        DELETE FROM outbound_proxy_revision WHERE organization_id = $1 AND registration_id = $2 AND revision = $3
        RETURNING revision
      ) SELECT revision FROM removed`,
        [organizationId, current.id, revision],
      )
      if (!removed) throw notFound()
    })
  }

  async reserveReference(owner: ReferenceOwner, name: string): Promise<ProxyReservation> {
    let prepared: ProxyReservation | undefined
    try {
      return await this.transaction(
        async (tx) => {
          await this.lockBox(tx, owner)
          const version = await this.lockRegistration(tx, owner.organizationId, name)
          const pending = await this.pending(tx, owner)
          if (pending) {
            if (!this.sameOwner(pending, owner) || pending.registrationId !== version.id) throw conflict()
            return pending
          }
          await tx.query(
            `INSERT INTO outbound_proxy_reference
          (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id)
          VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)`,
            [
              owner.organizationId,
              owner.boxId,
              version.id,
              version.revision,
              owner.runnerId,
              owner.runtimeEpoch,
              owner.attemptId,
            ],
          )
          prepared = { ...owner, registrationId: version.id, revision: version.revision }
          return prepared
        },
        () => prepared,
      )
    } catch (error) {
      if (!(error instanceof ReservationCommitUnknown)) throw error
      const candidate = error.reference
      return this.transaction(async (tx) => {
        await this.lockBox(tx, owner)
        const pending = await this.pending(tx, owner)
        if (
          !pending ||
          !this.sameOwner(pending, candidate) ||
          pending.registrationId !== candidate.registrationId ||
          pending.revision !== candidate.revision
        )
          throw conflict()
        await this.lockRegistration(tx, owner.organizationId, name)
        return candidate
      })
    }
  }

  async activateKey(keyId: string): Promise<void> {
    this.cipher.requireKey(keyId)
    await this.transaction(async (tx) => {
      await tx.query('SELECT key_id FROM outbound_proxy_key_selector FOR UPDATE')
      await tx.query('INSERT INTO outbound_proxy_key (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [keyId])
      const [key] = await tx.query('SELECT retired FROM outbound_proxy_key WHERE id = $1', [keyId])
      if (key.retired) throw conflict()
      await tx.query('UPDATE outbound_proxy_key_selector SET key_id = $1', [keyId])
    })
  }

  async retireKey(keyId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const [selected] = await tx.query('SELECT key_id FROM outbound_proxy_key_selector FOR UPDATE')
      const [used] = await tx.query('SELECT 1 FROM outbound_proxy_revision WHERE key_id = $1 LIMIT 1', [keyId])
      if (selected.key_id === keyId || used) throw conflict()
      await tx.query('UPDATE outbound_proxy_key SET retired = true WHERE id = $1', [keyId])
    })
  }

  async resealRevision(organizationId: string, name: string, revision: number): Promise<void> {
    const keyId = await this.reserveSeal()
    await this.transaction(async (tx) => {
      const { id } = await this.lockRegistration(tx, organizationId, name)
      const [row] = await tx.query(
        `SELECT url, envelope FROM outbound_proxy_revision
        WHERE organization_id = $1 AND registration_id = $2 AND revision = $3 FOR UPDATE`,
        [organizationId, id, revision],
      )
      if (!row) throw notFound()
      if (!row.envelope || row.envelope.keyId === keyId) return
      const identity = { organizationId, id, revision, url: row.url }
      const envelope = await this.seal(tx, keyId, identity, this.cipher.open(row.envelope, identity))
      await tx.query(
        `UPDATE outbound_proxy_revision SET envelope = $4
        WHERE organization_id = $1 AND registration_id = $2 AND revision = $3`,
        [organizationId, id, revision, envelope],
      )
    })
  }

  private async lockRegistration(tx: QueryRunner, organizationId: string, name: string): Promise<RegistryVersion> {
    // Take the lock in its own statement so the subsequent join sees the revision committed by a prior writer.
    const [registration] = await tx.query(
      `SELECT id FROM outbound_proxy_registration
      WHERE organization_id = $1 AND name = $2 FOR UPDATE`,
      [organizationId, name],
    )
    if (!registration) throw notFound()
    const [version] = await tx.query(
      `SELECT r.organization_id AS "organizationId", r.id, r.name, v.url, v.revision, v.envelope
      ${currentVersion} WHERE r.organization_id = $1 AND r.id = $2`,
      [organizationId, registration.id],
    )
    if (!version) throw unavailable()
    return version
  }

  private async lockBox(tx: QueryRunner, owner: ReferenceOwner): Promise<void> {
    const [box] = await tx.query(
      'SELECT id FROM box WHERE "organizationId" = $1 AND id = $2 AND "runnerId" = $3 FOR UPDATE',
      [owner.organizationId, owner.boxId, owner.runnerId],
    )
    if (!box) throw notFound()
  }

  private async pending(tx: QueryRunner, owner: ReferenceOwner): Promise<ProxyReservation | undefined> {
    const [row] = await tx.query(
      `SELECT ${referenceColumns} FROM outbound_proxy_reference p
      WHERE p.organization_id = $1 AND p.box_id = $2 AND p.kind = 'pending'`,
      [owner.organizationId, owner.boxId],
    )
    return row
  }

  private sameOwner(stored: ReferenceOwner, owner: ReferenceOwner): boolean {
    return (
      stored.runnerId === owner.runnerId &&
      stored.runtimeEpoch === owner.runtimeEpoch &&
      stored.attemptId === owner.attemptId
    )
  }

  private insertVersion(tx: QueryRunner, version: RegistryVersion): Promise<unknown> {
    return tx.query(
      `INSERT INTO outbound_proxy_revision (organization_id, registration_id, revision, url, envelope)
      VALUES ($1, $2, $3, $4, $5)`,
      [version.organizationId, version.id, version.revision, version.url, version.envelope],
    )
  }

  private async reserveSeal(): Promise<string | null> {
    return this.transaction(async (tx) => {
      await tx.query('SET LOCAL synchronous_commit = on')
      const [row] = await tx.query(`WITH reserved AS (
        UPDATE outbound_proxy_key SET uses = uses + 1
        WHERE id = (SELECT key_id FROM outbound_proxy_key_selector) AND uses < 4294967296 AND NOT retired
        RETURNING id
      ) SELECT id FROM reserved`)
      return row?.id ?? null
    })
  }

  private async seal(
    tx: QueryRunner,
    keyId: string | null,
    identity: CredentialIdentity,
    credential: ProxyCredential,
  ): Promise<CredentialEnvelope> {
    if (!keyId) throw unavailable()
    const [selected] = await tx.query('SELECT key_id FROM outbound_proxy_key_selector FOR SHARE')
    if (selected.key_id !== keyId) throw conflict()
    return this.cipher.seal(keyId, identity, credential)
  }

  private async transaction<T>(
    operation: (tx: QueryRunner) => Promise<T>,
    uncertain?: () => ProxyReservation | undefined,
  ): Promise<T> {
    if (!this.enabled) throw unavailable()
    const tx = this.source.createQueryRunner('master')
    let committing = false
    try {
      await tx.connect()
      await tx.startTransaction()
      await tx.query("SET LOCAL lock_timeout = '5s'")
      const result = await operation(tx)
      committing = true
      await tx.commitTransaction()
      return result
    } catch (error) {
      if (tx.isTransactionActive) await tx.rollbackTransaction().catch(() => undefined)
      const violation = error as { code?: string; constraint?: string }
      if (error instanceof HttpException) throw error
      if (violation.code === '23505' && violation.constraint === 'outbound_proxy_org_name_unique') {
        throw new ConflictException('Proxy name already exists')
      }
      if (violation.constraint === 'outbound_proxy_revision_pinned_fk' || violation.code === '55P03') throw conflict()
      const candidate = committing && uncertain?.()
      if (candidate) throw new ReservationCommitUnknown(candidate)
      // Query failures may include parameter values. Shared loggers and interceptors see only fixed errors.
      throw unavailable()
    } finally {
      await tx.release().catch(() => undefined)
    }
  }
}
