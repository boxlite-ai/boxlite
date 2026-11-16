import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsBoolean, IsDefined } from 'class-validator'

@ApiSchema({ name: 'AdminOrganizationNestedVirtualization' })
export class AdminOrganizationNestedVirtualizationDto {
  @ApiProperty({ description: 'Allow new boxes to use nesting when their selected Runner supports it.' })
  @IsDefined()
  @IsBoolean()
  enabled: boolean
}
