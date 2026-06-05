/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { DataSource, EntitySubscriberInterface, EventSubscriber, RemoveEvent, UpdateEvent } from 'typeorm'
import { BoxTemplateEvents } from '../constants/box-template-events'
import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateStateUpdatedEvent } from '../events/box-template-state-updated.event'
import { BoxTemplateRemovedEvent } from '../events/box-template-removed.event'

@EventSubscriber()
export class BoxTemplateSubscriber implements EntitySubscriberInterface<BoxTemplate> {
  @Inject(EventEmitter2)
  private eventEmitter: EventEmitter2

  constructor(dataSource: DataSource) {
    dataSource.subscribers.push(this)
  }

  listenTo() {
    return BoxTemplate
  }

  afterUpdate(event: UpdateEvent<BoxTemplate>) {
    const updatedColumns = event.updatedColumns.map((col) => col.propertyName)

    updatedColumns.forEach((column) => {
      switch (column) {
        case 'state':
          this.eventEmitter.emit(
            BoxTemplateEvents.STATE_UPDATED,
            new BoxTemplateStateUpdatedEvent(
              event.entity as BoxTemplate,
              event.databaseEntity[column],
              event.entity[column],
            ),
          )
          break
        default:
          break
      }
    })
  }

  beforeRemove(event: RemoveEvent<BoxTemplate>) {
    this.eventEmitter.emit(BoxTemplateEvents.REMOVED, new BoxTemplateRemovedEvent(event.databaseEntity as BoxTemplate))
  }
}
