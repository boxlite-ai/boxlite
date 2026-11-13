// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegistrationEmailError, RegistrationError } from '@/api/errors'
import { RegistrationGate } from '../RegistrationGate'
import { ErrorBoundaryFallback } from '../ErrorBoundaryFallback'

const api = vi.hoisted(() => ({ userApi: { getAuthenticatedUser: vi.fn() }, register: vi.fn() }))
const widgetMount = vi.hoisted(() => vi.fn())
const auth = vi.hoisted(() => ({ user: { profile: { sub: 'auth0|user' } } }))
const businessMount = vi.fn()
const businessUnmount = vi.fn()
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ turnstile: { sitekey: 'sitekey', action: 'signup' } }) }))
vi.mock('react-oidc-context', () => ({ useAuth: () => auth }))
vi.mock('../LoadingFallback', () => ({ default: () => <p>Checking account</p> }))
vi.mock('../Turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (value: string | null) => void }) => {
    useEffect(() => {
      widgetMount()
    }, [])
    return <button onClick={() => onToken(`token-${widgetMount.mock.calls.length}`)}>Complete challenge</button>
  },
}))

function Business() {
  const location = useLocation()
  useEffect(() => {
    businessMount()
    return () => businessUnmount()
  }, [])
  return <p>Business at {location.pathname + location.search}</p>
}

const required = () => new RegistrationError('Complete registration to continue', 'registration_required')
const userResponse = { data: { id: 'auth0|user', name: 'User' } }
let root: Root
let client: QueryClient

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  auth.user.profile.sub = 'auth0|user'
  onlineManager.setOnline(true)
  api.register.mockReset()
  api.userApi.getAuthenticatedUser.mockReset().mockRejectedValue(required())
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  onlineManager.setOnline(true)
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function flush() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
    else await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/dashboard/boxes?template=python']}>
          <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
            <RegistrationGate key={auth.user.profile.sub}>
              <Business />
            </RegistrationGate>
          </ErrorBoundary>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
  await flush()
}
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)
  expect(found, `button: ${text}`).toBeDefined()
  return found!
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
  })
  await flush()
}

