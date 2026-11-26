/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Button } from '@/components/ui/button'
import { useApi } from '@/hooks/useApi'
import { httpStatusOf } from '@/lib/apps/client'
import { useMutation } from '@tanstack/react-query'
import { AppHostingIllustration } from './AppHostingIllustration'

export function AppHostingRequest({ organizationId }: { organizationId: string }) {
  const api = useApi()
  const request = useMutation({
    mutationFn: () => api.requestExperimentalFeature(organizationId, 'App Hosting'),
    retry: false,
  })

  return (
    <main className="resource-page flex-1">
      <h1 className="resource-title">App hosting</h1>
      <section className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
        <AppHostingIllustration className="max-h-64 max-w-xl" />
        {request.isSuccess ? (
          <p role="status">Request sent. The BoxLite team will contact you by email.</p>
        ) : (
          <>
            <h2 className="font-display text-section font-semibold">Request early access</h2>
            <p className="max-w-lg text-body leading-relaxed text-muted-foreground">
              App hosting is an experimental feature. Request access for your organization and the BoxLite team will
              contact you by email.
            </p>
            <Button type="button" onClick={() => request.mutate()} disabled={request.isPending}>
              {request.isPending ? 'Sending request…' : 'Request access'}
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
      </section>
    </main>
  )
}
