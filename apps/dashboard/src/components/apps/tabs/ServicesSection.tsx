/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AppDetail } from '@/lib/apps/types'
import { SchedulesTable } from '../SchedulesTable'
import { ServicesTable } from '../ServicesTable'
import { SectionTitle } from '../spec'
import { Screen, ToolButton } from '../SubNav'

// What runs the app: its processes (state, health, restart) and its scheduled jobs. This is the
// machinery behind a deployment, so it lives under Deployments; the Overview only says whether
// it is all running.

export function ServicesSection({
  app,
  restarting,
  onRestartService,
}: {
  app: AppDetail
  /** The service being restarted right now, if any. */
  restarting: string | null
  onRestartService: (service: string) => void
}) {
  return (
    <div className="flex flex-col gap-10">
      <Screen
        title="Services"
        actions={
          app.services.length > 1 && (
            <ToolButton onClick={() => app.services.forEach((s) => onRestartService(s.name))}>Restart all</ToolButton>
          )
        }
      >
        {app.services.length === 0 ? (
          <p className="font-mono text-[13px] text-muted-foreground">
            No services yet; they start with the first deployment.
          </p>
        ) : (
          <ServicesTable
            services={app.services}
            started={!!app.activeRelease}
            restarting={restarting}
            onRestart={onRestartService}
          />
        )}
      </Screen>
      {app.schedules.length > 0 && (
        <section>
          <SectionTitle title="Schedules" />
          <SchedulesTable app={app} />
        </section>
      )}
    </div>
  )
}
