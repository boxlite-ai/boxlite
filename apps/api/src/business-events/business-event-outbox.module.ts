import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BusinessEventOutbox } from './business-event-outbox.entity'
import { BusinessEventOutboxService } from './business-event-outbox.service'

@Module({
  imports: [TypeOrmModule.forFeature([BusinessEventOutbox])],
  providers: [BusinessEventOutboxService],
  exports: [BusinessEventOutboxService],
})
export class BusinessEventOutboxModule {}
