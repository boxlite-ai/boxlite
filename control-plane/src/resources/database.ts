/** An env's Neon database: one project per App, one branch per env, created on first use (serialised per App). */
import type { Ctx } from '../ctx.js';
import { hostOf, withSslmode } from '../neon.js';
import type { Logger } from './boxes.js';

export class DatabaseProvisioner {
  private readonly dbLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {}

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.dbLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.dbLocks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * One Neon project per app (`mc-<app>`, created on first use); `main` uses the project's default
   * branch, every other env its own branch off its `from` env.
   */
  async ensureDatabase(appId: string, envId: string, log: Logger = () => undefined): Promise<{ url: string; host: string; branchId: string }> {
    return this.locked(appId, async () => {
      const { store, neon } = this.ctx;
      let app = store.appById(appId)!;
      if (!app.neon_project_id) {
        log(`creating Neon project mc-${app.name}`);
        const p = await neon.createProject(`mc-${app.name}`);
        store.updateApp(app.id, { neon_project_id: p.projectId, neon_main_branch_id: p.mainBranchId });
        const main = store.envByName(app.id, 'main');
        if (main) store.updateEnv(main.id, { neon_branch_id: p.mainBranchId, db_url: withSslmode(p.connectionUri) });
        app = store.appById(appId)!;
        // The read-only login reads use (F5), created through the Neon API; reads also do it lazily.
        if (main) {
          await this.ctx.appdb.ensureReader(withSslmode(p.connectionUri)).catch((err: Error) => log(`warning: read-only database login not ready yet: ${err.message}`));
        }
      }
      let env = store.envById(envId)!;
      if (!env.neon_branch_id) {
        let branchId: string;
        if (env.name === 'main') {
          branchId = app.neon_main_branch_id!;
        } else {
          const parent = store.envByName(app.id, env.from_env ?? 'main');
          const parentBranch = parent?.neon_branch_id ?? app.neon_main_branch_id;
          const init = env.with_data ? 'parent-data' : 'schema-only';
          log(`creating Neon branch ${env.name} from ${parent?.name ?? 'main'} (${init})`);
          // A SQL-created reader role would make Neon refuse schema-only branches (412); the CP's
          // start-up pass (DbReaders.migrateAll) removed those once, and nothing creates them now.
          branchId = (await neon.createBranch(app.neon_project_id!, env.name, parentBranch, init)).branchId;
        }
        store.updateEnv(env.id, { neon_branch_id: branchId });
        env = store.envById(envId)!;
      }
      if (!env.db_url) {
        const uri = await neon.connectionUri(app.neon_project_id!, env.neon_branch_id!);
        store.updateEnv(env.id, { db_url: withSslmode(uri) });
        env = store.envById(envId)!;
      }
      return { url: env.db_url!, host: hostOf(env.db_url!), branchId: env.neon_branch_id! };
    });
  }
}
