/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { TypedConfigService } from './typed-config.service'

@Injectable()
export class LegalVersionService {
  constructor(private readonly config: TypedConfigService) {}

  getCurrent() {
    return this.config.get('legal')
  }
}
