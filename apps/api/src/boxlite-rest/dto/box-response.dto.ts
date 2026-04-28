/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export class BoxResponseDto {
  box_id: string
  name?: string
  status: string
  created_at: string
  updated_at: string
  pid?: number
  image: string
  cpus: number
  memory_mib: number
  labels: Record<string, string>
}

export class ListBoxesResponseDto {
  boxes: BoxResponseDto[]
  next_page_token?: string
}

export class ErrorResponseDto {
  error: {
    message: string
    type: string
    code: number
  }
}
