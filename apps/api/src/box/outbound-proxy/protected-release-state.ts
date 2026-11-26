import { createHash } from 'node:crypto'
import type { Client } from 'pg'
import { UNCONFIRMED_PROTECTED_PLACEHOLDER } from '../errors/protected-placeholder.error'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const sha256 = /^[a-f0-9]{64}$/
type Pin = { endpoint: string; authority: string; version: 0 | 2; clientTrust?: string }
type Pins = Record<string, Pin>
type Release = { key: string; pins: Pins }
type Gate = {
  controlled: boolean
  enabled: boolean
  registry_writes: boolean
  release_key: string | null
  generation: string
  pins: Pins
  standalone_update: string | null
  restore_permit: string | null
  restore_runner: string | null
  restore_digest: string | null
  restore_generation: string | null
}

export function releaseContext(
  key: string | undefined,
  rawPins: string | undefined,
  clientCredentials?: string,
): Release {
  if (!key || !/^[a-zA-Z0-9._-]{1,120}$/.test(key)) throw new Error('Invalid protected CI release key')
  const enrolled: unknown = JSON.parse(rawPins || '[]')
  if (!Array.isArray(enrolled)) throw new Error('Invalid protected release pin set')
  const pins: Pins = {}
  for (const pin of enrolled) {
    if (!pin || typeof pin !== 'object') throw new Error('Invalid protected release pin')
    const { runnerId, url, caPem, apiVersion = 0, clientCaSha256, clientDnsName } = pin
    if (
      typeof runnerId !== 'string' ||
      !uuid.test(runnerId) ||
      typeof url !== 'string' ||
      typeof caPem !== 'string' ||
      ![0, 2].includes(apiVersion) ||
      pins[runnerId]
    ) {
      throw new Error('Invalid protected release pin')
    }
    const clientTrust =
      apiVersion === 2 && clientCredentials !== undefined
        ? createHash('sha256')
            .update(JSON.stringify([clientCaSha256, clientDnsName, clientCredentials]))
            .digest('hex')
        : undefined
    pins[runnerId] = {
      endpoint: url,
      authority: createHash('sha256').update(caPem).digest('hex'),
      version: apiVersion,
      ...(clientTrust ? { clientTrust } : {}),
    }
  }
  return { key, pins }
}

