import { useEffect, useRef, useState } from 'react'
import { Panel, SectionTitle } from '@/components/ascii'
import { Button } from '@/components/ui/button'
import { CopyIcon, Link2 } from '@/components/ui/icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { registrationLink } from '@/lib/referral-link'

export function ReferralCodeSection() {
  const { selectedOrganization } = useSelectedOrganization()
  const { organizationsApi } = useApi()
  // A new keyed component drops copied text synchronously when the organization changes.
  return selectedOrganization ? (
    <OrganizationReferral
      key={selectedOrganization.id}
      organizationId={selectedOrganization.id}
      name={selectedOrganization.name}
      api={organizationsApi}
    />
  ) : null
}

function OrganizationReferral({
  organizationId,
  name,
  api,
}: {
  organizationId: string
  name: string
  api: ReturnType<typeof useApi>['organizationsApi']
}) {
  const [code, setCode] = useState<string>()
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [copyText, setCopyText] = useState<string>()
  const [message, setMessage] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    setError(false)
    void api
      .getOrganizationReferralCode(organizationId, { signal: controller.signal })
      .then(({ data }) => {
        if (!controller.signal.aborted && data.organizationId === organizationId) setCode(data.referralCode)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      alive.current = false
      controller.abort()
    }
  }, [api, organizationId, retry])

  const copy = async (text: string) => {
    setMessage('')
    setCopyText(undefined)
    try {
      await navigator.clipboard.writeText(text)
      if (alive.current) setMessage('Copied')
    } catch {
      if (alive.current) {
        setCopyText(text)
        setMessage('Copy failed. Select and copy the text below.')
      }
    }
  }

  return (
    <section aria-label="Invite friends" className="mt-8">
      <SectionTitle title="Invite friends" />
      <Panel className="space-y-4 px-[22px] py-5">
        <p className="text-sm">
          Share an invitation for <strong>{name}</strong>. Eligible rewards belong to this organization.
        </p>
        {error ? (
          <div role="alert">
            Could not load the invitation code.{' '}
            <Button variant="outline" onClick={() => setRetry(retry + 1)}>
              Retry
            </Button>
          </div>
        ) : !code ? (
          <p role="status">Loading invitation code…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <code className="select-all break-all font-mono">{code}</code>
            {[
              { label: 'Copy code', icon: CopyIcon, value: code },
              { label: 'Copy invitation link', icon: Link2, value: registrationLink(window.location.origin, code) },
            ].map(({ label, icon: Icon, value }) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <Button variant="outline" aria-label={label} onClick={() => void copy(value)}>
                    <Icon aria-hidden="true" className="mr-2 size-4" />
                    {label}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
        {copyText && (
          <textarea
            aria-label="Invitation text to copy"
            readOnly
            value={copyText}
            onFocus={(event) => event.target.select()}
            className="w-full resize-none border border-border bg-card p-2 font-mono text-sm"
          />
        )}
      </Panel>
    </section>
  )
}
