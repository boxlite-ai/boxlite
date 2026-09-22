import { Module } from '@nestjs/common'
import { BusinessEventOutboxModule } from './business-event-outbox.module'
import { BusinessEventPublisherService } from './business-event-publisher.service'

@Module({
  imports: [BusinessEventOutboxModule],
  providers: [BusinessEventPublisherService],
})
export class BusinessEventPublisherModule {}
