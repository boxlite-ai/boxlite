/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { formatBytes } from '@/lib/apps/format'
import type { AppDetail, AppStorage } from '@/lib/apps/types'
import { useState } from 'react'
import { Disclosure, EmptyNote, PromptBlock, SpecRow } from '../spec'
import { Screen, ToolButton } from '../SubNav'
import { VolumeFilesSheet } from '../VolumeFiles'

// Volumes of this environment: a BoxLite managed volume per [[volume]], mounted into the
// environment's Box as a plain directory. Each panel leads with what it holds and where the
// app finds it; the BoxLite ids are behind "Details", the files in a side panel.

export function VolumesTab({ app }: { app: AppDetail }) {
  const [browsing, setBrowsing] = useState<AppStorage | null>(null)
  return (
    <Screen title={`Volumes in ${app.environment}`}>
      {app.storages.length === 0 ? (
        <EmptyNote
          title="No volume in this environment"
          action={
            <div className="w-full max-w-[640px] text-left">
              <PromptBlock
                text={`Give BoxLite app "${app.name}" a volume "uploads" mounted at /data/uploads, keep user uploads there, and deploy.`}
                compact
              />
            </div>
          }
        >
          A volume is a folder that survives deploys and restarts. Ask your agent to add one.
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-10">
          {app.storages.map((volume) => (
            // One bordered panel per volume, headed like the plan panel on Billing.
            <section key={volume.name} className="border border-border bg-card">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-[22px] py-4">
                <h3 className="font-mono text-em font-semibold text-foreground">{volume.name}</h3>
                <span className="font-mono text-meta text-muted-foreground">{summary(volume)}</span>
                <span className="ml-auto flex gap-[6px]">
                  <ToolButton
                    disabled={!app.activeRelease}
                    title={app.activeRelease ? undefined : 'The volume is created with the first deployment'}
                    onClick={() => setBrowsing(volume)}
                  >
                    Browse files
                  </ToolButton>
                </span>
              </div>

              <div className="grid gap-x-10 gap-y-5 px-[22px] pt-[18px] md:grid-cols-2">
                <Fact label="The app reads and writes it at">{volume.mountPath}</Fact>
                <Fact label="In BoxLite Volumes as">{volume.volumeName}</Fact>
              </div>

              <div className="px-[22px] pb-[18px] pt-5">
                <Disclosure>
                  <div className="max-w-[640px]">
                    <SpecRow label="Volume id">{volume.volumeId ?? 'Created with the first deployment'}</SpecRow>
                    <SpecRow label="State">{volume.state ?? '—'}</SpecRow>
                    <SpecRow label="Access">{volume.mode === 'rw' ? 'Read and write' : volume.mode}</SpecRow>
                  </div>
                </Disclosure>
              </div>
            </section>
          ))}
        </div>
      )}
      {browsing && <VolumeFilesSheet app={app} volume={browsing} onClose={() => setBrowsing(null)} />}
    </Screen>
  )
}

function summary(volume: AppStorage): string {
  return [
    volume.sizeBytes !== null ? formatBytes(volume.sizeBytes) : null,
    volume.mode === 'rw' ? 'read-write' : volume.mode,
    volume.state && volume.state !== 'ready' ? volume.state : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        <span className="text-brand">▸</span> {label}
      </span>
      <span className="font-mono text-body text-foreground">{children}</span>
    </div>
  )
}
