/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiButton } from '@/components/ascii'
import goIcon from '@/assets/go.svg'
import pythonIcon from '@/assets/python.svg'
import { RustIcon } from '@/assets/RustIcon'
import typescriptIcon from '@/assets/typescript.svg'
import { QuickstartAgentHandoff } from '@/components/QuickstartAgentHandoff'
import { QuickstartRecipeHeader, type QuickstartPreview } from '@/components/first-run/QuickstartRecipeHeader'
import { CODING_AGENT_MARKS } from '@/assets/AgentLogos'
import { QuickstartCopyButton } from '@/components/QuickstartCopyButton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FileText, KeyRound, Server, Terminal } from '@/components/ui/icon'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { getRestApiUrl } from '@/lib/environment'
import { copyToClipboard } from '@/lib/copy-text'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { createApiKeyWithFallbackName, DEFAULT_QUICKSTART_API_KEY_NAME } from '@/lib/quickstart-api-key'
import {
  getOnboardingCodeExamples,
  getOnboardingInterfaces,
  renderOnboardingCodeExample,
  renderOnboardingCodeSteps,
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
import { Suspense, lazy, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

// Load the shared syntax highlighter only when a code example is displayed.
const CodeBlock = lazy(() => import('@/components/CodeBlock'))

interface OnboardingGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onProgressChange: (progress: OnboardingProgress) => void
  progress: OnboardingProgress
  inline?: boolean
  preview?: QuickstartPreview
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
  {
    id: 'publish',
    tab: 'Build an app online',
    promise: 'Get a public URL',
    // Not "deploy": preview traffic keeps a running box alive but cannot wake a
    // stopped one, and boxes stop themselves after 15 idle minutes. "Online" is
    // the weaker word, and the weaker word is the true one.
    title: "Put your agent's app online.",
    sub: 'One prompt. Your agent builds it, BoxLite puts it online.',
  },
  {
    id: 'untrusted-code',
    tab: 'Run untrusted code',
    promise: 'An isolated box for your code',
    title: 'Run untrusted code in a box.',
    sub: 'A key, an SDK, and a box that runs whatever you give it.',
  },
] as const

type ScenarioId = (typeof SCENARIOS)[number]['id']

// One subject per card, with mass. The first pass drew the whole story —
// window chrome, page layout, a globe, a three-step pipeline — at one stroke
// weight, so twenty equal lines competed and nothing led. These keep a single
// filled object as the figure, one recessive frame as the ground, and spend
// brand exactly once, on the detail that names the job.
const ART_CLASS = 'h-[92px] w-full'
const SURFACE = 'hsl(var(--background))'
const BRAND = 'hsl(var(--brand))'

/** A browser window, and the one lit thing on it: its address. */
function PublishArt() {
  return (
    <svg viewBox="0 0 256 96" className={ART_CLASS} aria-hidden>
      <rect x="54" y="10" width="148" height="76" fill={SURFACE} stroke="currentColor" strokeWidth={1.75} />
      <path d="M54 32h148" stroke="currentColor" strokeWidth={1.25} opacity={0.7} />
      <circle cx="64" cy="21" r="1.75" fill="currentColor" opacity={0.45} />
      <circle cx="72" cy="21" r="1.75" fill="currentColor" opacity={0.45} />
      <circle cx="80" cy="21" r="1.75" fill="currentColor" opacity={0.45} />
      {/* the address: the only element that is lit, because a public URL is
          the whole point of this job */}
      <rect x="92" y="15.5" width="98" height="11" fill="hsl(var(--brand) / 0.16)" />
      <path d="M98 21h62" stroke={BRAND} strokeWidth={2.25} strokeLinecap="round" />
      {/* the page, as weight rather than drawing */}
      <rect x="68" y="44" width="120" height="7" fill="currentColor" opacity={0.16} />
      <rect x="68" y="58" width="84" height="7" fill="currentColor" opacity={0.16} />
      <rect x="68" y="72" width="52" height="7" fill="currentColor" opacity={0.16} />
    </svg>
  )
}

/** A solid box standing inside a boundary, with code running in it. */
function UntrustedCodeArt() {
  return (
    <svg viewBox="0 0 256 96" className={ART_CLASS} aria-hidden>
      {/* the boundary recedes: it is the condition, not the subject */}
      <rect
        x="70"
        y="8"
        width="116"
        height="80"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeDasharray="4 4"
        opacity={0.4}
      />
      {/* the box, with volume — it occludes the boundary behind it */}
      {/* Volume comes from three neutral values, not from hue: brand marks what
          is live, and a face of a box is material, not state. */}
      <path
        d="M128 18L162 35L128 52L94 35Z"
        fill="currentColor"
        fillOpacity={0.14}
        stroke="currentColor"
        strokeWidth={1.75}
      />
      <path d="M94 35L128 52L128 80L94 63Z" fill={SURFACE} stroke="currentColor" strokeWidth={1.75} />
      <path
        d="M128 52L162 35L162 63L128 80Z"
        fill="currentColor"
        fillOpacity={0.07}
        stroke="currentColor"
        strokeWidth={1.75}
      />
      {/* code, running inside it */}
      <path
        d="M103 60l5 4-5 4"
        fill="none"
        stroke={BRAND}
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M112 68h9" stroke={BRAND} strokeWidth={2.25} strokeLinecap="round" opacity={0.75} />
    </svg>
  )
}

const SCENARIO_ART: Record<ScenarioId, () => ReactElement> = {
  publish: PublishArt,
  'untrusted-code': UntrustedCodeArt,
}

/**
 * The four corners of a selected frame, the way a terminal draws one.
 *
 * `foreground`, not `brand`: brand marks what is live in this console — a
 * running box, a rising cost — and a card the user clicked is not that.
 * `aria-hidden` because the tab already announces itself through
 * `aria-selected`; these corners are that same fact, drawn.
 */
function CornerMarks() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 font-mono text-label leading-none text-foreground"
    >
      <span className="absolute -left-px -top-px">┌</span>
      <span className="absolute -right-px -top-px">┐</span>
      <span className="absolute -bottom-px -left-px">└</span>
      <span className="absolute -bottom-px -right-px">┘</span>
    </span>
  )
}

