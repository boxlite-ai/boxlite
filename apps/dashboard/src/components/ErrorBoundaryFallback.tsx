/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegistrationEmailError } from '@/api/errors'
import { Dialog, DialogHeader, DialogDescription, DialogTitle, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RoutePath } from '@/enums/RoutePath'
import { FallbackProps } from 'react-error-boundary'

/**
 * Signing out is the recovery: it ends the IdP session, so the next sign-in can
 * pick another account. This boundary sits outside the router and the auth
 * provider (see main.tsx), so it navigates the whole page rather than reaching
 * for useNavigate/useAuth.
 */
function RegistrationEmailRejected({ error }: { error: RegistrationEmailError }) {
  const messages = {
    disposable_email:
      "BoxLite doesn't support temporary email addresses for new accounts. Sign out and use a regular email address to continue.",
    email_required:
      "Your sign-in provider didn't share an email address. Sign out and choose an account that provides an email address.",
    invalid_email:
      'Your sign-in provider returned an invalid email address. Sign out and choose an account with a valid email address.',
  }

  return (
    <Dialog open>
      <DialogContent className="[&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Use a different email address</DialogTitle>
          <DialogDescription>{messages[error.code]}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button onClick={() => window.location.assign(RoutePath.LOGOUT)}>Sign out and use another email</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ErrorBoundaryFallback({ error, resetErrorBoundary }: FallbackProps) {
  // An account-state rejection is not a crash: the stack trace and "try again"
  // are noise, and the only useful action is the one that can clear it.
  if (error instanceof RegistrationEmailError) {
    return <RegistrationEmailRejected error={error} />
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
            <p className="text-red-700 dark:text-red-300 font-sans text-body break-all">{errorMessage}</p>
          </div>

          {caughtError?.stack && (
            <details className="bg-gray-50 dark:bg-gray-900/20 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <summary className="cursor-pointer font-semibold text-gray-800 dark:text-gray-200">
                Stack Trace (click to expand)
              </summary>
              <pre className="text-meta text-gray-700 dark:text-gray-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap mt-2">
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
