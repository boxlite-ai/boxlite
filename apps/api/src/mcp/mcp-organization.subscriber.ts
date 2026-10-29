/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Injectable } from '@nestjs/common'
import { DataSource, EntitySubscriberInterface, RemoveEvent } from 'typeorm'
import { Organization } from '../organization/entities/organization.entity'
import { McpOutputStore } from './mcp-output.store'

@Injectable()
export class McpOrganizationSubscriber implements EntitySubscriberInterface<Organization> {
  constructor(
    database: DataSource,
    private readonly output: McpOutputStore,
  ) {
    database.subscribers.push(this)
  }

  listenTo() {
    return Organization
  }

  async beforeRemove(event: RemoveEvent<Organization>): Promise<void> {
    const id = event.entity?.id ?? event.databaseEntity?.id
    if (id) await this.output.purgeOrganization(id)
  }
}
