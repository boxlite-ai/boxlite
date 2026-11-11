/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { CiConnectConfiguration, CiConnectResult } from '@/api/ci-types'
import { AsciiButton } from '@/components/ascii'
import { CiAccountPicker, CiOrganizationRecovery } from '@/components/CiAccountPicker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ArrowLeft, Loader2 } from '@/components/ui/icon'
import { useApi } from '@/hooks/useApi'
import {
  clearCiConnectSession,
  getCiConnectSession,
  githubAuthorizationSettingsUrl,
  prepareCiRedirect,
} from '@/lib/ci-connect'

export function CiConnectionFlow({
  organization,
  configuration,
}: {
  organization: string
  configuration?: CiConnectConfiguration
}) {
  const api = useApi(),
    cache = useQueryClient()
  const [search, setSearch] = useSearchParams(),
    id = search.get('connect')
  const [result, setResult] = useState<CiConnectResult>(),
    [starting, setStarting] = useState(false),
    [loading, setLoading] = useState(false),
    [message, setMessage] = useState(''),
    [resume, setResume] = useState(0),
    [cancelFailed, setCancelFailed] = useState(false)
  const startGeneration = useRef(0),
    startingRef = useRef(false)
  const removeRoute = () =>
    setSearch(
      (previous) => {
        const next = new URLSearchParams(previous)
        next.delete('connect')
        return next
      },
      { replace: true },
    )
  const cancelLater = (session: { organization: string; attempt: string }) => {
    void api
      .cancelCiConnect(session.organization, session.attempt)
      .catch(() => toast.error('Unable to confirm cancellation of the previous GitHub authorization.'))
  }
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (
        !event.persisted &&
        (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.type !==
          'back_forward'
      )
        return
      startGeneration.current++
      startingRef.current = false
      setStarting(false)
      if (id) setResume((value) => value + 1)
      else {
        const session = getCiConnectSession()
        clearCiConnectSession()
        if (session) cancelLater(session)
      }
    }
    window.addEventListener('pageshow', restored)
    return () => {
      window.removeEventListener('pageshow', restored)
      startGeneration.current++
      startingRef.current = false
    }
  }, [organization, id, api])
  useEffect(() => {
    setResult(undefined)
  }, [organization, id])
  useEffect(() => {
    let active = true
    if (!id) {
      setLoading(false)
      return
    }
    const session = getCiConnectSession()
    if (!session || session.attempt !== id || session.organization !== organization) {
      setLoading(false)
      setResult(undefined)
      setMessage('Authorization expired. Reconnect GitHub to continue.')
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)
    setMessage('')
    const read = () => {
      const current = getCiConnectSession()
      if (!active) return
      if (!current || current.attempt !== id || current.organization !== organization) {
        setLoading(false)
        setResult(undefined)
        setMessage('Authorization expired. Reconnect GitHub to continue.')
        return
      }
      api
        .getCiConnect(organization, id)
        .then(
          (value) => {
            const current = getCiConnectSession()
            if (!active) return
            if (!current || current.attempt !== id || current.organization !== organization) {
              setResult(undefined)
              setMessage('Authorization expired. Reconnect GitHub to continue.')
              return
            }
            setResult(value)
            if (value.status === 'pending') {
              timer = setTimeout(read, Math.min(1000, Math.max(1, current.expires - Date.now())))
            } else if (value.status === 'connected') {
              clearCiConnectSession()
              removeRoute()
            } else if (!['selection_required', 'installation_required'].includes(value.status)) {
              setMessage('Authorization did not complete. Reconnect GitHub to continue.')
            }
            void cache.invalidateQueries({ queryKey: ['ci-settings', organization] })
          },
          () => {
            if (active)
              setMessage(
                'Unable to read GitHub accounts. Review organization access and SSO, or retry authorization status.',
              )
          },
        )
        .finally(() => {
          if (active) setLoading(false)
        })
    }
    read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, cache, organization, id, resume])
  const close = () => {
    startGeneration.current++
    startingRef.current = false
    setStarting(false)
    const session = getCiConnectSession()
    clearCiConnectSession()
    removeRoute()
    setMessage('')
    setResult(undefined)
    if (session) cancelLater(session)
  }
  const start = async (selectAccount = false) => {
    if (startingRef.current || !configuration?.web_connect_available) return
    const request = ++startGeneration.current
    startingRef.current = true
    setStarting(true)
    setMessage('')
    try {
      const previous = getCiConnectSession()
      if (previous) {
        try {
          await api.cancelCiConnect(previous.organization, previous.attempt)
        } catch {
          if (request === startGeneration.current) {
            setCancelFailed(true)
            setMessage(
              'The previous authorization could not be cancelled. Retry cancellation or discard its local reference; the server authorization may remain active until it expires.',
            )
          }
          return
        }
      }
      setCancelFailed(false)
      if (request !== startGeneration.current) return
      clearCiConnectSession()
      const attempt = await api.startCiConnect(organization, {
        follow_installation: true,
        allow_private_repositories: false,
        select_account: selectAccount,
      })
      if (request !== startGeneration.current) {
        cancelLater({ organization, attempt: attempt.id })
        return
      }
      window.location.assign(prepareCiRedirect(organization, attempt))
    } catch {
      if (request === startGeneration.current) setMessage('Unable to start GitHub authorization. Try again.')
    } finally {
      if (request === startGeneration.current) {
        startingRef.current = false
        setStarting(false)
      }
    }
  }
  const changed = (value: CiConnectResult) => {
    setResult(value)
    setMessage('')
    if (value.status === 'connected') {
      clearCiConnectSession()
      removeRoute()
    } else if (value.status === 'pending') {
      setResume((value) => value + 1)
    } else if (!['selection_required', 'installation_required'].includes(value.status)) {
      setMessage('Authorization did not complete. Reconnect GitHub to continue.')
    }
    void cache.invalidateQueries({ queryKey: ['ci-settings', organization] })
  }
  const settingsUrl = githubAuthorizationSettingsUrl(
    result?.authorization_settings_url || configuration?.authorization_settings_url,
  )
  const discard = cancelFailed && (
    <AsciiButton
      onClick={() => {
        clearCiConnectSession()
        close()
        setCancelFailed(false)
      }}
    >
      Discard local authorization
    </AsciiButton>
  )
  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <AsciiButton
            variant="primary"
            disabled={starting || !configuration?.web_connect_available}
            onClick={() => void start()}
          >
            {starting && <Loader2 className="size-4 animate-spin" />}Connect GitHub
          </AsciiButton>
        </div>
        {configuration && !configuration.web_connect_available && (
          <p className="text-meta text-muted-foreground">Browser connect is not configured on this deployment.</p>
        )}
        {!id && message && (
          <p role="alert" className="text-meta text-muted-foreground">
            {message}
          </p>
        )}
      </div>
      {!id && discard}
      <Dialog
        open={!!id}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent className="overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Connect GitHub</DialogTitle>
            <DialogDescription>Choose your personal account or an organization you own.</DialogDescription>
          </DialogHeader>
          {loading || result?.status === 'pending' ? (
            <p role="status" className="text-body text-muted-foreground">
              {result?.status === 'pending' ? 'Finishing GitHub connection…' : 'Loading GitHub accounts…'}
            </p>
          ) : result?.accounts && result.authenticated_account ? (
            <CiAccountPicker
              api={api}
              organization={organization}
              result={result}
              onResult={changed}
              onSwitch={(select) => void start(select)}
            />
          ) : (
            <CiOrganizationRecovery settingsUrl={settingsUrl} reconnect={() => void start()} />
          )}
          {message && (
            <p role="alert" className="text-body text-muted-foreground">
              {message}
            </p>
          )}
          {message && getCiConnectSession() && (
            <AsciiButton onClick={() => setResume((value) => value + 1)}>Retry authorization status</AsciiButton>
          )}
          {discard}
          <DialogFooter>
            <AsciiButton onClick={close}>
              <ArrowLeft className="size-4" />
              Back to Connects
            </AsciiButton>
            <AsciiButton variant="primary" onClick={close}>
              Done
            </AsciiButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
