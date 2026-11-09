/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

type WidgetOptions = {
  sitekey: string
  action: string
  callback: (token: string) => void
  'expired-callback': () => void
  'timeout-callback': () => void
  'error-callback': () => boolean
}

type TurnstileApi = {
  render: (container: HTMLElement, options: WidgetOptions) => string
  reset: (id: string) => void
  remove: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptLoading: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!scriptLoading) {
    scriptLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      const failed = () => {
        script.remove()
        scriptLoading = undefined
        reject(new Error('Verification could not load. Please try again.'))
      }
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : failed())
      script.onerror = failed
      document.head.appendChild(script)
    })
  }
  return scriptLoading
}

export function Turnstile({
  sitekey,
  action,
  onToken,
}: {
  sitekey: string
  action: string
  onToken: (token: string | null) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let api: TurnstileApi | undefined
    let widgetId: string | undefined
    setError('')
    setLoading(true)
    void loadTurnstile()
      .then((loaded) => {
        if (!active || !container.current) return
        api = loaded
        const reset = () => {
          if (!active) return
          onToken(null)
          if (widgetId !== undefined) api?.reset(widgetId)
        }
        widgetId = api.render(container.current, {
          sitekey,
          action,
          callback: (token) => {
            if (active) {
              setError('')
              onToken(token)
            }
          },
          'expired-callback': reset,
          'timeout-callback': reset,
          'error-callback': () => {
            if (active) {
              onToken(null)
              setError('Verification failed. Please try again.')
            }
            return true
          },
        })
        setLoading(false)
      })
      .catch(() => {
        if (active) {
          setLoading(false)
          setError('Verification could not load. Please try again.')
        }
      })
    return () => {
      active = false
      onToken(null)
      if (widgetId !== undefined) api?.remove(widgetId)
    }
  }, [sitekey, action, onToken, attempt])

  return (
    <div className="space-y-3">
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading verification…
        </p>
      )}
      <div ref={container} aria-label="Human verification" />
      {error && (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry verification
          </Button>
        </>
      )}
    </div>
  )
}
