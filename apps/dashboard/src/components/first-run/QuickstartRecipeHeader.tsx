/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { QuickstartRecipe } from '@/lib/quickstart/recipes'
import { CODING_AGENT_MARKS } from '@/assets/AgentLogos'
import { UNDERLINE_LIST, UNDERLINE_TRIGGER } from '@/components/ui/tabs'
import { TabIcon } from '@/components/ui/TabIcon'

export interface QuickstartPreview {
  recipe: QuickstartRecipe
  onRecipeChange: (id: string) => void
  onConsole: () => void
  inline?: boolean
  creditCents: number
}

export function QuickstartRecipeHeader({
  preview,
  compact,
  statusOnly = false,
}: {
  preview: QuickstartPreview
  compact: boolean
  statusOnly?: boolean
}) {
  const { recipe } = preview
  const publishing = !recipe.command
  if (preview.inline)
    return publishing ? (
      <div className="mb-6 flex flex-wrap gap-x-5 gap-y-2 text-meta text-muted-foreground">
        {CODING_AGENT_MARKS.map(({ label, Mark }) => (
          <span key={label} className="inline-flex items-center gap-2">
            <Mark className="size-4" />
            {label}
          </span>
        ))}
      </div>
    ) : null
  return (
    <div className="shrink-0 px-6 pt-6 sm:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 pr-6 font-sans text-label text-muted-foreground">
        <span className="uppercase tracking-[1.5px]">Quickstart</span>
      </div>
      <div role="group" aria-label="Quickstart action" className={UNDERLINE_LIST}>
        {[
          { id: 'code-execution', label: 'Run code', selected: !publishing },
          { id: 'application-deployments', label: 'Build an app', selected: publishing },
        ].map(({ id, label, selected }) => (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) preview.onRecipeChange(id)
            }}
            data-state={selected ? 'active' : 'inactive'}
            className={UNDERLINE_TRIGGER}
          >
            <TabIcon name={id === 'code-execution' ? 'code' : 'browser'} />
            {label}
          </button>
        ))}
      </div>
      <DialogTitle
        className={compact ? 'sr-only' : 'mt-5 text-left font-display text-section font-semibold tracking-tight'}
      >
        {publishing ? recipe.title : 'Run your first command.'}
      </DialogTitle>
      <DialogDescription className={compact ? 'sr-only' : 'mt-2 text-left font-display text-body leading-relaxed'}>
        {publishing
          ? recipe.description
          : 'Create a Box, run a command, and read its output. Start with a simple Hello World.'}
      </DialogDescription>
      <p className="mt-4 border-l-2 border-brand/60 pl-3 font-display text-meta leading-relaxed text-muted-foreground">
        <span className="text-foreground">You’ll get: </span>
        {statusOnly
          ? 'Execution status and exit code. Choose an SDK or CLI to read this task’s output.'
          : recipe.result}
      </p>
      {publishing && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-label text-muted-foreground">
          {CODING_AGENT_MARKS.map(({ label, Mark }) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <Mark className="size-3.5" />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
