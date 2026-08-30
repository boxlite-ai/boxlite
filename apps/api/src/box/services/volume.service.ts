/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, Not, In, FindOptionsWhere } from 'typeorm'
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
import { setTimeout as sleep } from 'timers/promises'

// Shape Postgres accepts for a `uuid` column. Used to keep plain names out of
// an id predicate, not to validate ids - the database is the authority.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  async waitForReady(volumeId: string, timeoutSeconds: number): Promise<Volume> {
    const deadline = Date.now() + timeoutSeconds * 1000

    while (true) {
      const volume = await this.volumeRepository.findOne({ where: { id: volumeId } })
      if (!volume) {
        throw new NotFoundException(`Volume with ID ${volumeId} not found`)
      }
      if (volume.state === VolumeState.READY) {
        return volume
      }
      if (volume.state === VolumeState.ERROR) {
        throw new BadRequestError('Volume creation failed')
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new RequestTimeoutException(`Timed out waiting for volume ${volumeId} to become ready`)
      }
      await sleep(Math.min(500, remaining))
    }
  }

  async delete(volumeId: string, force = false): Promise<void> {
    const volume = await this.volumeRepository.findOne({
      where: {
        id: volumeId,
      },
    })

    if (!volume) {
      if (force) {
        return
      }
      throw new NotFoundException(`Volume with ID ${volumeId} not found`)
    }

    if (force && [VolumeState.PENDING_DELETE, VolumeState.DELETING, VolumeState.DELETED].includes(volume.state)) {
      return
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

  /**
   * Resolve each selector to the volume it names, or throw.
   *
   * Returns a selector -> canonical id map rather than void: a selector may be
   * a *name*, and a name is only unique within an organization. Everything
   * downstream - the persisted box, the runner dispatch, the derived bucket
   * `boxlite-volume-<id>` - treats the stored value as a globally canonical id.
   * Persisting the caller's selector instead would let one tenant name a volume
   * after another tenant's id and have the runner resolve it there.
   */
  async validateVolumes(organizationId: string, volumeIdOrNames: string[]): Promise<Map<string, string>> {
    if (!volumeIdOrNames.length) {
      return new Map()
    }

    // `id` is a Postgres uuid column, so comparing it against a plain name
    // raises `invalid input syntax for type uuid` and takes the whole query
    // down - including the name branch that would have matched. Only
    // uuid-shaped selectors reach the id predicate; every selector is safe
    // against `name`, which is a varchar.
    const uuidShaped = volumeIdOrNames.filter((selector) => UUID_PATTERN.test(selector))

    const where: FindOptionsWhere<Volume>[] = [
      { name: In(volumeIdOrNames), organizationId, state: Not(VolumeState.DELETED) },
    ]
    if (uuidShaped.length) {
      where.push({ id: In(uuidShaped), organizationId, state: Not(VolumeState.DELETED) })
    }

    const volumes = await this.volumeRepository.find({ where })

    const byId = new Map(volumes.map((volume) => [volume.id, volume]))
    const byName = new Map(volumes.map((volume) => [volume.name, volume]))

    // Resolve every selector before judging any of them. Ids win over names: an
    // id is globally unique, a name only unique per organization.
    const selected = new Map<string, Volume>()
    for (const selector of volumeIdOrNames) {
      const volume = byId.get(selector) ?? byName.get(selector)
      if (!volume) {
        throw new NotFoundException(`Volume '${selector}' not found`)
      }
      selected.set(selector, volume)
    }

    // Readiness is checked on the volumes actually selected, not on every row
    // the query returned: a non-ready volume whose *name* collides with a ready
    // volume's id is not part of this request and must not fail it.
    for (const volume of new Set(selected.values())) {
      if (volume.state !== VolumeState.READY) {
        throw new BadRequestError(`Volume '${volume.name}' is not in a ready state. Current state: ${volume.state}`)
      }
    }

    return new Map(Array.from(selected, ([selector, volume]) => [selector, volume.id]))
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
