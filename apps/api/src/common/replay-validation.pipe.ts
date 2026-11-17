/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import {
  ArgumentMetadata,
  Injectable,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  ValidationPipe,
} from '@nestjs/common'
import { noEffect } from './replay-no-effect'

@Injectable()
export class ReplayValidationPipe extends ValidationPipe {
  async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    try {
      return await super.transform(value, metadata)
    } catch (error) {
      throw error instanceof Error ? noEffect(error) : error
    }
  }
}

@Injectable()
export class ReplayParseBoolPipe extends ParseBoolPipe {
  async transform(value: string | boolean, metadata: ArgumentMetadata): Promise<boolean> {
    try {
      return await super.transform(value, metadata)
    } catch (error) {
      throw error instanceof Error ? noEffect(error) : error
    }
  }
}

@Injectable()
export class ReplayParseIntPipe extends ParseIntPipe {
  async transform(value: string, metadata: ArgumentMetadata): Promise<number> {
    try {
      return await super.transform(value, metadata)
    } catch (error) {
      throw error instanceof Error ? noEffect(error) : error
    }
  }
}

@Injectable()
export class ReplayParseUUIDPipe extends ParseUUIDPipe {
  async transform(value: string, metadata: ArgumentMetadata): Promise<string> {
    try {
      return await super.transform(value, metadata)
    } catch (error) {
      throw error instanceof Error ? noEffect(error) : error
    }
  }
}