async function inGateTransaction<T>(db: Client, operation: (gate: Gate) => Promise<T>): Promise<T> {
  await db.query('BEGIN')
  try {
    const {
      rows: [gate],
    } = await db.query<Gate>('SELECT * FROM outbound_proxy_admission WHERE singleton FOR UPDATE')
    if (!gate) throw new Error('The protected admission row is missing')
    const result = await operation(gate)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function hasProtectedDependencies(db: Client, runnerIds: string[]): Promise<boolean> {
  const {
    rows: [row],
  } = await db.query(
    `SELECT (
      EXISTS (SELECT 1 FROM outbound_proxy_reference WHERE runner_id = ANY($1::text[]))
      OR EXISTS (
        SELECT 1 FROM box WHERE (
          "outboundControl" ?| ARRAY['managed', 'bootstrap', 'placeholderClosed']
          OR "errorReason" = $2
        ) AND (
          "runnerId"::text = ANY($1::text[]) OR "prevRunnerId"::text = ANY($1::text[])
          OR "outboundControl" #>> '{managed,runnerId}' = ANY($1::text[])
          OR "outboundControl" #>> '{bootstrap,key,runner_id}' = ANY($1::text[])
          OR "outboundControl" #>> '{bootstrap,recovery,runnerId}' = ANY($1::text[])
          OR "outboundControl" #>> '{placeholderClosed,runnerId}' = ANY($1::text[])
        )
      )
    ) AS found`,
    [runnerIds, UNCONFIRMED_PROTECTED_PLACEHOLDER],
  )
  return row.found
}

export async function beginProtectedRelease(db: Client, release: Release): Promise<boolean> {
  return inGateTransaction(db, async (gate) => {
    if (!gate.controlled && !Object.values(release.pins).some(({ version }) => version === 2)) return false
    if (gate.standalone_update || gate.restore_permit) {
      throw new Error('Protected release is waiting for an active update or restore')
    }
    const lost = Object.entries(gate.pins)
      .filter(([id, current]) => {
        const next = release.pins[id]
        return (
          !next ||
          current.endpoint !== next.endpoint ||
          current.authority !== next.authority ||
          current.clientTrust !== next.clientTrust ||
          current.version !== next.version
        )
      })
      .map(([id]) => id)
    if (lost.length && (await hasProtectedDependencies(db, lost))) {
      throw new Error('A removed or changed Runner pin still has protected dependencies')
    }
    await db.query(
      `UPDATE outbound_proxy_admission SET
         enabled = false, controlled = true, registry_writes = false, pins = $2,
         dev_acceptance_organization = NULL, dev_acceptance_until = NULL, dev_acceptance_commit = NULL,
         generation = generation + (release_key IS DISTINCT FROM $1)::int, release_key = $1
       WHERE singleton`,
      [release.key, JSON.stringify(release.pins)],
    )
    return true
  })
}

export async function enableProtectedRegistryWrites(db: Client, key: string): Promise<void> {
  await inGateTransaction(db, async (gate) => {
    if (!gate.controlled || gate.release_key !== key || gate.restore_permit) {
      throw new Error('Registry write authorization does not match the protected release')
    }
    await db.query('UPDATE outbound_proxy_admission SET registry_writes = true WHERE singleton')
  })
}

type ApprovedProcess = { runnerId: string; process_id: string; executable_digest: string }

export async function recordProtectedProcessProof(
  db: Client,
  key: string,
  witnesses: readonly ApprovedProcess[],
  authorization: { openAdmission?: boolean; devAcceptance?: { organization: string; commit: string } } = {},
): Promise<void> {
  const { openAdmission = false, devAcceptance } = authorization
  if (
    devAcceptance &&
    (openAdmission || !uuid.test(devAcceptance.organization) || !/^[a-f0-9]{40}$/.test(devAcceptance.commit))
  ) {
    throw new Error('Dev acceptance requires one isolated organization and closed public admission')
  }
  await inGateTransaction(db, async (gate) => {
    if (!gate.controlled || !gate.registry_writes || gate.release_key !== key || gate.restore_permit) {
      throw new Error('Runner approval does not match the fenced release')
    }
    const enrolled = Object.keys(gate.pins).filter((id) => gate.pins[id].version === 2)
    if (
      !enrolled.length ||
      witnesses.length !== enrolled.length ||
      new Set(witnesses.map(({ runnerId }) => runnerId)).size !== enrolled.length
    ) {
      throw new Error('Final Runner proof does not cover the exact enrolled fleet')
    }
    for (const proof of witnesses) {
      if (!enrolled.includes(proof.runnerId) || !uuid.test(proof.process_id) || !sha256.test(proof.executable_digest)) {
        throw new Error('Invalid final Runner process proof')
      }
      const update = await db.query(
        `UPDATE runner SET "protectedExecutableDigest" = $3
         WHERE id = $1 AND "apiVersion" = '2' AND "protectedProcessId" = $2
           AND "lastChecked" BETWEEN clock_timestamp() - interval '60 seconds' AND clock_timestamp()`,
        [proof.runnerId, proof.process_id, proof.executable_digest],
      )
      if (update.rowCount !== 1) throw new Error('The Runner process changed before release approval')
    }
    if (openAdmission || devAcceptance) {
      if (devAcceptance) {
        const organization = await db.query('SELECT 1 FROM organization WHERE id = $1', [devAcceptance.organization])
        if (!organization.rowCount) throw new Error('The configured dev acceptance organization does not exist')
      }
      await db.query(
        `UPDATE outbound_proxy_admission SET enabled = $1, dev_acceptance_organization = $2, dev_acceptance_commit = $3,
           dev_acceptance_until = CASE WHEN $2::uuid IS NOT NULL THEN clock_timestamp() + interval '30 minutes' END
         WHERE singleton`,
        [openAdmission, devAcceptance?.organization ?? null, devAcceptance?.commit ?? null],
      )
    }
  })
}

export type ProtectedRestore = { permit: string; runnerId: string; digest: string; releaseKey: string }

export async function reserveProtectedRestore(db: Client, restore: ProtectedRestore): Promise<void> {
  if (
    typeof restore.permit !== 'string' ||
    !uuid.test(restore.permit) ||
    typeof restore.runnerId !== 'string' ||
    !uuid.test(restore.runnerId) ||
    typeof restore.digest !== 'string' ||
    !sha256.test(restore.digest) ||
    typeof restore.releaseKey !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,120}$/.test(restore.releaseKey)
  ) {
    throw new Error('Invalid protected Runner restore request')
  }
  const generation = await inGateTransaction(db, async (gate) => {
    if (
      !gate.controlled ||
      gate.standalone_update ||
      gate.release_key !== restore.releaseKey ||
      gate.pins[restore.runnerId]?.version !== 2
    ) {
      throw new Error('Restore does not identify an enrolled controlled Runner')
    }
    if (gate.restore_permit) {
      requireRestorePermit(gate, restore)
      return gate.generation
    }
    await db.query(`UPDATE outbound_proxy_admission SET enabled = false, registry_writes = false,
      dev_acceptance_organization = NULL, dev_acceptance_until = NULL, dev_acceptance_commit = NULL WHERE singleton`)
    return gate.generation
  })
  await inGateTransaction(db, async (gate) => {
    if (
      !gate.controlled ||
      gate.enabled ||
      gate.registry_writes ||
      gate.standalone_update ||
      gate.release_key !== restore.releaseKey ||
      gate.generation !== generation ||
      gate.pins[restore.runnerId]?.version !== 2
    ) {
      throw new Error('The current release does not allow protected restore')
    }
    if (gate.restore_permit) {
      requireRestorePermit(gate, restore)
      return
    }
    if (await hasProtectedDependencies(db, Object.keys(gate.pins))) {
      throw new Error('Protected Runner restore has live dependencies')
    }
    await db.query(
      `UPDATE outbound_proxy_admission SET restore_permit = $1, restore_runner = $2, restore_digest = $3,
         restore_generation = generation
       WHERE singleton`,
      [restore.permit, restore.runnerId, restore.digest],
    )
  })
}

function requireRestorePermit(gate: Gate, restore: ProtectedRestore): void {
  if (
    !gate.controlled ||
    gate.enabled ||
    gate.registry_writes ||
    gate.release_key !== restore.releaseKey ||
    gate.restore_generation !== gate.generation ||
    gate.restore_permit !== restore.permit ||
    gate.restore_runner !== restore.runnerId ||
    gate.restore_digest !== restore.digest
  ) {
    throw new Error('The current closed generation does not match the protected Runner restore permit')
  }
}

export async function verifyProtectedRestore(db: Client, restore: ProtectedRestore): Promise<void> {
  await inGateTransaction(db, async (gate) => requireRestorePermit(gate, restore))
}

export async function finishProtectedRestore(db: Client, restore: ProtectedRestore): Promise<void> {
  await inGateTransaction(db, async (gate) => {
    requireRestorePermit(gate, restore)
    await db.query('UPDATE runner SET "protectedExecutableDigest" = NULL WHERE id = $1', [restore.runnerId])
    await db.query(
      `UPDATE outbound_proxy_admission SET restore_permit = NULL, restore_runner = NULL, restore_digest = NULL,
         restore_generation = NULL WHERE singleton`,
    )
  })
}
