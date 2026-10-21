/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, Copy } from '@/components/ui/icon'
import type { AppDetail } from '@/lib/apps/types'
import { useState } from 'react'
import { toast } from 'sonner'
import { AgentLogos } from './AgentLogos'
import { copyText, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// What a new (not yet deployed) environment shows instead of the live overview:
// one section with the setup prompt for the agent, marked with the agents it
// works in. The header already names the app and its state. The prompt
// only connects the agent (install, sign in, link this directory, read the
// skill); what to build is said to the agent in its own chat, as with any
// other task. The page turns into the live overview after the first deploy.

const INSTALL = 'curl -fsSL https://sh.boxlite.ai | sh'

// Mock stand-in for the key the console mints on first copy (7 days, apps only).
const mintKey = () => `bxl_${Array.from({ length: 28 }, () => Math.random().toString(36)[2]).join('')}`

export function buildHandoffPrompt(app: AppDetail, key: string | null) {
  const env = app.environment === 'production' ? '' : ` --env ${app.environment}`
  return [
    `Set up BoxLite Cloud to host this project as the app "${app.name}".`,
    `1. Install the CLI: ${INSTALL}`,
    `2. Sign in: echo ${key ?? '<key, created when you copy>'} | boxlite auth login --api-key-stdin`,
    `3. Run boxlite app link ${app.name}${env} to link this directory to the app (it opens at https://${app.domains.defaultDomain}). This installs the BoxLite agent skill and writes an AGENTS.md.`,
    '4. Read AGENTS.md, then follow the boxlite skill to build and deploy. Keep the app private until I say it can be public.',
  ].join('\n')
}

export function HandoffToAgent({ app }: { app: AppDetail }) {
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const shown = buildHandoffPrompt(app, key ? `${key.slice(0, 4)}••••••••${key.slice(-4)}` : null)

  const copy = () => {
    const next = key ?? mintKey()
    setKey(next)
    copyText(buildHandoffPrompt(app, next))
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
    toast.success('Copied. Paste it into your coding agent, then tell it what to build.')
  }

  return (
    <div className="flex flex-col">
      <section className="flex flex-col">
        <SectionTitle
          title="Hand off to your agent"
          right={
            <>
              <AgentLogos className="mr-3" />
              <ToolButton primary onClick={copy}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy prompt'}
              </ToolButton>
            </>
          }
        />
        <pre className="whitespace-pre-wrap break-words border border-border bg-[hsl(var(--code-background))] px-[22px] py-[18px] font-mono text-meta leading-[1.75] text-foreground">
          {shown}
        </pre>
        <p className="mt-3 font-mono text-meta text-muted-foreground">
          Paste it into Claude Code, Codex, Cursor or any coding agent, then tell it what to build. The key lasts 7
          days, can only manage apps, and can be revoked in API Keys.
        </p>
      </section>
    </div>
  )
}