describe('RegistrationGate', () => {
  it('waits for a fresh account check when cached user data is available offline', async () => {
    client.setQueryData(['users', 'registration', 'auth0|user'], userResponse.data)
    onlineManager.setOnline(false)
    api.userApi.getAuthenticatedUser.mockResolvedValue(userResponse)
    await render()
    expect(api.userApi.getAuthenticatedUser).not.toHaveBeenCalled()
    expect(businessMount).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Checking account')
    await act(async () => onlineManager.setOnline(true))
    await flush()
    expect(businessMount).toHaveBeenCalledTimes(1)
  })

  it.each(['initial', 'confirmation', 'lost-response'])(
    'offers recovery when the %s account check stalls for 10 seconds',
    async (phase) => {
      vi.useFakeTimers()
      api.userApi.getAuthenticatedUser.mockReset().mockImplementation(
        (_referralCode, { timeout }: { timeout?: number }) =>
          new Promise((_resolve, reject) => {
            if (timeout) setTimeout(() => reject(new Error('Operation timed out')), timeout)
          }),
      )
      if (phase !== 'initial') api.userApi.getAuthenticatedUser.mockRejectedValueOnce(required())
      if (phase === 'lost-response') api.register.mockRejectedValue(new Error('Network Error'))
      else api.register.mockResolvedValue(userResponse.data)
      await render()
      if (phase !== 'initial') {
        await click('Complete challenge')
        await click('Continue')
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999)
      })
      expect(document.body.textContent).toContain('Checking account')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })
      expect(button('Try again').disabled).toBe(false)
      expect(businessMount).not.toHaveBeenCalled()
      expect(api.register).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1)
      api.userApi.getAuthenticatedUser.mockRejectedValue(required())
      await click('Try again')
      expect(button('Continue').disabled).toBe(true)
    },
  )

  it.each(['reconnect', 'invalidation'])(
    'keeps admitted business mounted during %s and transient failure',
    async (trigger) => {
      api.userApi.getAuthenticatedUser.mockResolvedValueOnce(userResponse)
      await render()
      let fail!: (error: Error) => void
      api.userApi.getAuthenticatedUser.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          }),
      )
      await act(async () => {
        if (trigger === 'reconnect') {
          onlineManager.setOnline(false)
          onlineManager.setOnline(true)
        } else {
          void client.invalidateQueries({ queryKey: ['users', 'registration'] })
        }
      })
      await flush()
      expect(api.userApi.getAuthenticatedUser).toHaveBeenCalledTimes(2)
      expect(businessUnmount).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Business at /dashboard/boxes?template=python')
      await act(async () => fail(new Error('Network Error')))
      await flush()
      expect(businessUnmount).not.toHaveBeenCalled()
      expect(businessMount).toHaveBeenCalledTimes(1)
    },
  )

  it('revokes admission when a background account check explicitly requires registration', async () => {
    api.userApi.getAuthenticatedUser.mockResolvedValueOnce(userResponse)
    await render()
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['users', 'registration'] })
    })
    await flush()
    expect(businessUnmount).toHaveBeenCalledTimes(1)
    expect(button('Continue').disabled).toBe(true)
  })

  it('requires fresh admission when the authenticated identity changes, even with cached user data', async () => {
    api.userApi.getAuthenticatedUser.mockResolvedValueOnce(userResponse)
    await render()
    auth.user.profile.sub = 'auth0|other'
    client.setQueryData(['users', 'registration', 'auth0|other'], { id: 'auth0|other', name: 'Other' })
    await render()
    expect(businessUnmount).toHaveBeenCalledTimes(1)
    expect(businessMount).toHaveBeenCalledTimes(1)
    expect(button('Continue').disabled).toBe(true)
  })

  it('revokes admission when a background account check rejects the email', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.userApi.getAuthenticatedUser
      .mockResolvedValueOnce(userResponse)
      .mockRejectedValue(new RegistrationEmailError('Email required', 'email_required'))
    await render()
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['users', 'registration'] })
    })
    await flush()
    expect(businessUnmount).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Sign out and use another email')
    consoleError.mockRestore()
  })

  it('blocks cached user data until the fresh account check succeeds', async () => {
    client.setQueryData(['users', 'registration', 'auth0|user'], userResponse.data)
    let resolve!: (value: typeof userResponse) => void
    api.userApi.getAuthenticatedUser.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    await render()
    expect(businessMount).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Checking account')
    await act(async () => resolve(userResponse))
    await flush()
    expect(businessMount).toHaveBeenCalledTimes(1)
  })

  it('does not admit a cached user after the server requires registration', async () => {
    client.setQueryData(['users', 'registration', 'auth0|user'], userResponse.data)
    await render()
    expect(api.userApi.getAuthenticatedUser).toHaveBeenCalledTimes(1)
    expect(businessMount).not.toHaveBeenCalled()
    expect(button('Continue').disabled).toBe(true)
  })

  it('blocks business providers until the initial account check completes', async () => {
    let resolve!: (value: typeof userResponse) => void
    api.userApi.getAuthenticatedUser.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    await render()
    expect(document.body.textContent).toContain('Checking account')
    expect(businessMount).not.toHaveBeenCalled()
    expect(widgetMount).not.toHaveBeenCalled()
    await act(async () => resolve(userResponse))
    await flush()
    expect(businessMount).toHaveBeenCalledTimes(1)
    expect(widgetMount).not.toHaveBeenCalled()
  })

  it('requires a challenge, submits once, and preserves the target URL after confirmation', async () => {
    let complete!: (value: typeof userResponse.data) => void
    api.register.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    await render()
    expect(businessMount).not.toHaveBeenCalled()
    expect(button('Continue').disabled).toBe(true)
    await click('Complete challenge')
    await act(async () => {
      button('Continue').click()
      button('Continue').click()
    })
    expect(api.register).toHaveBeenCalledTimes(1)
    expect(api.register).toHaveBeenCalledWith('token-1')
    expect(button('Creating account…').disabled).toBe(true)
    api.userApi.getAuthenticatedUser.mockResolvedValue(userResponse)
    await act(async () => complete(userResponse.data))
    await flush()
    expect(api.userApi.getAuthenticatedUser).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Business at /dashboard/boxes?template=python')
  })

  it.each([
    { created: true, cached: false },
    { created: false, cached: false },
    { created: true, cached: true },
    { created: false, cached: true },
  ])(
    'recovers a lost registration response with a user check (created=$created, cached=$cached)',
    async ({ created, cached }) => {
      if (cached) client.setQueryData(['users', 'registration', 'auth0|user'], userResponse.data)
      api.register.mockRejectedValue(new Error('Network Error'))
      await render()
      await click('Complete challenge')
      if (created) api.userApi.getAuthenticatedUser.mockResolvedValue(userResponse)
      await click('Continue')
      expect(api.register).toHaveBeenCalledTimes(1)
      expect(api.userApi.getAuthenticatedUser).toHaveBeenCalledTimes(2)
      if (created) expect(businessMount).toHaveBeenCalledTimes(1)
      else {
        expect(document.body.textContent).toContain('Registration could not be confirmed')
        expect(button('Continue').disabled).toBe(true)
        expect(widgetMount).toHaveBeenCalledTimes(2)
        expect(businessMount).not.toHaveBeenCalled()
      }
    },
  )

  it.each(['turnstile_verification_failed', 'turnstile_unavailable', 'registration_rate_limit_unavailable'])(
    'offers a new challenge after %s without entering business',
    async (code) => {
      api.register.mockRejectedValue(new RegistrationError('Try again later', code))
      await render()
      await click('Complete challenge')
      await click('Continue')
      expect(document.body.textContent).toContain('Try again later')
      expect(button('Continue').disabled).toBe(true)
      expect(widgetMount).toHaveBeenCalledTimes(2)
      expect(businessMount).not.toHaveBeenCalled()
    },
  )

  it('allows a failed initial check to be retried without mounting the widget', async () => {
    api.userApi.getAuthenticatedUser.mockRejectedValueOnce(new Error('Unavailable'))
    await render()
    expect(widgetMount).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Registration is temporarily unavailable')
    await click('Try again')
    expect(widgetMount).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing sign-out recovery for registration email rejections', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.register.mockRejectedValue(new RegistrationEmailError('Email required', 'email_required'))
    await render()
    await click('Complete challenge')
    await click('Continue')
    expect(document.body.textContent).toContain('Sign out and use another email')
    expect(businessMount).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('offers sign-out recovery when the initial account check rejects the email', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.userApi.getAuthenticatedUser.mockRejectedValue(new RegistrationEmailError('Email required', 'email_required'))
    await render()
    expect(document.body.textContent).toContain('Sign out and use another email')
    expect(api.register).not.toHaveBeenCalled()
    expect(widgetMount).not.toHaveBeenCalled()
    expect(businessMount).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
