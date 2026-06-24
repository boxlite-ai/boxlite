/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import goIcon from '@/assets/go.svg'
import pythonIcon from '@/assets/python.svg'
import rustIcon from '@/assets/rust.svg'
import typescriptIcon from '@/assets/typescript.svg'
import CodeBlock from '@/components/CodeBlock'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { getRestApiUrl } from '@/lib/environment'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { getOnboardingCodeExamples, type OnboardingLanguage } from '@/lib/onboarding-code-examples'
import { setLocalStorageItem } from '@/lib/local-storage'
import { cn } from '@/lib/utils'
import type { OnboardingProgress } from '@/lib/onboarding-progress'
import {
  CreateApiKeyPermissionsEnum,
  OrganizationRolePermissionsEnum,
  type ApiKeyResponse,
} from '@boxlite-ai/api-client'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

interface OnboardingGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onProgressChange: (progress: OnboardingProgress) => void
  progress: OnboardingProgress
}

const STAGES = [
  { tag: 'STEP 01', label: 'Create a key' },
  { tag: 'STEP 02', label: 'Install the SDK' },
  { tag: 'STEP 03', label: 'Execute code in box' },
] as const

// Quickstart scenarios. Today there is one; future scenarios slot in here and route to
// their own guided flow. (For now every scenario uses the SDK 3-step flow below.)
const SCENARIOS = [
  {
    id: 'untrusted-code',
    tag: 'Box',
    title: 'Box as your untrusted code container',
    description:
      'Run AI-generated or untrusted code in an isolated, disposable Box. Create a key, install the SDK, then execute code safely inside a box.',
  },
] as const

type ScenarioId = (typeof SCENARIOS)[number]['id']

const LANGS: { value: OnboardingLanguage; label: string; iconSrc: string }[] = [
  { value: 'python', label: 'Python', iconSrc: pythonIcon },
  { value: 'typescript', label: 'Node', iconSrc: typescriptIcon },
  { value: 'go', label: 'Go', iconSrc: goIcon },
  { value: 'rust', label: 'Rust', iconSrc: rustIcon },
]

function PrimaryBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 bg-primary px-4 py-[9px] text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
    >
      {children}
    </button>
  )
}

