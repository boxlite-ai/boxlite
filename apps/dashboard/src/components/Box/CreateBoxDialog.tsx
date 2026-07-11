/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { calculateBoxHourlyCost, formatUsdFromCents } from '@/components/billing/cost'
import type { BillingPricing } from '@/billing-api'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateBoxMutation } from '@/hooks/mutations/useCreateBoxMutation'
import { useBillingPricingQuery } from '@/hooks/queries/useBillingPricingQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxRouteId } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import type { Box } from '@boxlite-ai/api-client'
import { ChevronDown, Plus } from '@/components/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const SUPPORTED_BOX_IMAGES = [
  { id: 'base', name: 'Base', ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3', isDefault: true },
  { id: 'python', name: 'Python', ref: 'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3', isDefault: false },
  { id: 'node', name: 'Node.js', ref: 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3', isDefault: false },
] as const

const DEFAULTS = { cpu: 1, memory: 1, disk: 10 }

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

export const CreateBoxDialog = ({
  className,
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  onCreated,
}: {
  className?: string
  triggerClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCreated?: (box: Box) => void
}) => {
  const navigate = useNavigate()
  const [internalOpen, setInternalOpen] = useState(false)
  const wasOpenRef = useRef(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const { selectedOrganization } = useSelectedOrganization()
  const createBoxMutation = useCreateBoxMutation()
  const pricingQuery = useBillingPricingQuery(selectedOrganization?.id ?? '', Boolean(open && selectedOrganization))
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
    setAdvancedOpen(false)
    setSubmitting(false)
    setCapped({ cpu: false, memory: false, disk: false })
  }, [open, defaultImage.ref, initialCpu, initialMemory, initialDisk])

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

  const handleCreate = async () => {
    if (!selectedOrganization?.id) {
      toast.error('Select an organization to create a box.')
      return
    }
    if (!nameValid) {
      toast.error('Only letters, digits, dots, underscores and dashes are allowed in the name.')
      return
    }
    setSubmitting(true)
    try {
      const box = await createBoxMutation.mutateAsync({
        name: name.trim() || undefined,
        image: imageRef || defaultImage.ref,
        network: { mode: 'enabled' },
        resources: { cpu, memory, disk },
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
          {/* name */}
          <div className="flex flex-col gap-[9px]">
            <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-box"
              aria-invalid={!nameValid}
              className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
            />
          </div>

          {/* image */}
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

          {/* advanced */}
          <div className="flex flex-col gap-4 border-t border-border pt-5">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full flex-wrap items-start gap-x-[9px] gap-y-1 text-left font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground transition-colors hover:text-foreground sm:items-center"
            >
              <span className="text-[11px]">{advancedOpen ? '▾' : '▸'}</span>
              Advanced Options
              {!advancedOpen && (
                <span className="basis-full pl-5 font-mono text-[11px] normal-case tracking-normal text-muted-foreground/80 sm:basis-auto sm:pl-0">
                  · {cpu} vCPU · {memory} GiB · {disk} GiB
                </span>
              )}
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-[14px]">
                <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
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
                <CappedResourcesNote
                  items={[
                    capped.cpu && limits.cpu != null && { label: 'CPU', unit: 'vCPU', max: limits.cpu },
                    capped.memory && limits.memory != null && { label: 'Memory', unit: 'GiB', max: limits.memory },
                    capped.disk && limits.disk != null && { label: 'Disk', unit: 'GiB', max: limits.disk },
                  ].filter((r): r is { label: string; unit: string; max: number } => Boolean(r))}
                />
              </div>
            )}
          </div>
        </div>

        <BoxCostEstimate cpu={cpu} memory={memory} disk={disk} pricing={pricingQuery.data} />

        {/* footer */}
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
            disabled={submitting || !selectedOrganization?.id || !nameValid}
            className="bg-primary px-5 py-[11px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-50 sm:py-[10px]"
          >
            {submitting ? 'Creating…' : 'Create Box'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BoxCostEstimate({
  cpu,
  memory,
  disk,
  pricing,
}: {
  cpu: number
  memory: number
  disk: number
  pricing?: BillingPricing
}) {
  const [expanded, setExpanded] = useState(false)
  const cost = pricing ? calculateBoxHourlyCost(pricing, { cpu, memory, disk }) : null

  return (
    <div className="shrink-0 border-t border-border px-4 py-4 font-mono sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          disabled={!cost}
          className="text-[10px] uppercase tracking-[1.2px] text-muted-foreground enabled:hover:text-foreground"
        >
          {expanded ? '[-]' : '[+]'} Est. price / hour
        </button>
        {cost && pricing ? (
          <span className="text-[20px] font-bold tracking-normal sm:text-[24px]">
            {formatUsdFromCents(cost.totalCents, 5)}{' '}
            <span className="text-[11px] font-normal text-muted-foreground">/ hr · Pricing v{pricing.version}</span>
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground">Pricing unavailable</span>
        )}
      </div>
      {expanded && cost && pricing ? (
        <div className="mt-4 space-y-2 border-t border-dashed border-border pt-3 text-[11px] text-muted-foreground">
          <div className="flex justify-between gap-4">
            <span>
              CPU {cpu} vCPU x {formatUsdFromCents(pricing.cpuRateCentsPerHour, 4)}
            </span>
            <span className="text-foreground">{formatUsdFromCents(cost.cpuCents, 5)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span>
              Memory {memory} GiB x {formatUsdFromCents(pricing.memRateCentsPerHour, 4)}
            </span>
            <span className="text-foreground">{formatUsdFromCents(cost.memoryCents, 5)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span>
              Disk {disk} GiB x {formatUsdFromCents(pricing.diskRateCentsPerHour, 6)}
            </span>
            <span className="text-foreground">{formatUsdFromCents(cost.diskCents, 6)}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
