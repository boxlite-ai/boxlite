/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/apiClient'
import type { BoxOutboundPolicyStatus } from '@/api/outbound-policy'

type Props = {
  api: ApiClient
  organizationId: string
  boxId: string
  accessToken: string
}

export function BoxOutboundPolicy({ api, organizationId, boxId, accessToken }: Props) {
  const [read, setRead] = useState<{ api: ApiClient; accessToken: string; status: BoxOutboundPolicyStatus | null }>()
  useEffect(() => {
    const controller = new AbortController()
    const settle = (status: BoxOutboundPolicyStatus | null) => {
      if (!controller.signal.aborted) setRead({ api, accessToken, status })
    }
    void api
      .getBoxOutboundPolicyStatus(organizationId, boxId, accessToken, controller.signal)
      .then(settle, () => settle(null))
    return () => controller.abort()
  }, [api, organizationId, boxId, accessToken])

  if (read?.api !== api || read.accessToken !== accessToken) return <span role="status">Reading policy</span>
  const status = read.status
  if (!status) return <span>Policy unavailable</span>
  const policy = status.persisted?.policy
  const application = { confirmed: 'Applied', pending: 'Pending', uncertain: 'Application uncertain' }[
    status.application_state
  ]
  if (!policy) return <span>{application} · No committed policy</span>

  return (
    <details className="min-w-0">
      <summary className="cursor-pointer">
        {application} · {policy.mode} · {policy.allow_net.length} allow, {policy.deny_net.length} deny
      </summary>
      <PolicyRules title="Allowed destinations" rules={policy.allow_net} />
      <PolicyRules title="Denied destinations" rules={policy.deny_net} />
    </details>
  )
}

function PolicyRules({ title, rules }: { title: string; rules: string[] }) {
  if (rules.length === 0) return null
  return (
    <ul aria-label={title} className="mt-2 space-y-1 border-l pl-3 font-mono text-meta [overflow-wrap:anywhere]">
      {rules.map((rule, index) => (
        <li key={`${index}:${rule}`}>{rule}</li>
      ))}
    </ul>
  )
}
