import { useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Navigate, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import LoadingFallback from '@/components/LoadingFallback'
import { useConfig } from '@/hooks/useConfig'
import { parseRegistrationLink, registrationSession } from '@/lib/referral-session'
import { RoutePath } from '@/enums/RoutePath'

export default function Register() {
  const location = useLocation()
  const auth = useAuth()
  const config = useConfig()
  const [error, setError] = useState<string>()
  const [starting, setStarting] = useState(false)
  const resume = new URLSearchParams(location.search).get('resume') === '1'
  let input: ReturnType<typeof parseRegistrationLink> | undefined
  let problem = error
  let ready = false
  try {
    if (resume) {
      const draft = registrationSession.read()
      if (!draft)
        throw new Error('Registration context is missing. Reopen your invitation link or restart registration.')
      input = draft
      if (auth.user && draft.identity) {
        registrationSession.snapshot({ issuer: config.oidc.issuer, userId: auth.user.profile.sub })
        ready = true
      }
    } else input = parseRegistrationLink(location.search)
  } catch (failure) {
    problem = (failure as Error).message
  }

  if (ready && !problem) return <Navigate to={RoutePath.DASHBOARD} replace />
  if (auth.isLoading) return <LoadingFallback />

  const start = async () => {
    if (!input || starting) return
    setStarting(true)
    try {
      const draft = registrationSession.prepare(input)
      await auth.signinRedirect({
        state: registrationSession.oidcState(draft),
        prompt: 'login',
        extraQueryParams: {
          audience: config.oidc.audience,
          ...(config.oidc.issuer.includes('auth0') ? { screen_hint: 'signup' } : {}),
        },
      })
    } catch (failure) {
      setError((failure as Error).message)
      setStarting(false)
    }
  }

  const restart = () => {
    registrationSession.ordinaryLogin()
    window.location.replace(RoutePath.REGISTER)
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-5 px-6">
      <h1 className="text-2xl font-semibold">Create your BoxLite account</h1>
      {input?.source === 'link' && (
        <label className="flex flex-col gap-2">
          Invitation code
          <input
            aria-label="Invitation code"
            readOnly
            value={input.referredCode}
            className="w-full border border-border bg-card p-3 font-mono"
          />
        </label>
      )}
      {problem || auth.error ? (
        <p role="alert">{problem || auth.error?.message}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Continue to our sign-in provider to create your account.</p>
          <Button onClick={start} disabled={starting}>
            {starting ? 'Opening sign in…' : 'Continue'}
          </Button>
        </>
      )}
      {(problem || auth.error) && <Button onClick={restart}>Discard invitation and restart</Button>}
    </main>
  )
}
