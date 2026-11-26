/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Button } from '@/components/ui/button'
import { useApi } from '@/hooks/useApi'
import { httpStatusOf } from '@/lib/apps/client'
import { useMutation } from '@tanstack/react-query'
import { AgentLogos } from './AgentLogos'
import { AppHostingIllustration } from './AppHostingIllustration'

export function AppHostingAccess({ organizationId }: { organizationId: string }) {
  const api = useApi()
  const request = useMutation({
    mutationFn: () => api.requestExperimentalFeature(organizationId, 'App Hosting'),
    retry: false,
  })

  return (
    <main className="resource-page flex-1">
      <header className="space-y-2">
        <h1 className="resource-title">App hosting</h1>
        <p className="text-body text-muted-foreground">Turn your ideas into live apps.</p>
      </header>
      <section className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
        <AppHostingIllustration className="max-h-64 max-w-xl" />
        <div className="max-w-lg space-y-3">
          <h2 className="font-display text-section font-semibold">From insight to a cloud app.</h2>
          <p className="text-body leading-relaxed text-muted-foreground">
            Bring an idea to your coding agent. Build it, deploy it, and let BoxLite keep it running.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 py-2">
          <p className="text-meta text-muted-foreground">Works with your coding agent</p>
          <AgentLogos className="gap-5 [&>svg]:size-5" />
        </div>
        <div className="flex max-w-lg flex-col items-center gap-4">
          {request.isSuccess ? (
            <p role="status">Request sent. The BoxLite team will contact you by email.</p>
          ) : (
            <>
              <p className="text-body text-muted-foreground">
                App hosting is an experimental feature. Request access for your organization and the BoxLite team will
                contact you by email.
              </p>
              <Button type="button" disabled={request.isPending} onClick={() => request.mutate()}>
                {request.isPending ? 'Sending request…' : 'Get early access'}
              </Button>
              {request.isError && (
                <p role="alert">
                  {httpStatusOf(request.error) === 422
                    ? 'Your account needs a contact email before you can request access.'
                    : 'We couldn’t confirm your request. Please try again.'}
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  )
}
