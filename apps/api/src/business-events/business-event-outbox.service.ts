import { Injectable } from '@nestjs/common'
import { EntityManager } from 'typeorm'
import { BusinessEventOutbox, InvitationRegistrationSucceeded } from './business-event-outbox.entity'

@Injectable()
export class BusinessEventOutboxService {
  async enqueue(em: EntityManager, organizationId: string, payload: InvitationRegistrationSucceeded): Promise<void> {
    await em.insert(BusinessEventOutbox, { eventId: payload.eventId, organizationId, payload })
  }
}
