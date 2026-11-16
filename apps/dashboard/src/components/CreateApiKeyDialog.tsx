/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ApiKeyResponse, CreateApiKeyPermissionsEnum as Permission } from '@boxlite-ai/api-client'
import { AsciiButton } from '@/components/ascii'
import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { FormDialogContent, FormDialogHeader, FormDialogFooter, FormDialogBody } from '@/components/ui/form-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus } from '@/components/ui/icon'
import { useCreateApiKeyMutation } from '@/hooks/mutations/useCreateApiKeyMutation'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import {
  API_KEY_ACCESS_PRESETS,
  API_KEY_PERMISSION_GROUPS,
  API_KEY_PERMISSION_LABELS,
  API_KEY_PERMISSION_HELP,
  IMPLICIT_BOX_READ,
  apiKeyExpirationDate,
} from '@/lib/api-key-permissions'
import { ApiKeyPermissionsSummary } from './ApiKeyPermissionsSummary'

interface CreateApiKeyDialogProps {
  availablePermissions: Permission[]
  apiUrl: string
  className?: string
  organizationId?: string
  organizationName?: string
  permissionsStatus?: 'loading' | 'ready' | 'error'
  onRetryPermissions?: () => Promise<void>
}
const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiration' },
]

/** Each opening owns its draft and secret; unmounting discards all late responses. */
export function CreateApiKeyDialog(props: CreateApiKeyDialogProps) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <AsciiButton variant="primary" title="New API key" className={props.className}>
          <Plus className="size-4" />
          New API key
        </AsciiButton>
      </DialogTrigger>
      {open && <ApiKeyForm key={props.organizationId} {...props} onClose={() => setOpen(false)} />}
    </Dialog>
  )
}

