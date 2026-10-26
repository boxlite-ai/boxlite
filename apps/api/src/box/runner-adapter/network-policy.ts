import { HttpException, ServiceUnavailableException } from '@nestjs/common'
import { Runner } from '../entities/runner.entity'

export type OutboundPolicy = { mode: 'enabled' | 'disabled'; allow_net: string[] }

// Runtime control needs an acknowledgement; lifecycle jobs cannot provide one.
export async function setRunnerOutbound(runner: Runner, boxId: string, policy: OutboundPolicy): Promise<void> {
  const endpoint = runner.apiUrl || runner.proxyUrl
  if (!endpoint) throw new ServiceUnavailableException('Runner has no control endpoint')
  let response: Response
  try {
    response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/boxes/${encodeURIComponent(boxId)}/network/outbound`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${runner.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new ServiceUnavailableException('Outbound update was not acknowledged; retry the complete policy')
  }
  if (response.ok) return
  const body = await response.json().catch(() => null)
  if ([404, 405, 501].includes(response.status) && !body?.error?.code) {
    throw new HttpException({ message: 'Runner does not support outbound policy updates', code: 'unsupported' }, 400)
  }
  throw new HttpException(
    {
      message: body?.error?.message || 'Runner rejected outbound policy',
      code: body?.error?.code || 'upstream_unavailable',
    },
    response.status,
  )
}
