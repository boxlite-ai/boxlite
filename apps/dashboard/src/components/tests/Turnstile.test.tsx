// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Options = Parameters<NonNullable<Window['turnstile']>['render']>[1]
let Turnstile: (typeof import('../Turnstile'))['Turnstile']
let options: Options
const api = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() }
const onToken = vi.fn()
let root: Root

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.resetModules()
  Turnstile = (await import('../Turnstile')).Turnstile
  vi.clearAllMocks()
  api.render.mockImplementation((_host, value) => {
    options = value
    return 'widget-1'
  })
  window.turnstile = api
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.querySelectorAll('script[src*="challenges.cloudflare.com"]').forEach((script) => script.remove())
  delete window.turnstile
  vi.useRealTimers()
})

async function render(strict = false) {
  await act(async () => {
    const widget = <Turnstile sitekey="public-key" action="signup" onToken={onToken} />
    root.render(strict ? <StrictMode>{widget}</StrictMode> : widget)
  })
}

describe('Turnstile', () => {
  it('times out a stalled script after 10 seconds and permits a clean retry', async () => {
    vi.useFakeTimers()
    delete window.turnstile
    await render(true)
    const stalled = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999)
    })
    expect(document.body.textContent).toContain('Loading verification')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(document.body.textContent).toContain('Verification could not load')
    expect(stalled.isConnected).toBe(false)
    expect(stalled.onload).toBeNull()
    expect(stalled.onerror).toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button')!.click()
    })
    const retry = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')!
    expect(retry).not.toBe(stalled)
    window.turnstile = api
    await act(async () => {
      retry.dispatchEvent(new Event('load'))
    })
    expect(api.render).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    act(() => options.callback('fresh-token'))
    expect(onToken).toHaveBeenLastCalledWith('fresh-token')
  })

  it.each(['error', 'load'])(
    'shares the official script and retries when %s leaves the API unavailable',
    async (event) => {
      delete window.turnstile
      await render(true)
      expect(document.body.textContent).toContain('Loading verification')
      let scripts = document.querySelectorAll<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')
      expect(scripts).toHaveLength(1)
      expect(scripts[0].src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
      await act(async () => {
        scripts[0].dispatchEvent(new Event(event))
      })
      expect(document.body.textContent).toContain('Verification could not load')
      await act(async () => {
        document.querySelector<HTMLButtonElement>('button')!.click()
      })
      scripts = document.querySelectorAll('script[src*="challenges.cloudflare.com"]')
      expect(scripts).toHaveLength(1)
      window.turnstile = api
      await act(async () => {
        scripts[0].dispatchEvent(new Event('load'))
      })
      expect(api.render).toHaveBeenCalledTimes(1)
      expect(document.body.textContent).not.toContain('Loading verification')
      expect(options).toMatchObject({ sitekey: 'public-key', action: 'signup' })
    },
  )

  it.each(['load', 'error'])('ignores a script %s event after unmount', async (event) => {
    delete window.turnstile
    await render()
    const script = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]')!
    act(() => root.render(null))
    expect(onToken).toHaveBeenLastCalledWith(null)
    onToken.mockClear()
    if (event === 'load') window.turnstile = api
    await act(async () => {
      script.dispatchEvent(new Event(event))
    })
    expect(api.render).not.toHaveBeenCalled()
    expect(api.remove).not.toHaveBeenCalled()
    expect(onToken).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('')
  })

  it('clears expired and timed-out tokens and resets the same widget', async () => {
    await render()
    act(() => options.callback('token-1'))
    expect(onToken).toHaveBeenLastCalledWith('token-1')
    act(() => options['expired-callback']())
    expect(onToken).toHaveBeenLastCalledWith(null)
    expect(api.reset).toHaveBeenLastCalledWith('widget-1')
    act(() => options['timeout-callback']())
    expect(api.reset).toHaveBeenCalledTimes(2)
  })

  it('clears a failed challenge and removes it before rendering a retry', async () => {
    await render()
    act(() => options['error-callback']())
    expect(onToken).toHaveBeenLastCalledWith(null)
    expect(document.body.textContent).toContain('Verification failed')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button')!.click()
    })
    expect(api.remove).toHaveBeenCalledWith('widget-1')
    expect(api.render).toHaveBeenCalledTimes(2)
    act(() => options.callback('replacement-token'))
    expect(onToken).toHaveBeenLastCalledWith('replacement-token')
    expect(document.body.textContent).not.toContain('Verification failed')
  })

  it('removes the widget on unmount and ignores its late callbacks', async () => {
    await render()
    act(() => root.render(null))
    expect(api.remove).toHaveBeenCalledWith('widget-1')
    onToken.mockClear()
    act(() => {
      options.callback('late-token')
      options['expired-callback']()
      options['error-callback']()
    })
    expect(onToken).not.toHaveBeenCalled()
  })
})
