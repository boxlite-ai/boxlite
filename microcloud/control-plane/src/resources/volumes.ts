/** An env's BoxLite managed volumes: naming, creating or adopting them for a new Box, and deleting them by recorded id (F10). */
import type { VolumeSpec } from '@microcloud/shared';
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { UpstreamError, fail } from '../errors.js';

/** The BoxLite managed volume of an env's `[[volume]]` (contracts §4.1 "Volumes"). */
export const volumeName = (app: string, env: string, volume: string) => `mc-${app}-${env}-${volume}`;

/** The env's volume set as recorded on the env (`name:mount,…`, sorted): a change means a new Box. */
export function volumeKey(volumes: VolumeSpec[]): string {
  return volumes
    .map((v) => `${v.name}:${v.mount}`)
    .sort()
    .join(',');
}

/** The mounts for a new Box: each declared volume, created on first use or adopted when this CP made it before ids were recorded. */
export async function volumeMounts(ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>, app: AppRow, env: EnvRow, volumes: VolumeSpec[], log: (line: string) => void): Promise<{ managed_volume: string; guest_path: string }[]> {
  const { store, boxlite } = ctx;
  const mounts: { managed_volume: string; guest_path: string }[] = [];
  const existing = await boxlite.listVolumes();
  const recorded = new Map(store.envVolumes(env.id).map((r) => [r.name, r.volume_id]));
  // Pre-F10 envs: the CP's own record of what it mounted (`name:mount,…`).
  const legacy = new Set((env.box_volumes ?? '').split(',').filter(Boolean).map((e) => e.slice(0, e.indexOf(':'))));
  for (const v of volumes) {
    const name = volumeName(app.name, env.name, v.name);
    const id = recorded.get(name);
    const byId = id ? existing.find((x) => x.id === id) : undefined;
    if (!byId) {
      const sameName = existing.find((x) => x.name === name);
      if (sameName && !id && legacy.has(v.name)) {
        // Created by this CP before volume ids were recorded; adopt it by its id.
        log(`recording volume ${name} (${sameName.id})`);
        store.recordVolume(env.id, name, sameName.id);
      } else if (sameName) {
        // Never mount (or later delete) a volume this CP did not create (F10).
        throw fail('conflict', `a BoxLite volume named ${name} already exists and was not created for this environment`, 'rename the [[volume]] in boxlite.toml, or remove that volume in BoxLite');
      } else {
        log(`creating volume ${name}`);
        const created = await boxlite.createVolume(name);
        store.recordVolume(env.id, name, created.id);
      }
    }
    // BoxLite mounts managed volumes by name.
    mounts.push({ managed_volume: name, guest_path: v.mount });
  }
  return mounts;
}

/**
 * Deletes the BoxLite volumes recorded for the env, by id (F10). A volume is recorded when this CP
 * creates it; nothing is ever matched by name, so another resource in the org is never touched.
 * Volumes of an env created before ids were recorded, and not deployed since, are left in place
 * and reported.
 */
export async function deleteVolumes(ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>, app: AppRow, env: EnvRow): Promise<string[]> {
  const { store, boxlite } = ctx;
  for (const v of store.envVolumes(env.id)) {
    try {
      await boxlite.deleteVolume(v.volume_id);
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
    }
    store.forgetVolume(env.id, v.name);
  }
  const unrecorded = (env.box_volumes ?? '')
    .split(',')
    .filter(Boolean)
    .map((e) => volumeName(app.name, env.name, e.slice(0, e.indexOf(':'))))
    .filter((name) => !store.envVolumes(env.id).some((r) => r.name === name));
  if (unrecorded.length) console.warn(`[resources] env ${env.id}: volumes without a recorded id were left in place: ${unrecorded.join(', ')}`);
  return unrecorded;
}
