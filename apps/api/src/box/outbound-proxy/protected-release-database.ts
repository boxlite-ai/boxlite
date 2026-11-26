import { Client } from 'pg'
import { setTimeout as wait } from 'node:timers/promises'
import {
  beginProtectedRelease,
  enableProtectedRegistryWrites,
  finishProtectedRestore,
  releaseContext,
  recordProtectedProcessProof,
  reserveProtectedRestore,
  verifyProtectedRestore,
  type ProtectedRestore,
} from './protected-release-state'

type ReleaseDatabase = {
  host: string
  database: string
  administrator: { user: string; password: string }
  former: { user: string; password: string }
  runtime: { user: string; password: string }
}

function identifier(name: string): string {
  if (!name || name.includes('\0')) throw new Error('Invalid release database identifier')
  return `"${name.replaceAll('"', '""')}"`
}

function validateLogins(db: ReleaseDatabase): void {
  if (new Set([db.administrator.user, db.former.user, db.runtime.user]).size !== 3) {
    throw new Error('Protected release requires distinct database logins')
  }
}

async function connected(db: ReleaseDatabase, login: ReleaseDatabase['runtime']): Promise<Client> {
  const client = new Client({
    ...login,
    host: db.host,
    database: db.database,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
  })
  try {
    await client.connect()
    return client
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
}

async function verifyRuntime(db: ReleaseDatabase): Promise<void> {
  const runtime = await connected(db, db.runtime)
  try {
    const {
      rows: [role],
    } = await runtime.query('SELECT session_user AS login, current_user AS owner')
    if (role.login !== db.runtime.user || role.owner !== db.former.user) {
      throw new Error('The API login does not use the existing schema owner')
    }
  } finally {
    await runtime.end()
  }
}

export async function prepareProtectedApiLogin(db: ReleaseDatabase): Promise<void> {
  validateLogins(db)
  if (!/^[A-Za-z0-9]{32,128}$/.test(db.runtime.password)) throw new Error('Invalid protected API database password')
  const admin = await connected(db, db.administrator)
  const runtime = identifier(db.runtime.user)
  const owner = identifier(db.former.user)
  try {
    await admin.query('BEGIN')
    await admin.query("SELECT pg_advisory_xact_lock(hashtext('boxlite:protected-api-login'))")
    const {
      rows: [existing],
    } = await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [db.runtime.user])
    if (!existing) await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${db.runtime.password}'`)
    else if (!existing.rolcanlogin) throw new Error('The existing protected API login is disabled')
    await admin.query(`GRANT ${owner} TO ${runtime} WITH INHERIT TRUE, SET TRUE`)
    await admin.query(`ALTER ROLE ${runtime} IN DATABASE ${identifier(db.database)} SET role TO ${owner}`)
    await admin.query('COMMIT')
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await admin.end()
  }
  await verifyRuntime(db)
}

async function endFormerSessions(admin: Client, login: string): Promise<void> {
  const deadline = performance.now() + 20_000
  while (true) {
    const { rows } = await admin.query(
      'SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()',
      [login],
    )
    if (!rows.length) return
    if (performance.now() >= deadline) {
      throw new Error('Could not verify termination of every former API database session')
    }
    await wait(200)
  }
}

export async function fenceFormerProtectedApiLogin(db: ReleaseDatabase): Promise<void> {
  validateLogins(db)
  await verifyRuntime(db)
  const admin = await connected(db, db.administrator)
  try {
    const {
      rows: [before],
    } = await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [db.former.user])
    if (!before) throw new Error('The former API login does not exist')
    if (before.rolcanlogin) {
      const probe = await connected(db, db.former)
      probe.on('error', () => undefined)
      try {
        const {
          rows: [held],
        } = await probe.query('SELECT pg_backend_pid() AS pid')
        const {
          rows: [proof],
        } = await admin.query('SELECT pg_terminate_backend($1, 5000) AS terminated', [held.pid])
        if (!proof?.terminated) throw new Error('Could not terminate the held former login test session')
      } finally {
        await probe.end()
      }
    }
    await admin.query(`ALTER ROLE ${identifier(db.former.user)} NOLOGIN`)
    await endFormerSessions(admin, db.former.user)
    const {
      rows: [former],
    } = await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [db.former.user])
    if (former?.rolcanlogin !== false) throw new Error('Could not verify the former API login is fenced')
  } finally {
    await admin.end()
  }

  let unexpected: Client
  try {
    unexpected = await connected(db, db.former)
  } catch (error) {
    if ((error as { code?: string }).code !== '28000') throw error
    await verifyRuntime(db)
    return
  }
  await unexpected.end()
  throw new Error('The former API login still connects')
}