/**
 * The chosen job is the headline, so the biggest text on the screen is the
 * user's own decision; the two cards beneath stay equal peers. Radix Tabs
 * underneath, so keyboard and screen-reader behaviour is the console's own.
 */
function ScenarioHeader({
  scenario,
  onSelect,
  compact = false,
  onExpand,
}: {
  scenario: ScenarioId
  onSelect: (id: ScenarioId) => void
  /** Once a step is underway the cards have done their job; a full header
   *  would push the step's own content — the code — below the fold. */
  compact?: boolean
  onExpand?: () => void
}) {
  const current = SCENARIOS.find((sc) => sc.id === scenario) ?? SCENARIOS[0]
  if (compact) {
    return (
      <div className="flex shrink-0 items-baseline gap-3 px-8 pt-7">
        <DialogHeader className="space-y-0 text-left">
          <DialogTitle className="font-display text-em font-semibold text-foreground">{current.title}</DialogTitle>
          <DialogDescription className="sr-only">{current.sub}</DialogDescription>
        </DialogHeader>
        <button
          type="button"
          onClick={onExpand}
          className="text-meta text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Change
        </button>
      </div>
    )
  }
  return (
    <div className="shrink-0 px-8 pt-8">
      <DialogHeader className="space-y-0 text-left">
        <DialogTitle className="font-display text-page font-semibold text-foreground">{current.title}</DialogTitle>
        <DialogDescription className="mt-2 text-body text-muted-foreground">{current.sub}</DialogDescription>
      </DialogHeader>

      {/* Compatibility stated in one glance instead of a sentence: the agents
          the prompt is written for, or the interfaces the walkthrough covers. */}
      <div className="mt-5 flex h-[22px] items-center gap-6 text-foreground/70">
        {scenario === 'publish'
          ? CODING_AGENT_MARKS.map(({ label, Mark }) => <Mark key={label} className="size-[22px]" />)
          : QUICKSTART_INTERFACES.map((item) => (
              <QuickstartInterfaceIcon key={item.id} item={item} className="size-[22px] grayscale" />
            ))}
      </div>

      <Tabs value={scenario} onValueChange={(v) => onSelect(v as ScenarioId)} className="mt-6">
        {/* The segmented variant's strip is a container the active segment shows
            through; these are free-standing cards with a gutter between them,
            so the strip itself carries neither ground nor border. */}
        <TabsList variant="segmented" className="grid h-auto w-full grid-cols-2 gap-4 border-0 bg-transparent">
          {SCENARIOS.map((sc) => {
            const Art = SCENARIO_ART[sc.id]
            return (
              <TabsTrigger
                key={sc.id}
                value={sc.id}
                className={cn(
                  'relative h-auto flex-col items-stretch gap-0 border border-border p-0 text-left hover:bg-transparent',
                  // One rule across the console: the chosen thing is the
                  // surface that differs from its container, and the ones not
                  // chosen recede into it. Here the container is the dialog,
                  // so the chosen card lifts onto `card` and the others sit
                  // flat on the dialog's own ground.
                  sc.id === scenario
                    ? 'border-border-selected bg-card opacity-100'
                    : 'bg-transparent text-muted-foreground',
                )}
              >
                {/* Corner marks, the way a terminal draws a selected frame. The
                    plain 1px rule alone was the one piece of this screen with no
                    accent of the console's own language on it. */}
                {sc.id === scenario && <CornerMarks />}
                {/* Thumbnail on a dotted field, flush to the card's edges — the
                    drawing is the card's first line, not an icon beside its title. */}
                <span
                  className={cn(
                    'flex h-[104px] items-center justify-center border-b border-border/60 transition-[filter,color]',
                    // `text-muted-foreground` only reaches the strokes drawn in
                    // `currentColor`. Each drawing also spends brand once, on the
                    // detail that names the job, and that stayed fully saturated
                    // on the card the user did not choose — the brightest thing
                    // in the pair sat on the one meant to recede. `grayscale` is
                    // how this dialog already dims the interface marks above.
                    sc.id === scenario ? 'text-foreground' : 'text-muted-foreground grayscale',
                  )}
                >
                  <Art />
                </span>
                <span className="flex flex-col gap-1 px-5 pb-3.5 pt-3">
                  <span className="font-display text-em font-semibold">{sc.tab}</span>
                  <span className="text-meta font-normal text-muted-foreground">{sc.promise}</span>
                </span>
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>
    </div>
  )
}

const QUICKSTART_INTERFACES = getOnboardingInterfaces()
const DEFAULT_INTERFACE = QUICKSTART_INTERFACES[0]?.id ?? 'python'
const EXAMPLE_FILES: Record<string, string> = {
  python: 'main.py',
  typescript: 'index.mts',
  go: 'main.go',
  rust: 'src/main.rs',
  c: 'main.c',
  cli: 'quickstart.sh',
  rest: 'quickstart-rest.sh',
}
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

function QuickstartInterfaceIcon({
  item,
  className = 'size-3.5',
}: {
  item: QuickstartInterfaceDefinition
  className?: string
}) {
  const iconSrc = ICON_ASSETS[item.icon]
  if (iconSrc) {
    return <img src={iconSrc} alt="" className={className} />
  }
  const Icon = ICON_COMPONENTS[item.icon]
  return Icon ? <Icon className={className} /> : null
}

/**
 * Interface picker. Rendered once for the whole flow — the choice spans steps 2 and 3,
 * so it does not belong to either one. Grouped explicitly: "SDK" scopes the languages,
 * which is why no single entry has to carry that word in its own label.
 */
function InterfacePicker({
  selected,
  onSelect,
  quiet = false,
}: {
  selected: OnboardingInterface
  onSelect: (id: OnboardingInterface) => void
  quiet?: boolean
}) {
  if (quiet) {
    return (
      <Tabs value={selected} onValueChange={onSelect} className="min-w-0 max-w-full">
        <TabsList variant="segmented" aria-label="SDK or CLI" className="h-auto flex-wrap">
          {QUICKSTART_INTERFACES.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="h-9 gap-1.5 px-3">
              <QuickstartInterfaceIcon item={item} />
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    )
  }
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-5">
      {GROUPS.map((group) => {
        const items = QUICKSTART_INTERFACES.filter((item) => item.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id} className="min-w-0">
            <div className="mb-[9px] text-label uppercase tracking-[1.5px] text-muted-foreground">{group.label}</div>
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
                      'flex min-h-[34px] items-center justify-center gap-2 px-[12px] py-[7px] text-meta transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
                      quiet
                        ? on
                          ? 'rounded-none bg-foreground/[0.07] font-semibold text-foreground'
                          : 'rounded-none text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
                        : on
                          ? 'border-border-selected bg-card font-semibold text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      !quiet && 'border',
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
    <AsciiButton variant="primary" type="button" onClick={onClick}>
      {children}
    </AsciiButton>
  )
}

type CopyTarget = 'api-key' | 'install' | 'code' | 'creation' | 'execution' | 'preview'

/** Keeps short examples at their natural height and bounds scrolling for examples over 35 lines. */
function QuickstartCode({ code, language }: { code: string; language: string }) {
  return (
    <Suspense fallback={<pre className="quickstart-code overflow-auto whitespace-pre p-4">{code}</pre>}>
      <CodeBlock
        code={code}
        preserveWhitespace
        language={language}
        showCopy={false}
        className="w-full rounded-none border-0 bg-transparent shadow-none"
        codeAreaClassName={`quickstart-code overflow-x-auto rounded-none px-4 pb-5 pt-4 pr-4 ${code.split('\n').length > 35 ? 'max-h-[560px] overflow-y-auto' : ''}`}
      />
    </Suspense>
  )
}

function QuickstartStepHeading({ title }: { title: string }) {
  const split = title.indexOf(' ')
  return (
    <h2 className="font-display text-em font-semibold">
      <span className="quickstart-step-number">{title.slice(0, split)}</span> {title.slice(split + 1)}
    </h2>
  )
}

/** Renders numbered SDK instructions with independently copyable code blocks. */
function InlineCodeSteps({
  language,
  apiKey,
  restApiUrl,
  command,
  copiedTarget,
  onCopy,
}: {
  language: OnboardingInterface
  apiKey?: string
  restApiUrl: string
  command?: { executable: string; args: string[] }
  copiedTarget: CopyTarget | null
  onCopy: (value: string, target: CopyTarget) => Promise<void>
}) {
  const parts = renderOnboardingCodeSteps(language, { apiKey, restApiUrl, command })
  return (
    <>
      {(
        [
          {
            id: 'creation',
            title: '3. Create a Box',
            note: `A Box is an isolated environment created from a container image. Start ${EXAMPLE_FILES[language]} with this section to create and start a named Box using the agent base image, or replace the image reference with your own.`,
            code: parts.creation,
          },
          {
            id: 'execution',
            title: '4. Run code and commands',
            note: 'Continue in the same file to run a command in your Box and check its result. Keep the Box running for the preview below.',
            code: parts.execution,
          },
          {
            id: 'preview',
            title: '5. Create a preview',
            note: 'Start a small web server on port 3000 and print its public preview URL. Open that URL in your browser to see Hello from BoxLite. Anyone with the URL can access this demo. The script leaves your Box running. Idle auto-stop still applies (15 minutes by default); manage it from Boxes.',
            code: parts.preview,
          },
        ] as const
      ).map((part, index) => (
        <section key={part.id} className="quickstart-step min-w-0">
          <QuickstartStepHeading title={part.title} />
          <p className="mt-2 max-w-[900px] font-display text-body leading-relaxed text-muted-foreground">{part.note}</p>
          <div className="mt-4 overflow-hidden rounded-none quickstart-code-surface">
            <div className="flex items-center justify-between border-b border-[hsl(var(--quickstart-code-border))] bg-card px-4 py-2">
              <span className="font-mono text-meta tracking-normal text-muted-foreground">
                {EXAMPLE_FILES[language]} · part {index + 1}
              </span>
              <QuickstartCopyButton
                quiet
                copied={copiedTarget === part.id}
                onClick={() => void onCopy(part.code, part.id)}
              />
            </div>
            <QuickstartCode code={part.code} language={getOnboardingCodeExamples()[language].codeLanguage} />
          </div>
        </section>
      ))}
    </>
  )
}

export function OnboardingGuideDialog(props: OnboardingGuideDialogProps) {
  const { selectedOrganization } = useSelectedOrganization()
  const userId = useAuth().user?.profile.sub
  return <OnboardingGuideContent key={`${userId}:${selectedOrganization?.id}`} {...props} />
}

/** Guides SDK, console, and prompt-based setup while keeping progress scoped to the selected account. */
function OnboardingGuideContent({
  open,
  onOpenChange,
  onProgressChange,
  preview,
  inline = false,
}: OnboardingGuideDialogProps) {
  const { apiKeyApi } = useApi()
  const config = useConfig()
  const restApiUrl = getRestApiUrl(config.apiUrl, undefined, config.oidc.issuer)
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const userId = useAuth().user?.profile.sub
  const canCreateApiKey = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)

  // The two jobs are peers, but one of them has to be showing on open: a new
  // account has nothing to base the choice on, so it lands on the guided one.
  //
  // Changing tabs only changes tabs. It used to reset the walkthrough as well,
  // so a user who created a key, looked at the other job and came back found it
  // gone from their snippets — and the plaintext value is returned once, so it
  // was gone for good. The `open` effect below still resets on each opening.
  const [scenario, setScenario] = useState<ScenarioId>('publish')
  const [step, setStep] = useState(0)
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false])
  const [language, setLanguage] = useState<OnboardingInterface>(DEFAULT_INTERFACE)
  const [createdKey, setCreatedKey] = useState<ApiKeyResponse | null>(null)
  const [keyName, setKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null)
  const activeScenario = preview ? (preview.recipe.command ? 'untrusted-code' : 'publish') : scenario

  const codeExamples = getOnboardingCodeExamples()
  const activeExample = codeExamples[language] ?? codeExamples[DEFAULT_INTERFACE]
  const activeInterface = QUICKSTART_INTERFACES.find((item) => item.id === language) ?? QUICKSTART_INTERFACES[0]
  const renderedExample = useMemo(
    () =>
      renderOnboardingCodeExample(language, {
        apiKey: createdKey?.value,
        restApiUrl,
        command: preview?.recipe.command,
      }),
    [createdKey?.value, language, restApiUrl, preview?.recipe.command],
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
      setLanguage(DEFAULT_INTERFACE)
      setStep(0)
      setDone([false, false, false])
      setCreatedKey(null)
      setKeyName('')
      setCopiedTarget(null)
    }
  }, [open, userId])

  useEffect(() => {
    // A different task needs its own completion, but the key and interface remain useful.
    setDone((previous) => [previous[0], previous[1], false])
    setCopiedTarget(null)
  }, [preview?.recipe.id])

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

  const copyText = async (value: string, target: CopyTarget) => {
    if (!(await copyToClipboard(value))) return
    setCopiedTarget(target)
    setTimeout(() => setCopiedTarget(null), 1400)
  }

  if (inline)
    return activeScenario === 'publish' ? (
      <section>
        <QuickstartAgentHandoff
          composeRequest
          restApiUrl={restApiUrl}
          onProgressChange={onProgressChange}
          onLeave={() => onOpenChange(false)}
        />
      </section>
    ) : (
      <section className="min-w-0 font-sans">
        <div className="quickstart-sequence min-w-0">
          <section className="quickstart-step min-w-0">
            <QuickstartStepHeading title="1. Get an API key" />
            <p className="mt-2 max-w-[900px] font-display text-body leading-relaxed text-muted-foreground">
              An API key connects your local code to your BoxLite organization. Create one here, or set BOXLITE_API_KEY
              in your terminal to use an existing key.
            </p>
            {createdKey ? (
              <div className="mt-4 flex items-start gap-3 rounded-none quickstart-code-surface p-3">
                <code className="quickstart-code min-w-0 flex-1 break-all">{createdKey.value}</code>
                <QuickstartCopyButton
                  quiet
                  copied={copiedTarget === 'api-key'}
                  onClick={() => void copyText(createdKey.value ?? '', 'api-key')}
                />
              </div>
            ) : (
              <div className="mt-4 flex max-w-lg flex-wrap gap-2">
                <input
                  aria-label="Quickstart API key name"
                  value={keyName}
                  onChange={(event) => setKeyName(event.target.value)}
                  placeholder="Key name (optional)"
                  className="min-w-0 flex-1 rounded-none border border-border/60 bg-transparent px-3 py-2 font-display text-meta outline-none focus:border-brand"
                />
                <button
                  type="button"
                  disabled={creating || !canCreateApiKey}
                  onClick={() => void handleCreateKey()}
                  className="bg-primary px-3 py-2 text-meta text-primary-foreground disabled:opacity-50"
                >
                  {creating ? 'Creating…' : 'Create key'}
                </button>
              </div>
            )}
            {createdKey && (
              <p className="mt-3 font-display text-meta text-muted-foreground">
                Your key is included in the examples below.
              </p>
            )}
          </section>
          <section className="quickstart-step min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <QuickstartStepHeading title="2. Choose your SDK or CLI" />
              <InterfacePicker quiet selected={language} onSelect={setLanguage} />
            </div>
            <p className="mt-2 max-w-[900px] font-display text-body leading-relaxed text-muted-foreground">
              {language === 'cli'
                ? 'Install the BoxLite CLI to create and manage Boxes from your terminal. The commands below connect using your API key.'
                : language === 'rest'
                  ? 'Use curl and jq to call the BoxLite REST API directly, without an SDK. The requests below create a Box and execute a command using your API key.'
                  : `Install the ${activeInterface.label} SDK in your local project to create Boxes, run commands and read results from your code. Run the installation command below in your terminal.`}
            </p>
            <div className="mt-4 overflow-hidden rounded-none quickstart-code-surface">
              <div className="flex items-center justify-between border-b border-[hsl(var(--quickstart-code-border))] bg-card px-4 py-2">
                <span className="font-sans text-meta tracking-normal text-muted-foreground">Local terminal</span>
                <QuickstartCopyButton
                  quiet
                  copied={copiedTarget === 'install'}
                  onClick={() => void copyText(activeExample.install, 'install')}
                />
              </div>
              <QuickstartCode code={activeExample.install} language="bash" />
            </div>
          </section>
          <p className="font-display text-body leading-relaxed text-muted-foreground">
            Save parts 1–3 in order in <span className="font-mono text-foreground">{EXAMPLE_FILES[language]}</span>, or
            use Copy full example below. Run the complete file once to create your Box and open a preview.
          </p>
          <InlineCodeSteps
            language={language}
            apiKey={createdKey?.value}
            restApiUrl={restApiUrl}
            command={preview?.recipe.command}
            copiedTarget={copiedTarget}
            onCopy={copyText}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-none quickstart-code-surface px-4 py-3">
            <pre className="quickstart-code min-w-0 overflow-x-auto whitespace-pre">
              ${' '}
              {language === 'cli'
                ? 'bash quickstart.sh'
                : activeExample.run.replace('BOXLITE_API_KEY=$KEY ', '').replace('your-api-url', restApiUrl)}
            </pre>
            <QuickstartCopyButton
              quiet
              label="Copy full example"
              copied={copiedTarget === 'code'}
              onClick={() =>
                void copyText(
                  renderOnboardingCodeSteps(language, {
                    apiKey: createdKey?.value,
                    restApiUrl,
                    command: preview?.recipe.command,
                  }).example,
                  'code',
                )
              }
            />
          </div>
        </div>
      </section>
    )

  const content = (
    <>
      {' '}
      {activeScenario === 'publish' ? (
        <>
          {preview ? (
            <QuickstartRecipeHeader preview={preview} compact={false} />
          ) : (
            <ScenarioHeader scenario={scenario} onSelect={setScenario} />
          )}

          <div className="scrollbar-elevated min-h-0 flex-1 overflow-y-auto">
            <QuickstartAgentHandoff
              restApiUrl={restApiUrl}
              onProgressChange={onProgressChange}
              onLeave={() => onOpenChange(false)}
            />
          </div>
          <div className="flex shrink-0 items-center justify-between border-t border-border px-8 py-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-meta text-muted-foreground hover:text-foreground"
            >
              Maybe later
            </button>
            {preview && (
              <button type="button" className="text-meta text-foreground hover:text-brand" onClick={preview.onConsole}>
                Try in console →
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {preview ? (
            <QuickstartRecipeHeader preview={preview} compact={step > 0} statusOnly={language === 'rest'} />
          ) : (
            <ScenarioHeader scenario={scenario} onSelect={setScenario} compact={step > 0} onExpand={() => setStep(0)} />
          )}

          {/* stage rail */}
          <div className="flex shrink-0 items-center px-8 pb-4 pt-6">
            {STAGES.map((s, i) => {
              const isDone = done[i]
              const active = step === i
              return (
                <div key={s.tag} className="flex flex-1 items-center last:flex-none">
                  <button type="button" onClick={() => setStep(i)} className="flex flex-none items-center gap-[9px]">
                    <span
                      className={cn(
                        'flex size-6 flex-none items-center justify-center rounded-full border-[1.5px] text-label font-bold transition-colors',
                        isDone
                          ? 'border-brand bg-brand text-brand-foreground'
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
                        'hidden whitespace-nowrap text-meta sm:inline',
                        active ? 'font-semibold text-foreground' : isDone ? 'text-foreground' : 'text-muted-foreground',
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
            <div className="shrink-0 border-t border-border px-8 py-4">
              {preview && (
                <label className="flex items-center gap-3 text-meta text-muted-foreground sm:hidden">
                  Interface
                  <select
                    aria-label="SDK or interface"
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    className="h-10 min-w-0 flex-1 border border-border bg-background px-3 text-foreground"
                  >
                    {GROUPS.map((group) => (
                      <optgroup key={group.id} label={group.label}>
                        {QUICKSTART_INTERFACES.filter((item) => item.group === group.id).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              )}
              <div className={preview ? 'hidden sm:block' : undefined}>
                <InterfacePicker selected={language} onSelect={setLanguage} />
              </div>
            </div>
          )}

          {/* body */}
          <div
            className={cn(
              'scrollbar-elevated min-h-0 flex-1 border-t border-border',
              step === 2 ? (preview ? 'overflow-y-auto sm:overflow-hidden' : 'overflow-hidden') : 'overflow-y-auto',
            )}
          >
            {step === 0 && (
              <div className="px-8 py-6" style={{ animation: 'stat-in .25s ease' }}>
                <div className="mb-[9px] text-label uppercase tracking-[1.5px] text-muted-foreground">
                  {createdKey ? 'Your API key' : 'Key name'}
                </div>
                <div className="flex items-center gap-[10px] quickstart-code-surface px-[14px] py-3 focus-within:border-brand">
                  <KeyRound className={cn('size-4 flex-none', createdKey ? 'text-brand' : 'text-muted-foreground')} />
                  {createdKey ? (
                    <span className="flex-1 break-all text-meta leading-relaxed text-foreground">
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
                      className="min-w-0 flex-1 bg-transparent text-body tracking-[0.5px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  )}
                  {createdKey ? (
                    <QuickstartCopyButton
                      copied={copiedTarget === 'api-key'}
                      onClick={() => void copyText(createdKey.value, 'api-key')}
                    />
                  ) : null}
                </div>
                {!createdKey && (
                  <div className="mt-[9px] text-meta leading-relaxed text-muted-foreground">
                    Leave blank to use <span className="text-foreground">{DEFAULT_QUICKSTART_API_KEY_NAME}</span>.
                  </div>
                )}
                {createdKey && (
                  <div className="mt-[11px] flex items-start gap-2 text-meta leading-relaxed text-muted-foreground">
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
                      className="text-label text-muted-foreground hover:text-foreground"
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
              <div className="px-8 py-6" style={{ animation: 'stat-in .25s ease' }}>
                <div className="mb-[9px] text-label uppercase tracking-[1.5px] text-muted-foreground">
                  {activeExample.setupLabel ?? 'Run in your local terminal'}
                </div>
                <div className="flex items-start gap-3 quickstart-code-surface px-[14px] py-3">
                  <span className="flex-none pt-[1px] text-success">$</span>
                  <pre className="quickstart-code scrollbar-elevated min-w-0 flex-1 overflow-x-auto whitespace-pre text-foreground">
                    {activeExample.install}
                  </pre>
                  <QuickstartCopyButton
                    copied={copiedTarget === 'install'}
                    onClick={() => void copyText(activeExample.install, 'install')}
                  />
                </div>
                <div className="mt-[11px] flex items-start gap-2 text-meta leading-relaxed text-muted-foreground">
                  <span className="flex-none text-brand">ⓘ</span>
                  <span>
                    {activeExample.setupDescription ?? (
                      <>
                        Run this command in your <span className="text-foreground">local development environment</span>{' '}
                        to install the {activeInterface?.label} library. Continue once the install finishes.
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
              <div
                className={cn('flex min-h-0 flex-col px-8 py-6', preview ? 'h-auto sm:h-full' : 'h-full')}
                style={{ animation: 'stat-in .25s ease' }}
              >
                <div className="mb-[9px] text-label uppercase tracking-[1.5px] text-muted-foreground">
                  {preview
                    ? `Save as ${EXAMPLE_FILES[language]} on your local machine`
                    : 'Run this from your local machine'}
                </div>
                <div className={cn('relative min-h-0', preview ? 'h-[220px] flex-none sm:h-auto sm:flex-1' : 'flex-1')}>
                  <Suspense
                    fallback={
                      <pre className="quickstart-code scrollbar-elevated h-full overflow-auto whitespace-pre rounded-none p-4 pr-24">
                        {renderedExample}
                      </pre>
                    }
                  >
                    <CodeBlock
                      code={renderedExample}
                      language={activeExample.codeLanguage}
                      showCopy={false}
                      className="h-full rounded-none quickstart-code-surface"
                      codeAreaClassName="quickstart-code h-full overflow-auto whitespace-pre pr-24"
                    />
                  </Suspense>
                  <QuickstartCopyButton
                    copied={copiedTarget === 'code'}
                    onClick={() => void copyText(renderedExample, 'code')}
                    className="absolute right-2 top-2.5"
                  />
                </div>
                <div className="mt-[12px] flex items-start gap-2 text-meta leading-relaxed text-muted-foreground">
                  <span className="flex-none text-brand">ⓘ</span>
                  <span>{activeExample.executionDescription}</span>
                </div>
                {preview && (
                  <div className="mt-3 flex items-start gap-3 border border-border px-3 py-2 text-label">
                    <span className="pt-0.5 text-muted-foreground">$</span>
                    <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words">
                      {language === 'cli'
                        ? 'bash quickstart.sh'
                        : activeExample.run.replace('BOXLITE_API_KEY=$KEY ', '').replace('your-api-url', restApiUrl)}
                    </pre>
                  </div>
                )}
                <div className="mt-4 flex items-center justify-end">
                  <PrimaryBtn onClick={() => complete(2)}>
                    {done[2] ? '✓ Done' : preview ? 'Finish walkthrough' : "I've run it"}
                  </PrimaryBtn>
                </div>
              </div>
            )}
          </div>

          {/* footer */}
          <div className="flex shrink-0 items-center justify-between border-t border-border px-8 py-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-meta text-muted-foreground hover:text-foreground"
            >
              Maybe later
            </button>
            {preview && !finished && (
              <button type="button" className="text-meta text-foreground hover:text-brand" onClick={preview.onConsole}>
                Try in console →
              </button>
            )}
            {finished && <PrimaryBtn onClick={() => onOpenChange(false)}>Open Fleet →</PrimaryBtn>}
          </div>

          {/* finale */}
          {finished && !inline && (
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
                <div className="text-label uppercase tracking-[4px] text-success">
                  ✓ {preview ? 'Walkthrough complete' : 'Mission complete'}
                </div>
                <div className="mt-[10px] text-page font-bold tracking-[-1.5px]">
                  {preview ? 'Ready to build.' : 'Box is live.'}
                </div>
                <div className="mt-[10px] text-meta text-muted-foreground">
                  {preview
                    ? 'Continue in your terminal to create your first Box.'
                    : 'You shipped your first Box from code in three steps.'}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlay={<DialogOverlay className="bg-background/70 backdrop-blur-md" />}
        className={cn(
          'flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 font-sans sm:max-w-[720px]',
          activeScenario === 'untrusted-code' && step === 2 && 'h-[92vh]',
        )}
      >
        {content}
      </DialogContent>
    </Dialog>
  )
}
