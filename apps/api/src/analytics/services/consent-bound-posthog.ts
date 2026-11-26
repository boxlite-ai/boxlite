/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { PostHog } from 'posthog-node'

export class ConsentBoundPostHog extends PostHog {
  // The public captureImmediate in posthog-node 4.18 resolves before its HTTP request.
  // Track the HTTP attempt through shutdown and report transport failures.
  deliver({
    distinctId,
    event,
    properties,
    groups,
    timestamp,
    uuid,
  }: Parameters<PostHog['capture']>[0]): Promise<void> {
    return this.captureStatelessImmediate(distinctId, event, { ...properties, $groups: groups }, { timestamp, uuid })
  }
}
