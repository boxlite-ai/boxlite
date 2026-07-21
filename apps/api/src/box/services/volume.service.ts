/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, Not, In } from 'typeorm'
import { Volume } from '../entities/volume.entity'
import { VolumeState } from '../enums/volume-state.enum'
import { CreateVolumeDto } from '../dto/create-volume.dto'
import { v4 as uuidv4 } from 'uuid'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Organization } from '../../organization/entities/organization.entity'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxCreatedEvent } from '../events/box-create.event'
import { OrganizationService } from '../../organization/services/organization.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxRepository } from '../repositories/box.repository'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

@Injectable()
export class VolumeService {
  private readonly logger = new Logger(VolumeService.name)

  constructor(
    @InjectRepository(Volume)
    private readonly volumeRepository: Repository<Volume>,
    private readonly boxRepository: BoxRepository,
    private readonly organizationService: OrganizationService,
    private readonly configService: TypedConfigService,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  async create(organization: Organization, createVolumeDto: CreateVolumeDto): Promise<Volume> {
    if (!this.configService.get('s3.endpoint')) {
      throw new ServiceUnavailableException('Object storage is not configured')
    }

    this.organizationService.assertOrganizationIsNotSuspended(organization)

    const volume = new Volume()

    // Generate ID
    volume.id = uuidv4()

    // Set name from DTO or use ID as default
    volume.name = createVolumeDto.name || volume.id

    // Check if volume with same name already exists for organization
    const existingVolume = await this.volumeRepository.findOne({
      where: {
        organizationId: organization.id,
        name: volume.name,
        state: Not(VolumeState.DELETED),
      },
    })

    if (existingVolume) {
      throw new BadRequestError(`Volume with name ${volume.name} already exists`)
    }

    volume.organizationId = organization.id
    volume.state = VolumeState.PENDING_CREATE

    const savedVolume = await this.volumeRepository.save(volume)
    this.logger.debug(`Created volume ${savedVolume.id} for organization ${organization.id}`)
    return savedVolume
  }

  async delete(volumeId: string): Promise<void> {
    const volume = await this.volumeRepository.findOne({
      where: {
        id: volumeId,
      },
    })

    if (!volume) {
      throw new NotFoundException(`Volume with ID ${volumeId} not found`)
    }

    if (volume.state !== VolumeState.READY && volume.state !== VolumeState.ERROR) {
      throw new BadRequestError(
        `Volume must be in '${VolumeState.READY}' or '${VolumeState.ERROR}' state in order to be deleted`,
      )
    }

    // Check if any non-destroyed boxes are using this volume
    const boxUsingVolume = await this.boxRepository
      .createQueryBuilder('box')
      .where('box.organizationId = :organizationId', {
        organizationId: volume.organizationId,
      })
      .andWhere('box.volumes @> :volFilter::jsonb', {
        volFilter: JSON.stringify([{ volumeId }]),
      })
      .andWhere('box.desiredState != :destroyed', {
        destroyed: BoxDesiredState.DESTROYED,
      })
      .select(['box.id', 'box.name'])
      .getOne()

    if (boxUsingVolume) {
      throw new ConflictException(
        `Volume cannot be deleted because it is in use by one or more boxes (e.g. ${boxUsingVolume.name})`,
      )
    }

    // Update state to mark as deleting
    volume.state = VolumeState.PENDING_DELETE
    await this.volumeRepository.save(volume)
    this.logger.debug(`Marked volume ${volumeId} for deletion`)
  }

  async findOne(volumeId: string): Promise<Volume> {
    const volume = await this.volumeRepository.findOne({
      where: { id: volumeId },
    })

    if (!volume) {
      throw new NotFoundException(`Volume with ID ${volumeId} not found`)
    }

    return volume
  }

  async findAll(organizationId: string, includeDeleted = false): Promise<Volume[]> {
    return this.volumeRepository.find({
      where: {
        organizationId,
        ...(includeDeleted ? {} : { state: Not(VolumeState.DELETED) }),
      },
      order: {
        lastUsedAt: {
          direction: 'DESC',
          nulls: 'LAST',
        },
        createdAt: 'DESC',
      },
    })
  }

  async findByName(organizationId: string, name: string): Promise<Volume> {
    const volume = await this.volumeRepository.findOne({
      where: {
        organizationId,
        name,
        state: Not(VolumeState.DELETED),
      },
    })

    if (!volume) {
      throw new NotFoundException(`Volume with name ${name} not found`)
    }

    return volume
  }

  async resolveReadyVolumes(organizationId: string, volumeIdOrNames: string[]): Promise<Volume[]> {
    if (!volumeIdOrNames.length) {
      return []
    }

    const volumes = await this.volumeRepository.find({
      where: [
        { id: In(volumeIdOrNames), organizationId, state: Not(VolumeState.DELETED) },
        { name: In(volumeIdOrNames), organizationId, state: Not(VolumeState.DELETED) },
      ],
    })

    const volumesById = new Map(volumes.map((volume) => [volume.id, volume]))
    const volumesByName = new Map(volumes.map((volume) => [volume.name, volume]))

    return volumeIdOrNames.map((idOrName) => {
      const volume = volumesById.get(idOrName) || volumesByName.get(idOrName)
      if (!volume) {
        throw new NotFoundException(`Volume '${idOrName}' not found`)
      }

      if (volume.state !== VolumeState.READY) {
        throw new BadRequestError(`Volume '${volume.name}' is not in a ready state. Current state: ${volume.state}`)
      }

      return volume
    })
  }

  async getOrganizationId(params: { id: string } | { name: string; organizationId: string }): Promise<string> {
    if ('id' in params) {
      const volume = await this.volumeRepository.findOneOrFail({
        where: {
          id: params.id,
        },
        select: ['organizationId'],
        loadEagerRelations: false,
      })
      return volume.organizationId
    }

    const volume = await this.volumeRepository.findOneOrFail({
      where: {
        name: params.name,
        organizationId: params.organizationId,
      },
      select: ['organizationId'],
      loadEagerRelations: false,
    })

    return volume.organizationId
  }

  @OnEvent(BoxEvents.CREATED)
  private async handleBoxCreatedEvent(event: BoxCreatedEvent) {
    if (!event.box.volumes.length) {
      return
    }

    try {
      const volumeIds = event.box.volumes.map((vol) => vol.volumeId)
      const volumes = await this.volumeRepository.find({ where: { id: In(volumeIds) } })

      const results = await Promise.allSettled(
        volumes.map(async (volume) => {
          // Update once per minute at most
          if (!(await this.redisLockProvider.lock(`volume:${volume.id}:update-last-used`, 60))) {
            return
          }
          volume.lastUsedAt = event.box.createdAt
          return this.volumeRepository.save(volume)
        }),
      )

      results.forEach((result) => {
        if (result.status === 'rejected') {
          this.logger.error(`Failed to update volume lastUsedAt timestamp for box ${event.box.id}: ${result.reason}`)
        }
      })
    } catch (err) {
      this.logger.error(err)
    }
  }
}
