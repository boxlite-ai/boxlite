/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { CreateOrganizationRoleDto } from '../dto/create-organization-role.dto'
import { splitResourcePermissions } from '../dto/proxy-permissions.dto'
import { UpdateOrganizationRoleDto } from '../dto/update-organization-role.dto'
import { OrganizationRole } from '../entities/organization-role.entity'
import { OrganizationResourcePermission } from '../enums/organization-resource-permission.enum'

@Injectable()
export class OrganizationRoleService {
  constructor(
    @InjectRepository(OrganizationRole)
    private readonly organizationRoleRepository: Repository<OrganizationRole>,
  ) {}

  async create(
    organizationId: string,
    createOrganizationRoleDto: CreateOrganizationRoleDto,
  ): Promise<OrganizationRole> {
    const role = new OrganizationRole()
    role.organizationId = organizationId
    role.name = createOrganizationRoleDto.name
    role.description = createOrganizationRoleDto.description
    role.permissions = rolePermissions(
      createOrganizationRoleDto.permissions,
      createOrganizationRoleDto.proxyPermissions,
    )
    return this.organizationRoleRepository.save(role)
  }

  async findAll(organizationId: string): Promise<OrganizationRole[]> {
    return this.organizationRoleRepository.find({
      where: [{ organizationId }, { isGlobal: true }],
      order: {
        id: 'ASC',
      },
    })
  }

  async findByIds(roleIds: string[]): Promise<OrganizationRole[]> {
    if (roleIds.length === 0) {
      return []
    }

    return this.organizationRoleRepository.find({
      where: {
        id: In(roleIds),
      },
    })
  }

  async update(
    organizationId: string,
    roleId: string,
    updateOrganizationRoleDto: UpdateOrganizationRoleDto,
  ): Promise<OrganizationRole> {
    if (!organizationId || !roleId) {
      throw new NotFoundException('Organization role not found')
    }

    return this.organizationRoleRepository.manager.transaction(async (manager) => {
      const roles = manager.getRepository(OrganizationRole)
      const role = await roles.findOne({
        where: [
          { id: roleId, organizationId },
          { id: roleId, isGlobal: true },
        ],
        lock: { mode: 'pessimistic_write' },
      })

      if (!role) {
        throw new NotFoundException(`Organization role with ID ${roleId} not found`)
      }

      if (role.isGlobal) {
        throw new ForbiddenException('Global roles cannot be updated')
      }

      role.name = updateOrganizationRoleDto.name
      role.description = updateOrganizationRoleDto.description
      role.permissions = rolePermissions(
        updateOrganizationRoleDto.permissions,
        updateOrganizationRoleDto.proxyPermissions ?? splitResourcePermissions(role.permissions).proxyPermissions,
      )

      return roles.save(role)
    })
  }

  async delete(organizationId: string, roleId: string): Promise<void> {
    if (!organizationId || !roleId) {
      throw new NotFoundException('Organization role not found')
    }

    const role = await this.organizationRoleRepository.findOne({
      where: [
        { id: roleId, organizationId },
        { id: roleId, isGlobal: true },
      ],
    })

    if (!role) {
      throw new NotFoundException(`Organization role with ID ${roleId} not found`)
    }

    if (role.isGlobal) {
      throw new ForbiddenException('Global roles cannot be deleted')
    }

    await this.organizationRoleRepository.remove(role)
  }
}

function rolePermissions(
  permissions: OrganizationResourcePermission[],
  proxyPermissions: OrganizationResourcePermission[] = [],
): OrganizationResourcePermission[] {
  if (permissions.length === 0 && proxyPermissions.length === 0) {
    throw new BadRequestException(['permissions should not be empty'])
  }

  return [...permissions, ...proxyPermissions]
}
