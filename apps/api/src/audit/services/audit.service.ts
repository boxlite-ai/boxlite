/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { LessThan, Repository, IsNull, Not } from 'typeorm'
import { CreateAuditLogInternalDto } from '../dto/create-audit-log-internal.dto'
import { UpdateAuditLogInternalDto } from '../dto/update-audit-log-internal.dto'
import { AuditLog } from '../entities/audit-log.entity'
import { PaginatedList } from '../../common/interfaces/paginated-list.interface'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { AUDIT_LOG_PUBLISHER, AUDIT_STORAGE_ADAPTER } from '../constants/audit-tokens'
import { AuditLogStorageAdapter } from '../interfaces/audit-storage.interface'
import { AuditLogPublisher } from '../interfaces/audit-publisher.interface'
import { AuditLogFilter } from '../interfaces/audit-filter.interface'
import { DistributedLock } from '../../common/decorators/distributed-lock.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { LogExecution } from '../../common/decorators/log-execution.decorator'

@Injectable()
export class AuditService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditService.name)

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    private readonly configService: TypedConfigService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(AUDIT_STORAGE_ADAPTER)
    private readonly auditStorageAdapter: AuditLogStorageAdapter,
    @Optional()
    @Inject(AUDIT_LOG_PUBLISHER)
    private readonly auditLogPublisher?: AuditLogPublisher,
  ) {}

  onApplicationBootstrap() {
    const auditConfig = this.configService.get('audit')

    // Enable publish cron job if publish is enabled
    if (auditConfig.publish.enabled) {
      this.schedulerRegistry.getCronJob('publish-audit-logs').start()
      return
    }

    // Enable cleanup cron job if retention days is configured and publish is disabled
    if (auditConfig.retentionDays && auditConfig.retentionDays > 0) {
      this.schedulerRegistry.getCronJob('cleanup-old-audit-logs').start()
    }

    const batchSize = this.configService.getOrThrow('audit.publish.batchSize')

    if (batchSize > 50000) {
      throw new Error('Audit publish batch size cannot be greater than 50000')
    }
  }

  async createLog(createDto: CreateAuditLogInternalDto): Promise<AuditLog> {
    const auditLog = new AuditLog(createDto)

    await this.auditLogRepository.insert(auditLog)
    if (auditLog.statusCode !== undefined && this.configService.get('audit.consoleLogEnabled')) {
      this.logger.log(`AUDIT_ENTRY: ${JSON.stringify(auditLog)}`)
    }
    return auditLog
  }

  async updateLog(id: string, updateDto: UpdateAuditLogInternalDto): Promise<AuditLog> {
    const auditLog = await this.auditLogRepository.findOne({ where: { id } })
    if (!auditLog) {
      throw new NotFoundException(`Audit log with ID ${id} not found`)
    }

    if (updateDto.statusCode !== undefined) {
      auditLog.statusCode = updateDto.statusCode
    }

    if (updateDto.errorMessage) {
      auditLog.errorMessage = updateDto.errorMessage
    }

    if (updateDto.targetId) {
      auditLog.targetId = updateDto.targetId
    }

    if (updateDto.organizationId) {
      auditLog.organizationId = updateDto.organizationId
    }

    if (updateDto.metadata !== undefined) {
      auditLog.metadata = { ...auditLog.metadata, ...updateDto.metadata }
    }

    if (this.configService.get('audit.consoleLogEnabled')) {
      this.logger.log(`AUDIT_ENTRY: ${JSON.stringify(auditLog)}`)
    }

    return this.auditLogRepository.save(auditLog)
  }

  async getAllLogs(
    page = 1,
    limit = 10,
    filters?: AuditLogFilter,
    nextToken?: string,
  ): Promise<PaginatedList<AuditLog>> {
    return this.auditStorageAdapter.getAllLogs(page, limit, filters, nextToken)
  }

  async getOrganizationLogs(
    organizationId: string,
    page = 1,
    limit = 10,
    filters?: AuditLogFilter,
    nextToken?: string,
  ): Promise<PaginatedList<AuditLog>> {
    return this.auditStorageAdapter.getOrganizationLogs(organizationId, page, limit, filters, nextToken)
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'cleanup-old-audit-logs',
    waitForCompletion: true,
    disabled: true,
  })
  @DistributedLock()
  @LogExecution('cleanup-old-audit-logs')
  async cleanupOldAuditLogs(): Promise<void> {
    try {
      const retentionDays = this.configService.get('audit.retentionDays')
      if (!retentionDays) {
        return
      }

      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
      this.logger.log(`Starting cleanup of audit logs older than ${retentionDays} days`)

      const deletedLogs = await this.auditLogRepository.delete({
        createdAt: LessThan(cutoffDate),
      })

      const totalDeleted = deletedLogs.affected

      this.logger.log(`Completed cleanup of audit logs older than ${retentionDays} days (${totalDeleted} logs deleted)`)
    } catch (error) {
      this.logger.error(`An error occurred during cleanup of old audit logs: ${error.message}`, error.stack)
    }
  }

  // Resolve dangling audit logs where status code is not set and created at is more than half an hour ago
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'resolve-dangling-audit-logs',
    waitForCompletion: true,
  })
  @DistributedLock()
  @WithInstrumentation()
  @LogExecution('resolve-dangling-audit-logs')
  async resolveDanglingLogs() {
    const started = Date.now()
    const cutoff = new Date(started - 30 * 60 * 1000)
    const consoleEnabled = this.configService.get('audit.consoleLogEnabled')
    let total = 0
    // Four 5-second statement budgets stay below the usual 30-second lease.
    // Row locks and the NULL predicate remain authoritative if the lease expires.
    for (let batch = 0; batch < 4; batch++) {
      const logs: AuditLog[] = await this.auditLogRepository.manager.transaction(async (manager) => {
        await manager.query("SET LOCAL statement_timeout = '5s'")
        await manager.query("SET LOCAL lock_timeout = '1s'")
        // Dedicated NULL -> unknown transition: raw SQL deliberately avoids the
        // per-entity subscriber while enforcing its immutability rule in SQL.
        return manager.query(
          `WITH pending AS (
          SELECT id FROM audit_log
          WHERE "statusCode" IS NULL AND "createdAt" < $1
          ORDER BY "createdAt" LIMIT 500 FOR UPDATE SKIP LOCKED
        ), updated AS (
          UPDATE audit_log AS log SET "statusCode" = 0
          FROM pending WHERE log.id = pending.id AND log."statusCode" IS NULL
          RETURNING ${consoleEnabled ? 'log.*' : 'log.id'}
        ) SELECT * FROM updated`,
          [cutoff],
        )
      })
      total += logs.length
      if (consoleEnabled) {
        for (const log of logs) this.logger.log(`AUDIT_ENTRY: ${JSON.stringify(log)}`)
      }
      if (logs.length < 500) break
    }
    this.logger.debug(`Resolved ${total} dangling audit logs in ${Date.now() - started}ms`)
  }

  @Cron(CronExpression.EVERY_SECOND, {
    name: 'publish-audit-logs',
    waitForCompletion: true,
    disabled: true,
  })
  @LogExecution('publish-audit-logs')
  @DistributedLock()
  @WithInstrumentation()
  async publishAuditLogs() {
    // Safeguard
    if (!this.auditLogPublisher) {
      this.logger.warn('Audit log publisher not configured, skipping publish')
      return
    }

    const auditLogs = await this.auditLogRepository.find({
      where: {
        statusCode: Not(IsNull()),
      },
      take: this.configService.getOrThrow('audit.publish.batchSize'),
      order: {
        createdAt: 'ASC',
      },
    })

    if (auditLogs.length === 0) {
      return
    }

    await this.auditLogPublisher.write(auditLogs)
    await this.auditLogRepository.delete(auditLogs.map((log) => log.id))
  }
}
