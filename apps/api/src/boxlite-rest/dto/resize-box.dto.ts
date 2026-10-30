import { IsInt, Max, Min, ValidateIf } from 'class-validator'

export class ResizeBoxDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(255)
  cpus?: number

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(0xffffffff)
  memory_mib?: number
}
