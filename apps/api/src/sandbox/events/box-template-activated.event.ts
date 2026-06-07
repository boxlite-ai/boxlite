/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplate } from '../entities/box-template.entity'

export class BoxTemplateActivatedEvent {
  constructor(public readonly template: BoxTemplate) {}
}
