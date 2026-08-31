/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../../config/typed-config.service'

export interface AlertEvent {
  title: string
  status: 'firing' | 'resolved'
  /** Stable per-component key: incident.io updates the matching alert instead of opening a new one. */
  deduplicationKey: string
  description: string
  metadata: Record<string, string>
}

/**
 * Thin transport for incident.io's two ingest endpoints. Both methods throw on
 * any failure so the caller keeps its damping state and retries next tick —
 * classification, logging and retry policy all live with the caller.
 */
@Injectable()
export class IncidentIoClient {
  constructor(private readonly configService: TypedConfigService) {}

  /** POST /v2/alert_events/http/{sourceConfigId}; incident.io answers 202. */
  async sendAlertEvent(event: AlertEvent): Promise<void> {
    const apiUrl = this.configService.get('incidentIo.apiUrl')
    const sourceConfigId = this.configService.get('incidentIo.alertSourceConfigId')
    await axios.post(
      `${apiUrl}/v2/alert_events/http/${sourceConfigId}`,
      {
        title: event.title,
        status: event.status,
        deduplication_key: event.deduplicationKey,
        description: event.description,
        metadata: event.metadata,
      },
      this.requestConfig(),
    )
  }

  /** POST /v2/heartbeat/{heartbeatId}/ping — the dead man's switch. */
  async pingHeartbeat(): Promise<void> {
    const apiUrl = this.configService.get('incidentIo.apiUrl')
    const heartbeatId = this.configService.get('incidentIo.heartbeatId')
    await axios.post(`${apiUrl}/v2/heartbeat/${heartbeatId}/ping`, undefined, this.requestConfig())
  }

  private requestConfig() {
    return {
      timeout: this.configService.get('incidentIo.timeoutMs'),
      headers: {
        authorization: `Bearer ${this.configService.get('incidentIo.token')}`,
        'content-type': 'application/json',
      },
    }
  }
}
