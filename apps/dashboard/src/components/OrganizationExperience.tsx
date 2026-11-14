/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { LogoText } from '@/assets/Logo'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Building2, Check, ChevronDown, Loader2 } from '@/components/ui/icon'
import { useApi } from '@/hooks/useApi'
import {
  readOrganizationSession,
  saveOrganizationSession,
  ORGANIZATION_SESSION_EVENT,
  organizationSwitchPath,
} from '@/lib/organization-session'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { RoutePath } from '@/enums/RoutePath'
function OrganizationChoices({
  onComplete,
  currentId,
  onBusyChange,
}: {
  onComplete: () => void
  currentId?: string
  onBusyChange?: (busy: boolean) => void
}) {
  const choosing = !currentId
  const { organizations } = useOrganizations()
  const { organizationsApi } = useApi()
  const { user } = useAuth()
  const { pathname } = useLocation()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const filtered = organizations.filter((org) => `${org.name} ${org.id}`.toLowerCase().includes(search.toLowerCase()))
  async function select(id: string) {
    if (lock.current) return
    if (currentId === id) return
    lock.current = true
    onBusyChange?.(true)
    setPending(id)
    setError('')
    try {
      const members = (await organizationsApi.listOrganizationMembers(id)).data
      if (!alive.current) return
      if (!user || !members.some((member) => member.userId === user.profile.sub)) throw new Error('Access denied')
      saveOrganizationSession(user.profile.sub, id)
      onComplete()
    } catch {
      setError('We could not open this organization. Check your connection and allow site storage, then try again.')
    } finally {
      lock.current = false
      onBusyChange?.(false)
      setPending(null)
    }
  }
  return (
    <div
      className="space-y-3"
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        if (!buttons.length) return
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          index < 0
            ? event.key === 'ArrowDown'
              ? 0
              : buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next].focus()
      }}
    >
      {organizations.length > 5 && (
        <Input
          aria-label="Search organizations"
          placeholder="Search organizations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={Boolean(pending)}
        />
      )}
      <div className="max-h-[45vh] overflow-y-auto">
        {filtered.map((org) => (
          <button
            type="button"
            key={org.id}
            onClick={() => {
              if (org.id === currentId) return
              const listPath = organizationSwitchPath(pathname)
              if (!choosing && pathname !== listPath) setConfirmId(org.id)
              else void select(org.id)
            }}
            aria-current={currentId === org.id ? 'true' : undefined}
            disabled={Boolean(pending)}
            className={`flex w-full items-center gap-2 px-2 text-left hover:bg-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 ${choosing ? 'min-h-12 border-b border-border py-3' : 'min-h-11 py-1.5'}`}
          >
            <Building2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-normal">{org.name}</span>
              <span className="block break-all font-mono text-meta leading-4 text-muted-foreground">{org.id}</span>
            </span>
            {org.isDefaultForAuthenticatedUser && <span className="text-meta text-muted-foreground">Default</span>}
            {pending === org.id ? (
              <Loader2 className="size-4 animate-spin" />
            ) : !choosing && currentId === org.id ? (
              <Check className="size-4" />
            ) : (
              <span className="size-4" />
            )}
          </button>
        ))}
      </div>
      {!filtered.length && <p className="py-6 text-body text-muted-foreground">No organizations match your search.</p>}
      {pending && (
        <p role="status" className="text-body text-muted-foreground">
          Opening organization…
        </p>
      )}
      <AlertDialog
        open={Boolean(confirmId)}
        onOpenChange={(open) => {
          if (!open) setConfirmId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch organization?</AlertDialogTitle>
            <AlertDialogDescription>
              Any unsaved changes on this page will be discarded. Console terminal connections will close; running Boxes
              will keep running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmId) void select(confirmId)
              }}
            >
              Switch organization
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
function subscribeSelection(listener: () => void) {
  window.addEventListener(ORGANIZATION_SESSION_EVENT, listener)
  return () => window.removeEventListener(ORGANIZATION_SESSION_EVENT, listener)
}

export function OrganizationGate({ children }: { children: ReactNode }) {
  const { organizations } = useOrganizations()
  const { user } = useAuth()
  const { pathname } = useLocation()
  const selectedId = useSyncExternalStore(subscribeSelection, () => readOrganizationSession(user?.profile.sub))
  const bypass = pathname === RoutePath.USER_INVITATIONS || matchPath(RoutePath.EMAIL_VERIFY, pathname)
  if (bypass || organizations.length === 1 || organizations.some((org) => org.id === selectedId)) return children
  return (
    <div className="min-h-svh bg-background font-sans text-foreground">
      <header className="flex h-16 items-center justify-between gap-4 border-b border-border px-6 md:px-10">
        <LogoText className="h-9 w-auto shrink-0" />
        <span className="truncate text-body text-muted-foreground">{user?.profile.email}</span>
      </header>
      <main className="mx-auto max-w-[560px] px-6 pb-16 pt-16 md:pt-24">
        <h1 className="mb-3 mt-3 text-page font-semibold tracking-tight">
          {organizations.length ? 'Choose an organization' : 'No organizations yet'}
        </h1>
        <p className="mb-8 text-body leading-6 text-muted-foreground">
          {organizations.length
            ? 'Select an organization to continue.'
            : 'You have not joined an organization. Open your invitation link, or refresh after joining.'}
        </p>
        {organizations.length ? (
          <OrganizationChoices onComplete={() => window.dispatchEvent(new Event(ORGANIZATION_SESSION_EVENT))} />
        ) : (
          <Button variant="outline" onClick={() => window.location.reload()}>
            Refresh
          </Button>
        )}
        <div className="mt-6 flex justify-between text-meta text-muted-foreground">
          <span>{organizations.length} organizations</span>
          <Button variant="ghost" size="sm" onClick={() => window.location.assign(RoutePath.LOGOUT)}>
            Use another account
          </Button>
        </div>
      </main>
    </div>
  )
}

export function OrganizationSwitcher() {
  const { selectedOrganization } = useSelectedOrganization()
  const { organizations } = useOrganizations()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const identity = (
    <>
      <Building2 className="size-[18px] shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-body font-medium">{selectedOrganization?.name}</span>
    </>
  )
  return (
    <div className="ml-3 min-w-0 flex-1 md:ml-6 md:flex-none">
      {organizations.length < 2 ? (
        <div className="flex h-9 items-center gap-2 px-3" title={selectedOrganization?.id}>
          {identity}
        </div>
      ) : (
        <Popover
          modal
          open={open}
          onOpenChange={(next) => {
            if (!busy) setOpen(next)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="h-9 w-full max-w-full justify-start gap-2 px-3 md:max-w-[280px]"
              aria-label={`Switch organization: ${selectedOrganization?.name}`}
            >
              {identity}
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} className="w-[280px] max-w-[calc(100vw-32px)] p-1">
            <p className="px-2 py-1.5 text-meta text-muted-foreground">Organizations</p>
            <OrganizationChoices
              onBusyChange={setBusy}
              currentId={selectedOrganization?.id}
              onComplete={() => window.location.assign(organizationSwitchPath(pathname))}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
