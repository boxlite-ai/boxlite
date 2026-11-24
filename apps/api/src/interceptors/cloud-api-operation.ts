/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { Logger } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { AnalyticsService } from '../analytics/services/analytics.service'
import { isDelegatedMcpRequest } from '../auth/mcp-delegation'
import { CustomHeaders } from '../common/constants/header.constants'
import { AuthContextType, isOrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { SystemRole } from '../user/enums/system-role.enum'

// Keys are registered Express route templates. Never construct one from the URL.
const operations = new Map(
  Object.entries({
    'POST /api/v1/boxes': 'box.create',
    'DELETE /api/v1/boxes/:boxId': 'box.delete',
    'POST /api/v1/boxes/:boxId/start': 'box.start',
    'POST /api/v1/boxes/:boxId/stop': 'box.stop',
    'PUT /api/v1/boxes/:boxId/network/inbound': 'network.inbound.update',
    'PUT /api/v1/boxes/:boxId/network/outbound': 'network.outbound.update',
    'POST /api/v1/boxes/:boxId/exec': 'execution.start',
    'POST /api/v1/boxes/:boxId/executions/:execId/signal': 'execution.signal',
    'DELETE /api/v1/boxes/:boxId/executions/:execId': 'execution.kill',
    'PUT /api/v1/boxes/:boxId/files': 'file.upload',
    'GET /api/v1/boxes/:boxId/files': 'file.download',
    'POST /api/v1/boxes/:boxId/ssh': 'ssh.configure',
    'POST /api/v1/boxes/:boxId/ssh/enable': 'ssh.enable',
    'DELETE /api/v1/boxes/:boxId/ssh': 'ssh.disable',
    'POST /api/v1/boxes/:boxId/network/tunnel': 'tunnel.prepare',
    'DELETE /api/v1/boxes/:boxId/network/tunnel': 'tunnel.revoke',
    'POST /api/v1/checkpoints': 'checkpoint.create',
    'DELETE /api/v1/checkpoints/:key': 'checkpoint.delete',
    'POST /api/v1/images/:name/aliases': 'image.alias.create',
    'DELETE /api/v1/images/:name/aliases/:alias': 'image.alias.delete',
    'DELETE /api/v1/images/:name': 'image.delete',
    'POST /api/images/:idOrRef/aliases': 'image.alias.create',
    'DELETE /api/images/:idOrRef/aliases/:alias': 'image.alias.delete',
    'DELETE /api/images/:idOrRef': 'image.delete',
    'POST /api/v1/images/registries': 'registry.create',
    'DELETE /api/v1/images/registries/:id': 'registry.delete',
    'POST /api/images/registries': 'registry.create',
    'PUT /api/images/registries/:id': 'registry.update',
    'DELETE /api/images/registries/:id': 'registry.delete',
    'POST /api/v1/volumes': 'volume.create',
    'DELETE /api/v1/volumes/:volumeId': 'volume.delete',
    'POST /api/volumes': 'volume.create',
    'DELETE /api/volumes/:volumeId': 'volume.delete',
    'POST /api/v1/domains': 'domain.claim',
    'PUT /api/v1/domains/:domain/target': 'domain.bind',
    'DELETE /api/v1/domains/:domain/target': 'domain.unbind',
    'POST /api/organizations/:organizationId/custom-domains': 'custom_domain.create',
    'POST /api/organizations/:organizationId/custom-domains/:id/verify': 'custom_domain.verify',
    'POST /api/organizations/:organizationId/custom-domains/:id/prepare': 'custom_domain.prepare',
    'POST /api/organizations/:organizationId/custom-domains/:id/advance': 'custom_domain.advance',
    'DELETE /api/organizations/:organizationId/custom-domains/:id': 'custom_domain.delete',
    'POST /api/v1/ci/connect': 'ci.connect.start',
    'POST /api/v1/ci/connect/web': 'ci.connect.start',
    'POST /api/v1/ci/connect/:id/complete': 'ci.connect.complete',
    'POST /api/v1/ci/connect/:id/select': 'ci.connect.select',
    'POST /api/v1/ci/connect/:id/installation': 'ci.connect.installation',
    'DELETE /api/v1/ci/connect/:id': 'ci.connect.cancel',
    'PATCH /api/v1/ci/connections/:id': 'ci.connection.update',
    'DELETE /api/v1/ci/connections/:id': 'ci.connection.delete',
    'PATCH /api/v1/ci/settings': 'ci.settings.update',
    'POST /api/regions': 'region.create',
    'PATCH /api/regions/:id': 'region.update',
    'DELETE /api/regions/:id': 'region.delete',
    'POST /api/regions/:id/regenerate-proxy-api-key': 'region.key.rotate',
    'POST /api/box/:boxIdOrName/recover': 'box.recover',
    'POST /api/box/:boxIdOrName/attach-tickets': 'box.attach_ticket.create',
    'POST /api/api-keys': 'api_key.create',
    'DELETE /api/api-keys/:name': 'api_key.delete',
    'PATCH /api/organizations/:organizationId/name': 'org.rename',
    'PUT /api/organizations/:organizationId/onboarding': 'onboarding.save',
    'POST /api/organizations/:organizationId/quickstart/handoffs': 'quickstart.handoff.create',
    'PATCH /api/organizations/:organizationId/quickstart/handoffs/:requestId/copied': 'quickstart.handoff.copy',
    'POST /api/organizations/:organizationId/coupon-claims': 'coupon.claim.submit',
    'PUT /api/organizations/:organizationId/cancellation-feedback': 'billing.feedback.submit',
    'POST /api/webhooks/organizations/:organizationId/app-portal-access': 'webhook.portal.open',
  }),
)
const logger = new Logger('CloudApiOperation')

export function observeCloudApiOperation(
  request: Request & { user?: AuthContextType },
  response: Response,
  analytics: AnalyticsService,
  startedAt: number,
): void {
  const path = request.route?.path
  if (typeof path !== 'string') return
  let operation = operations.get(request.method + ' ' + path.replace('/api/v1/:prefix/', '/api/v1/'))
  if (!operation) return
  const user = request.user
  if (!user || user.role !== SystemRole.USER || !isOrganizationAuthContext(user)) return
  const { userId, organizationId, organizationUser } = user
  if (
    !userId ||
    !organizationId ||
    organizationUser?.userId !== userId ||
    organizationUser.organizationId !== organizationId
  )
    return

  if (operation === 'box.create' && request.body?.checkpoint_id !== undefined) operation = 'checkpoint.restore'
  const label = request.get(CustomHeaders.SOURCE.name)
  const source = isDelegatedMcpRequest(request)
    ? 'mcp'
    : label === 'sdk' || label === 'dashboard'
      ? label
      : 'unattributed'
  // Proxied handlers can return before the runner has supplied the HTTP result.
  const finish = () => {
    response.off('close', close)
    const status = response.statusCode
    if (status < 200 || (status >= 300 && status < 400) || status >= 600) return
    try {
      analytics.capture(
        {
          event: 'cloud.api.operation',
          distinctId: userId,
          groups: { organization: organizationId },
          timestamp: new Date(startedAt),
          properties: {
            'api.operation': operation,
            'http.status_class': Math.floor(status / 100) + 'xx',
            'client.source': source,
          },
        },
        { users: [userId], organizations: [organizationId] },
      )
    } catch {
      logger.warn('Cloud API operation capture failed')
    }
  }
  const close = () => response.off('finish', finish)
  response.once('finish', finish)
  response.once('close', close)
}
