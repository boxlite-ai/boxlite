/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import goIcon from '@/assets/go.svg'
import pythonIcon from '@/assets/python.svg'
import { RustIcon } from '@/assets/RustIcon'
import typescriptIcon from '@/assets/typescript.svg'
import { QuickstartAgentHandoff } from '@/components/QuickstartAgentHandoff'
import { QuickstartCopyButton } from '@/components/QuickstartCopyButton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileText, KeyRound, Server, Terminal } from '@/components/ui/icon'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { getRestApiUrl } from '@/lib/environment'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { createApiKeyWithFallbackName, DEFAULT_QUICKSTART_API_KEY_NAME } from '@/lib/quickstart-api-key'
import {
  getOnboardingCodeExamples,
  getOnboardingInterfaces,
  renderOnboardingCodeExample,
  type OnboardingInterface,
} from '@/lib/onboarding-code-examples'
import type { QuickstartGroup, QuickstartIconName, QuickstartInterfaceDefinition } from '@/lib/quickstart/types'
import { cn } from '@/lib/utils'
import type { OnboardingProgress } from '@/lib/onboarding-progress'
import {
  CreateApiKeyPermissionsEnum,
  OrganizationRolePermissionsEnum,
  type ApiKeyResponse,
} from '@boxlite-ai/api-client'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

// Lazy so prism-react-renderer (syntax highlighting, ~130KB) stays out of the
// first-paint bundle. CodeBlock only renders in step 2 of this dialog, which is
// closed on load — the <pre> fallback below is never visible during startup.
const CodeBlock = lazy(() => import('@/components/CodeBlock'))

interface OnboardingGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onProgressChange: (progress: OnboardingProgress) => void
  progress: OnboardingProgress
}

const STAGES = [
  { tag: 'STEP 01', label: 'Create a key' },
  { tag: 'STEP 02', label: 'Install SDK/CLI' },
  { tag: 'STEP 03', label: 'Execute code in box' },
] as const

// The two jobs an account arrives with, carried as equals. `publish` hands the
// work to the user's own coding agent; `untrusted-code` is the SDK walkthrough
// that has always lived here, unchanged.
const SCENARIOS = [
  { id: 'publish', tab: 'Build an app online' },
  { id: 'untrusted-code', tab: 'Run untrusted code' },
] as const

type ScenarioId = (typeof SCENARIOS)[number]['id']

const QUICKSTART_INTERFACES = getOnboardingInterfaces()
const DEFAULT_INTERFACE = QUICKSTART_INTERFACES[0]?.id ?? 'python'
// Multi-color brand marks ship as assets; single-color marks render inline so they
// inherit `currentColor` and stay visible in both themes.
const ICON_ASSETS: Partial<Record<QuickstartIconName, string>> = {
  go: goIcon,
  python: pythonIcon,
  typescript: typescriptIcon,
}
const ICON_COMPONENTS: Partial<Record<QuickstartIconName, React.ComponentType<{ className?: string }>>> = {
  file: FileText,
  rust: RustIcon,
  server: Server,
  terminal: Terminal,
}

const GROUPS: ReadonlyArray<{ id: QuickstartGroup; label: string }> = [
  { id: 'sdk', label: 'SDK' },
  { id: 'direct', label: 'Direct' },
]

function QuickstartInterfaceIcon({ item }: { item: QuickstartInterfaceDefinition }) {
  const iconSrc = ICON_ASSETS[item.icon]
  if (iconSrc) {
    return <img src={iconSrc} alt="" className="size-3.5" />
  }
  const Icon = ICON_COMPONENTS[item.icon]
  return Icon ? <Icon className="size-3.5" /> : null
}

/**
 * Interface picker. Rendered once for the whole flow — the choice spans steps 2 and 3,
 * so it does not belong to either one. Grouped explicitly: "SDK" scopes the languages,
 * which is why no single entry has to carry that word in its own label.
 */
