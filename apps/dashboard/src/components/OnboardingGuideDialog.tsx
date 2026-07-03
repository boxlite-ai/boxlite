/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import goIcon from '@/assets/go.svg'
import pythonIcon from '@/assets/python.svg'
import rustIcon from '@/assets/rust.svg'
import typescriptIcon from '@/assets/typescript.svg'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KeyRound, Server, Terminal } from '@/components/ui/icon'
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
import type { QuickstartIconName, QuickstartInterfaceDefinition } from '@/lib/quickstart/types'
import { setLocalStorageItem } from '@/lib/local-storage'
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

// Quickstart scenarios. Today there is one; future scenarios slot in here and route to
// their own guided flow. (For now every scenario uses the SDK 3-step flow below.)
const SCENARIOS = [
  {
    id: 'untrusted-code',
    tag: 'Box',
    title: 'Box as your untrusted code container',
    description:
      'Run AI-generated or untrusted code in an isolated, disposable Box. Create a key, choose an interface, then execute code safely inside a box.',
  },
] as const

type ScenarioId = (typeof SCENARIOS)[number]['id']

const QUICKSTART_INTERFACES = getOnboardingInterfaces()
const DEFAULT_INTERFACE = QUICKSTART_INTERFACES[0]?.id ?? 'python'
const ICON_ASSETS: Partial<Record<QuickstartIconName, string>> = {
  go: goIcon,
  python: pythonIcon,
  rust: rustIcon,
  typescript: typescriptIcon,
}
const ICON_COMPONENTS: Partial<Record<QuickstartIconName, React.ComponentType<{ className?: string }>>> = {
  server: Server,
  terminal: Terminal,
}

function QuickstartInterfaceIcon({ item }: { item: QuickstartInterfaceDefinition }) {
  const iconSrc = ICON_ASSETS[item.icon]
  const Icon = ICON_COMPONENTS[item.icon]
  if (iconSrc) {
    return <img src={iconSrc} alt="" className="size-3.5" />
  }
  if (Icon) {
    return <Icon className="size-3.5" />
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 items-center justify-center border border-current text-[9px] leading-none"
    >
      {item.badge}
    </span>
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

function QuickstartCopyButton({
  copied,
  onClick,
  className,
}: {
  copied: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        boxShadow: copied ? '3px 3px 0 hsl(var(--success) / 0.35)' : '3px 3px 0 hsl(var(--border))',
      }}
      className={cn(
        'flex h-7 min-w-[76px] flex-none items-center justify-center border-2 bg-[hsl(var(--code-background))] px-[10px] text-[10px] font-semibold uppercase tracking-[1px] transition-[color,border-color,background-color,transform,box-shadow] active:translate-x-px active:translate-y-px active:shadow-none',
        copied
          ? 'border-success bg-[hsl(var(--success)/0.14)] text-success'
          : 'border-border text-muted-foreground hover:border-brand hover:text-foreground',
        className,
      )}
    >
      {copied ? '✓ Copied' : 'Copy'}
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

  const [scenario, setScenario] = useState<ScenarioId | null>(null)
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
      setScenario(null)
      setStep(0)
      setDone([false, false, false])
      setCreatedKey(null)
      setKeyName('')
      setCopiedTarget(null)
    }
  }, [open])

  const activeScenario = SCENARIOS.find((s) => s.id === scenario)
  const enterScenario = (id: ScenarioId) => {
    setScenario(id)
    setStep(0)
    setDone([false, false, false])
    setCreatedKey(null)
    setKeyName('')
    setCopiedTarget(null)
  }
  const backToScenarios = () => {
    setScenario(null)
    setStep(0)
    setDone([false, false, false])
    setCreatedKey(null)
    setKeyName('')
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
          scenario !== null && step === 2 && 'h-[88vh]',
        )}
      >
        {scenario === null ? (
          <>
            <DialogHeader className="shrink-0 px-5 pb-2 pt-[18px]">
              <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">Quickstart</DialogTitle>
              <DialogDescription className="font-mono text-[11px] uppercase tracking-[1.5px] text-muted-foreground">
                {SCENARIOS.length} scenario{SCENARIOS.length === 1 ? '' : 's'} available
              </DialogDescription>
            </DialogHeader>
            <div className="scrollbar-elevated min-h-0 flex-1 overflow-y-auto border-t border-border px-5 pb-3 pt-[24px]">
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
                      3 steps · sdk/api
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
                  <div className="mb-[14px] grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {QUICKSTART_INTERFACES.map((item) => {
                      const on = language === item.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-label={item.ariaLabel}
                          onClick={() => setLanguage(item.id)}
                          className={cn(
                            'flex min-h-[34px] items-center justify-center gap-2 border px-[10px] py-[7px] text-[12px] transition-colors',
                            on
                              ? 'border-brand bg-[hsl(var(--brand)/0.12)] font-semibold text-brand'
                              : 'border-border text-muted-foreground hover:border-brand/70 hover:text-foreground',
                          )}
                        >
                          <QuickstartInterfaceIcon item={item} />
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
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
                  <div className="mb-[14px] grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {QUICKSTART_INTERFACES.map((item) => {
                      const on = language === item.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-label={item.ariaLabel}
                          onClick={() => setLanguage(item.id)}
                          className={cn(
                            'flex min-h-[34px] items-center justify-center gap-2 border px-[10px] py-[7px] text-[12px] transition-colors',
                            on
                              ? 'border-brand bg-[hsl(var(--brand)/0.12)] font-semibold text-brand'
                              : 'border-border text-muted-foreground hover:border-brand/70 hover:text-foreground',
                          )}
                        >
                          <QuickstartInterfaceIcon item={item} />
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
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
