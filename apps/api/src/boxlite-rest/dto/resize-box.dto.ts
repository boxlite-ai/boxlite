import { IsInt, Max, Min, ValidateIf } from 'class-validator'
import { CpuAllocation } from '../../box/utils/cpu-allocation'

export class ResizeBoxDto {
  @ValidateIf((_object, value) => value !== undefined)
  @CpuAllocation()
  cpus?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(0xffffffff)
  memory_mib?: number
}