function InterfacePicker({
  selected,
  onSelect,
}: {
  selected: OnboardingInterface
  onSelect: (id: OnboardingInterface) => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-5">
      {GROUPS.map((group) => {
        const items = QUICKSTART_INTERFACES.filter((item) => item.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id} className="min-w-0">
            <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">{group.label}</div>
            <div className="flex flex-wrap gap-2">
              {items.map((item) => {
                const on = selected === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      'flex min-h-[34px] items-center justify-center gap-2 border px-[12px] py-[7px] text-[12px] transition-colors',
                      on
                        ? 'border-brand bg-[hsl(var(--brand)/0.12)] font-semibold text-foreground'
                        : 'border-border text-muted-foreground hover:border-brand/70 hover:text-foreground',
                    )}
                  >
                    <QuickstartInterfaceIcon item={item} />
                    {item.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

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

type CopyTarget = 'api-key' | 'install' | 'code'

export function OnboardingGuideDialog({ open, onOpenChange, onProgressChange }: OnboardingGuideDialogProps) {
  const { apiKeyApi } = useApi()
  const config = useConfig()
  const restApiUrl = getRestApiUrl(config.apiUrl, undefined, config.oidc.issuer)
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const canCreateApiKey = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)

  // The two jobs are peers, but one of them has to be showing on open: a new
  // account has nothing to base the choice on, so it lands on the guided one.
  const [scenario, setScenario] = useState<ScenarioId>('publish')
  const [step, setStep] = useState(0)
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [language, setLanguage] = useState<OnboardingInterface>(DEFAULT_INTERFACE)
  const [createdKey, setCreatedKey] = useState<ApiKeyResponse | null>(null)
  const [keyName, setKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null)

  const codeExamples = getOnboardingCodeExamples()
  const activeExample = codeExamples[language] ?? codeExamples[DEFAULT_INTERFACE]
  const activeInterface = QUICKSTART_INTERFACES.find((item) => item.id === language) ?? QUICKSTART_INTERFACES[0]
  const renderedExample = useMemo(
    () => renderOnboardingCodeExample(language, { apiKey: createdKey?.value, restApiUrl }),
    [createdKey?.value, language, restApiUrl],
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
      setScenario('publish')
      setStep(0)
      setDone([false, false, false])
      setCreatedKey(null)
      setKeyName('')
      setCopiedTarget(null)
    }
  }, [open])

  const enterScenario = (id: ScenarioId) => {
    setScenario(id)
    setStep(0)
    setDone([false, false, false])
    setCreatedKey(null)
    setKeyName('')
    setCopiedTarget(null)
  }

  const finished = done.every(Boolean)

  const complete = (i: number) => {
    setDone((prev) => {
      const next = [...prev] as [boolean, boolean, boolean]
      next[i] = true
      if (next.every(Boolean)) {
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
        await createApiKeyWithFallbackName<{ data: ApiKeyResponse }>(
          (name) => apiKeyApi.createApiKey({ name, permissions: apiKeyPermissions }, selectedOrganization.id),
          { baseName: keyName },
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

  const copyText = (value: string, target: CopyTarget) => {
    try {
      navigator.clipboard?.writeText(value)
    } catch {
      /* clipboard may be unavailable */
    }
    setCopiedTarget(target)
    setTimeout(() => setCopiedTarget(null), 1400)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 font-mono sm:max-w-[860px]',
          scenario === 'untrusted-code' && step === 2 && 'h-[88vh]',
        )}
      >
        {scenario === 'publish' ? (
          <>
            {/* The dialog is opened from a nav button labelled "Quickstart" and
                the tabs below say what it does, so a visible title would only
                repeat the click that got here. Kept for screen readers. */}
            <DialogHeader className="sr-only">
              <DialogTitle>Quickstart</DialogTitle>
              <DialogDescription className="sr-only">
                Two ways to start: hand the job to your coding agent, or run untrusted code yourself.
              </DialogDescription>
            </DialogHeader>

            {/* Two jobs, equal weight. Radix Tabs so keyboard and screen-reader
                behaviour comes from the same primitive the console already uses. */}
            <Tabs
              value={scenario}
              onValueChange={(v) => enterScenario(v as ScenarioId)}
              className="shrink-0 px-5 pt-[18px]"
            >
              <TabsList variant="segmented">
                {SCENARIOS.map((sc) => (
                  <TabsTrigger key={sc.id} value={sc.id}>
                    {sc.tab}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="scrollbar-elevated mt-[18px] min-h-0 flex-1 overflow-y-auto border-t border-border">
              <QuickstartAgentHandoff restApiUrl={restApiUrl} onProgressChange={onProgressChange} />
            </div>
            <div className="flex shrink-0 items-center border-t border-border px-5 py-[14px]">
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
            {/* The dialog is opened from a nav button labelled "Quickstart" and
                the tabs below say what it does, so a visible title would only
                repeat the click that got here. Kept for screen readers. */}
            <DialogHeader className="sr-only">
              <DialogTitle>Quickstart</DialogTitle>
              <DialogDescription className="sr-only">
                Two ways to start: hand the job to your coding agent, or run untrusted code yourself.
              </DialogDescription>
            </DialogHeader>

            {/* Two jobs, equal weight. Radix Tabs so keyboard and screen-reader
                behaviour comes from the same primitive the console already uses. */}
            <Tabs
              value={scenario}
              onValueChange={(v) => enterScenario(v as ScenarioId)}
              className="shrink-0 px-5 pt-[18px]"
            >
              <TabsList variant="segmented">
                {SCENARIOS.map((sc) => (
                  <TabsTrigger key={sc.id} value={sc.id}>
                    {sc.tab}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {/* stage rail */}
            <div className="flex shrink-0 items-center px-5 pb-4 pt-[18px]">
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
                          'hidden whitespace-nowrap text-[12px] sm:inline',
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

            {/* interface picker — spans steps 2 and 3, so it lives outside the step body */}
            {step > 0 && (
              <div className="shrink-0 border-t border-border px-5 py-[14px]">
                <InterfacePicker selected={language} onSelect={setLanguage} />
              </div>
            )}

            {/* body */}
            <div
              className={cn(
                'scrollbar-elevated min-h-0 flex-1 border-t border-border',
                step === 2 ? 'overflow-hidden' : 'overflow-y-auto',
              )}
            >
              {step === 0 && (
                <div className="px-5 py-[18px]" style={{ animation: 'stat-in .25s ease' }}>
                  <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">
                    {createdKey ? 'Your API key' : 'Key name'}
                  </div>
                  <div className="flex items-center gap-[10px] border border-border bg-[hsl(var(--code-background))] px-[14px] py-3 focus-within:border-brand">
                    <KeyRound className={cn('size-4 flex-none', createdKey ? 'text-brand' : 'text-muted-foreground')} />
                    {createdKey ? (
                      <span className="flex-1 break-all text-[11.5px] leading-relaxed text-foreground">
                        {createdKey.value}
                      </span>
                    ) : (
                      <input
                        value={keyName}
                        onChange={(e) => setKeyName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !creating) {
                            void handleCreateKey()
                          }
                        }}
                        placeholder={`${DEFAULT_QUICKSTART_API_KEY_NAME} (default)`}
                        aria-label="Quickstart API key name"
                        disabled={creating}
                        className="min-w-0 flex-1 bg-transparent text-[13px] tracking-[0.5px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    )}
                    {createdKey ? (
                      <QuickstartCopyButton
                        copied={copiedTarget === 'api-key'}
                        onClick={() => copyText(createdKey.value, 'api-key')}
                      />
                    ) : null}
                  </div>
                  {!createdKey && (
                    <div className="mt-[9px] text-[11.5px] leading-relaxed text-muted-foreground">
                      Leave blank to use <span className="text-foreground">{DEFAULT_QUICKSTART_API_KEY_NAME}</span>.
                    </div>
                  )}
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
                  <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">
                    {activeExample.setupLabel ?? 'Run in your local terminal'}
                  </div>
                  <div className="flex items-start gap-3 border border-border bg-[hsl(var(--code-background))] px-[14px] py-3">
                    <span className="flex-none pt-[1px] text-success">$</span>
                    <pre className="scrollbar-elevated min-w-0 flex-1 overflow-x-auto whitespace-pre text-[13px] leading-relaxed text-foreground">
                      {activeExample.install}
                    </pre>
                    <QuickstartCopyButton
                      copied={copiedTarget === 'install'}
                      onClick={() => copyText(activeExample.install, 'install')}
                    />
                  </div>
                  <div className="mt-[11px] flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    <span className="flex-none text-brand">ⓘ</span>
                    <span>
                      {activeExample.setupDescription ?? (
                        <>
                          Run this command in your{' '}
                          <span className="text-foreground">local development environment</span> to install the{' '}
                          {activeInterface?.label} library. Continue once the install finishes.
                        </>
                      )}
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
                <div className="flex h-full min-h-0 flex-col px-5 py-[18px]" style={{ animation: 'stat-in .25s ease' }}>
                  <div className="mb-[9px] text-[9px] uppercase tracking-[1.5px] text-muted-foreground">
                    Run this from your local machine
                  </div>
                  <div className="relative min-h-0 flex-1">
                    <Suspense
                      fallback={
                        <pre className="scrollbar-elevated h-full overflow-auto whitespace-pre rounded-none p-3 pr-24 text-[11.5px] leading-relaxed">
                          {renderedExample}
                        </pre>
                      }
                    >
                      <CodeBlock
                        code={renderedExample}
                        language={activeExample.codeLanguage}
                        showCopy={false}
                        className="h-full rounded-none"
                        codeAreaClassName="h-full overflow-auto whitespace-pre pr-24 text-[11.5px] leading-relaxed"
                      />
                    </Suspense>
                    <QuickstartCopyButton
                      copied={copiedTarget === 'code'}
                      onClick={() => copyText(renderedExample, 'code')}
                      className="absolute right-2 top-2.5"
                    />
                  </div>
                  <div className="mt-[12px] flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    <span className="flex-none text-brand">ⓘ</span>
                    <span>
                      {activeExample.executionDescription} Run it in your terminal with the install command from the
                      previous step.
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
