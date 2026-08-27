/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EmailVerificationRequiredError } from '@/api/errors'
import { Dialog, DialogHeader, DialogDescription, DialogTitle, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RoutePath } from '@/enums/RoutePath'
import { FallbackProps } from 'react-error-boundary'

/**
 * Signing out is the recovery: it ends the IdP session, so the sign-in that
 * follows is a fresh interactive login — the only flow that can render the
 * hosted email verification step. Reloading or retrying replays the same
 * unverified identity.
 *
 * /logout marks the session just-logged-out, which LandingPage honours by
 * showing a manual sign-in button instead of auto-redirecting (see
 * lib/auth-session.ts). That pause is wanted here: it keeps a still-unverified
 * account from being bounced straight back into the same 403.
 *
 * This boundary sits outside the router and the auth provider (see main.tsx), so
 * it navigates the whole page rather than reaching for useNavigate/useAuth.
 */
function EmailVerificationRequired() {
  return (
    <Dialog open>
      <DialogContent className="[&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Verify your email address</DialogTitle>
          <DialogDescription>
            You're signed in, but BoxLite needs a verified email address before it can load your account. Check your
            inbox for the verification link, then sign in again to finish.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button onClick={() => window.location.assign(RoutePath.LOGOUT)}>Sign out and verify</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ErrorBoundaryFallback({ error, resetErrorBoundary }: FallbackProps) {
  // An account-state rejection is not a crash: the stack trace and "try again"
  // are noise, and the only useful action is the one that can clear it.
  if (error instanceof EmailVerificationRequiredError) {
    return <EmailVerificationRequired />
  }

  const caughtError = error instanceof Error ? error : undefined
  const errorMessage = caughtError?.message || (typeof error === 'string' ? error : 'Unknown error')

  return (
    <Dialog open>
      <DialogContent className="[&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Something went wrong</DialogTitle>
          <DialogDescription>
            We're having trouble loading the dashboard. This could be due to a temporary service issue or network
            problem. Please try again or contact support if the issue persists.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <h4 className="font-semibold text-red-800 dark:text-red-200 mb-2">Error Details:</h4>
            <p className="text-red-700 dark:text-red-300 font-mono text-sm break-all">{errorMessage}</p>
          </div>

          {caughtError?.stack && (
            <details className="bg-gray-50 dark:bg-gray-900/20 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <summary className="cursor-pointer font-semibold text-gray-800 dark:text-gray-200">
                Stack Trace (click to expand)
              </summary>
              <pre className="text-xs text-gray-700 dark:text-gray-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap mt-2">
                {caughtError.stack}
              </pre>
            </details>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload Page
            </Button>
            <Button variant="outline" onClick={resetErrorBoundary}>
              Try Again
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
