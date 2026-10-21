/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { formatBytes } from '@/lib/apps/format'
import type { AppDetail } from '@/lib/apps/types'
import { EmptyNote, PromptBlock, SpecRow } from '../spec'
import { Screen } from '../SubNav'

// Volumes of this environment, as boxlite.toml declares them: a BoxLite managed
// volume per [[volume]], mounted into the environment's Box as a plain
// directory. Size and state are shown when BoxLite reports them. Browsing files
// needs a file listing from the supervisor, which it does not offer yet, so
// there is no file browser here.

export function VolumesTab({ app }: { app: AppDetail }) {
  return (
    <Screen title={`Volumes in ${app.environment}`}>
      {app.storages.length === 0 ? (
        <EmptyNote
          title="No volume in this environment"
          action={
            <div className="w-full max-w-[640px] text-left">
              <PromptBlock
                text={`Give the BoxLite app "${app.name}" persistent file storage: add a [[volume]] with name = "uploads" and mount = "/data/uploads" to boxlite.toml, keep uploaded files under that path, then deploy.`}
                compact
              />
            </div>
          }
        >
          A volume is a directory that survives deploys and restarts. Your agent declares it in boxlite.toml.
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-10">
          {app.storages.map((volume) => (
            // One bordered panel per volume, headed like the plan panel on Billing.
            <section key={volume.name} className="border border-border bg-card">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-[22px] py-4">
                <h3 className="font-mono text-em font-semibold text-foreground">{volume.name}</h3>
                <span className="font-mono text-meta text-muted-foreground">
                  {[
                    volume.sizeBytes !== null ? formatBytes(volume.sizeBytes) : null,
                    volume.mode === 'rw' ? 'read-write' : volume.mode,
                    volume.state,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>

              <div className="grid gap-x-10 gap-y-5 px-[22px] pt-[18px] md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                    <span className="text-brand">▸</span> The app reads and writes it at
                  </span>
                  <span className="font-mono text-body text-foreground">{volume.mountPath}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                    <span className="text-brand">▸</span> BoxLite volume
                  </span>
                  <span className="font-mono text-body text-foreground">{volume.volumeName}</span>
                </div>
              </div>

              <div className="max-w-[640px] px-[22px] pb-[18px] pt-5">
                <SpecRow label="Volume id">
                  {volume.volumeId ?? 'created with the first deployment that mounts it'}
                </SpecRow>
                <SpecRow label="Files">not browsable here yet</SpecRow>
              </div>
            </section>
          ))}
        </div>
      )}
    </Screen>
  )
}