export function OnboardingGuideDialog({ open, onOpenChange, onProgressChange, progress }: OnboardingGuideDialogProps) {
  const { apiKeyApi } = useApi()
  const { apiUrl } = useConfig()
  const restApiUrl = getRestApiUrl(apiUrl)
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const canCreateApiKey = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)

  const [scenario, setScenario] = useState<ScenarioId | null>(null)
  const [step, setStep] = useState(0)
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [language, setLanguage] = useState<OnboardingLanguage>('python')
  const [createdKey, setCreatedKey] = useState<ApiKeyResponse | null>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)

  const codeExamples = getOnboardingCodeExamples()
  const activeExample = codeExamples[language]
  const renderedExample = useMemo(
    () => activeExample.example.replaceAll('your-api-url', restApiUrl),
    [activeExample.example, restApiUrl],
  )

  const apiKeyPermissions = useMemo(() => {
    if (!canCreateApiKey) return []
    const permissions: CreateApiKeyPermissionsEnum[] = [CreateApiKeyPermissionsEnum.WRITE_BOXES]
    if (authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)) {
      permissions.push(CreateApiKeyPermissionsEnum.DELETE_BOXES)
    }
    return permissions
  }, [authenticatedUserHasPermission, canCreateApiKey])

  useEffect(() => {
    if (open) {
      setScenario(null)
      setStep(0)
      setDone([false, false, false])
      setCreatedKey(null)
      setCopied(false)
    }
  }, [open])

  const activeScenario = SCENARIOS.find((s) => s.id === scenario)
  const enterScenario = (id: ScenarioId) => {
    setScenario(id)
    setStep(0)
    setDone([false, false, false])
    setCreatedKey(null)
    setCopied(false)
  }
  const backToScenarios = () => {
    setScenario(null)
    setStep(0)
    setDone([false, false, false])
    setCreatedKey(null)
  }

  const finished = done.every(Boolean)

  const complete = (i: number) => {
    setDone((prev) => {
      const next = [...prev] as [boolean, boolean, boolean]
      next[i] = true
      if (next.every(Boolean)) {
        setLocalStorageItem('boxlite-quickstart-done', '1')
        onProgressChange({ boxCreated: true, sdkConnected: true })
      }
      return next
    })
    setStep(Math.min(2, i + 1))
  }

  const handleCreateKey = async () => {
    if (!selectedOrganization || !canCreateApiKey || apiKeyPermissions.length === 0) {
      toast.error('API key creation is not available for this user.')
      return
    }
    setCreating(true)
    try {
      const key = (
        await apiKeyApi.createApiKey(
          { name: 'sdk-quickstart', permissions: apiKeyPermissions },
          selectedOrganization.id,
        )
      ).data
      setCreatedKey(key)
      toast.success('API key created successfully')
    } catch (error) {
      handleApiError(error, 'Failed to create API key')
    } finally {
      setCreating(false)
    }
  }

  const copyKey = (value: string) => {
    try {
      navigator.clipboard?.writeText(value)
    } catch {
      /* clipboard may be unavailable */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 font-mono sm:max-w-[620px]">
        {scenario === null ? (
          <>
            <DialogHeader className="shrink-0 px-5 pb-2 pt-[18px]">
              <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">Quickstart</DialogTitle>
              <DialogDescription className="font-mono text-[11px] uppercase tracking-[1.5px] text-muted-foreground">
                {SCENARIOS.length} scenario{SCENARIOS.length === 1 ? '' : 's'} available
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-5 pb-3 pt-[24px] scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
              <div className="grid grid-cols-2 gap-[20px]">
                {SCENARIOS.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    onClick={() => enterScenario(sc.id)}
                    className="group relative flex min-h-[168px] flex-col border border-dashed border-border bg-[hsl(var(--code-background))] p-[16px] text-left transition-colors hover:border-brand"
                  >
                    <div className="text-[13px] font-semibold leading-snug">{sc.title}</div>
                    <div className="mt-[6px] font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
                      3 steps · sdk
                    </div>
                    <div className="mt-auto flex items-center gap-[7px] pt-4 font-mono text-[11px] uppercase tracking-[1.5px]">
                      Start
                      <span className="transition-transform group-hover:translate-x-1">▸</span>
                      <span
                        className="inline-block h-[12px] w-[7px] bg-brand opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ animation: 'blink 1s steps(1) infinite' }}
                      />
                    </div>
                  </button>
                ))}

                {/* coming-soon tile — keeps the grid alive + hints extensibility (ASCII shimmer) */}
                <div className="relative flex min-h-[168px] flex-col border border-dashed border-border/60 p-[16px] opacity-70">
                  <div className="text-[13px] font-semibold leading-snug text-muted-foreground">
                    Box as your agent security runtime
                  </div>
                  <div className="mt-[6px] font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground/70">
                    coming soon
                  </div>
                  <div className="halftone-brand mt-auto h-[34px] w-full opacity-60" />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-[14px]">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                Maybe later
              </button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="shrink-0 px-5 pb-4 pt-[18px]">
              <button
                type="button"
                onClick={backToScenarios}
                className="mb-[6px] flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                ‹ Quickstart
              </button>
              <DialogTitle className="text-[15px] font-bold leading-snug tracking-[-0.3px]">
                {activeScenario?.title}
              </DialogTitle>
              <DialogDescription className="text-[11.5px] text-muted-foreground">
                Three steps, straight from code.
              </DialogDescription>
            </DialogHeader>

            {/* stage rail */}
            <div className="flex shrink-0 items-center px-5 pb-4">
              {STAGES.map((s, i) => {
                const isDone = done[i]
                const active = step === i
                return (
                  <div key={s.tag} className="flex flex-1 items-center last:flex-none">
                    <button type="button" onClick={() => setStep(i)} className="flex flex-none items-center gap-[9px]">
                      <span
                        className={cn(
                          'flex size-6 flex-none items-center justify-center rounded-full border-[1.5px] text-[11px] font-bold transition-colors',
                          isDone
                            ? 'border-brand bg-brand text-white'
                            : active
                              ? 'border-brand text-brand'
                              : 'border-border text-muted-foreground',
                        )}
                        style={active && !isDone ? { animation: 'qs-pulse 2s infinite' } : undefined}
                      >
                        {isDone ? '✓' : i + 1}
                      </span>
                      <span
                        className={cn(
                          'whitespace-nowrap text-[12px]',
                          active
                            ? 'font-semibold text-foreground'
                            : isDone
                              ? 'text-foreground'
                              : 'text-muted-foreground',
                        )}
                      >
                        {s.label}
                      </span>
                    </button>
                    {i < STAGES.length - 1 && (
                      <span
                        className="mx-[10px] h-[1.5px] min-w-[12px] flex-1 transition-colors"
                        style={{ background: done[i] ? 'hsl(var(--brand))' : 'hsl(var(--border))' }}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* body */}
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
              {step === 0 && (
                <div className="px-5 py-[18px]" style={{ animation: 'stat-in .25s ease' }}>
                  <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">
                    {createdKey ? 'Your API key  ·  shown once' : 'Create a key to authenticate'}
                  </div>
                  <div className="flex items-center gap-[10px] border border-border bg-[hsl(var(--code-background))] px-[14px] py-3">
                    <span
                      className={cn(
                        'flex-1 break-all text-[13px] tracking-[0.5px]',
                        createdKey ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {createdKey ? createdKey.value : 'Click “Create key” to generate a secret'}
                    </span>
                    {createdKey && (
                      <button
                        type="button"
                        onClick={() => copyKey(createdKey.value)}
                        className={cn(
                          'flex-none border px-[11px] py-[6px] text-[10px] uppercase tracking-[1px] transition-colors',
                          copied
                            ? 'border-success text-success'
                            : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {copied ? '✓ Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                  {createdKey && (
                    <div className="mt-[11px] flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                      <span className="flex-none text-brand">ⓘ</span>
                      <span>
                        Save this as <span className="text-foreground">BOXLITE_API_KEY</span> in your environment (e.g.{' '}
                        <code className="text-foreground">export BOXLITE_API_KEY=…</code>) — the SDK reads it at runtime
                        so the key never lives in your code.
                      </span>
                    </div>
                  )}
                  <div className="mt-4 flex items-center justify-between">
                    {createdKey ? (
                      <button
                        type="button"
                        onClick={handleCreateKey}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        ↻ Regenerate
                      </button>
                    ) : (
                      <span />
                    )}
                    {createdKey ? (
                      <PrimaryBtn onClick={() => complete(0)}>
                        {done[0] ? '✓ Secured · Next' : 'Copied · Next →'}
                      </PrimaryBtn>
                    ) : (
                      <PrimaryBtn onClick={handleCreateKey}>{creating ? 'Creating…' : 'Create key'}</PrimaryBtn>
                    )}
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="px-5 py-[18px]" style={{ animation: 'stat-in .25s ease' }}>
                  <div className="mb-[14px] flex border-b border-border">
                    {LANGS.map((l) => {
                      const on = language === l.value
                      return (
                        <button
                          key={l.value}
                          type="button"
                          onClick={() => setLanguage(l.value)}
                          className={cn(
                            '-mb-px flex items-center gap-2 border-b-2 px-[14px] py-[7px] text-[12px] transition-colors',
                            on
                              ? 'border-brand font-semibold text-foreground'
                              : 'border-transparent text-muted-foreground',
                          )}
                        >
                          <img src={l.iconSrc} alt="" className="size-3.5" />
                          {l.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">
                    Run in your local terminal
                  </div>
                  <div className="flex items-center gap-3 border border-border bg-[hsl(var(--code-background))] px-[14px] py-3">
                    <span className="flex-none text-success">$</span>
                    <span className="flex-1 break-all text-[13px]">{activeExample.install}</span>
                  </div>
                  <div className="mt-[11px] flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    <span className="flex-none text-brand">ⓘ</span>
                    <span>
                      Run this command in your <span className="text-foreground">local development environment</span> to
                      install the {LANGS.find((l) => l.value === language)?.label} library. Continue once the install
                      finishes.
                    </span>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <PrimaryBtn onClick={() => complete(1)}>
                      {done[1] ? '✓ Installed · Next' : 'Installed · Next →'}
                    </PrimaryBtn>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="px-5 py-[18px]" style={{ animation: 'stat-in .25s ease' }}>
                  <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">
                    Run this from your local machine
                  </div>
                  <CodeBlock
                    code={renderedExample}
                    language={activeExample.codeLanguage}
                    showCopy
                    className="rounded-none"
                    codeAreaClassName="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed"
                  />
                  <div className="mt-[12px] flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    <span className="flex-none text-brand">ⓘ</span>
                    <span>
                      What it does: reads your <span className="text-foreground">BOXLITE_API_KEY</span> from the
                      environment, creates a Box, runs a command inside it, prints the output, then removes the Box. Run
                      it in your terminal with the install command from the previous step.
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-end">
                    <PrimaryBtn onClick={() => complete(2)}>{done[2] ? '✓ Done' : "I've run it"}</PrimaryBtn>
                  </div>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-[14px]">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                Maybe later
              </button>
              {finished && <PrimaryBtn onClick={() => onOpenChange(false)}>Open Fleet →</PrimaryBtn>}
            </div>

            {/* finale */}
            {finished && (
              <div
                className="pointer-events-none absolute inset-0 z-[55] overflow-hidden"
                style={{ background: 'hsl(var(--background) / 0.82)' }}
              >
                {Array.from({ length: 28 }).map((_, i) => (
                  <span
                    key={i}
                    className="absolute top-[-20px] size-[7px]"
                    style={{
                      left: `${(i * 37) % 100}%`,
                      background: i % 2 ? 'hsl(var(--success))' : 'hsl(var(--foreground))',
                      opacity: 0.9,
                      animation: `qs-fall ${(1.4 + (i % 5) * 0.24).toFixed(2)}s ${((i % 6) * 0.1).toFixed(2)}s ease-in forwards`,
                    }}
                  />
                ))}
                <div
                  className="absolute left-1/2 top-[28%] w-full -translate-x-1/2 text-center"
                  style={{ animation: 'stat-in .4s ease' }}
                >
                  <div className="text-[10px] uppercase tracking-[4px] text-success">✓ Mission complete</div>
                  <div className="mt-[10px] text-[34px] font-bold tracking-[-1.5px]">Box is live.</div>
                  <div className="mt-[10px] text-[12.5px] text-muted-foreground">
                    You shipped your first Box from code in three steps.
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
