// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Storage } from '@google-cloud/storage'
import { Checkpoint } from '../entities/checkpoint.entity'
import { checkpointConfig } from '../../config/checkpoint-config'

/** Deletes only the immutable object assigned to this checkpoint's tenant. */
@Injectable()
export class CheckpointArchiveStore {
  private readonly storage = new Storage()

  constructor(private readonly config: ConfigService) {}

  async remove(checkpoint: Checkpoint): Promise<void> {
    const prefix = this.config.get<ReturnType<typeof checkpointConfig>>('checkpoint')?.archivePrefix
    if (!prefix || checkpoint.arcPath !== `${prefix}${checkpoint.organizationId}/${checkpoint.id}/archive.boxlite`)
      throw new ServiceUnavailableException('Checkpoint archive is outside the configured storage prefix')
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(checkpoint.arcPath)
    if (!match) throw new ServiceUnavailableException('Checkpoint storage is not configured')
    try {
      await this.storage.bucket(match[1]).file(match[2]).delete({ ignoreNotFound: true })
    } catch (cause) {
      throw new ServiceUnavailableException('Checkpoint archive deletion failed; retry deletion', { cause })
    }
  }
}
