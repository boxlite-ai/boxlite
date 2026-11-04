/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { ConflictException, Injectable } from '@nestjs/common'
import { BoxCheckpointService, checkpointName, checkpointUnsupported } from '../box/services/box-checkpoint.service'
import { BoxCheckpoint } from '../box/entities/box-checkpoint.entity'
import { BoxService } from '../box/services/box.service'
import { AUTO_DELETE_DISABLED } from '../box/constants/box-lifecycle.constants'
import { Context } from '../common/context/context'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { createBoxToCreateBox, boxToBoxResponse } from './mappers/box-to-box.mapper'

/** Uses ordinary organization/resource/image/network admission without overriding captured configuration. */
@Injectable()
export class CheckpointBoxService {
  constructor(
    private readonly checkpoints: BoxCheckpointService,
    private readonly boxes: BoxService,
    private readonly limits: CommerceBoxLimitService,
  ) {}

  async create(auth: OrganizationAuthContext, checkpoint: BoxCheckpoint, name?: string) {
    this.checkpoints.requireStorage()
    if (checkpoint.state !== 'ready') throw new ConflictException('Only a ready checkpoint can create a box')
    if (name !== undefined) checkpointName(name)
    const saved = checkpoint.configuration
    if (saved.tty || checkpoint.memoryMib % 1024 !== 0)
      throw checkpointUnsupported('Captured configuration cannot be represented by cloud box creation')
    const dto = createBoxToCreateBox(
      {
        image: saved.image,
        env: Object.fromEntries(saved.env),
        user: saved.user ?? undefined,
        working_dir: saved.working_dir ?? undefined,
        entrypoint: saved.entrypoint ?? undefined,
        cmd: saved.cmd ?? undefined,
        advanced: { privileged: saved.privileged },
        cpus: checkpoint.cpus,
        memory_mib: checkpoint.memoryMib,
        disk_size_gb: checkpoint.diskGb,
        network: { outbound: saved.outbound, inbound: saved.inbound },
        auto_resume: false,
      },
      checkpoint.region,
    )
    dto.name = name
    // Memory imports must never be silently cold-started or automatically deleted.
    dto.autoDelete = AUTO_DELETE_DISABLED
    const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(auth.organizationId)
    return boxToBoxResponse(
      await this.boxes.create(dto, auth.organization, Context.user(), {
        maxCreatedBoxes,
        initialCheckpointId: checkpoint.id,
        initialCheckpointRunnerId: checkpoint.nativeRunnerId ?? undefined,
      }),
    )
  }
}
