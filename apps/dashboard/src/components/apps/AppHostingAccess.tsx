/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { ResourceEmptyState } from '@/components/ResourceLayout'
import { Button } from '@/components/ui/button'
import { AgentApp } from '@/components/ui/icon'

/** Presentation fixture only. Server-side eligibility is a separate API contract. */
export function hasMockAppHostingAccess(): boolean {
  if (import.meta.env.VITE_ENABLE_MOCKING !== 'true') return false
  try {
    return sessionStorage.getItem('mock-app-hosting-access') === 'enabled'
  } catch {
    return false
  }
}

export function AppHostingAccess() {
  return (
    <main className="resource-page flex-1">
      <header className="space-y-2">
        <h1 className="resource-title">App hosting</h1>
        <p className="text-body text-muted-foreground">Turn your ideas into live apps.</p>
      </header>
      <ResourceEmptyState
        icon={<AgentApp />}
        title="From your agent to a live app."
        description="Your coding agent builds and ships. BoxLite keeps your apps running."
      >
        <div className="flex max-w-md flex-col items-center gap-5">
          <p className="text-body text-muted-foreground">
            App hosting is in early access. Get access before creating your first app.
          </p>
          {/* UI only: application submission is intentionally not connected. */}
          <Button type="button">Get early access</Button>
        </div>
      </ResourceEmptyState>
    </main>
  )
}
