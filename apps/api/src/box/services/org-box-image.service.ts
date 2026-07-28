/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { supportedImages } from '../constants/curated-images.constant'
import { CreateOrgBoxImageDto, BoxImageDto } from '../dto/org-box-image.dto'
import { OrgBoxImage } from '../entities/org-box-image.entity'
import { OrgBoxImageStatus } from '../enums/org-box-image-status.enum'

@Injectable()
export class OrgBoxImageService {
  constructor(
    @InjectRepository(OrgBoxImage)
    private readonly orgBoxImageRepository: Repository<OrgBoxImage>,
  ) {}

  async create(organizationId: string, dto: CreateOrgBoxImageDto, userId?: string): Promise<OrgBoxImage> {
    this.assertImageRef(dto.ref)

    const image = this.orgBoxImageRepository.create({
      organizationId,
      name: dto.name,
      ref: dto.ref,
      status: OrgBoxImageStatus.ACTIVE,
      createdBy: userId,
    })
    return await this.orgBoxImageRepository.save(image)
  }

  async listAvailable(organizationId: string): Promise<BoxImageDto[]> {
    const orgImages = await this.orgBoxImageRepository.find({
      where: { organizationId, status: OrgBoxImageStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    })

    return [
      ...supportedImages().map((image) => ({ ...image, source: 'system' as const })),
      ...orgImages.map(BoxImageDto.fromOrgImage),
    ]
  }

  async resolveImage(organizationId: string, image: string | undefined): Promise<string> {
    const systemImages = supportedImages()

    if (image === undefined) {
      return systemImages[0].ref
    }

    const systemMatch = systemImages.find(({ name, ref }) => image === name || image === ref)
    if (systemMatch) {
      return systemMatch.ref
    }

    const orgMatch = await this.orgBoxImageRepository.findOne({
      where: [
        { organizationId, status: OrgBoxImageStatus.ACTIVE, name: image },
        { organizationId, status: OrgBoxImageStatus.ACTIVE, ref: image },
      ],
    })
    if (orgMatch) {
      return orgMatch.ref
    }

    const options = (await this.listAvailable(organizationId)).map(({ name, ref }) => `${name} (${ref})`).join(', ')
    throw new BadRequestError(`Unsupported image '${image}'. Supported images: ${options}`)
  }

  private assertImageRef(ref: string): void {
    if (/^\s|\s$|\s/.test(ref)) {
      throw new BadRequestError('Image ref must not contain whitespace')
    }
    if (ref.includes('://')) {
      throw new BadRequestError('Image ref must be an OCI image reference, not a URL')
    }
  }
}
