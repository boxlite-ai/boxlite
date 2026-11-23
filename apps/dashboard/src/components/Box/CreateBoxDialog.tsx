/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogFooter as DialogFooter,
  FormDialogBody,
} from '@/components/ui/form-dialog'
import { AsciiButton } from '@/components/ascii'
import { BRAND, PanelNote } from '@/components/ascii'
import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { BoxPriceSummary } from './BoxPriceSummary'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateBoxMutation } from '@/hooks/mutations/useCreateBoxMutation'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useOrganizationBoxLimitsQuery } from '@/hooks/queries/useOrganizationBoxLimitsQuery'
import { getBoxRouteId } from '@/lib/box-identity'
import { boxHourlyPrice, formatPriceCents, type BoxSpec } from '@/lib/box-price'
import { handleApiError } from '@/lib/error-handling'
import { formatLifecycleSeconds, validateLifecyclePolicy, validateMounts, type BoxVolumeMount } from '@/lib/cloudBox'
import { useUsagePricesQuery } from '@/hooks/queries/useUsagePricesQuery'
import { useImagesQuery } from '@/hooks/queries/useImagesQuery'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { VolumeState } from '@boxlite-ai/api-client'
import { cn } from '@/lib/utils'
import type { Box } from '@boxlite-ai/api-client'
import { ChevronDown } from '@/components/ui/icon'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const CPU_STOPS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16]

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

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
  fractional = false,
  wholeMiB = false,
  onValidityChange,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  onExceed?: () => void
  wholeMiB?: boolean
  fractional?: boolean
  onValidityChange?: (valid: boolean) => void
}) {
  const [invalid, setInvalid] = useState(false)
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText(String(value))
    setInvalid(false)
    onValidityChange?.(true)
  }, [value, onValidityChange])
  const clamp = (n: number) => {
    const v = Math.max(min, n)
    return max != null ? Math.min(max, v) : v
  }
  // Handle a keystroke or paste: clamp the raw text to max so the input can
  // never display an out-of-range value (defeats the earlier bug where blur
  // wouldn't re-sync `text` when the clamped result equalled the previous
  // parent value, leaving a stale typed number in the box).
  const handleTyped = (raw: string) => {
    if (fractional) {
      const n = Number(raw)
      const valid =
        (wholeMiB ? /^\d+(?:\.\d*)?$/ : /^\d+(?:\.\d{0,3})?$/).test(raw) &&
        Number.isFinite(n) &&
        n >= min &&
        (!wholeMiB || Number.isInteger(n * 1024))
      setInvalid(!valid)
      onValidityChange?.(valid)
      if (!valid) {
        setText(raw)
        return
      }
      if (max != null && n > max) onExceed?.()
      const next = clamp(n)
      setText(next === n ? raw : String(next))
      onChange(next)
      return
    }
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
    if (fractional) {
      handleTyped(raw)
      return
    }
    const n = parseInt(raw, 10)
    const next = Number.isFinite(n) ? clamp(n) : min
    onChange(next)
    setText(String(next))
  }
  const btn =
    'flex size-11 flex-none items-center justify-center font-sans text-em text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:size-9'
  return (
    <div className="flex items-stretch border border-border bg-card">
      <button
        type="button"
        aria-label="decrease"
        onClick={() =>
          onChange(clamp(fractional ? ([...CPU_STOPS].reverse().find((stop) => stop < value) ?? min) : value - 1))
        }
        disabled={value <= min}
        className={cn(btn, 'border-r border-border')}
      >
        −
      </button>
      <input
        value={text}
        inputMode={fractional ? 'decimal' : 'numeric'}
        aria-invalid={invalid}
        title={
          invalid
            ? wholeMiB
              ? 'Enter memory in whole MiB increments, at least 0.125 GiB'
              : 'Enter at least 0.125 CPU with up to three decimal places'
            : undefined
        }
        aria-label="value"
        onChange={(e) => handleTyped(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="min-w-0 flex-1 bg-transparent py-[9px] text-center font-mono text-body text-foreground outline-none"
      />
      <button
        type="button"
        aria-label="increase"
        onClick={() => onChange(clamp(fractional ? (CPU_STOPS.find((stop) => stop > value) ?? value + 1) : value + 1))}
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
  estimate,
  label,
  unit,
  value,
  onChange,
  max,
  onExceed,
  fractional,
  onValidityChange,
}: {
  estimate?: string
  label: string
  unit: string
  value: number
  onChange: (v: number) => void
  max?: number
  onExceed?: () => void
  fractional?: boolean
  onValidityChange?: (valid: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-[9px]">
      <div className="font-sans text-label uppercase tracking-[1px]">
        {label} <span className="normal-case tracking-normal text-muted-foreground">({unit})</span>
      </div>
      <Stepper
        value={value}
        onChange={onChange}
        min={fractional ? 0.125 : 1}
        max={max}
        onExceed={onExceed}
        fractional={fractional}
        wholeMiB={label === 'Memory'}
        onValidityChange={onValidityChange}
      />
      {estimate && <span className="font-mono text-meta text-muted-foreground">{estimate} / hr</span>}
      {max != null && (
        <span className="font-mono text-meta text-muted-foreground">
          Max {max} {unit}
        </span>
      )}
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
    <div className="border-l-2 border-warning/60 bg-warning-background/40 px-3 py-2 font-sans text-meta leading-relaxed text-warning-foreground">
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

// ── Size ────────────────────────────────────────────────────────────────────
// Previously buried in a collapsed "Advanced Options" section whose only
// content was ever these three numbers — cost and headroom are as
// consequential as which image to boot, not a detail to tuck away. Presets
// mirror the Lifecycle pattern (chips + a `Custom` escape hatch) so the two
// sections teach one interaction, not two.
const SIZE_PRESETS = [
  { id: 'matchbox', label: 'Matchbox', cpu: 0.125, memory: 0.25, disk: 10 },
  { id: 'pocket', label: 'Pocket', cpu: 0.25, memory: 0.5, disk: 10 },
  { id: 'lunchbox', label: 'Lunchbox', cpu: 0.5, memory: 1, disk: 10 },
  { id: 'small', label: 'Shoebox', cpu: 1, memory: 1, disk: 10 },
  { id: 'medium', label: 'Crate', cpu: 2, memory: 4, disk: 20 },
  { id: 'large', label: 'Cargo', cpu: 4, memory: 8, disk: 50 },
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
        <span className="font-sans text-meta font-medium">{label}</span>
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
            className="w-[56px] border border-border bg-card px-[10px] py-[7px] text-center font-mono text-meta text-foreground outline-none focus:border-brand"
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${ariaLabel} unit`}
              className="flex min-w-[64px] items-center justify-between gap-1 border border-l-0 border-border bg-card px-[9px] py-[7px] font-mono text-meta text-muted-foreground outline-none data-[state=open]:border-brand"
            >
              <span>{DURATION_UNITS.find((u) => u.id === customUnit)?.label}</span>
              <ChevronDown className="size-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="font-mono text-meta">
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
      <span className="font-sans text-meta font-medium">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={ariaLabel}
          className="flex min-w-[104px] items-center justify-between gap-2 border border-border bg-card px-[11px] py-[7px] font-mono text-meta text-foreground outline-none data-[state=open]:border-brand"
        >
          <span>{current?.label ?? formatLifecycleSeconds(value)}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="font-mono text-meta">
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
            className="flex min-w-0 flex-1 items-center justify-between gap-2 border border-border bg-card px-[11px] py-[8px] font-mono text-meta outline-none data-[state=open]:border-brand"
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {selected?.name ?? 'Select a volume'}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="font-mono text-meta">
            {volumes.length === 0 && <DropdownMenuItem disabled>No volumes yet</DropdownMenuItem>}
            {volumes.map((v) => {
              const ready = v.state === VolumeState.READY
              return (
                <DropdownMenuItem
                  key={v.id}
                  disabled={!ready}
                  className={cn('cursor-pointer', v.id === mount.volumeId && 'text-brand')}
                  // Submit the id. The API takes a name too and resolves
                  // either to the volume's id, but a name is only unique
                  // within one organization and this picker already holds the
                  // id, so there is nothing to gain by sending the weaker one.
                  onClick={() => ready && onChange({ ...mount, volumeId: v.id })}
                >
                  {v.name}
                  {!ready && <span className="ml-2 text-muted-foreground">({v.state})</span>}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="self-center font-mono text-meta text-muted-foreground">→</span>

        <input
          value={mount.mountPath}
          onChange={(e) => onChange({ ...mount, mountPath: e.target.value })}
          placeholder="/data"
          aria-label="Mount path"
          className="min-w-0 flex-1 border border-border bg-card px-[11px] py-[8px] font-mono text-meta text-foreground outline-none focus:border-brand"
        />

        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove mount"
          className="shrink-0 border border-border px-[10px] font-sans text-meta text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/** Collects a Box image, resource size, mounts, and lifecycle policy, validates them, and submits creation for the current organization. */
export const CreateBoxDialog = ({
  className,
  children,
  open: controlledOpen,
  onOpenChange,
  onCreated,
  prefillVolume,
  prefillImage,
}: {
  className?: string
  /**
   * The control that opens the dialog. Omit it where the page already owns one
   * — a table row's action, say — and drive `open` instead; the dialog then
   * mounts without a button of its own.
   */
  children?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCreated?: (box: Box) => void
  /**
   * Volume id to pre-mount at /data. The API takes a name too and resolves
   * either to the canonical id, but a name is only unique within one
   * organization (volume.service.ts validateVolumes), so the id is the
   * selector to hand it — see MountRow above.
   */
  prefillVolume?: string
  /** Image reference to start from, as the Images page hands it over from a row. */
  prefillImage?: string
}) => {
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const wasOpenRef = useRef(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const { selectedOrganization } = useSelectedOrganization()
  const {
    data: confirmedLimits,
    isError: limitsError,
    refetch: refreshLimits,
  } = useOrganizationBoxLimitsQuery(selectedOrganization, { enabled: open, poll: open })
  useEffect(() => {
    if (open && selectedOrganization?.id) void refreshLimits({ cancelRefetch: false })
  }, [open, selectedOrganization?.id, refreshLimits])
  const createBoxMutation = useCreateBoxMutation()
  const { data: availableVolumes = [] } = useVolumesQuery()
  const { data: catalogImages = [] } = useImagesQuery()

  // Only confirmed effective limits constrain input; the server validates unknown limits on creation.
  const resolvedLimits = resolvePerBoxLimits(confirmedLimits)
  const limits = { ...resolvedLimits, cpu: Math.min(resolvedLimits.cpu ?? 16, 16) }
  const config = useConfig()
  const pricesQuery = useUsagePricesQuery()
  const effectiveSpec = (spec: BoxSpec): BoxSpec => ({
    cpu: Math.min(spec.cpu, limits.cpu),
    memory: Math.min(spec.memory, limits.memory ?? spec.memory),
    disk: Math.min(spec.disk, limits.disk ?? spec.disk),
  })

  // A DEFAULT value can exceed a stricter per-org cap (e.g. DEFAULTS.disk=10
  // vs an org's maxDiskPerBox=3), which would otherwise send an over-limit
  // create the moment the dialog opens. Clamp only when the org provides a cap.
  const initialCpu = limits.cpu == null ? DEFAULTS.cpu : Math.min(DEFAULTS.cpu, limits.cpu)
  const initialMemory = limits.memory == null ? DEFAULTS.memory : Math.min(DEFAULTS.memory, limits.memory)
  const initialDisk = limits.disk == null ? DEFAULTS.disk : Math.min(DEFAULTS.disk, limits.disk)

  const [name, setName] = useState('')
  const [imageRef, setImageRef] = useState('')
  const [imageControl, setImageControl] = useState<HTMLDivElement | null>(null)
  const [imageMenuWidth, setImageMenuWidth] = useState(0)
  const [imageRefOverflows, setImageRefOverflows] = useState(false)
  const imageDescriptionId = useId()
  useEffect(() => {
    if (!imageControl) return
    const measure = () => {
      // offsetWidth is unaffected by the dialog's opening scale animation.
      setImageMenuWidth(imageControl.offsetWidth)
      const input = imageControl.querySelector('input')
      setImageRefOverflows(Boolean(imageRef && input && input.scrollWidth > input.clientWidth))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(imageControl)
    return () => observer.disconnect()
  }, [imageControl, imageRef])

  const [cpu, setCpu] = useState(initialCpu)
  const [cpuValid, setCpuValid] = useState(true)
  const [memoryValid, setMemoryValid] = useState(true)
  const resourceDescriptionId = useId()
  const customDraft = useRef<BoxSpec | null>(null)
  useEffect(() => {
    customDraft.current = null
  }, [selectedOrganization?.id])
  const [memory, setMemory] = useState(initialMemory)
  const [disk, setDisk] = useState(initialDisk)
  const selectedQuote = boxHourlyPrice(pricesQuery.data, { cpu, memory, disk })
  const resourceEstimate = (code: string) => {
    if (!config.billingApiUrl) return '$0.00'
    const line = selectedQuote?.lines.find((item) => item.code === code)
    return line ? formatPriceCents(line.subtotalCents, 6) : '—'
  }
  // 0 means "never" for both — a legitimate value, not the accidental-empty-input
  // bug the old free-text field had, because a dropdown has no empty state.
  const [stopSeconds, setStopSeconds] = useState(DEFAULTS.autoStopIntervalSeconds)
  const [deleteDelaySeconds, setDeleteDelaySeconds] = useState(0)
  const [autoResume, setAutoResumeEnabled] = useState(true)
  const [mounts, setMounts] = useState<BoxVolumeMount[]>([])
  const [sizePreset, setSizePreset] = useState<SizePresetId>('small')
  const customResourcesRef = useRef<HTMLDivElement>(null)
  const focusCustomResources = () => {
    customResourcesRef.current?.querySelector('input')?.focus({ preventScroll: true })
    customResourcesRef.current?.scrollIntoView?.({ block: 'nearest' })
  }
  useEffect(() => {
    if (open && sizePreset === 'custom') focusCustomResources()
  }, [open, sizePreset])

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

    customDraft.current = null
    setName('')
    setImageRef(prefillImage ?? '')
    setCpu(initialCpu)
    setMemory(initialMemory)
    setDisk(initialDisk)
    setStopSeconds(DEFAULTS.autoStopIntervalSeconds)
    setDeleteDelaySeconds(0)
    setAutoResumeEnabled(true)
    // The Volumes page mounts this dialog with a volume already chosen, so its
    // "+ Box" row action lands on a form that is holding it.
    setMounts(prefillVolume ? [{ volumeId: prefillVolume, mountPath: '/data' }] : [])
    setSizePreset('small')
    setCpuValid(true)
    setMemoryValid(true)
    setSubmitting(false)
    setCapped({ cpu: false, memory: false, disk: false })
  }, [open, initialCpu, initialMemory, initialDisk, prefillVolume, prefillImage])

  useEffect(() => {
    if (!open || !confirmedLimits) return

    // Preserve preset intent when a higher grant arrives; Custom retains entered values.
    const preset = SIZE_PRESETS.find((p) => p.id === sizePreset)
    const requestedCpu = preset?.cpu ?? cpu
    const requestedMemory = preset?.memory ?? memory
    const requestedDisk = preset?.disk ?? disk
    const nextCpu = limits.cpu == null ? requestedCpu : Math.min(requestedCpu, limits.cpu)
    const nextMemory = limits.memory == null ? requestedMemory : Math.min(requestedMemory, limits.memory)
    const nextDisk = limits.disk == null ? requestedDisk : Math.min(requestedDisk, limits.disk)

    if (nextCpu !== cpu) setCpu(nextCpu)
    if (nextMemory !== memory) setMemory(nextMemory)
    if (nextDisk !== disk) setDisk(nextDisk)

    setCapped((current) => ({
      cpu: limits.cpu != null && (nextCpu !== requestedCpu || (current.cpu && nextCpu >= limits.cpu)),
      memory:
        limits.memory != null && (nextMemory !== requestedMemory || (current.memory && nextMemory >= limits.memory)),
      disk: limits.disk != null && (nextDisk !== requestedDisk || (current.disk && nextDisk >= limits.disk)),
    }))
  }, [open, confirmedLimits, sizePreset, cpu, memory, disk, limits.cpu, limits.memory, limits.disk])

  // What the catalog already holds, as references that can be typed back in.
  // A curated image goes in under its short name — that is what the API
  // accepts and what the docs use. An organization's own image goes in with
  // its alias when exactly one is recorded, because that is the build it last
  // booted; with none or several, the bare name is offered and the user
  // finishes it, since guessing which alias they meant would silently pick one.
  const imageSuggestions = useMemo(
    () =>
      catalogImages.map((image) => ({
        ref: image.curated || image.aliases.length !== 1 ? image.name : `${image.name}:${image.aliases[0]}`,
      })),
    [catalogImages],
  )

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
    if (id === sizePreset) {
      if (id === 'custom') focusCustomResources()
      return
    }
    if (sizePreset === 'custom' && cpuValid && memoryValid) customDraft.current = { cpu, memory, disk }
    if (id === 'custom' && customDraft.current) {
      const restored = effectiveSpec(customDraft.current)
      setCpu(restored.cpu)
      setMemory(restored.memory)
      setDisk(restored.disk)
      setCapped({
        cpu: restored.cpu !== customDraft.current.cpu,
        memory: restored.memory !== customDraft.current.memory,
        disk: restored.disk !== customDraft.current.disk,
      })
    }
    setSizePreset(id)
    setCpuValid(true)
    setMemoryValid(true)
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
    if (!cpuValid || !memoryValid) return
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
        // Left out when blank so the API picks its own default. Sending a
        // reference copied from here instead would pin the console to whichever
        // curated image was current when this shipped.
        image: imageRef.trim() || undefined,
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
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}

      <DialogContent className={cn('sm:max-w-[760px]', className)}>
        <DialogHeader>
          <DialogTitle>New Box</DialogTitle>
          <DialogDescription className="sr-only">Create a Box for your agent.</DialogDescription>
        </DialogHeader>

        <FormDialogBody>
          {/* name + image — two short single-line controls; a full-width row
              each was pure vertical waste. */}
          <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
            <div className="flex flex-col gap-[9px]">
              <div className="form-field-label">Name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-new-box"
                aria-invalid={!nameValid}
                aria-describedby="create-box-name-hint"
                className="form-field-input font-mono"
              />
              {/* Submitting an empty name is a real, supported path — the API then assigns
                  an adjective-animal name of its own. Say so here, or the placeholder reads
                  as a promise that the box will be called something like "my-new-box". */}
              <div id="create-box-name-hint" className="font-sans text-meta leading-relaxed text-muted-foreground">
                Optional — auto-named like <span className="text-foreground">cozy-otter</span>.
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-[9px]">
              <div className="form-field-label">Image</div>
              {/* Free text with the catalog as suggestions, not a closed list:
                  any reference the operator's allowlist admits is valid here,
                  and an image only enters the catalog after something has
                  already booted from it — so a picker of known images could
                  never offer the first one. */}
              <div
                ref={setImageControl}
                className="flex min-w-0 items-stretch border border-border bg-card focus-within:border-brand"
              >
                <input
                  value={imageRef}
                  onChange={(e) => setImageRef(e.target.value)}
                  placeholder="Default image"
                  aria-label="Image reference"
                  aria-describedby={imageRefOverflows ? imageDescriptionId : undefined}
                  className="w-full min-w-0 border-0 bg-transparent px-[13px] py-[11px] font-mono text-body text-foreground outline-none placeholder:text-muted-foreground"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Browse images"
                    className="flex shrink-0 items-center gap-2 border-l border-border px-[11px] text-meta text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    Browse images
                    <ChevronDown className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    style={{ width: imageMenuWidth || undefined }}
                    className="max-h-[min(260px,var(--radix-dropdown-menu-content-available-height))] min-w-0 max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto font-mono text-meta"
                  >
                    {imageSuggestions.length === 0 ? (
                      <DropdownMenuItem disabled>No images yet</DropdownMenuItem>
                    ) : (
                      imageSuggestions.map((suggestion) => (
                        <DropdownMenuItem
                          key={suggestion.ref}
                          className={cn(
                            'min-w-0 cursor-pointer whitespace-normal [overflow-wrap:anywhere]',
                            suggestion.ref === imageRef && 'text-brand',
                          )}
                          onClick={() => setImageRef(suggestion.ref)}
                        >
                          {suggestion.ref}
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {imageRefOverflows && (
                <p
                  id={imageDescriptionId}
                  className="min-w-0 font-mono text-meta text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {imageRef}
                </p>
              )}
              <div className="font-sans text-meta leading-relaxed text-muted-foreground">
                Optional — any reference your operator allows. The first box on a new image waits for it to be pulled.
              </div>
            </div>
          </div>

          {/* size — pulled out of a collapsed "Advanced Options" whose only
              content was ever these three numbers. What a box can do and what
              it costs is not an advanced concern; it gets the same visibility
              as Lifecycle and Volumes below. */}
          <fieldset aria-label="Box resources" className="flex min-w-0 flex-col gap-[13px] border-t border-border pt-5">
            <div role="group" aria-label="Size" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="form-field-label mb-0">Size</div>
                <AsciiButton
                  aria-label="Larger or custom box"
                  aria-pressed={sizePreset === 'custom'}
                  variant="secondary"
                  className={sizePreset === 'custom' ? 'border-foreground bg-secondary' : undefined}
                  aria-expanded={sizePreset === 'custom'}
                  aria-controls={`${resourceDescriptionId}-custom`}
                  size="sm"
                  onClick={() => applySizePreset('custom')}
                >
                  Larger or custom box
                </AsciiButton>
              </div>
              {(limitsError || !confirmedLimits) && (
                <p role="status" className="font-sans text-meta text-muted-foreground">
                  {limitsError
                    ? confirmedLimits
                      ? 'Could not refresh limits. Showing last known limits.'
                      : 'Could not load limits. Limits are checked when you create.'
                    : 'Limits are checked when you create.'}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {SIZE_PRESETS.filter((p) => p.id !== 'custom').map((p, index) => {
                  const spec = effectiveSpec({ cpu: p.cpu, memory: p.memory, disk: p.disk })
                  const adjusted = spec.cpu !== p.cpu || spec.memory !== p.memory || spec.disk !== p.disk
                  const quote = boxHourlyPrice(pricesQuery.data, spec)
                  const selected = sizePreset === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-label={p.label}
                      aria-describedby={`${resourceDescriptionId}-${p.id}`}
                      aria-pressed={selected}
                      onClick={() => applySizePreset(p.id)}
                      className={cn(
                        'group min-w-0 border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        selected
                          ? 'border-foreground bg-secondary'
                          : 'border-border hover:border-muted-foreground hover:bg-accent',
                      )}
                    >
                      <span className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-body font-medium">{p.label}</span>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 32 32"
                          className={cn('size-7 shrink-0', selected ? 'text-foreground' : 'text-muted-foreground')}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                        >
                          <g transform={`translate(16 16) scale(${0.55 + index * 0.085}) translate(-16 -16)`}>
                            <path d="M16 2 29 9.5v13L16 30 3 22.5v-13Z M3 9.5 16 17l13-7.5 M16 17v13 M9.5 5.75l13 7.5" />
                          </g>
                        </svg>
                      </span>
                      <span id={`${resourceDescriptionId}-${p.id}`} className="block">
                        <span className="block font-mono text-em">
                          {spec.cpu} <span className="text-meta text-muted-foreground">vCPU</span>
                        </span>
                        <span className="mt-1 block text-meta text-muted-foreground">
                          {spec.memory} GiB RAM · {spec.disk} GiB disk
                        </span>
                        <span className="mt-2 flex flex-wrap items-baseline justify-between gap-1 border-t border-border pt-2">
                          <span className="font-mono text-body">
                            {!config.billingApiUrl ? '$0.00' : quote ? formatPriceCents(quote.totalCents) : '—'}
                            <span className="font-sans text-meta text-muted-foreground"> / hr</span>
                          </span>
                          {adjusted && <span className="text-meta text-warning-foreground">Adjusted</span>}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Hidden once Custom is open: the steppers below already show
                these same three numbers as editable fields, so keeping this
                line too was pure duplication — it only earns its place when
                there's no other visible readout of the current size. */}
            {sizePreset !== 'custom' && (
              <div className="font-mono text-meta text-muted-foreground">
                Selected: {cpu} vCPU · {memory} GiB RAM · {disk} GiB disk
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
              <div
                ref={customResourcesRef}
                id={`${resourceDescriptionId}-custom`}
                className="grid scroll-mt-4 grid-cols-1 gap-[14px] border-t border-dashed border-border pt-[13px] sm:grid-cols-3"
              >
                <ResourceField
                  fractional
                  onValidityChange={setCpuValid}
                  label="CPU"
                  estimate={cpuValid ? resourceEstimate('cpu') : '—'}
                  unit="vCPU"
                  value={cpu}
                  onChange={changeResource('cpu', setCpu)}
                  max={limits.cpu}
                  onExceed={() => setCapped((c) => ({ ...c, cpu: true }))}
                />
                <ResourceField
                  fractional
                  onValidityChange={setMemoryValid}
                  label="Memory"
                  estimate={memoryValid ? resourceEstimate('mem') : '—'}
                  unit="GiB"
                  value={memory}
                  onChange={changeResource('memory', setMemory)}
                  max={limits.memory}
                  onExceed={() => setCapped((c) => ({ ...c, memory: true }))}
                />
                <ResourceField
                  label="Disk"
                  estimate={resourceEstimate('disk')}
                  unit="GiB"
                  value={disk}
                  onChange={changeResource('disk', setDisk)}
                  max={limits.disk}
                  onExceed={() => setCapped((c) => ({ ...c, disk: true }))}
                />
              </div>
            )}
          </fieldset>

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
              <div className="form-field-label">
                <span style={{ color: BRAND }}>▸</span> Volumes
              </div>
              <button
                type="button"
                onClick={() => setMounts((prev) => [...prev, { volumeId: '', mountPath: '/data' }])}
                className="inline-flex h-7 items-center border border-border px-[10px] font-sans text-meta transition-colors hover:border-brand"
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
            <div className="form-field-label">
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
                <span className="font-sans text-meta font-medium">Wake on access</span>
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
                <p className="border-l-2 border-destructive/60 bg-destructive/5 px-3 py-2 font-sans text-meta leading-relaxed text-destructive">
                  Permanent. The box and everything on its disk are gone — this cannot be undone.
                </p>
              )}
            </div>
          </div>
          <div className="-mx-6">
            {!memoryValid && (
              <p role="alert" className="text-destructive">
                Enter memory in whole MiB increments, at least 0.125 GiB.
              </p>
            )}
            {!cpuValid && (
              <p role="alert" className="text-destructive">
                Enter at least 0.125 CPU with up to three decimal places.
              </p>
            )}
            {/* Keep blocking reasons outside collapsible options, within the scrollable body. */}
            {(lifecycleError || mountError) && (
              <p className="border-t border-border px-6 pt-3 font-sans text-meta text-destructive">
                {lifecycleError ?? mountError}
              </p>
            )}
          </div>
        </FormDialogBody>
        <DialogFooter className="flex-wrap items-center">
          <div className="mr-auto flex basis-full flex-wrap items-center gap-x-4 gap-y-2 text-left sm:basis-auto">
            {cpuValid && memoryValid && config.billingApiUrl && selectedQuote ? (
              <BoxPriceSummary
                quote={selectedQuote}
                spec={{ cpu, memory, disk }}
                currency={pricesQuery.data?.currency}
              />
            ) : (
              <div>
                <div className="text-meta text-muted-foreground">Estimated total</div>
                <div className="font-mono text-em">
                  {!cpuValid || !memoryValid
                    ? '—'
                    : !config.billingApiUrl
                      ? '$0.00'
                      : pricesQuery.isLoading
                        ? '—'
                        : 'Unavailable'}
                  <span className="font-sans text-meta text-muted-foreground"> / hr</span>
                </div>
              </div>
            )}
            {!config.billingApiUrl && <span className="text-meta text-muted-foreground">No usage charges</span>}
            {config.billingApiUrl && !selectedQuote && (
              <p role="status" className="basis-full text-meta text-muted-foreground">
                {pricesQuery.isLoading
                  ? 'Fetching current rates.'
                  : 'Current rates could not be loaded. Usage is still metered — this box is not free.'}
              </p>
            )}
          </div>
          <AsciiButton className="h-11 sm:h-9" type="button" onClick={() => setOpen(false)}>
            Cancel
          </AsciiButton>
          <AsciiButton
            variant="primary"
            className="h-11 sm:h-9"
            type="button"
            data-console-action="create_box"
            onClick={handleCreate}
            disabled={
              submitting ||
              !cpuValid ||
              !memoryValid ||
              !selectedOrganization?.id ||
              !nameValid ||
              Boolean(lifecycleError) ||
              Boolean(mountError)
            }
          >
            {submitting ? 'Creating…' : 'Create Box'}
          </AsciiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