function ApiKeyForm({
  availablePermissions,
  organizationId,
  organizationName,
  permissionsStatus = 'ready',
  onRetryPermissions,
  onClose,
}: CreateApiKeyDialogProps & { onClose: () => void }) {
  const id = useId()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('30')
  const [selected, setSelected] = useState<Permission[]>([])
  const [customize, setCustomize] = useState(false)
  const [presetId, setPresetId] = useState('operate')
  const [expandedGroups, setExpandedGroups] = useState<string[]>(['Boxes'])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ApiKeyResponse | null>(null)
  const [error, setError] = useState('')
  const [unknownOutcome, setUnknownOutcome] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [copied, copy] = useCopyToClipboard()
  const { mutateAsync } = useCreateApiKeyMutation()
  const initialized = useRef(false)
  const generation = useRef(0)
  const pending = useRef(false)
  const permissionsSignature = [...availablePermissions].sort().join(',')
  const preset = API_KEY_ACCESS_PRESETS.find((item) => item.id === presetId)
  const invalid = selected.filter((permission) => !availablePermissions.includes(permission))
  const canSubmit = Boolean(
    organizationId &&
    name.trim() &&
    selected.length &&
    !invalid.length &&
    permissionsStatus === 'ready' &&
    !submitting &&
    !unknownOutcome,
  )

  useLayoutEffect(() => {
    generation.current += 1
    setResult(null)
    if (pending.current) {
      setUnknownOutcome(true)
      setError(
        'Permissions changed during creation. Close this dialog and check the key list before creating another key.',
      )
    }
    pending.current = false
    setSubmitting(false)
    if (!initialized.current && permissionsStatus === 'ready') {
      initialized.current = true
      const defaultAvailable = availablePermissions.includes(Permission.WRITE_BOXES)
      setSelected(defaultAvailable ? [Permission.WRITE_BOXES] : [])
      setCustomize(!defaultAvailable)
      setPresetId(defaultAvailable ? 'operate' : 'custom')
    }
    return () => {
      generation.current += 1
    }
    // The signature represents the permission set, independent of array identity/order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsSignature, permissionsStatus])

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit || pending.current) return
    pending.current = true
    setSubmitting(true)
    setError('')
    const requestGeneration = generation.current
    try {
      const created = await mutateAsync({
        organizationId,
        name: name.trim(),
        permissions: [...selected],
        expiresAt: expiry === 'never' ? null : new Date(Date.now() + Number(expiry) * 86400000),
      })
      if (generation.current === requestGeneration) setResult(created)
    } catch (cause) {
      if (generation.current !== requestGeneration) return
      const failure = cause as { response?: { status?: number }; cause?: { response?: { status?: number } } }
      const status = failure?.response?.status ?? failure?.cause?.response?.status
      const uncertain = !status || status >= 500
      setUnknownOutcome(uncertain)
      setError(
        uncertain
          ? 'Creation could not be confirmed. Close this dialog and check the key list before creating another key.'
          : status === 409
            ? 'A key with this name already exists. Choose another name.'
            : status === 403
              ? 'You can no longer grant these permissions. Refresh permissions and review your selection.'
              : 'The key could not be created. Review your selection and try again.',
      )
    } finally {
      if (generation.current === requestGeneration) {
        pending.current = false
        setSubmitting(false)
      }
    }
  }

  async function refreshPermissions() {
    try {
      await onRetryPermissions?.()
    } catch {
      setError('Could not load permissions. Try again.')
    }
  }

  return (
    <FormDialogContent>
      <FormDialogHeader>
        <DialogTitle>{result ? 'API key created' : 'New API key'}</DialogTitle>
        <DialogDescription className="text-body text-muted-foreground">
          {result
            ? 'Copy your key now. You will not be able to see it again.'
            : `Choose access for ${organizationName || 'this organization'}.`}
        </DialogDescription>
      </FormDialogHeader>
      {result ? (
        <FormDialogBody className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-body">Permissions</span>
            <ApiKeyPermissionsSummary permissions={result.permissions} />
          </div>
          <div className="flex items-center justify-between gap-3 text-body">
            <span>Expires</span>
            <span>{apiKeyExpirationDate(result.expiresAt)}</span>
          </div>
          <div className="ph-no-capture border border-border bg-card p-4 space-y-3">
            <p className="ph-mask break-all select-all font-mono text-body">{result.value}</p>
            <AsciiButton
              type="button"
              variant="primary"
              onClick={async () => setCopyFailed(!(await copy(result.value)))}
            >
              {copied === result.value ? 'Copied' : 'Copy'}
            </AsciiButton>
          </div>
          {copyFailed && (
            <p role="alert" className="text-body text-destructive">
              Could not copy. Select the key above and copy it manually.
            </p>
          )}
        </FormDialogBody>
      ) : (
        <form className="form-dialog-body space-y-5" id="create-api-key-form" onSubmit={handleCreate} noValidate>
          <div className="space-y-2">
            <label htmlFor={`${id}-name`} className="form-field-label">
              Name
            </label>
            <input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              autoFocus
              disabled={submitting}
              className="form-field-input"
            />
          </div>
          <fieldset className="space-y-2" disabled={submitting} aria-describedby={`${id}-permission-help`}>
            <legend className="form-field-label mb-2">Access</legend>
            <Select
              value={presetId}
              disabled={submitting || permissionsStatus !== 'ready'}
              onValueChange={(value) => {
                if (value === 'custom') {
                  setPresetId(value)
                  setCustomize(true)
                  return
                }
                const choice = API_KEY_ACCESS_PRESETS.find((item) => item.id === value)!
                if (!choice.permissions.every((permission) => availablePermissions.includes(permission))) return
                setPresetId(value)
                setSelected([...choice.permissions])
                setExpandedGroups(
                  API_KEY_PERMISSION_GROUPS.filter((group) =>
                    group.permissions.some((p) => choice.permissions.includes(p)),
                  ).map((group) => group.name),
                )
                setCustomize(false)
              }}
            >
              <SelectTrigger aria-label="Access" aria-describedby={id + '-permission-help'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {API_KEY_ACCESS_PRESETS.map((item) => {
                  const missing = item.permissions.filter((permission) => !availablePermissions.includes(permission))
                  return (
                    <SelectItem key={item.id} value={item.id} disabled={missing.length > 0}>
                      {item.label}
                      {missing.length > 0 && (
                        <span className="block text-meta text-muted-foreground">
                          Requires: {missing.map((p) => API_KEY_PERMISSION_LABELS[p]).join(', ')}
                        </span>
                      )}
                    </SelectItem>
                  )
                })}
                <SelectItem value="custom">Custom access</SelectItem>
              </SelectContent>
            </Select>
            <p id={id + '-permission-help'} className="text-body text-muted-foreground">
              {preset?.description ?? 'Choose specific operations for this key.'}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-meta text-muted-foreground" aria-live="polite">
                {selected.length} permission{selected.length === 1 ? '' : 's'} selected
              </span>
              <AsciiButton
                type="button"
                variant="quiet"
                aria-expanded={customize}
                aria-controls={id + '-permissions'}
                onClick={() => setCustomize(!customize)}
              >
                {customize ? 'Hide advanced' : 'Adjust permissions'}
              </AsciiButton>
            </div>
            {permissionsStatus !== 'ready' ? (
              <p role="status" className="text-body">
                {permissionsStatus === 'loading' ? 'Loading permissions…' : 'Could not load permissions.'}
              </p>
            ) : !availablePermissions.length ? (
              <p role="status" className="text-body">
                You have no permissions available to grant.
              </p>
            ) : !selected.length ? (
              <p className="text-body">Choose at least one permission to continue.</p>
            ) : null}
            {invalid.length > 0 && (
              <p role="alert" className="text-body text-destructive">
                Some selected permissions are no longer available. Remove them to continue.
              </p>
            )}
            {(customize || invalid.length > 0) && (
              <div id={`${id}-permissions`} className="space-y-3 border-t border-border pt-3">
                <p className="text-meta text-muted-foreground">Applies across this organization. {IMPLICIT_BOX_READ}</p>
                {API_KEY_PERMISSION_GROUPS.map((group) => {
                  const options = group.permissions.filter(
                    (p) => availablePermissions.includes(p) || selected.includes(p),
                  )
                  if (!options.length) return null
                  return (
                    <details
                      key={group.name}
                      className="group border-b border-border pb-3 last:border-0"
                      open={expandedGroups.includes(group.name) || options.some((p) => invalid.includes(p))}
                      onToggle={(event) => {
                        const isOpen = event.currentTarget.open
                        setExpandedGroups((previous) =>
                          isOpen
                            ? [...new Set([...previous, group.name])]
                            : previous.filter((name) => name !== group.name),
                        )
                      }}
                    >
                      <summary className="cursor-pointer text-body font-medium py-1 focus-visible:outline focus-visible:outline-2">
                        {group.name}
                        <span className="ml-2 text-meta font-normal text-muted-foreground">
                          {options.filter((p) => selected.includes(p)).length} selected
                        </span>
                      </summary>
                      <fieldset className="space-y-3 pt-3" aria-label={group.name}>
                        {options.map((permission) => (
                          <div key={permission} className="flex items-start gap-3">
                            <Checkbox
                              id={`${id}-${permission}`}
                              className="mt-0.5 rounded-none"
                              checked={selected.includes(permission)}
                              disabled={submitting || permissionsStatus !== 'ready'}
                              onCheckedChange={(checked) => {
                                setPresetId('custom')
                                setSelected((previous) =>
                                  checked ? [...previous, permission] : previous.filter((p) => p !== permission),
                                )
                              }}
                            />
                            <label htmlFor={`${id}-${permission}`} className="min-w-0 cursor-pointer text-body">
                              {API_KEY_PERMISSION_LABELS[permission]}
                              {invalid.includes(permission) && <span className="text-destructive"> · Unavailable</span>}

                              {API_KEY_PERMISSION_HELP[permission] && (
                                <span className="block text-meta text-muted-foreground">
                                  {API_KEY_PERMISSION_HELP[permission]}
                                </span>
                              )}
                            </label>
                          </div>
                        ))}
                      </fieldset>
                    </details>
                  )
                })}
                <details className="text-meta text-muted-foreground">
                  <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-2">
                    Technical scopes
                  </summary>
                  <p className="mt-2 break-words font-mono">{selected.join(', ') || 'None selected'}</p>
                </details>
              </div>
            )}
          </fieldset>
          {onRetryPermissions && (permissionsStatus === 'error' || error) && (
            <AsciiButton type="button" onClick={refreshPermissions} disabled={permissionsStatus === 'loading'}>
              Refresh permissions
            </AsciiButton>
          )}
          <div className="space-y-2">
            <label htmlFor={`${id}-expiry`} className="form-field-label">
              Expiration
            </label>
            <Select value={expiry} onValueChange={setExpiry} disabled={submitting}>
              <SelectTrigger id={`${id}-expiry`} aria-describedby={`${id}-expiry-help`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={`${id}-expiry-help`} className="text-meta text-muted-foreground">
              {expiry === 'never'
                ? 'This key remains valid until it is revoked.'
                : 'The key will stop working after it expires.'}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-body text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
      <FormDialogFooter>
        <AsciiButton type="button" onClick={onClose}>
          {result ? 'Done' : 'Close'}
        </AsciiButton>
        {!result && (
          <AsciiButton variant="primary" type="submit" form="create-api-key-form" disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create API key'}
          </AsciiButton>
        )}
      </FormDialogFooter>
    </FormDialogContent>
  )
}
