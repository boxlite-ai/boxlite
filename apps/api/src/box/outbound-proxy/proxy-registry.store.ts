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
import type { ProtectedBootRoute } from '../runner-adapter/protected-runner'
import type { ManagedBinding, ManagedUpdate } from '../runner-adapter/protected-outbound'

type RegistryVersion = CredentialIdentity & { name: string; envelope: CredentialEnvelope | null }
type RegistryTransaction = Pick<QueryRunner, 'query'>
type PublicProxy = { name: string; url: string; revision: number; credential_configured: boolean }
type ReferenceOwner<Epoch extends string | null = string> = {
  organizationId: string
  boxId: string
  runnerId: string
  runtimeEpoch: Epoch
  attemptId: string
}
export type ProxyReservation<Epoch extends string | null = string> = ReferenceOwner<Epoch> & {
  registrationId: string
  revision: number
}

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
  constructor(readonly reference: ProxyReservation<string | null>) {
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
        `UPDATE outbound_proxy_registration
        SET current_revision = $3, rollout_pending = true, rollout_check_after = now()
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

  claimRolloutWork(limit: number): Promise<
    {
      id: string
      organizationId: string
      name: string
      registrationId: string
      revision: number
    }[]
  > {
    if (limit <= 0) return Promise.resolve([])
    return this.transaction((tx) =>
      tx.query(
        `WITH due AS (
        SELECT b.id, b."organizationId", r.name, r.id AS "registrationId", r.current_revision AS revision
        FROM outbound_proxy_reference p
        JOIN outbound_proxy_registration r ON (r.organization_id, r.id) = (p.organization_id, p.registration_id)
        JOIN box b ON (b."organizationId", b.id) = (p.organization_id, p.box_id)
        WHERE p.kind = 'committed' AND r.rollout_pending AND p.revision < r.current_revision
          AND p.runner_id = b."runnerId"::text AND b."outboundControl" -> 'managed' IS NOT NULL
          AND NOT (b."outboundControl" -> 'managed' ?| ARRAY['pending', 'unbindRelease'])
          AND NOT (b."outboundControl" ? 'bootstrap')
          AND (b."outboundControlDueAt" IS NULL OR b."outboundControlDueAt" <= now()
            OR b."outboundControl" #>> '{managed,rolloutRetry}' IS DISTINCT FROM r.id::text || ':' || r.current_revision::text)
        ORDER BY b."outboundControlDueAt" NULLS FIRST, b.id LIMIT $1 FOR UPDATE OF b SKIP LOCKED
      ), leased AS (
        UPDATE box b SET
          "outboundControlDueAt" = now() + interval '60 seconds',
          "outboundControl" = jsonb_set(b."outboundControl", '{managed,rolloutRetry}',
            to_jsonb(due."registrationId"::text || ':' || due.revision::text))
        FROM due WHERE due.id = b.id
        RETURNING due.id, due."organizationId", due.name, due."registrationId", due.revision
      ) SELECT * FROM leased`,
        [Math.min(limit, 16)],
      ),
    )
  }

  async completeRollouts(): Promise<void> {
    await this.transaction(async (tx) => {
      const due: { organization_id: string; id: string; current_revision: number }[] = await tx.query(`
        SELECT organization_id, id, current_revision FROM outbound_proxy_registration
        WHERE rollout_pending AND rollout_check_after <= now()
        ORDER BY rollout_check_after, organization_id, id LIMIT 16 FOR UPDATE SKIP LOCKED`)
      if (due.length === 0) return
      await tx.query(
        `
        UPDATE outbound_proxy_registration r SET rollout_pending = EXISTS (
          SELECT 1 FROM outbound_proxy_reference p
          WHERE (p.organization_id, p.registration_id) = (due.organization_id, due.id)
            AND (p.kind <> 'committed' OR p.revision < due.current_revision)
        ), rollout_check_after = now() + interval '30 seconds'
        FROM unnest($1::uuid[], $2::uuid[], $3::integer[]) AS due(organization_id, id, current_revision)
        WHERE (r.organization_id, r.id, r.current_revision) = (due.organization_id, due.id, due.current_revision)`,
        [due.map((row) => row.organization_id), due.map((row) => row.id), due.map((row) => row.current_revision)],
      )
    })
  }

  reserveReference(owner: ReferenceOwner, name: string): Promise<ProxyReservation> {
    return this.reserve(owner, name, 'legacy')
  }

  reserveBootstrapReference(
    owner: Omit<ReferenceOwner, 'runtimeEpoch'>,
    name: string,
  ): Promise<ProxyReservation<null>> {
    return this.reserve({ ...owner, runtimeEpoch: null }, name, 'bootstrap')
  }

  reserveBootstrapInTransaction(
    tx: RegistryTransaction,
    owner: Omit<ReferenceOwner, 'runtimeEpoch'>,
    name: string,
  ): Promise<ProxyReservation<null>> {
    return this.reservePending(tx, { ...owner, runtimeEpoch: null }, name, 'bootstrap')
  }

  async nameForRegistration(tx: RegistryTransaction, org: string, id: string): Promise<string | undefined> {
    const [row] = await tx.query(
      'SELECT name FROM outbound_proxy_registration WHERE organization_id = $1 AND id = $2',
      [org, id],
    )
    return row?.name
  }

  async reserveRecoveryInTransaction(
    tx: RegistryTransaction,
    owner: Omit<ReferenceOwner, 'runtimeEpoch'>,
    recovery: { runnerId: string; binding: ManagedBinding },
  ): Promise<ProxyReservation<null>> {
    const reference = {
      ...owner,
      runtimeEpoch: null,
      registrationId: recovery.binding.registration_id,
      revision: Number(recovery.binding.registration_revision),
    }
    await this.lockVersions(tx, owner.organizationId, [reference.registrationId])
    const committed = await this.reference(tx, reference, 'committed')
    if (!this.matchesBinding(committed, recovery.binding, recovery.runnerId) || (await this.pending(tx, reference)))
      throw conflict()
    await tx.query(
      `INSERT INTO outbound_proxy_reference
        (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id, purpose)
        VALUES ($1, $2, 'pending', $3, $4, $5, NULL, $6, 'bootstrap')`,
      [
        owner.organizationId,
        owner.boxId,
        reference.registrationId,
        reference.revision,
        owner.runnerId,
        owner.attemptId,
      ],
    )
    return reference
  }

  private async reserve<Epoch extends string | null>(
    owner: ReferenceOwner<Epoch>,
    name: string,
    purpose: 'legacy' | 'bootstrap',
  ): Promise<ProxyReservation<Epoch>> {
    let prepared: ProxyReservation<Epoch> | undefined
    try {
      return await this.transaction(
        async (tx) => {
          await this.lockBox(tx, owner)
          prepared = await this.reservePending(tx, owner, name, purpose)
          return prepared
        },
        () => prepared,
      )
    } catch (error) {
      if (!(error instanceof ReservationCommitUnknown) || !prepared || error.reference !== prepared) throw error
      const candidate = prepared
      return this.transaction(async (tx) => {
        await this.lockBox(tx, owner)
        const pending = await this.pending(tx, owner)
        if (
          !pending ||
          !this.sameOwner(pending, candidate) ||
          pending.registrationId !== candidate.registrationId ||
          pending.revision !== candidate.revision ||
          pending.purpose !== purpose
        )
          throw conflict()
        await this.lockRegistration(tx, owner.organizationId, name)
        return candidate
      })
    }
  }

  /** Call with the epoch from the authenticated receipt for this exact reservation. */
  async confirmBootstrapReference(reference: ProxyReservation<null>, epoch: string): Promise<void> {
    await this.transaction(async (tx) => {
      await this.lockBox(tx, reference)
      await this.promoteBootstrapInTransaction(tx, reference, epoch)
    })
  }

  async promoteBootstrapInTransaction(
    tx: RegistryTransaction,
    reference: ProxyReservation<null>,
    epoch: string,
    recovery?: { runnerId: string; binding: ManagedBinding },
  ) {
    if (!this.enabled || !/^[A-Za-z0-9_-]{1,128}$/.test(epoch)) throw conflict()
    const present = await this.reference(tx, reference, 'committed')
    const confirmed = { ...reference, runtimeEpoch: epoch }
    if (present) {
      if (present.purpose === 'bootstrap' && this.sameReference(present, confirmed)) return
      if (!recovery || !this.matchesBinding(present, recovery.binding, recovery.runnerId)) throw conflict()
    } else if (recovery) {
      throw conflict()
    }
    const pending = await this.pending(tx, reference)
    if (pending?.purpose !== 'bootstrap' || !this.sameReference(pending, reference)) throw conflict()
    await this.lockVersions(tx, reference.organizationId, [reference.registrationId])
    if (present) {
      await tx.query(
        "DELETE FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = 'committed'",
        [reference.organizationId, reference.boxId],
      )
    }
    await tx.query(
      `UPDATE outbound_proxy_reference SET runtime_epoch = $3, kind = 'committed'
      WHERE organization_id = $1 AND box_id = $2 AND kind = 'pending'`,
      [reference.organizationId, reference.boxId, epoch],
    )
  }

  async loadBootstrapRoute(
    tx: RegistryTransaction,
    reference: ProxyReservation<null>,
    recovery?: { runnerId: string; binding: ManagedBinding },
  ): Promise<ProtectedBootRoute> {
    const pin = await this.pending(tx, reference)
    if (pin?.purpose !== 'bootstrap' || !this.sameReference(pin, reference)) throw conflict()
    const versions = await this.lockVersions(tx, reference.organizationId, [reference.registrationId])
    if (recovery) {
      const predecessor = await this.reference(tx, reference, 'committed')
      if (!this.matchesBinding(predecessor, recovery.binding, recovery.runnerId)) throw conflict()
    } else if (versions.get(reference.registrationId) !== reference.revision) throw conflict()
    return this.loadPinnedRoute(tx, reference.organizationId, reference.registrationId, reference.revision)
  }

  async retireBootstrapInTransaction(tx: RegistryTransaction, reference: ProxyReservation<null>) {
    const pending = await this.pending(tx, reference)
    if (pending?.purpose !== 'bootstrap' || !this.sameReference(pending, reference)) throw conflict()
    await this.lockVersions(tx, reference.organizationId, [reference.registrationId])
    await tx.query(
      "DELETE FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = 'pending'",
      [reference.organizationId, reference.boxId],
    )
  }

  async reserveUpdateInTransaction(
    tx: RegistryTransaction,
    owner: ReferenceOwner,
    predecessor: ManagedBinding | null,
    name: string | null,
  ): Promise<ManagedBinding | null> {
    if (!this.enabled) throw unavailable()
    let id: string | undefined
    if (name !== null) {
      const [registration] = await tx.query(
        'SELECT id FROM outbound_proxy_registration WHERE organization_id = $1 AND name = $2',
        [owner.organizationId, name],
      )
      if (!registration) throw notFound()
      id = registration.id
    }
    const relevant = [predecessor?.registration_id, id].filter((value): value is string => value !== undefined)
    const current = await this.lockVersions(tx, owner.organizationId, relevant)
    if (await this.pending(tx, owner)) throw conflict()
    const committed = await this.reference(tx, owner, 'committed')
    if (!this.matchesBinding(committed, predecessor, owner.runnerId)) throw conflict()
    if (!id) return null
    const revision = current.get(id)
    if (!revision) throw conflict()
    await tx.query(
      `INSERT INTO outbound_proxy_reference
        (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id, purpose)
        VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, 'update')`,
      [owner.organizationId, owner.boxId, id, revision, owner.runnerId, owner.runtimeEpoch, owner.attemptId],
    )
    return { epoch: owner.runtimeEpoch, registration_id: id, registration_revision: String(revision) }
  }

  async lockUpdateVersions(tx: RegistryTransaction, owner: ReferenceOwner, update: ManagedUpdate): Promise<boolean> {
    const before = update.predecessor.binding
    const candidate = update.candidate.binding
    const ids = [before?.registration_id, candidate?.registration_id].filter((id): id is string => id !== undefined)
    const versions = await this.lockVersions(tx, owner.organizationId, ids)
    const pending = await this.reference(tx, owner, 'pending')
    const committed = await this.reference(tx, owner, 'committed')
    if (
      !this.matchesBinding(committed, before, owner.runnerId) ||
      !this.matchesBinding(pending, candidate, owner.runnerId) ||
      (pending && (pending.attemptId !== owner.attemptId || pending.purpose !== 'update'))
    )
      throw conflict()
    return candidate === null || versions.get(candidate.registration_id) === Number(candidate.registration_revision)
  }

  async reserveRestoration(
    tx: RegistryTransaction,
    owner: ReferenceOwner,
    failed: ManagedUpdate,
    restoration: ManagedUpdate,
  ): Promise<void> {
    await this.lockUpdateVersions(tx, owner, failed)
    if (failed.candidate.binding) {
      await tx.query(
        "UPDATE outbound_proxy_reference SET kind = 'retained' WHERE organization_id = $1 AND box_id = $2 AND kind = 'pending'",
        [owner.organizationId, owner.boxId],
      )
    }
    if (restoration.candidate.binding) {
      await tx.query(
        `INSERT INTO outbound_proxy_reference
          (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id, purpose)
        SELECT organization_id, box_id, 'pending', registration_id, revision, runner_id, runtime_epoch, $3, 'update'
          FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = 'committed'`,
        [owner.organizationId, owner.boxId, restoration.attempt_id],
      )
    }
  }

  async lockRestorationVersions(
    tx: RegistryTransaction,
    owner: ReferenceOwner,
    failed: ManagedUpdate,
    restoration: ManagedUpdate,
  ): Promise<void> {
    const before = failed.predecessor.binding
    const candidate = failed.candidate.binding
    const ids = [before?.registration_id, candidate?.registration_id].filter((id): id is string => id !== undefined)
    await this.lockVersions(tx, owner.organizationId, ids)
    const committed = await this.reference(tx, owner, 'committed')
    const retained = await this.reference(tx, owner, 'retained')
    const pending = await this.reference(tx, owner, 'pending')
    if (
      !this.matchesBinding(committed, before, owner.runnerId) ||
      !this.matchesBinding(retained, candidate, owner.runnerId) ||
      (retained && retained.attemptId !== failed.attempt_id) ||
      !this.matchesBinding(pending, restoration.candidate.binding, owner.runnerId) ||
      (pending && pending.attemptId !== restoration.attempt_id)
    )
      throw conflict()
  }

  async releaseRetiredBinding(
    tx: RegistryTransaction,
    org: string,
    boxId: string,
    runnerId: string,
    binding: ManagedBinding | null,
  ): Promise<void> {
    if (binding) await this.lockVersions(tx, org, [binding.registration_id])
    const pins: {
      kind: string
      registration_id: string
      runtime_epoch: string
      runner_id: string
      revision: number
    }[] = await tx.query(
      'SELECT kind, registration_id, runtime_epoch, runner_id, revision FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2',
      [org, boxId],
    )
    if (!binding && pins.length === 0) return
    const pin = pins[0]
    if (
      !binding ||
      pins.length !== 1 ||
      pin.kind !== 'committed' ||
      pin.runner_id !== runnerId ||
      pin.runtime_epoch !== binding.epoch ||
      pin.registration_id !== binding.registration_id ||
      String(pin.revision) !== binding.registration_revision
    )
      throw conflict()
    await tx.query(
      "DELETE FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = 'committed'",
      [org, boxId],
    )
  }

  private matchesBinding(
    pin: ProxyReservation<string | null> | undefined,
    binding: ManagedBinding | null,
    runnerId: string,
  ) {
    if (!binding) return pin === undefined
    return (
      !!pin &&
      pin.runnerId === runnerId &&
      pin.runtimeEpoch === binding.epoch &&
      pin.registrationId === binding.registration_id &&
      pin.revision === Number(binding.registration_revision)
    )
  }

  /** Callers hold the primary Box lock first. Registration locks last through dispatch and finalization. */
  async lockVersions(tx: RegistryTransaction, org: string, ids: string[]): Promise<Map<string, number>> {
    if (!this.enabled) throw unavailable()
    const ordered = [...new Set(ids)].sort()
    if (ordered.length === 0) return new Map()
    const rows: { id: string; current_revision: number }[] = await tx.query(
      `SELECT id, current_revision FROM outbound_proxy_registration
      WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE`,
      [org, ordered],
    )
    if (rows.length !== ordered.length) throw conflict()
    return new Map(rows.map((row) => [row.id, row.current_revision]))
  }

  async loadPinnedRoute(
    tx: RegistryTransaction,
    org: string,
    id: string,
    revision: number,
  ): Promise<ProtectedBootRoute> {
    if (!this.enabled) throw unavailable()
    const [row] = await tx.query(
      'SELECT url, envelope FROM outbound_proxy_revision WHERE organization_id = $1 AND registration_id = $2 AND revision = $3',
      [org, id, revision],
    )
    if (!row) throw conflict()
    const url = new URL(row.url)
    const scheme = url.protocol.slice(0, -1)
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'socks5') throw unavailable()
    const credential = row.envelope
      ? this.cipher.open(row.envelope, { organizationId: org, id, url: row.url, revision })
      : undefined
    return {
      scheme,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : { http: 80, https: 443, socks5: 1080 }[scheme],
      credential,
    }
  }

  private async reservePending<Epoch extends string | null>(
    tx: RegistryTransaction,
    owner: ReferenceOwner<Epoch>,
    name: string,
    purpose: 'legacy' | 'bootstrap' | 'update',
  ): Promise<ProxyReservation<Epoch>> {
    if (!this.enabled) throw unavailable()
    const version = await this.lockRegistration(tx, owner.organizationId, name, 'SHARE')
    const pending = await this.pending(tx, owner)
    if (pending) {
      if (!this.sameOwner(pending, owner) || pending.registrationId !== version.id || pending.purpose !== purpose)
        throw conflict()
      return { ...owner, registrationId: pending.registrationId, revision: pending.revision }
    }
    await tx.query(
      `INSERT INTO outbound_proxy_reference
        (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id, purpose)
        VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8)`,
      [
        owner.organizationId,
        owner.boxId,
        version.id,
        version.revision,
        owner.runnerId,
        owner.runtimeEpoch,
        owner.attemptId,
        purpose,
      ],
    )
    return { ...owner, registrationId: version.id, revision: version.revision }
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

  private async lockRegistration(
    tx: RegistryTransaction,
    organizationId: string,
    name: string,
    lock: 'UPDATE' | 'SHARE' = 'UPDATE',
  ): Promise<RegistryVersion> {
    // Take the lock in its own statement so the subsequent join sees the revision committed by a prior writer.
    const [registration] = await tx.query(
      `SELECT id FROM outbound_proxy_registration
      WHERE organization_id = $1 AND name = $2 FOR ${lock}`,
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

  private async lockBox(tx: QueryRunner, owner: ReferenceOwner<string | null>): Promise<void> {
    const [box] = await tx.query(
      'SELECT id FROM box WHERE "organizationId" = $1 AND id = $2 AND "runnerId" = $3 FOR UPDATE',
      [owner.organizationId, owner.boxId, owner.runnerId],
    )
    if (!box) throw notFound()
  }

  private pending(tx: RegistryTransaction, owner: ReferenceOwner<string | null>) {
    return this.reference(tx, owner, 'pending')
  }

  private async reference(
    tx: RegistryTransaction,
    owner: ReferenceOwner<string | null>,
    kind: 'committed' | 'pending' | 'retained',
  ): Promise<(ProxyReservation<string | null> & { purpose: string }) | undefined> {
    const [row] = await tx.query(
      `SELECT ${referenceColumns}, p.purpose FROM outbound_proxy_reference p
      WHERE p.organization_id = $1 AND p.box_id = $2 AND p.kind = $3`,
      [owner.organizationId, owner.boxId, kind],
    )
    return row
  }

  private sameReference(stored: ProxyReservation<string | null>, expected: ProxyReservation<string | null>): boolean {
    return (
      this.sameOwner(stored, expected) &&
      stored.registrationId === expected.registrationId &&
      stored.revision === expected.revision
    )
  }

  private sameOwner(stored: ReferenceOwner<string | null>, owner: ReferenceOwner<string | null>): boolean {
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
    uncertain?: () => ProxyReservation<string | null> | undefined,
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
