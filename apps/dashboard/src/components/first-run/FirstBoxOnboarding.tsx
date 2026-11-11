/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { ConsoleTemplatePicker } from './ConsoleTemplatePicker'
import { Code2, Container, Terminal } from '@/components/ui/icon'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import { quickstartRecipeFor } from '@/lib/quickstart/recipes'

export function FirstBoxQuickstart() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [method, setMethod] = useState<'sdk' | 'console' | 'prompt'>(
    params.get('method') === 'console' ? 'console' : 'sdk',
  )
  const methods = [
    {
      id: 'sdk' as const,
      title: 'Deploy from SDK / CLI',
      description: 'Use your code or terminal.',
      Icon: Code2,
    },
    {
      id: 'console' as const,
      title: 'Deploy from console',
      description: 'Choose an image. Create a Box.',
      Icon: Container,
    },
    {
      id: 'prompt' as const,
      title: 'Deploy from prompt',
      description: 'Build with your local coding agent.',
      Icon: Terminal,
    },
  ]
  return (
    <main className="page-container py-7">
      <div className="mb-7 flex items-center justify-between gap-4">
        <h1 className="font-display text-page font-semibold tracking-tight">Create your first Box</h1>
      </div>
      <div className="grid w-full gap-3 md:grid-cols-3" role="group" aria-label="Deployment method">
        {methods.map(({ id, title, description, Icon }) => (
          <button
            key={id}
            type="button"
            aria-label={title}
            aria-pressed={method === id}
            onClick={() => setMethod(id)}
            className={`group flex items-center gap-3 rounded-none px-4 py-3.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${method === id ? 'bg-accent' : 'bg-card hover:bg-accent'}`}
          >
            <Icon aria-hidden className="size-5 shrink-0 text-foreground/75" />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-body font-semibold">{title}</span>
              <span className="mt-1 block font-display text-label leading-relaxed text-muted-foreground">
                {description}
              </span>
            </span>
            <span aria-hidden className="w-3 shrink-0 text-meta text-brand">
              {method === id ? '✓' : ''}
            </span>
          </button>
        ))}
      </div>
      <div hidden={method !== 'console'} className="mt-8">
        <ConsoleTemplatePicker />
      </div>
      <div hidden={method !== 'sdk' && method !== 'prompt'} className="mt-8">
        <OnboardingGuideDialog
          inline
          open
          onOpenChange={(next) => {
            if (!next) navigate(RoutePath.BOXES)
          }}
          progress={{ boxCreated: false, sdkConnected: false }}
          onProgressChange={() => {}}
          preview={{
            recipe: quickstartRecipeFor(method === 'prompt' ? 'application-deployments' : 'code-execution'),
            onRecipeChange: () => {},
            onConsole: () => setMethod('console'),
            inline: true,
            creditCents: 0,
          }}
        />
      </div>
    </main>
  )
}