export async function runProtectedReleaseDatabase(
  phase: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const value = (name: string) => {
    const configured = environment[name]
    if (!configured) throw new Error(`Missing protected release database input ${name}`)
    return configured
  }
  const db: ReleaseDatabase = {
    host: value('PROTECTED_RELEASE_DB_HOST'),
    database: value('PROTECTED_RELEASE_DB_NAME'),
    administrator: {
      user: value('PROTECTED_RELEASE_DB_ADMIN_USER'),
      password: value('PROTECTED_RELEASE_DB_ADMIN_PASSWORD'),
    },
    former: {
      user: value('PROTECTED_RELEASE_DB_FORMER_USER'),
      password: value('PROTECTED_RELEASE_DB_FORMER_PASSWORD'),
    },
    runtime: {
      user: value('PROTECTED_RELEASE_DB_RUNTIME_USER'),
      password: value('PROTECTED_RELEASE_DB_RUNTIME_PASSWORD'),
    },
  }
  const release = releaseContext(
    value('PROTECTED_RELEASE_KEY'),
    environment.PROTECTED_RELEASE_PINS,
    value('PROTECTED_RELEASE_CLIENT_CREDENTIAL_VERSIONS'),
  )
  if (phase === 'prepare') await prepareProtectedApiLogin(db)
  else validateLogins(db)

  const runtime = await connected(db, db.runtime)
  try {
    if (phase === 'prepare') {
      const {
        rows: [schema],
      } = await runtime.query("SELECT to_regclass('outbound_proxy_admission') AS available")
      if (schema?.available) await beginProtectedRelease(runtime, release)
    } else if (phase === 'fence') {
      if (await beginProtectedRelease(runtime, release)) {
        await fenceFormerProtectedApiLogin(db)
        await enableProtectedRegistryWrites(runtime, release.key)
      }
    } else if (phase === 'record-proof' || phase === 'approve') {
      const witnesses: unknown = JSON.parse(value('PROTECTED_RELEASE_WITNESSES'))
      if (!Array.isArray(witnesses)) throw new Error('Invalid final Runner proof')
      const organization = environment.PROTECTED_RELEASE_DEV_ORGANIZATION
      await recordProtectedProcessProof(runtime, release.key, witnesses, {
        openAdmission: phase === 'approve',
        devAcceptance:
          phase === 'record-proof' && environment.PROTECTED_RELEASE_STAGE === 'dev' && organization
            ? { organization, commit: value('PROTECTED_RELEASE_DEV_COMMIT') }
            : undefined,
      })
    } else if (phase === 'reserve-restore' || phase === 'verify-restore' || phase === 'finish-restore') {
      const restore: ProtectedRestore = JSON.parse(value('PROTECTED_RELEASE_RESTORE'))
      if (!restore || typeof restore !== 'object' || restore.releaseKey !== release.key) {
        throw new Error('Protected Runner restore request does not match the deployed release')
      }
      if (phase === 'reserve-restore') await reserveProtectedRestore(runtime, restore)
      else if (phase === 'verify-restore') await verifyProtectedRestore(runtime, restore)
      else await finishProtectedRestore(runtime, restore)
    } else {
      throw new Error('Invalid protected release database phase')
    }
  } finally {
    await runtime.end()
  }
}
