/** Creating an App (row, key, `main` env) and rotating its key; called by the admin API and the console. */
import { PLATFORM_ORG } from '../orgs.js';
import { newAppKey, newId, newSecret, sha256hex } from '../auth.js';
import type { AppRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { nameProblem } from '../platform.js';

/** Creates the app row, its key and the `main` env. Neon and the Box are created lazily. */
/** A new App in `orgId` (orgs.ts; the platform's org for the admin token and the CLI's admin calls). */
export function createApp(ctx: Ctx, name: string, actor = 'admin', orgId = PLATFORM_ORG): { app: AppRow; key: string } {
  const problem = nameProblem(name);
  if (problem) throw fail('invalid_request', `app name "${name}" ${problem}`);
  if (ctx.store.appByName(name)) throw fail('conflict', `an app named "${name}" already exists`);
  const deleted = ctx.store.appByNameAnyState(name);
  if (deleted?.deleted_at) {
    // App names are one namespace (they are URLs); another org's deleted App is just a taken name.
    if (deleted.org_id !== orgId) throw fail('conflict', `the name "${name}" is taken`, 'pick another name');
    // A date people read (the console shows this message as is); the exact time stays in Recently deleted.
    const until = deleted.purge_after ? new Date(deleted.purge_after).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'its purge';
    throw fail('conflict', `"${name}" belongs to a deleted app that is kept until ${until}`, 'restore it from Recently deleted, or pick another name');
  }
  const key = newAppKey();
  const appId = newId('app');
  ctx.store.tx(() => {
    ctx.store.run('INSERT INTO apps (id, name, created_at, org_id) VALUES (?, ?, ?, ?)', appId, name, now(), orgId);
    insertKey(ctx, appId, key);
    ctx.store.run('INSERT INTO envs (id, app_id, name, created_at, forward_secret) VALUES (?, ?, ?, ?, ?)', newId('env'), appId, 'main', now(), newSecret());
  });
  const app = ctx.store.appById(appId)!;
  ctx.store.recordActivity(app.id, null, actor, 'app.create', { name });
  return { app, key };
}

/** Only the key's sha256 and last 4 characters are kept. */
function insertKey(ctx: Ctx, appId: string, key: string): void {
  ctx.store.run('INSERT INTO keys (id, app_id, hash, last4, created_at) VALUES (?, ?, ?, ?, ?)', newId('key'), appId, sha256hex(key), key.slice(-4), now());
}

/** Active App keys an App may hold at once (one per agent setup, roughly). */
export const MAX_ACTIVE_KEYS = 10;

/**
 * One more App key, alongside the active ones: for another agent session or machine, so whoever
 * already works on the App keeps working. The key is shown once; the CP keeps its sha256.
 */
export function issueKey(ctx: Ctx, app: AppRow, actor: string): string {
  const active = ctx.store.get<{ n: number }>('SELECT count(*) AS n FROM keys WHERE app_id = ? AND revoked_at IS NULL', app.id)!.n;
  if (active >= MAX_ACTIVE_KEYS) {
    throw fail('conflict', `${app.name} already has ${active} active App keys`, 'rotate the key instead: that retires every key and issues one new one');
  }
  const key = newAppKey();
  insertKey(ctx, app.id, key);
  ctx.store.recordActivity(app.id, null, actor, 'key.issue');
  return key;
}

/** A new App key; every other key stops working at once. The new key exists in clear text only in the return value. */
export function rotateKey(ctx: Ctx, app: AppRow, actor: string): string {
  const key = newAppKey();
  ctx.store.tx(() => {
    ctx.store.run('UPDATE keys SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL', now(), app.id);
    insertKey(ctx, app.id, key);
  });
  ctx.store.recordActivity(app.id, null, actor, 'key.rotate');
  return key;
}
