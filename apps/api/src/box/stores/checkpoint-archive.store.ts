// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Storage } from '@google-cloud/storage'
import { Checkpoint } from '../entities/checkpoint.entity'
import { checkpointConfig } from '../../config/checkpoint-config'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

/** Deletes only the immutable object assigned to this checkpoint's tenant. */
@Injectable()
export class CheckpointArchiveStore {
  private readonly storage = new Storage()
  private s3?: Pick<S3Client, 'send'>

  constructor(
    private readonly config: ConfigService,
    @Optional() transport?: { s3?: Pick<S3Client, 'send'> },
  ) {
    this.s3 = transport?.s3
  }

  async remove(checkpoint: Checkpoint): Promise<void> {
    const prefix = this.config.get<ReturnType<typeof checkpointConfig>>('checkpoint')?.archivePrefix
    if (!prefix || checkpoint.arcPath !== `${prefix}${checkpoint.organizationId}/${checkpoint.id}/archive.boxlite`)
      throw new ServiceUnavailableException('Checkpoint archive is outside the configured storage prefix')
    const match = /^(gs|s3):\/\/([^/]+)\/(.+)$/.exec(checkpoint.arcPath)
    if (!match) throw new ServiceUnavailableException('Checkpoint storage is not configured')
    try {
      if (match[1] === 'gs') {
        await this.storage.bucket(match[2]).file(match[3]).delete({ ignoreNotFound: true })
      } else {
        this.s3 ??= new S3Client({})
        await this.s3.send(new DeleteObjectCommand({ Bucket: match[2], Key: match[3] }))
      }
    } catch (cause) {
      throw new ServiceUnavailableException('Checkpoint archive deletion failed; retry deletion', { cause })
    }
  }
}
