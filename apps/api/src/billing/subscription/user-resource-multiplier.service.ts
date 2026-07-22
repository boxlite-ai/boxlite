/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import Decimal from 'decimal.js'
import { IsNull, Repository } from 'typeorm'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { UserResourceMultiplier } from '../entities/user-resource-multiplier.entity'
import type { ResourceMultipliers } from './subscription.types'

@Injectable()
export class UserResourceMultiplierService {
  constructor(
    @InjectRepository(UserResourceMultiplier)
    private readonly multipliers: Repository<UserResourceMultiplier>,
  ) {}

  async getCurrent(organizationId: string, userId: string) {
    await this.assertOrganizationUser(organizationId, userId)
    const multiplier = await this.multipliers.findOne({
      where: { organizationId, userId, effectiveTo: IsNull() },
    })
    return this.view(userId, multiplier)
  }

  async setCurrent(organizationId: string, userId: string, input: Partial<ResourceMultipliers>) {
    const keys = Object.keys(input)
    if (!keys.length || keys.some((key) => key !== 'cpu' && key !== 'mem' && key !== 'disk' && key !== 'gpu')) {
      throw new BadRequestException('resource multipliers must contain at least one supported resource')
    }
    return this.multipliers.manager.transaction(async (manager) => {
      await this.assertOrganizationUser(organizationId, userId, manager.getRepository(OrganizationUser), true)
      const repository = manager.getRepository(UserResourceMultiplier)
      const current = await repository.findOne({
        where: { organizationId, userId, effectiveTo: IsNull() },
        lock: { mode: 'pessimistic_write' },
      })
      const values = {
        cpu: this.multiplier(input.cpu ?? current?.cpuMultiplier ?? '1', 'cpu'),
        mem: this.multiplier(input.mem ?? current?.memMultiplier ?? '1', 'memory'),
        disk: this.multiplier(input.disk ?? current?.diskMultiplier ?? '1', 'disk'),
        gpu: this.multiplier(input.gpu ?? current?.gpuMultiplier ?? '1', 'gpu'),
      }
      if (
        current &&
        current.cpuMultiplier === values.cpu &&
        current.memMultiplier === values.mem &&
        current.diskMultiplier === values.disk &&
        current.gpuMultiplier === values.gpu
      ) {
        return this.view(userId, current)
      }

      let effectiveFrom = new Date()
      if (current && effectiveFrom <= current.effectiveFrom) {
        effectiveFrom = new Date(current.effectiveFrom.getTime() + 1)
      }
      if (current) {
        current.effectiveTo = effectiveFrom
        await repository.save(current)
      }
      const saved = await repository.save(
        repository.create({
          organizationId,
          userId,
          cpuMultiplier: values.cpu,
          memMultiplier: values.mem,
          diskMultiplier: values.disk,
          gpuMultiplier: values.gpu,
          effectiveFrom,
          effectiveTo: null,
        }),
      )
      return this.view(userId, saved)
    })
  }

  private async assertOrganizationUser(
    organizationId: string,
    userId: string,
    repository = this.multipliers.manager.getRepository(OrganizationUser),
    lock = false,
  ): Promise<void> {
    const member = await repository.findOne({
      where: { organizationId, userId },
      select: { organizationId: true, userId: true },
      ...(lock ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    })
    if (!member) throw new NotFoundException(`user ${userId} is not a member of this organization`)
  }

  private multiplier(value: string, name: string): string {
    try {
      const parsed = new Decimal(value)
      if (!parsed.isFinite() || parsed.isNegative() || parsed.decimalPlaces() > 9) throw new Error()
      return parsed.toString()
    } catch {
      throw new BadRequestException(`${name} multiplier must be a non-negative decimal with at most 9 places`)
    }
  }

  private view(userId: string, multiplier: UserResourceMultiplier | null) {
    return {
      userId,
      multipliers: multiplier
        ? {
            cpu: multiplier.cpuMultiplier,
            mem: multiplier.memMultiplier,
            disk: multiplier.diskMultiplier,
            gpu: multiplier.gpuMultiplier,
          }
        : { cpu: '1', mem: '1', disk: '1', gpu: '1' },
      effectiveFrom: multiplier?.effectiveFrom.toISOString() ?? null,
    }
  }
}
