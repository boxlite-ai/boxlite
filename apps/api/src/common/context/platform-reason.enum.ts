/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** Why the platform, rather than a user or an admin, started an operation. */
export enum PlatformReason {
  AUTO_STOP = 'auto_stop',
  AUTO_DELETE = 'auto_delete',
  ORG_SUSPENSION = 'org_suspension',
  WARM_POOL = 'warm_pool',
  BOOTSTRAP = 'bootstrap',
}
