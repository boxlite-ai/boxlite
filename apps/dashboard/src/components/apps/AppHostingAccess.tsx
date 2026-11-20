/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Button } from '@/components/ui/button'
import { AgentLogos } from './AgentLogos'
import { AppHostingIllustration } from './AppHostingIllustration'

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
        <div className="flex flex-col items-center gap-4">
          <p className="text-meta text-muted-foreground">App hosting is in early access.</p>
          {/* UI only: application submission is intentionally not connected. */}
          <Button type="button">Get early access</Button>
        </div>
      </section>
    </main>
  )
}
