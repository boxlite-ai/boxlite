/** Creating an App (row, key, `main` env) and rotating its key; called by the admin API and the console. */
import { newAppKey, newId, newSecret, sha256hex } from '../auth.js';
import type { AppRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { nameProblem } from '../platform.js';

/** Creates the app row, its key and the `main` env. Neon and the Box are created lazily. */
export function createApp(ctx: Ctx, name: string, actor = 'admin'): { app: AppRow; key: string } {
  const problem = nameProblem(name);
  if (problem) throw fail('invalid_request', `app name "${name}" ${problem}`);
  if (ctx.store.appByName(name)) throw fail('conflict', `an app named "${name}" already exists`);
  const deleted = ctx.store.appByNameAnyState(name);
  if (deleted?.deleted_at) {
    throw fail('conflict', `"${name}" belongs to a deleted app that is kept until ${deleted.purge_after}`, 'restore it from Recently deleted, or pick another name');
  }
  const key = newAppKey();
  const appId = newId('app');
  ctx.store.tx(() => {
    ctx.store.run('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)', appId, name, now());
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

/** A new App key; the old one stops working at once. The new key exists in clear text only in the return value. */
export function rotateKey(ctx: Ctx, app: AppRow, actor: string): string {
  const key = newAppKey();
  ctx.store.tx(() => {
    ctx.store.run('UPDATE keys SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL', now(), app.id);
    insertKey(ctx, app.id, key);
  });
  ctx.store.recordActivity(app.id, null, actor, 'key.rotate');
  return key;
}
