// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Injectable, Optional } from '@nestjs/common'
import {
  DescribeVolumesCommand,
  DescribeVolumesModificationsCommand,
  EC2Client,
  ModifyVolumeCommand,
} from '@aws-sdk/client-ec2'
import { TypedConfigService } from '../../config/typed-config.service'
import type { RunnerDataDiskRef } from '../common/runner-data-disk-ref'
import { DiskRateLimitedError, type DiskOperation } from './disk-client-contract'

export function toAwsDiskClientError(error: unknown): Error {
  if (
    ['VolumeModificationRateExceeded', 'RequestLimitExceeded', 'Throttling', 'ThrottlingException'].includes(
      (error as Error)?.name,
    )
  ) {
    return new DiskRateLimitedError(error instanceof Error ? error.message : String(error))
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** Capacity changes preserve the volume's IOPS/throughput and verify tenant, stage and host ownership. */
@Injectable()
export class AwsDiskClient {
  private client?: Pick<EC2Client, 'send'>

  constructor(
    private readonly config: TypedConfigService,
    @Optional() transport?: { client?: Pick<EC2Client, 'send'> },
  ) {
    this.client = transport?.client
  }

  private async volume(ref: RunnerDataDiskRef, runnerName?: string) {
    const scope = this.config.get('runnerDisk.aws')
    if (
      ref.provider !== 'aws' ||
      ref.diskType !== 'gp3' ||
      !scope?.region ||
      !scope.accountId ||
      !scope.app ||
      !scope.stage ||
      ref.project !== scope.accountId ||
      !/^vol-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(ref.diskName) ||
      !ref.zone.startsWith(scope.region) ||
      !/^[a-z]$/.test(ref.zone.slice(scope.region.length)) ||
      !runnerName
    ) {
      throw new Error('Runner disk is outside the configured AWS tenant or zone')
    }
    this.client ??= new EC2Client({ region: scope.region })
    const result = await this.client.send(new DescribeVolumesCommand({ VolumeIds: [ref.diskName] }))
    const volume = result.Volumes?.[0]
    const tags = Object.fromEntries((volume?.Tags ?? []).map((tag) => [tag.Key, tag.Value]))
    if (
      !volume ||
      result.Volumes?.length !== 1 ||
      volume.VolumeId !== ref.diskName ||
      volume.AvailabilityZone !== ref.zone ||
      volume.VolumeType !== 'gp3' ||
      !Number.isSafeInteger(volume.Size) ||
      tags['boxlite:app'] !== scope.app ||
      tags['boxlite:stage'] !== scope.stage ||
      tags['boxlite:role'] !== 'runner-data' ||
      tags['boxlite:control-plane-runner-name'] !== runnerName
    ) {
      throw new Error('AWS data disk does not belong to this stage and runner')
    }
    return volume
  }

  async resizeDisk(ref: RunnerDataDiskRef, sizeGb: number, runnerName?: string): Promise<{ operation: string }> {
    if (!Number.isSafeInteger(sizeGb) || sizeGb < 1) throw new Error('AWS disk size must be a positive integer')
    try {
      const volume = await this.volume(ref, runnerName)
      if (volume.Size! < sizeGb) {
        const current = await this.client!.send(new DescribeVolumesModificationsCommand({ VolumeIds: [ref.diskName] }))
        const state = current.VolumesModifications?.[0]?.ModificationState
        if (state && state !== 'completed' && state !== 'failed') {
          throw new DiskRateLimitedError('The previous EBS modification has not completed')
        }
        await this.client!.send(new ModifyVolumeCommand({ VolumeId: ref.diskName, Size: sizeGb }))
      }
      return { operation: `${ref.diskName}:${sizeGb}` }
    } catch (error) {
      throw toAwsDiskClientError(error)
    }
  }

  async getZoneOperation(ref: RunnerDataDiskRef, operation: string, runnerName?: string): Promise<DiskOperation> {
    const [volumeId, rawSize, extra] = operation.split(':')
    const size = Number(rawSize)
    if (
      volumeId !== ref.diskName ||
      extra !== undefined ||
      !/^[1-9][0-9]*$/.test(rawSize ?? '') ||
      !Number.isSafeInteger(size)
    ) {
      throw new Error('AWS modification operation does not identify this data disk')
    }
    try {
      const volume = await this.volume(ref, runnerName)
      const result = await this.client!.send(new DescribeVolumesModificationsCommand({ VolumeIds: [ref.diskName] }))
      const modification = result.VolumesModifications?.[0]
      if (modification?.VolumeId && modification.VolumeId !== ref.diskName)
        throw new Error('AWS returned another disk modification')
      if (modification?.ModificationState === 'failed' && (modification.TargetSize ?? 0) >= size) {
        return { status: 'DONE', error: modification.StatusMessage ?? 'EBS modification failed' }
      }
      const usable = !modification || ['optimizing', 'completed'].includes(modification.ModificationState ?? '')
      return { status: usable && volume.Size! >= size ? 'DONE' : 'RUNNING' }
    } catch (error) {
      throw toAwsDiskClientError(error)
    }
  }
}
