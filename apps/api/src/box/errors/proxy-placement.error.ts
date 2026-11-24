/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ServiceUnavailableException } from '@nestjs/common'

export type ProxyPlacementDiagnostic = 'runner_proxy_tls_unsupported' | 'runner_proxy_unsupported'

export class ProxyPlacementError extends ServiceUnavailableException {
  constructor(
    readonly diagnostic: ProxyPlacementDiagnostic,
    operation: 'create' | 'start',
  ) {
    super({
      message:
        diagnostic === 'runner_proxy_tls_unsupported'
          ? 'Managed outbound proxy requires an enrolled HTTPS Runner'
          : 'Runner does not support managed outbound proxy',
      ...(operation === 'create' ? { code: 'outbound_create_rejected' } : {}),
    })
  }
}
