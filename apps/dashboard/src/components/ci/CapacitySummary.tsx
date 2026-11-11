/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import type { CiCapacity } from '@/api/ci-types'
import { AsciiButton } from '@/components/ascii'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'

export function CapacitySummary({ capacity }: { capacity: CiCapacity }) {
  const api = useApi(),
    cache = useQueryClient()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organization = selectedOrganization!.id
  const owner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const [open, setOpen] = useState(false),
    [maximum, setMaximum] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const submitting = useRef(false)
  if (!capacity.available) return null
  const limit = capacity.effective_limit
  const atLimit = limit !== null && limit > 0 && capacity.used >= limit
  const nearLimit = limit !== null && limit > 0 && capacity.used >= limit * 0.8
  const save = async () => {
    if (submitting.current) return
    const parsed = maximum === '' ? null : Number(maximum)
    if (
      maximum !== '' &&
      (!/^(0|[1-9]\d*)$/.test(maximum) ||
        !Number.isSafeInteger(parsed) ||
        (capacity.commerce_limit !== null && parsed! > capacity.commerce_limit))
    ) {
      setError('Enter a whole number within your account allowance, or leave blank to inherit it.')
      return
    }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const settings = await api.setCiCapacity(organization, parsed)
      cache.setQueryData(['ci-settings', organization], settings)
      await cache.invalidateQueries({ queryKey: ['ci-runners', organization] })
      setOpen(false)
    } catch {
      setError('Unable to save CI capacity. Try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <span
          className={cn(
            'whitespace-nowrap font-mono text-meta tabular-nums',
            atLimit ? 'text-destructive' : nearLimit ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground',
          )}
        >
          {limit === null
            ? `CI slots ${capacity.used} / Unlimited`
            : limit === 0
              ? `CI slots ${capacity.used} / 0 · Paused`
              : `CI slots ${capacity.used} / ${limit}`}
        </span>
        {owner && (
          <button
            type="button"
            className="font-mono text-meta text-foreground underline underline-offset-4 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            onClick={() => {
              setMaximum(capacity.max_concurrent_jobs?.toString() ?? '')
              setError('')
              setOpen(true)
            }}
          >
            Edit
          </button>
        )}
      </div>
      <Dialog open={open} onOpenChange={(value) => !busy && setOpen(value)}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <DialogHeader>
              <DialogTitle>CI capacity</DialogTitle>
              <DialogDescription>
                One total across all connected GitHub accounts and repositories. Existing jobs continue when you lower
                it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <Label htmlFor="ci-maximum">Maximum concurrent CI jobs</Label>
              <Input
                id="ci-maximum"
                type="number"
                min="0"
                max={capacity.commerce_limit ?? undefined}
                step="1"
                value={maximum}
                placeholder="Inherit account allowance"
                disabled={busy}
                onChange={(event) => setMaximum(event.target.value)}
              />
              <p className="text-body text-muted-foreground">
                Leave blank to inherit; 0 pauses new workers. Account allowance:{' '}
                {capacity.commerce_limit ?? 'Unlimited'}. Other Boxes also use this allowance.
              </p>
              {error && (
                <p role="alert" className="text-body text-muted-foreground">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <AsciiButton type="button" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </AsciiButton>
              <AsciiButton variant="primary" type="submit" disabled={busy}>
                Save capacity
              </AsciiButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
