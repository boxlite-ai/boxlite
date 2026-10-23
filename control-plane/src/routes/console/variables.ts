/** Console API: variable and secret-reference edits (each save is one apply deployment), copying variables, backups, the org secret list. */
import { PLATFORM_ORG, appSecretNames, orgSecretNames, secretValue, setAppSecret } from '../../orgs.js';
import { buffer } from 'node:stream/consumers';
import type { Manifest } from '@microcloud/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppRow, Deployment, EnvRow, MigrationFile } from '../../db.js';
import { fail } from '../../errors.js';
import { specToManifest, type Spec } from '../../spec.js';
import { readManifest } from '../util.js';
import { actorOf, type ConsoleKit } from './kit.js';

export function consoleVariableRoutes(api: Hono, k: ConsoleKit): void {
  const { ctx, cp, appOf, envOf, v1, detail, json } = k;
  const { store } = ctx;

  // ---- variables: one save is one apply deployment -------------------------

  /** The manifest behind the latest spec: the request of the deploy/apply that wrote it (rollbacks copy their target). */
  function originOf(env: EnvRow, spec: Spec): Deployment | undefined {
    let d = store.deployment(env.id, spec.deployment);
    for (let i = 0; d && d.kind === 'rollback' && d.request.to && i < 50; i++) d = store.deployment(env.id, d.request.to);
    return d && d.kind !== 'rollback' ? d : undefined;
  }

  function manifestFor(app: AppRow, env: EnvRow, spec: Spec, origin: Deployment | undefined): Manifest {
    const base: Manifest = origin?.request.manifest ? structuredClone(origin.request.manifest) : specToManifest(spec);
    return { ...base, app: app.name, environment: env.name, variables: { ...spec.variables }, secrets: { ...spec.secrets } };
  }

  /** The env's migration files with their SQL, so an apply re-records exactly what is applied. */
  async function migrationsFor(app: AppRow, spec: Spec, origin: Deployment | undefined): Promise<MigrationFile[]> {
    if (!spec.database) return [];
    const withSql = origin?.request.migrations?.filter((m) => typeof m.sql === 'string');
    if (withSql?.length) return withSql;
    const listed = origin?.request.resolved_migrations?.length ? origin.request.resolved_migrations : spec.database.applied;
    const out: MigrationFile[] = [];
    for (const m of listed) {
      if (!ctx.blobs.has(app.id, m.sha256)) continue;
      out.push({ file: m.file, sha256: m.sha256, sql: (await buffer(ctx.blobs.read(app.id, m.sha256))).toString('utf8') });
    }
    return out;
  }

  /**
   * The spec the env is really at: a failed or cancelled deployment writes its spec before it
   * fails, and an edit must neither re-apply that broken configuration nor plan against it.
   */
  const effectiveSpec = (env: EnvRow): Spec | undefined => {
    const version = store.effectiveSpecVersion(env.id);
    return version ? store.spec(env.id, version) : undefined;
  };

  async function applyConfig(app: AppRow, env: EnvRow, message: string, edit: (m: Manifest) => void): Promise<void> {
    const spec = effectiveSpec(env);
    if (!spec) throw fail('conflict', 'this environment has no configuration yet', 'variables come from boxlite.toml; your agent creates them with the first apply or deploy');
    const origin = originOf(env, spec);
    const manifest = manifestFor(app, env, spec, origin);
    edit(manifest);
    // The same rules as boxlite.toml (shared parser), so a console edit never lands something `check` rejects.
    const problem = readManifest(manifest, env.name).errors[0];
    if (problem) throw fail('invalid_request', problem.message, 'change the variable name or secret reference and save again');
    await cp('POST', `${v1(app, env)}/deployments`, { kind: 'apply', manifest, base_version: spec.version, message, migrations: await migrationsFor(app, spec, origin) });
  }

  const actionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('setVariable'), name: z.string(), value: z.string() }),
    z.object({ type: z.literal('removeVariable'), name: z.string() }),
    z.object({ type: z.literal('importVariables'), values: z.record(z.string(), z.string()) }),
    z.object({ type: z.literal('referenceSecret'), name: z.string(), from: z.string() }),
    // A new App secret and its reference in one step: the value is stored as app/<name>, never in the config.
    z.object({ type: z.literal('addSecret'), name: z.string(), value: z.string() }),
    z.object({ type: z.literal('removeSecret'), name: z.string() }),
    z.object({ type: z.literal('createBackup'), message: z.string().max(500).optional() }),
  ]);

  api.post('/apps/:id/actions', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const a = await json(c, actionSchema);
    switch (a.type) {
      case 'setVariable':
        await applyConfig(app, env, `Set ${a.name}`, (m) => {
          delete m.secrets[a.name];
          m.variables[a.name] = a.value;
        });
        break;
      case 'removeVariable':
        await applyConfig(app, env, `Remove ${a.name}`, (m) => {
          if (!(a.name in m.variables)) throw fail('not_found', `no variable ${a.name}`);
          delete m.variables[a.name];
        });
        break;
      case 'importVariables': {
        const names = Object.keys(a.values);
        if (!names.length) throw fail('invalid_request', 'nothing to import');
        await applyConfig(app, env, `Import ${names.length} variable${names.length === 1 ? '' : 's'}`, (m) => {
          for (const [k, v] of Object.entries(a.values)) {
            delete m.secrets[k];
            m.variables[k] = v;
          }
        });
        break;
      }
      case 'referenceSecret':
        if (secretValue(ctx, app, a.from) === undefined) throw fail('not_found', `no secret "${a.from}" for this App`, 'set an App secret first, or have an org admin create the org secret');
        await applyConfig(app, env, `Reference ${a.from} as ${a.name}`, (m) => {
          delete m.variables[a.name];
          m.secrets[a.name] = a.from;
        });
        break;
      case 'addSecret': {
        const stored = setAppSecret(ctx, app, a.name.toLowerCase().replace(/_/g, '-'), a.value, actorOf(k.viewer(c)));
        await applyConfig(app, env, `Add secret ${a.name}`, (m) => {
          delete m.variables[a.name];
          m.secrets[a.name] = stored.name;
        });
        break;
      }
      case 'removeSecret':
        await applyConfig(app, env, `Remove secret ${a.name}`, (m) => {
          if (!(a.name in m.secrets)) throw fail('not_found', `no secret reference ${a.name}`);
          delete m.secrets[a.name];
        });
        break;
      case 'createBackup':
        await cp('POST', `${v1(app, env)}/db/snapshots`, { message: a.message ?? 'Backup from the console' });
        break;
    }
    return c.json(await detail(app, env));
  });

  /** Replaces this env's plain variables and secret references with another env's, as one deployment. */
  api.post('/apps/:id/variables/copy', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ from: z.string() }));
    const source = store.envByName(app.id, b.from);
    const spec = source ? effectiveSpec(source) : undefined;
    if (!source || !spec) throw fail('not_found_env', `environment "${b.from}" has no variables to copy`);
    await applyConfig(app, env, `Copy variables from ${b.from}`, (m) => {
      m.variables = { ...spec.variables };
      m.secrets = { ...spec.secrets };
    });
    return c.json(await detail(app, env));
  });

  /** The App's own secrets (names only) and its org's, for "Add a secret" › "Stored secret". */
  api.get('/apps/:id/secrets', (c) => {
    const app = appOf(c);
    return c.json([...appSecretNames(ctx, app.id), ...orgSecretNames(ctx, app.org_id ?? PLATFORM_ORG)]);
  });
}
