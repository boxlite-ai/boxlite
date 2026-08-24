import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { SignupCreditOutbox } from './entities/signup-credit-outbox.entity'
import { SignupCreditOutboxService } from './services/signup-credit-outbox.service'
import { SignupCreditPublisherService } from './services/signup-credit-publisher.service'

@Module({
  imports: [TypeOrmModule.forFeature([SignupCreditOutbox])],
  providers: [SignupCreditOutboxService, SignupCreditPublisherService, RedisLockProvider],
  exports: [SignupCreditOutboxService],
})
export class SignupCreditModule {}
