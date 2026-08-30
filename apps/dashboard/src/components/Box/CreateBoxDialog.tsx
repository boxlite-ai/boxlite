/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiChip, BRAND, PanelNote } from '@/components/ascii'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateBoxMutation } from '@/hooks/mutations/useCreateBoxMutation'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxRouteId } from '@/lib/box-identity'
import { boxHourlyPrice, formatPriceCents, type BoxSpec } from '@/lib/box-price'
import { handleApiError } from '@/lib/error-handling'
import { formatLifecycleSeconds, validateLifecyclePolicy, validateMounts, type BoxVolumeMount } from '@/lib/cloudBox'
import { useUsagePricesQuery } from '@/hooks/queries/useUsagePricesQuery'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { VolumeState } from '@boxlite-ai/api-client'
import { cn } from '@/lib/utils'
import type { Box } from '@boxlite-ai/api-client'
import { ChevronDown, Plus } from '@/components/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const SUPPORTED_BOX_IMAGES = [
  { id: 'base', name: 'Base', ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0', isDefault: true },
  { id: 'python', name: 'Python', ref: 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0', isDefault: false },
  { id: 'node', name: 'Node.js', ref: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0', isDefault: false },
] as const

const DEFAULTS = {
  cpu: 1,
  memory: 1,
  disk: 10,
  autoStopIntervalSeconds: 900,
}

const SUPPORT_EMAIL = 'support@boxlite.ai'

type OrgPerBoxLimits = {
  maxCpuPerBox?: number | null
  maxMemoryPerBox?: number | null
  maxDiskPerBox?: number | null
}

// The organization carries per-box ceilings (maxCpuPerBox / maxMemoryPerBox /
// maxDiskPerBox) and the backend rejects a create that exceeds them. A value
// <= 0 means "unset / unlimited" there, so the dashboard leaves the stepper
// uncapped instead of inventing a local ceiling.
export function resolvePerBoxLimits(org: OrgPerBoxLimits | null | undefined) {
  const pick = (value: number | null | undefined) => (typeof value === 'number' && value > 0 ? value : undefined)
  return {
    cpu: pick(org?.maxCpuPerBox),
    memory: pick(org?.maxMemoryPerBox),
    disk: pick(org?.maxDiskPerBox),
  }
}

// Stepper: − / editable value / + . Enforces the ceiling at both edges — the
// input is pinned at max the moment the typed value would overshoot (so the box
// never visually holds an over-limit value), and blur/Enter normalizes an empty
// or shortened entry (parseInt("") → NaN → min).
function Stepper({
  value,
  onChange,
  min = 1,
  max,
  onExceed,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  onExceed?: () => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText(String(value))
  }, [value])
  const clamp = (n: number) => {
    const v = Math.max(min, n)
    return max != null ? Math.min(max, v) : v
  }
  // Handle a keystroke or paste: clamp the raw text to max so the input can
  // never display an out-of-range value (defeats the earlier bug where blur
  // wouldn't re-sync `text` when the clamped result equalled the previous
  // parent value, leaving a stale typed number in the box).
  const handleTyped = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '')
    if (digits === '') {
      setText('')
      return
    }
    const n = parseInt(digits, 10)
    if (max != null && n > max) {
      onExceed?.()
      setText(String(max))
      return
    }
    setText(digits)
  }
  // On blur / Enter, normalize the text and forward the value to the parent.
  // Text sync is unconditional so `text` stays consistent even when the parent
  // value doesn't change (e.g., already at max).
  const commit = (raw: string) => {
    const n = parseInt(raw, 10)
    const next = Number.isFinite(n) ? clamp(n) : min
    onChange(next)
    setText(String(next))
  }
  const btn =
    'flex size-11 flex-none items-center justify-center font-mono text-[15px] text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:size-9'
  return (
    <div className="flex items-stretch border border-border bg-card">
      <button
        type="button"
        aria-label="decrease"
        onClick={() => onChange(clamp(value - 1))}
        disabled={value <= min}
        className={cn(btn, 'border-r border-border')}
      >
        −
      </button>
      <input
        value={text}
        inputMode="numeric"
        aria-label="value"
        onChange={(e) => handleTyped(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="min-w-0 flex-1 bg-transparent py-[9px] text-center font-mono text-[13px] text-foreground outline-none"
      />
      <button
        type="button"
        aria-label="increase"
        onClick={() => onChange(clamp(value + 1))}
        disabled={max != null && value >= max}
        className={cn(btn, 'border-l border-border')}
      >
        +
      </button>
    </div>
  )
}

// One resource control: label + stepper. The over-limit note is rendered once,
// full-width below the grid (see CappedResourcesNote) rather than cramped under
// each narrow column.
function ResourceField({
  label,
  unit,
  value,
  onChange,
  max,
  onExceed,
}: {
  label: string
  unit: string
  value: number
  onChange: (v: number) => void
  max?: number
  onExceed?: () => void
}) {
  return (
    <div className="flex flex-col gap-[9px]">
      <div className="font-mono text-[10px] uppercase tracking-[1px]">
        {label} <span className="text-muted-foreground">({unit})</span>
      </div>
      <Stepper value={value} onChange={onChange} max={max} onExceed={onExceed} />
    </div>
  )
}

// A single amber "we adjusted your input to the org limit" note, shown full-width
// below the resource grid when one or more fields were capped. It is informational
// (the value was corrected to a valid maximum), not an error — hence the warning
// color and the still-enabled Create button.
function CappedResourcesNote({ items }: { items: { label: string; unit: string; max: number }[] }) {
  if (items.length === 0) return null
  return (
    <div className="border-l-2 border-warning/60 bg-warning-background/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-warning-foreground">
      Adjusted to your organization&apos;s max: {items.map((r) => `${r.label} ${r.max} ${r.unit}`).join(' · ')}. Need
      more?{' '}
      <a
        href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Increase box resource limits')}`}
        className="underline underline-offset-2"
      >
        {SUPPORT_EMAIL}
      </a>
    </div>
  )
}

// ── Price ───────────────────────────────────────────────────────────────────
// Quoted from Commerce's published rates so the number tracks the size chosen
// above. Three absences are kept distinct, because collapsing them is how a
// dialog ends up claiming a box is free when it is not:
//
//   no billing service  — nothing is charged, and saying "free" is the truth
//   rates still loading — we do not know the price yet
//   rates unavailable   — we do not know the price, and usage is metered anyway
//
// Only the first may render as $0.00. Commerce settles the real charge, so this
// is labelled an estimate rather than a price.
function BoxPriceRow({ cpu, memory, disk }: BoxSpec) {
  const config = useConfig()
  const pricesQuery = useUsagePricesQuery()
  const quote = boxHourlyPrice(pricesQuery.data, { cpu, memory, disk })
  const [breakdownOpen, setBreakdownOpen] = useState(false)

  const ROW = 'flex shrink-0 flex-col gap-1 border-t border-border px-4 py-4 sm:px-6'
  const LABEL = 'font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground'
  const FIGURE = 'font-mono text-[20px] font-bold tracking-[-0.5px] sm:text-[24px]'

  if (!config.billingApiUrl) {
    return (
      <div className={cn(ROW, 'sm:flex-row sm:items-baseline sm:justify-between')}>
        <span className={LABEL}>Price per hour</span>
        <span className={FIGURE}>
          $0.00 <span className="text-[11px] font-normal text-muted-foreground">/ hr · free in preview</span>
        </span>
      </div>
    )
  }

  if (!quote) {
    const loading = pricesQuery.isLoading
    return (
      <div className={ROW}>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <span className={LABEL}>Est. price per hour</span>
          <span className={cn(FIGURE, 'text-muted-foreground')}>{loading ? '—' : 'Unavailable'}</span>
        </div>
        <PanelNote>
          {loading
            ? 'Fetching current rates.'
            : 'Current rates could not be loaded. Usage is still metered — this box is not free.'}
        </PanelNote>
      </div>
    )
  }

  // The total is the decision; how it splits across CPU/memory/disk is the
  // audit. Collapsed by default so the row stays one line, on the same `▸`
  // affordance the sibling Size / Lifecycle / Volumes labels already use.
  return (
    <div className={ROW}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <button
          type="button"
          aria-expanded={breakdownOpen}
          aria-controls="box-price-breakdown"
          onClick={() => setBreakdownOpen((wasOpen) => !wasOpen)}
          className={cn(LABEL, 'self-start transition-colors hover:text-foreground')}
        >
          <span style={{ color: BRAND }}>{breakdownOpen ? '▾' : '▸'}</span> Est. price per hour
        </button>
        <span className={FIGURE}>
          {formatPriceCents(quote.totalCents)}
          <span className="text-[11px] font-normal text-muted-foreground"> / hr</span>
        </span>
      </div>
      {breakdownOpen && (
        <div id="box-price-breakdown" className="mt-1 flex flex-col gap-0.5">
          {quote.lines.map((line) => (
            <div key={line.code} className="flex items-baseline justify-between gap-3 font-mono text-[11px]">
              <span className="text-muted-foreground">
                {line.label} · {line.quantity} {line.quantityUnit} × {formatPriceCents(line.unitPriceCents, 6)}/
                {line.quantityUnit}·hr
              </span>
              <span className="tabular-nums text-foreground">{formatPriceCents(line.subtotalCents, 6)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Size ────────────────────────────────────────────────────────────────────
// Previously buried in a collapsed "Advanced Options" section whose only
// content was ever these three numbers — cost and headroom are as
// consequential as which image to boot, not a detail to tuck away. Presets
// mirror the Lifecycle pattern (chips + a `Custom` escape hatch) so the two
// sections teach one interaction, not two.
const SIZE_PRESETS = [
  { id: 'small', label: 'Small', cpu: 1, memory: 1, disk: 10 },
  { id: 'medium', label: 'Medium', cpu: 2, memory: 4, disk: 20 },
  { id: 'large', label: 'Large', cpu: 4, memory: 8, disk: 50 },
  { id: 'custom', label: 'Custom', cpu: null, memory: null, disk: null },
] as const

type SizePresetId = (typeof SIZE_PRESETS)[number]['id']

// ── Lifecycle ───────────────────────────────────────────────────────────────
// Auto-stop and auto-delete are not two independent settings: the backend
// measures both from the same `lastActivityAt` baseline (auto-stop-check /
// auto-delete-check in box.manager.ts) and `validateLifecyclePolicy` rejects a
// policy whose auto-delete is not strictly later than its auto-stop.
//
// So the UI models the delete as a *delay after the stop* and derives the
// absolute value the API wants. That makes the constraint impossible to
// violate by construction — the dialog never has to disable submission on a
// cross-field error.
//
// This used to be four named preset chips ("Stop & delete" / "Stop & keep" /
// "Always on" / "Custom") plus a hidden "Custom" panel with the real controls.
// User feedback after two rounds: still confusing — the chips bundle two
// independent questions (how long idle before stopping, whether to eventually
// delete) into combo names you have to learn, and the real controls stay
// invisible until you think to open "Custom". Two direct selects, always
// visible, remove both problems: nothing to learn, nothing hidden. `0` is a
// legitimate value here (not the "old field goes to 0 on empty input" bug
// this replaced) because a dropdown can't be typed into — the failure mode
// that made 0 dangerous in a free-text field doesn't exist for a fixed list.
const STOP_OPTIONS = [
  { seconds: 0, label: 'Never' },
  { seconds: 300, label: '5 min' },
  { seconds: 900, label: '15 min' },
  { seconds: 1800, label: '30 min' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 14400, label: '4 hours' },
] as const

// No "immediately" (0) option: with a stop threshold set, `validateLifecyclePolicy`
// requires auto_delete strictly greater than auto_stop, so a 0 delay would
// equal the stop threshold and be rejected — a delay has to be positive to
// mean anything. `0` here means "never delete" instead (see `autoDelete` below).
const DELETE_DELAY_OPTIONS = [
  { seconds: 0, label: 'Never' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 86400, label: '1 day' },
  { seconds: 604800, label: '7 days' },
  { seconds: 2592000, label: '30 days' },
] as const

// The units a "Custom…" entry can be typed in. Deliberately small (not a
// second `LIFECYCLE_PRESETS`-style system) — this exists only so a value the
// fixed list doesn't cover has somewhere to go, scoped to the one field it
// was opened from.
const DURATION_UNITS = [
  { id: 'm', label: 'min', seconds: 60 },
  { id: 'h', label: 'hours', seconds: 3600 },
  { id: 'd', label: 'days', seconds: 86400 },
] as const

type DurationUnitId = (typeof DURATION_UNITS)[number]['id']

function durationUnitSeconds(unit: DurationUnitId): number {
  return DURATION_UNITS.find((u) => u.id === unit)?.seconds ?? 60
}

function splitDuration(seconds: number): { amount: number; unit: DurationUnitId } {
  for (const unit of [...DURATION_UNITS].reverse()) {
    if (seconds > 0 && seconds % unit.seconds === 0) {
      return { amount: seconds / unit.seconds, unit: unit.id }
    }
  }
  return { amount: Math.max(1, Math.round(seconds / 60)), unit: 'm' }
}

// One row: label on the left, a dropdown of fixed choices plus "Custom…" on
// the right. Picking "Custom…" swaps the dropdown for a small amount+unit
// entry, scoped to this one field — not a second bundled-preset system, just
// an escape hatch for a value the fixed list doesn't happen to cover.
// `ariaLabel` stays constant across both the dropdown and the custom input,
// and even as the visible `label` changes (Delete reads "…after stopping" vs
// "…when idle" depending on Stop) — anything targeting the control needs one
// stable handle regardless of which mode it's in.
function SelectField({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: string
  ariaLabel: string
  value: number
  options: readonly { seconds: number; label: string }[]
  onChange: (seconds: number) => void
}) {
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const [customUnit, setCustomUnit] = useState<DurationUnitId>('m')
  const current = options.find((o) => o.seconds === value)

  const openCustom = () => {
    const split = splitDuration(value || 60)
    setCustomText(String(split.amount))
    setCustomUnit(split.unit)
    setCustomOpen(true)
  }

  const commitCustom = (rawText: string, unit: DurationUnitId) => {
    const parsed = parseInt(rawText.replace(/[^0-9]/g, ''), 10)
    const amount = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    onChange(amount * durationUnitSeconds(unit))
    setCustomOpen(false)
  }

  if (customOpen) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[1px]">{label}</span>
        <div className="flex items-stretch">
          <input
            autoFocus
            value={customText}
            inputMode="numeric"
            aria-label={ariaLabel}
            onChange={(e) => setCustomText(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={(e) => commitCustom(e.target.value, customUnit)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="w-[56px] border border-border bg-card px-[10px] py-[7px] text-center font-mono text-[12.5px] text-foreground outline-none focus:border-brand"
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${ariaLabel} unit`}
              className="flex min-w-[64px] items-center justify-between gap-1 border border-l-0 border-border bg-card px-[9px] py-[7px] font-mono text-[12px] text-muted-foreground outline-none data-[state=open]:border-brand"
            >
              <span>{DURATION_UNITS.find((u) => u.id === customUnit)?.label}</span>
              <ChevronDown className="size-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="font-mono text-[12px]">
              {DURATION_UNITS.map((u) => (
                <DropdownMenuItem
                  key={u.id}
                  className={cn('cursor-pointer', u.id === customUnit && 'text-brand')}
                  onClick={() => {
                    setCustomUnit(u.id)
                    commitCustom(customText, u.id)
                  }}
                >
                  {u.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[1px]">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={ariaLabel}
          className="flex min-w-[104px] items-center justify-between gap-2 border border-border bg-card px-[11px] py-[7px] font-mono text-[12.5px] text-foreground outline-none data-[state=open]:border-brand"
        >
          <span>{current?.label ?? formatLifecycleSeconds(value)}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="font-mono text-[12px]">
          {options.map((o) => (
            <DropdownMenuItem
              key={o.seconds}
              className={cn('cursor-pointer', o.seconds === value && 'text-brand')}
              onClick={() => onChange(o.seconds)}
            >
              {o.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem className="cursor-pointer text-muted-foreground" onClick={openCustom}>
            Custom…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// One volume attached at one path. Only `ready` volumes can be picked: the API
// rejects anything else ("not in a ready state"), and a volume is briefly
// `creating` after it is made, so an unfiltered picker would offer a choice
// that fails on submit.
function MountRow({
  mount,
  volumes,
  onChange,
  onRemove,
}: {
  mount: BoxVolumeMount
  volumes: { id: string; name: string; state: string }[]
  onChange: (next: BoxVolumeMount) => void
  onRemove: () => void
}) {
  const selected = volumes.find((v) => v.name === mount.volumeId || v.id === mount.volumeId)
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-stretch gap-[7px]">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Volume"
            className="flex min-w-0 flex-1 items-center justify-between gap-2 border border-border bg-card px-[11px] py-[8px] font-mono text-[12.5px] outline-none data-[state=open]:border-brand"
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected?.name ?? 'Select a volume'}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="font-mono text-[12px]">
            {volumes.length === 0 && <DropdownMenuItem disabled>No volumes yet</DropdownMenuItem>}
            {volumes.map((v) => {
              const ready = v.state === VolumeState.READY
              return (
                <DropdownMenuItem
                  key={v.id}
                  disabled={!ready}
                  className={cn('cursor-pointer', v.id === mount.volumeId && 'text-brand')}
                  // Submit the id, never the name. The API accepts either for
                  // validation, but it persists whatever it is given verbatim
                  // (box.service.ts resolveVolumes), while the delete guard
                  // matches `box.volumes @> [{volumeId: <uuid>}]`. A name stored
                  // here is invisible to that guard, so the volume could be
                  // deleted out from under this box with no 409.
                  onClick={() => ready && onChange({ ...mount, volumeId: v.id })}
                >
                  {v.name}
                  {!ready && <span className="ml-2 text-muted-foreground">({v.state})</span>}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="self-center font-mono text-[12px] text-muted-foreground">→</span>

        <input
          value={mount.mountPath}
          onChange={(e) => onChange({ ...mount, mountPath: e.target.value })}
          placeholder="/data"
          aria-label="Mount path"
          className="min-w-0 flex-1 border border-border bg-card px-[11px] py-[8px] font-mono text-[12.5px] text-foreground outline-none focus:border-brand"
        />

        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove mount"
          className="shrink-0 border border-border px-[10px] font-mono text-[12px] text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

export const CreateBoxDialog = ({
  className,
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  onCreated,
  prefillVolume,
}: {
  className?: string
  triggerClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCreated?: (box: Box) => void
  /** Volume name to pre-mount, set when arriving from the Volumes page. */
  prefillVolume?: string
}) => {
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const wasOpenRef = useRef(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const { selectedOrganization } = useSelectedOrganization()
  const createBoxMutation = useCreateBoxMutation()
  const { data: availableVolumes = [] } = useVolumesQuery()
  const defaultImage = SUPPORTED_BOX_IMAGES.find((i) => i.isDefault) ?? SUPPORTED_BOX_IMAGES[0]

  // Per-box ceilings for the current org (backend rejects a create above these).
  const limits = resolvePerBoxLimits(selectedOrganization)

  // A DEFAULT value can exceed a stricter per-org cap (e.g. DEFAULTS.disk=10
  // vs an org's maxDiskPerBox=3), which would otherwise send an over-limit
  // create the moment the dialog opens. Clamp only when the org provides a cap.
  const initialCpu = limits.cpu == null ? DEFAULTS.cpu : Math.min(DEFAULTS.cpu, limits.cpu)
  const initialMemory = limits.memory == null ? DEFAULTS.memory : Math.min(DEFAULTS.memory, limits.memory)
  const initialDisk = limits.disk == null ? DEFAULTS.disk : Math.min(DEFAULTS.disk, limits.disk)

  const [name, setName] = useState('')
  const [imageRef, setImageRef] = useState<string>(defaultImage.ref)
  const [cpu, setCpu] = useState(initialCpu)
  const [memory, setMemory] = useState(initialMemory)
  const [disk, setDisk] = useState(initialDisk)
  // 0 means "never" for both — a legitimate value, not the accidental-empty-input
  // bug the old free-text field had, because a dropdown has no empty state.
  const [stopSeconds, setStopSeconds] = useState(DEFAULTS.autoStopIntervalSeconds)
  const [deleteDelaySeconds, setDeleteDelaySeconds] = useState(0)
  const [autoResume, setAutoResumeEnabled] = useState(true)
  const [mounts, setMounts] = useState<BoxVolumeMount[]>([])
  const [sizePreset, setSizePreset] = useState<SizePresetId>('small')
  const [submitting, setSubmitting] = useState(false)
  const [capped, setCapped] = useState({ cpu: false, memory: false, disk: false })

  // Clear a field's "hit the cap" hint once its value is back under the max.
  const changeResource = (key: 'cpu' | 'memory' | 'disk', set: (v: number) => void) => (v: number) => {
    set(v)
    const limit = limits[key]
    if (limit != null && v < limit) setCapped((c) => (c[key] ? { ...c, [key]: false } : c))
  }

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = open
    if (!open || wasOpen) return

    setName('')
    setImageRef(defaultImage.ref)
    setCpu(initialCpu)
    setMemory(initialMemory)
    setDisk(initialDisk)
    setStopSeconds(DEFAULTS.autoStopIntervalSeconds)
    setDeleteDelaySeconds(0)
    setAutoResumeEnabled(true)
    // A volume passed in from the Volumes page arrives as navigation state, so
    // "Create a box with this volume" lands on a form already holding it.
    setMounts(prefillVolume ? [{ volumeId: prefillVolume, mountPath: '/data' }] : [])
    setSizePreset('small')
    setSubmitting(false)
    setCapped({ cpu: false, memory: false, disk: false })
  }, [open, defaultImage.ref, initialCpu, initialMemory, initialDisk, prefillVolume])

  useEffect(() => {
    if (!open) return

    const nextCpu = limits.cpu == null ? cpu : Math.min(cpu, limits.cpu)
    const nextMemory = limits.memory == null ? memory : Math.min(memory, limits.memory)
    const nextDisk = limits.disk == null ? disk : Math.min(disk, limits.disk)

    if (nextCpu !== cpu) setCpu(nextCpu)
    if (nextMemory !== memory) setMemory(nextMemory)
    if (nextDisk !== disk) setDisk(nextDisk)

    setCapped((current) => ({
      cpu: limits.cpu != null && (nextCpu !== cpu || (current.cpu && nextCpu >= limits.cpu)),
      memory: limits.memory != null && (nextMemory !== memory || (current.memory && nextMemory >= limits.memory)),
      disk: limits.disk != null && (nextDisk !== disk || (current.disk && nextDisk >= limits.disk)),
    }))
  }, [open, cpu, memory, disk, limits.cpu, limits.memory, limits.disk])

  const selectedImage = SUPPORTED_BOX_IMAGES.find((i) => i.ref === imageRef) ?? defaultImage
  const nameValid = !name || NAME_REGEX.test(name)

  // The two values the API takes, derived from the policy the user edits. The
  // delete is a delay *after* the stop, so it is always strictly later than the
  // stop threshold and `validateLifecyclePolicy` can never fail on their
  // relationship — it stays only as a backstop.
  const autoStopIntervalSeconds = stopSeconds
  const autoDelete = deleteDelaySeconds > 0 ? stopSeconds + deleteDelaySeconds : 0
  const lifecycleError = validateLifecyclePolicy({ autoStopIntervalSeconds, autoDelete })
  const mountError = validateMounts(mounts)

  // Unlike Lifecycle's direct selects, a Size preset can collide with an org ceiling
  // (e.g. "Large" wants 4 vCPU but the org caps at 2) — so this clamps and
  // flags `capped` immediately, rather than relying on the effect below to
  // catch up silently. A pick the user just made deserves an explanation for
  // why the number on screen doesn't match the tier they clicked.
  const applySizePreset = (id: SizePresetId) => {
    setSizePreset(id)
    const spec = SIZE_PRESETS.find((p) => p.id === id)
    if (!spec || spec.cpu == null || spec.memory == null || spec.disk == null) return // `custom` only reveals the controls
    const nextCpu = limits.cpu != null && spec.cpu > limits.cpu ? limits.cpu : spec.cpu
    const nextMemory = limits.memory != null && spec.memory > limits.memory ? limits.memory : spec.memory
    const nextDisk = limits.disk != null && spec.disk > limits.disk ? limits.disk : spec.disk
    setCpu(nextCpu)
    setMemory(nextMemory)
    setDisk(nextDisk)
    setCapped({ cpu: nextCpu !== spec.cpu, memory: nextMemory !== spec.memory, disk: nextDisk !== spec.disk })
  }

  const handleCreate = async () => {
    if (!selectedOrganization?.id) {
      toast.error('Select an organization to create a box.')
      return
    }
    if (!nameValid) {
      toast.error('Only letters, digits, dots, underscores and dashes are allowed in the name.')
      return
    }
    if (lifecycleError) {
      toast.error(lifecycleError)
      return
    }
    if (mountError) {
      toast.error(mountError)
      return
    }
    setSubmitting(true)
    try {
      const box = await createBoxMutation.mutateAsync({
        name: name.trim() || undefined,
        image: imageRef || defaultImage.ref,
        network: { mode: 'enabled' },
        resources: { cpu, memory, disk },
        autoStopIntervalSeconds,
        autoDelete,
        autoResume,
        volumes: mounts.length ? mounts : undefined,
      })
      onCreated?.(box)
      toast.success('Box created')
      setOpen(false)
      const boxId = getBoxRouteId(box)
      if (boxId) {
        navigate(generatePath(RoutePath.BOX_DETAILS, { boxId }))
      }
    } catch (error) {
      handleApiError(error, 'Failed to create box')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          title="New Box"
          className={cn(
            'inline-flex h-9 items-center gap-[7px] bg-primary px-[15px] text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85',
            triggerClassName,
          )}
        >
          <Plus className="size-3.5" strokeWidth={2.4} />
          New Box
        </button>
      </DialogTrigger>

      <DialogContent
        className={cn(
          'flex max-h-[92svh] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[88vh] sm:max-w-[540px]',
          className,
        )}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
          <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">Create a box for your agent</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          {/* name + image — two short single-line controls; a full-width row
              each was pure vertical waste. */}
          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-[1fr_150px]">
            <div className="flex flex-col gap-[9px]">
              <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-new-box"
                aria-invalid={!nameValid}
                aria-describedby="create-box-name-hint"
                className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
              />
              {/* Submitting an empty name is a real, supported path — the API then assigns
                  an adjective-animal name of its own. Say so here, or the placeholder reads
                  as a promise that the box will be called something like "my-new-box". */}
              <div id="create-box-name-hint" className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                Optional — auto-named like <span className="text-foreground">cozy-otter</span>.
              </div>
            </div>

            <div className="flex flex-col gap-[9px]">
              <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Image</div>
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center justify-between border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none data-[state=open]:border-brand">
                  <span>{selectedImage.name}</span>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="min-w-[var(--radix-dropdown-menu-trigger-width)] font-mono text-[12px]"
                >
                  {SUPPORTED_BOX_IMAGES.map((img) => (
                    <DropdownMenuItem
                      key={img.id}
                      className={cn('cursor-pointer', img.ref === imageRef && 'text-brand')}
                      onClick={() => setImageRef(img.ref)}
                    >
                      {img.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* size — pulled out of a collapsed "Advanced Options" whose only
              content was ever these three numbers. What a box can do and what
              it costs is not an advanced concern; it gets the same visibility
              as Lifecycle and Volumes below. */}
          <div className="flex flex-col gap-[13px] border-t border-border pt-5">
            {/* Matches the sibling `▸ Lifecycle` / `▸ Volumes` treatment rather
                than `ascii.SectionTitle`: inside this dialog the established
                label scale is 10px/1.2px (Name, Image), and SectionTitle's
                11px/1.5px heading would read as a different tier from its own
                siblings. */}
            <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> Size
            </div>

            <div role="group" aria-label="Size" className="grid grid-cols-2 gap-[6px] sm:grid-cols-4">
              {SIZE_PRESETS.map((p) => (
                <AsciiChip
                  key={p.id}
                  selected={sizePreset === p.id}
                  aria-pressed={sizePreset === p.id}
                  onClick={() => applySizePreset(p.id)}
                  className="px-2 py-[7px] text-[12px]"
                >
                  {p.label}
                </AsciiChip>
              ))}
            </div>

            {/* Hidden once Custom is open: the steppers below already show
                these same three numbers as editable fields, so keeping this
                line too was pure duplication — it only earns its place when
                there's no other visible readout of the current size. */}
            {sizePreset !== 'custom' && (
              <div className="font-mono text-[11px] text-muted-foreground">
                · {cpu} vCPU · {memory} GiB · {disk} GiB
              </div>
            )}

            {/* Shown regardless of whether Custom is expanded: a preset that
                got silently clamped (e.g. "Large" against a 2-vCPU org cap)
                needs to say so the moment it happens, not only once the user
                thinks to open Custom to investigate. */}
            <CappedResourcesNote
              items={[
                capped.cpu && limits.cpu != null && { label: 'CPU', unit: 'vCPU', max: limits.cpu },
                capped.memory && limits.memory != null && { label: 'Memory', unit: 'GiB', max: limits.memory },
                capped.disk && limits.disk != null && { label: 'Disk', unit: 'GiB', max: limits.disk },
              ].filter((r): r is { label: string; unit: string; max: number } => Boolean(r))}
            />

            {sizePreset === 'custom' && (
              <div className="grid grid-cols-1 gap-[14px] border-t border-dashed border-border pt-[13px] sm:grid-cols-3">
                <ResourceField
                  label="CPU"
                  unit="vCPU"
                  value={cpu}
                  onChange={changeResource('cpu', setCpu)}
                  max={limits.cpu}
                  onExceed={() => setCapped((c) => ({ ...c, cpu: true }))}
                />
                <ResourceField
                  label="Memory"
                  unit="GiB"
                  value={memory}
                  onChange={changeResource('memory', setMemory)}
                  max={limits.memory}
                  onExceed={() => setCapped((c) => ({ ...c, memory: true }))}
                />
                <ResourceField
                  label="Disk"
                  unit="GiB"
                  value={disk}
                  onChange={changeResource('disk', setDisk)}
                  max={limits.disk}
                  onExceed={() => setCapped((c) => ({ ...c, disk: true }))}
                />
              </div>
            )}
          </div>

          {/* volumes — the only moment a box and a volume can be connected:
              there is no attach/detach endpoint, so a running box can never
              gain or lose one. That fact used to be spelled out in a note
              below the list, but Size is equally locked at create time (no
              resize endpoint either) and gets no such disclaimer — singling
              Volumes out implied a false asymmetry. Dropped; "+ Mount a
              volume" moved into the header row instead, saving the row it
              cost. */}
          <div className="flex flex-col gap-[11px] border-t border-border pt-5">
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">
                <span style={{ color: BRAND }}>▸</span> Volumes
              </div>
              <button
                type="button"
                onClick={() => setMounts((prev) => [...prev, { volumeId: '', mountPath: '/data' }])}
                className="border border-border px-[10px] py-[4px] font-mono text-[11px] transition-colors hover:border-brand"
              >
                + Mount a volume
              </button>
            </div>

            {/* Disk above is scratch space that dies with the box; a volume is
                the opposite of that, which is the one fact worth stating here. */}
            <PanelNote>
              A volume persists independently of this box and can be mounted into another box later.
            </PanelNote>

            {mounts.length > 0 && (
              <div className="flex flex-col gap-[9px]">
                {mounts.map((mount, index) => (
                  <MountRow
                    key={index}
                    mount={mount}
                    volumes={availableVolumes}
                    onChange={(next) => setMounts((prev) => prev.map((m, i) => (i === index ? next : m)))}
                    onRemove={() => setMounts((prev) => prev.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            )}
          </div>

          {/* lifecycle — decides when the box disappears (and whether its disk
              goes with it); placed last so it sits directly above the price it
              changes. Three flat rows, always visible: no presets to learn,
              no "Custom" panel hiding the real controls. */}
          <div className="flex flex-col gap-[13px] border-t border-border pt-5">
            <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">
              <span style={{ color: BRAND }}>▸</span> Lifecycle
            </div>

            <div className="flex flex-col gap-[9px]">
              <SelectField
                label="Stop when idle"
                ariaLabel="Stop when idle"
                value={stopSeconds}
                options={STOP_OPTIONS}
                onChange={setStopSeconds}
              />
              {/* The single most surprising part of the feature: only the
                  three request paths that refresh `lastActivityAt` count as
                  activity (the REST proxy, the WS attach and the preview
                  proxy's last-activity ping). Nothing running *inside* the box
                  touches it, so a long job is not self-protecting. */}
              {stopSeconds > 0 && (
                <PanelNote>
                  Idle means no SDK, terminal or preview traffic. Work running inside the box does not count — a long
                  job can be stopped mid-run.
                </PanelNote>
              )}

              {/* Not indented under Stop: a manually-stopped box still needs
                  waking even with auto-stop off, so this is its own row, not a
                  modifier of one. */}
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[1px]">Wake on access</span>
                <Switch aria-label="Wake on access" checked={autoResume} onCheckedChange={setAutoResumeEnabled} />
              </div>
              {/* Wake is served by the API's own REST/WS proxy
                  (box-auto-resume.service). The preview proxy only pings
                  last-activity, so preview traffic keeps a *running* box alive
                  but cannot bring a stopped one back. */}
              <PanelNote>
                SDK exec, file operations and terminal attach wake a stopped box. Preview URL traffic keeps a running
                box alive but cannot wake a stopped one.
              </PanelNote>

              {/* Expressed relative to the stop it follows, not as its own
                  absolute threshold — see the `autoDelete` derivation above. */}
              <SelectField
                label={stopSeconds > 0 ? 'Delete after stopping' : 'Delete when idle'}
                ariaLabel="Delete after stopping"
                value={deleteDelaySeconds}
                options={DELETE_DELAY_OPTIONS}
                onChange={setDeleteDelaySeconds}
              />
              {/* Same shape as CappedResourcesNote above — left rule, tinted
                  ground, mono 11px — in the destructive tone. */}
              {deleteDelaySeconds > 0 && (
                <p className="border-l-2 border-destructive/60 bg-destructive/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-destructive">
                  Permanent. The box and everything on its disk are gone — this cannot be undone.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* price — quoted from Commerce's published rates for the size above */}
        <BoxPriceRow cpu={cpu} memory={memory} disk={disk} />

        {/* footer — any blocking reason is rendered here, beside the button it
            disables, never inside a collapsible section where it can be hidden */}
        {(lifecycleError || mountError) && (
          <p className="shrink-0 border-t border-border px-4 pt-3 font-mono text-[11px] text-destructive sm:px-6">
            {lifecycleError ?? mountError}
          </p>
        )}
        <div className="grid shrink-0 grid-cols-2 gap-[10px] border-t border-border px-4 py-4 sm:flex sm:justify-end sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="border border-border px-[18px] py-[11px] text-[13px] font-medium transition-colors hover:bg-card focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 sm:py-[10px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={
              submitting || !selectedOrganization?.id || !nameValid || Boolean(lifecycleError) || Boolean(mountError)
            }
            className="bg-primary px-5 py-[11px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-50 sm:py-[10px]"
          >
            {submitting ? 'Creating…' : 'Create Box'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
