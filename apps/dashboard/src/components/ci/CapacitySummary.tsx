/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { QuotaTicks } from '@/components/QuotaTicks'
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import type { CiCapacity } from '@/api/ci-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
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
  const inputRef = useRef<HTMLInputElement>(null)
  if (!capacity.available) return null
  const limit = capacity.effective_limit
  const atLimit = limit !== null && limit > 0 && capacity.used >= limit
  const nearLimit = limit !== null && limit > 0 && capacity.used >= limit * 0.8
  const save = async () => {
    if (!owner || submitting.current) return
    const parsed = maximum === '' ? null : Number(maximum)
    if (
      maximum !== '' &&
      (!/^(0|[1-9]\d*)$/.test(maximum) ||
        !Number.isSafeInteger(parsed) ||
        (capacity.commerce_limit !== null && parsed! > capacity.commerce_limit))
    ) {
      setError('Enter a whole number within your account allowance, or use the account limit.')
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
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={cn(
          'inline-flex items-center gap-2 whitespace-nowrap font-mono text-meta tabular-nums',
          atLimit ? 'text-destructive' : nearLimit ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        {limit === null
          ? `CI slots ${capacity.used} / Unlimited`
          : limit === 0
            ? `CI slots ${capacity.used} / 0 · Paused`
            : `CI slots ${capacity.used} / ${limit}`}
        <QuotaTicks used={capacity.used} limit={limit} />
      </span>
      {owner && (
        <Dialog
          open={open}
          onOpenChange={(value) => {
            if (busy) return
            if (value) {
              setMaximum(capacity.max_concurrent_jobs?.toString() ?? '')
              setError('')
            }
            setOpen(value)
          }}
        >
          <DialogTrigger asChild>
            <Button type="button" variant="quiet" size="sm" disabled={busy}>
              Edit limit
            </Button>
          </DialogTrigger>
          <DialogContent
            aria-modal="true"
            aria-describedby="ci-capacity-help"
            className="sm:max-w-[440px] overflow-y-auto"
            showCloseButton={!busy}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              inputRef.current?.focus()
              inputRef.current?.select()
            }}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault()
            }}
            onInteractOutside={(event) => {
              if (busy) event.preventDefault()
            }}
          >
            <form
              className="space-y-4"
              noValidate
              aria-busy={busy}
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <DialogTitle>Concurrency limit</DialogTitle>
              <div>
                <Label htmlFor="ci-maximum" className="form-field-label">
                  Maximum concurrent CI jobs
                </Label>
                <Input
                  id="ci-maximum"
                  ref={inputRef}
                  type="text"
                  inputMode="numeric"
                  className="form-field-input h-9 font-mono tabular-nums"
                  value={maximum}
                  placeholder={`Account limit (${capacity.commerce_limit ?? 'Unlimited'})`}
                  aria-describedby={error ? 'ci-capacity-help ci-capacity-error' : 'ci-capacity-help'}
                  aria-invalid={!!error}
                  disabled={busy}
                  onChange={(event) => {
                    setMaximum(event.target.value)
                    setError('')
                  }}
                />
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-meta text-muted-foreground">
                    Account limit: {capacity.commerce_limit ?? 'Unlimited'}
                  </span>
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    disabled={busy || maximum === ''}
                    onClick={() => {
                      setMaximum('')
                      setError('')
                    }}
                  >
                    {maximum === '' ? 'Using account limit' : 'Use account limit'}
                  </Button>
                </div>
              </div>
              <p id="ci-capacity-help" className="text-meta leading-relaxed text-muted-foreground">
                Other Boxes share the account limit. Set 0 to pause new CI jobs; running jobs continue.
              </p>
              {error && (
                <p id="ci-capacity-error" role="alert" className="text-meta text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="quiet" size="sm" type="button" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
