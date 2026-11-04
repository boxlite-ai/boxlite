/** An env's Neon database: one project per App, one branch per env, created on first use (serialised per App). */
import type { Ctx } from '../ctx'
import { hostOf, withSslmode } from '../neon'
import type { Logger } from './boxes'

export class DatabaseProvisioner {
  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {}

  /**
   * One Neon project per app (`mc-<app-id>`, created on first use); `main` uses the project's default
   * branch, every other env its own branch off its `from` env.
   */
  async ensureDatabase(
    appId: string,
    envId: string,
    log: Logger = () => undefined,
    signal?: AbortSignal,
  ): Promise<{ url: string; host: string; branchId: string }> {
    const { store, neon } = this.ctx
    let readerUrl: string | null = null
    // Every worker locks the same platform App before checking whether its project exists.
    // Commit the project reference before provisioning branches so a branch failure can retry it.
    const app = await store.tx(async () => {
      await store.get('SELECT id FROM apps WHERE id = ? FOR UPDATE', appId)
      signal?.throwIfAborted()
      let app = (await store.appById(appId))!
      if (!app.neon_project_id) {
        log(`creating the database for ${app.name}`)
        const p = await neon.createProject(`mc-${app.id}`)
        await store.updateApp(app.id, { neon_project_id: p.projectId, neon_main_branch_id: p.mainBranchId })
        const main = await store.envByName(app.id, 'main')
        if (main)
          await store.updateEnv(main.id, { neon_branch_id: p.mainBranchId, db_url: withSslmode(p.connectionUri) })
        app = (await store.appById(appId))!
        if (main) readerUrl = withSslmode(p.connectionUri)
      }
      return app
    })
    signal?.throwIfAborted()
    if (readerUrl)
      await this.ctx.appdb
        .ensureReader(readerUrl)
        .catch((err: Error) => log(`warning: read-only database login not ready yet: ${err.message}`))
    let env = (await store.envById(envId))!
    /** The parent's database, when this env just became a schema-only branch of it. */
    let ledgerFrom: string | null = null
    if (!env.neon_branch_id) {
      let branchId: string
      if (env.name === 'main') {
        branchId = app.neon_main_branch_id!
      } else {
        const parent = await store.envByName(app.id, env.from_env ?? 'main')
        const parentBranch = parent?.neon_branch_id ?? app.neon_main_branch_id
        const init = env.with_data ? 'parent-data' : 'schema-only'
        log(
          `creating the database of ${env.name} from ${parent?.name ?? 'main'} (${env.with_data ? 'with its data' : 'tables only'})`,
        )
        signal?.throwIfAborted()
        branchId = (await neon.createBranch(app.neon_project_id!, env.name, parentBranch, init)).branchId
        if (!env.with_data) ledgerFrom = parent?.db_url ?? null
      }
      await store.updateEnv(env.id, { neon_branch_id: branchId })
      env = (await store.envById(envId))!
    }
    if (!env.db_url) {
      signal?.throwIfAborted()
      const uri = await neon.connectionUri(app.neon_project_id!, env.neon_branch_id!)
      await store.updateEnv(env.id, { db_url: withSslmode(uri) })
      env = (await store.envById(envId))!
    }
    // The schema came with the branch but not the ledger of applied migrations: copy it, or the
    // env's first deploy runs every migration again on tables that already exist.
    if (ledgerFrom) {
      signal?.throwIfAborted()
      const copied = await this.ctx.appdb.copyMigrationLedger(ledgerFrom, env.db_url!)
      log(
        `migrations ledger copied from ${env.from_env ?? 'main'} (${copied} applied migration${copied === 1 ? '' : 's'})`,
      )
    }
    return { url: env.db_url!, host: hostOf(env.db_url!), branchId: env.neon_branch_id! }
  }
}
