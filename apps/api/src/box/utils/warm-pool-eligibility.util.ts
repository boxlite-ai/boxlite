/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBoxDto } from '../dto/create-box.dto'

/**
 * Whether this request must get a freshly-created box instead of claiming a
 * pre-warmed one.
 *
 * A warm-pool box is already created and booted on a runner, so anything fixed
 * at container-build time cannot be applied to it afterwards. The pool key
 * (`warm_pool_find_idx`: image, target, class, cpu, mem, disk, gpu, osUser, env)
 * covers only what the pool is provisioned with — so for every option outside
 * that key, claiming a warm box means silently ignoring what the caller asked
 * for.
 *
 * Kept as a pure rule rather than inline in `BoxService.create` so it can be
 * pinned directly: the failure it prevents is a 201 plus a box that ignored the
 * request, which is invisible from the outside.
 */
export function requiresFreshBox(
  createBoxDto: Pick<
    CreateBoxDto,
    'networkBlockAll' | 'networkAllowList' | 'runAsUser' | 'workingDir' | 'entrypoint' | 'cmd' | 'secrets' | 'diskIo'
  >,
  organization: { boxLimitedNetworkEgress?: boolean },
): boolean {
  // Network policy is applied to the box at create time on the runner.
  const overridesNetworkPolicy =
    createBoxDto.networkBlockAll !== undefined ||
    createBoxDto.networkAllowList !== undefined ||
    Boolean(organization.boxLimitedNetworkEgress)

  // entrypoint, cmd, working_dir and the process user are all decided when the
  // container is built and cannot change on a running box.
  const overridesContainerProcess =
    createBoxDto.runAsUser !== undefined ||
    createBoxDto.workingDir !== undefined ||
    createBoxDto.entrypoint !== undefined ||
    createBoxDto.cmd !== undefined

  // Secrets become placeholder env vars and an MITM CA at box-build time; a
  // warm box was built without the caller's secrets, so claiming one would
  // silently drop them.
  const overridesSecrets = (createBoxDto.secrets?.length ?? 0) > 0

  // Disk I/O limits are written to the box's cgroup when the runner creates
  // it; a warm box was created unthrottled and is not in the pool key.
  const overridesDiskIo = createBoxDto.diskIo !== undefined

  return overridesNetworkPolicy || overridesContainerProcess || overridesSecrets || overridesDiskIo
}
