/** Platform volumes owned by an App and provisioned for an environment. */
import type { VolumeSpec } from '@boxlite-ai/cloud-app-shared'
import type { AppRow, EnvRow } from '../db'
import type { Ctx } from '../ctx'

/** The BoxLite managed volume of an env's `[[volume]]` (contracts §4.1 "Volumes"). */
export const volumeName = (app: string, env: string, volume: string) => `mc-${app}-${env}-${volume}`

/** The env's volume set as recorded on the env (`name:mount,…`, sorted): a change means a new Box. */
export function volumeKey(volumes: VolumeSpec[]): string {
  return volumes
    .map((v) => `${v.name}:${v.mount}`)
    .sort()
    .join(',')
}

/** Resolve declared mounts through platform volume ownership, creating missing volumes. */
export async function volumeMounts(
  ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>,
  app: AppRow,
  env: EnvRow,
  volumes: VolumeSpec[],
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ managed_volume: string; guest_path: string }[]> {
  const mounts: { managed_volume: string; guest_path: string }[] = []
  const existing = await ctx.volumes.list(app, env)
  for (const v of volumes) {
    signal?.throwIfAborted()
    const name = volumeName(app.name, env.name, v.name)
    let volume = existing.find((volume) => volume.name === name)
    if (!volume) {
      log(`creating volume ${name}`)
      volume = await ctx.volumes.create(app, env, name)
    }
    mounts.push({ managed_volume: volume.id, guest_path: v.mount })
  }
  return mounts
}

/** Delete the platform volumes owned by this App environment. */
export async function deleteVolumes(
  ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>,
  app: AppRow,
  env: EnvRow,
): Promise<void> {
  for (const volume of await ctx.volumes.list(app, env)) {
    await ctx.volumes.remove(app, env, volume.id)
  }
}
