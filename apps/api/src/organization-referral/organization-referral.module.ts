import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationReferralService } from './organization-referral.service'

@Module({
  imports: [TypeOrmModule.forFeature([Organization])],
  providers: [OrganizationReferralService],
  exports: [OrganizationReferralService],
})
export class OrganizationReferralModule {}
