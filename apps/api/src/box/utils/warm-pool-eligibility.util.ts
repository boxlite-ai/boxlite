/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBoxDto } from '../dto/create-box.dto'
import { ResolvedImage } from '../../image/services/image-resolver.service'

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
 * The image is the other half, and it is not about what the pool was built
 * with: an organization's own image must never be served from a shared pool at
 * all. `BoxService.createForWarmPool` refuses the same thing from the other
 * side, so neither a claim nor a top-up can cross organizations.
 *
 * Kept as a pure rule rather than inline in `BoxService.create` so it can be
 * pinned directly: the failure it prevents is a 201 plus a box that ignored the
 * request, which is invisible from the outside.
 */
export function requiresFreshBox(
  createBoxDto: Pick<
    CreateBoxDto,
    'networkBlockAll' | 'networkAllowList' | 'runAsUser' | 'workingDir' | 'entrypoint' | 'cmd' | 'secrets'
  >,
  organization: { boxLimitedNetworkEgress?: boolean },
  resolvedImage: Pick<ResolvedImage, 'isOrgOwned'>,
): boolean {
  // The pool is curated-only, and this is the near side of that: a warm box is
  // created without an organization and handed to whichever one claims it, so a
  // box built from one tenant's image could be handed to another. Answering
  // here rather than by finding nothing in the pool also keeps an org image out
  // of `warm-pool:skip:<image>`, a Redis key whose name would otherwise be
  // tenant input.
  if (resolvedImage.isOrgOwned) {
    return true
  }

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

  return overridesNetworkPolicy || overridesContainerProcess || overridesSecrets
}
