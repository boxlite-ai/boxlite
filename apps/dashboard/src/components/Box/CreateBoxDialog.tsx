/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateBoxMutation } from '@/hooks/mutations/useCreateBoxMutation'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxRouteId } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import type { Box } from '@boxlite-ai/api-client'
import { ChevronDown, Plus } from '@/components/ui/icon'
import { useEffect, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const SUPPORTED_BOX_IMAGES = [
  { id: 'base', name: 'Base', ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3', isDefault: true },
  { id: 'python', name: 'Python', ref: 'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3', isDefault: false },
  { id: 'node', name: 'Node.js', ref: 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3', isDefault: false },
] as const

const DEFAULTS = { cpu: 1, memory: 1, disk: 10 }
const LIMITS = { cpu: 8, memory: 32, disk: 50 }

// Stepper: − / editable value / + . Accepts any integer ≥ min (the backend takes arbitrary
// cpu/memory/disk); click +/− or type directly (commits/clamps on blur or Enter).
function Stepper({
  value,
  onChange,
  min = 1,
  max,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText(String(value))
  }, [value])
  const clamp = (n: number) => {
    const v = Math.max(min, n)
    return max != null ? Math.min(max, v) : v
  }
  const commit = (raw: string) => {
    const n = parseInt(raw, 10)
    onChange(Number.isFinite(n) ? clamp(n) : min)
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
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
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
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const { selectedOrganization } = useSelectedOrganization()
  const createBoxMutation = useCreateBoxMutation()
  const defaultImage = SUPPORTED_BOX_IMAGES.find((i) => i.isDefault) ?? SUPPORTED_BOX_IMAGES[0]

  const [name, setName] = useState('')
  const [imageRef, setImageRef] = useState<string>(defaultImage.ref)
  const [cpu, setCpu] = useState(DEFAULTS.cpu)
  const [memory, setMemory] = useState(DEFAULTS.memory)
  const [disk, setDisk] = useState(DEFAULTS.disk)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setName('')
      setImageRef(defaultImage.ref)
      setCpu(DEFAULTS.cpu)
      setMemory(DEFAULTS.memory)
      setDisk(DEFAULTS.disk)
      setAdvancedOpen(false)
      setSubmitting(false)
    }
  }, [open, defaultImage.ref])

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
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
                <div className="flex flex-col gap-[9px]">
                  <div className="font-mono text-[10px] uppercase tracking-[1px]">
                    CPU <span className="text-muted-foreground">(vCPU)</span>
                  </div>
                  <Stepper value={cpu} onChange={setCpu} max={LIMITS.cpu} />
                </div>
                <div className="flex flex-col gap-[9px]">
                  <div className="font-mono text-[10px] uppercase tracking-[1px]">
                    Memory <span className="text-muted-foreground">(GiB)</span>
                  </div>
                  <Stepper value={memory} onChange={setMemory} max={LIMITS.memory} />
                </div>
                <div className="flex flex-col gap-[9px]">
                  <div className="font-mono text-[10px] uppercase tracking-[1px]">
                    Disk <span className="text-muted-foreground">(GiB)</span>
                  </div>
                  <Stepper value={disk} onChange={setDisk} max={LIMITS.disk} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* price — billing is not enabled yet, so everything is free ($0) */}
        <div className="flex shrink-0 flex-col gap-1 border-t border-border px-4 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:px-6">
          <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Price per hour</span>
          <span className="font-mono text-[20px] font-bold tracking-[-0.5px] sm:text-[24px]">
            $0.00 <span className="text-[11px] font-normal text-muted-foreground">/ hr · free in preview</span>
          </span>
        </div>

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
