/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { BoxAdvancedOptions, LinuxCapabilities } from '../common/box-advanced-options'

@ApiSchema({ name: 'LinuxCapabilities' })
export class LinuxCapabilitiesDto implements LinuxCapabilities {
  @ApiProperty({
    description: 'Linux capabilities added to the default container capability set',
    type: [String],
    example: ['SYS_ADMIN'],
  })
  add: string[]

  @ApiProperty({
    description: 'Linux capabilities removed from the container capability set',
    type: [String],
    example: ['NET_RAW'],
  })
  drop: string[]
}

@ApiSchema({ name: 'BoxAdvancedOptions' })
export class BoxAdvancedOptionsDto implements BoxAdvancedOptions {
  @ApiProperty({ type: LinuxCapabilitiesDto })
  capabilities: LinuxCapabilitiesDto
}
