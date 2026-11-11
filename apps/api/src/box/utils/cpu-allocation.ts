import { applyDecorators, BadRequestException } from '@nestjs/common'
import { IsNumber, Max, Min, ValidateBy } from 'class-validator'
import { MIN_CPUS } from '@boxlite-ai/resource-limits'

export const MIN_CPU_PER_BOX = MIN_CPUS
/** Bundled guest kernel CPU ceiling; organization limits may be lower. */
export const MAX_CPU_PER_BOX = 16

function hasCpuPrecision(value: number): boolean {
  return Math.round(value * 1000) / 1000 === value
}

export function assertCpuAllocation(value: number): void {
  if (!Number.isFinite(value) || value < MIN_CPU_PER_BOX || value > MAX_CPU_PER_BOX || !hasCpuPrecision(value)) {
    throw new BadRequestException(
      `cpu must be between ${MIN_CPU_PER_BOX} and ${MAX_CPU_PER_BOX}, in increments of 0.001 cores`,
    )
  }
}

export function CpuAllocation(): PropertyDecorator {
  return applyDecorators(
    IsNumber(),
    Min(MIN_CPU_PER_BOX),
    Max(MAX_CPU_PER_BOX),
    ValidateBy({
      name: 'cpuPrecision',
      validator: {
        validate: hasCpuPrecision,
        defaultMessage: () => 'CPU allocation must be a multiple of 0.001 cores',
      },
    }),
  )
}
