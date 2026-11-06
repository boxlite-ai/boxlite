// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingGuideDialog } from './OnboardingGuideDialog'
import { quickstartRecipeFor } from '@/lib/quickstart/recipes'

const mocks = vi.hoisted(() => ({
  orgId: 'org-1',
  saveDraft: vi.fn(async (_org, text, revision) => ({ text, revision: revision + 1 })),
  handoff: vi.fn(async () => ({})),
  markCopied: vi.fn(async () => ({})),
  copy: vi.fn(async () => true),
  createApiKey: vi.fn(),
  listBoxes: vi.fn(),
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('@/lib/copy-text', () => ({ copyToClipboard: mocks.copy }))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    savePromptDraft: mocks.saveDraft,
    preparePromptHandoff: mocks.handoff,
    markPromptCopied: mocks.markCopied,
    apiKeyApi: { createApiKey: mocks.createApiKey },
    boxApi: { listBoxesPaginated: mocks.listBoxes },
  }),
}))
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'https://api.test', oidc: { issuer: 'https://auth.test' } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: mocks.orgId, name: 'Org' },
    organizationMembers: [{ id: 'member-1' }],
    refreshOrganizationMembers: vi.fn(),
    authenticatedUserHasPermission: mocks.hasPermission,
  }),
}))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'user-1' } } }) }))
// The handoff screen polls for boxes; this test is about the other tab.
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useQuery: ({ queryKey }) => (queryKey[0] === 'quickstart-prompt' ? { data: null, isSuccess: true } : { data: [] }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let root: Root | null = null

function flush() {
  return act(async () => {
    await Promise.resolve()
  })
}

function tabNamed(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) =>
    (t.textContent ?? '').includes(label),
  )
}

// Radix activates a tab on `mousedown`, so a bare click never switched panels.
async function click(el: HTMLElement | undefined) {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.orgId = 'org-1'
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.listBoxes.mockReset()
  sessionStorage.clear()
  mocks.createApiKey.mockResolvedValue({ data: { name: 'sdk-quickstart', value: 'blk_live_theOnlyCopy' } })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('OnboardingGuideDialog tabs', () => {
  it('renders SDK and editable local-agent handoff inline without a dialog or second scenario picker', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const progress = vi.fn()
    mocks.listBoxes.mockResolvedValue({ data: { items: [] } })
    const renderMethod = async (method: 'sdk' | 'prompt') => {
      await act(async () => {
        root ??= createRoot(host)
        root.render(
          <OnboardingGuideDialog
            inline
            open
            onOpenChange={() => {}}
            onProgressChange={progress}
            progress={{ boxCreated: false, sdkConnected: false }}
            preview={{
              inline: true,
              recipe: quickstartRecipeFor(method === 'sdk' ? 'code-execution' : 'application-deployments'),
              onRecipeChange: () => {},
              onConsole: () => {},
              creditCents: 10000,
            }}
          />,
        )
      })
      await flush()
    }
    await renderMethod('sdk')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[aria-label="Quickstart action"]')).toBeNull()
    expect(document.body.textContent).toContain('Create key')
    expect(document.body.textContent).toContain('pip install --upgrade boxlite')
    const installSection = [...document.querySelectorAll('h2')]
      .find((item) => item.textContent === '2. Choose your SDK or CLI')!
      .closest('section')!
    await click([...installSection.querySelectorAll('button')].find((item) => item.textContent === 'Copy'))
    expect(mocks.copy).toHaveBeenCalledWith('pip install --upgrade boxlite')
    expect(document.body.textContent).toContain('Hello from BoxLite')
    expect([...document.querySelectorAll('h2')].map((item) => item.textContent)).toEqual([
      '1. Get an API key',
      '2. Choose your SDK or CLI',
      '3. Create a Box',
      '4. Run code and commands',
      '5. Create a preview',
    ])
    expect(document.body.textContent).toContain('Idle auto-stop still applies')
    expect(document.querySelector('select')).toBeNull()
    const cliButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === 'CLI',
    )!
    await click(cliButton)
    expect(cliButton.getAttribute('data-state')).toBe('active')
    expect(document.body.textContent).toContain('boxlite create --name')
    expect(document.body.textContent).toContain('boxlite exec "$box_name"')
    expect(document.body.textContent).not.toContain('Next →')
    await renderMethod('prompt')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const request = document.querySelector<HTMLTextAreaElement>('[aria-label="Application request"]')!
    expect(request).not.toBeNull()
    expect(request.value).toBe('')
    expect(document.querySelector('details')?.open).toBe(false)
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
        item.textContent?.includes('Prepare prompt'),
      )?.disabled,
    ).toBe(true)
    const agents = document.querySelector('[aria-label="Local coding agents"]')!
    expect(agents.querySelector('button')).toBeNull()
    for (const label of ['Grok', 'Hermes', 'Pi']) expect(agents.querySelector(`[title="${label}"]`)).not.toBeNull()
    expect(agents.querySelectorAll('svg, img')).toHaveLength(8)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        request,
        'Build an inventory dashboard.',
      )
      request.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(document.querySelector('pre')?.textContent).toContain('Application request: Build an inventory dashboard.')
    expect(document.querySelector('pre')?.textContent).not.toContain('blk_live_theOnlyCopy')
    expect(document.body.textContent).not.toContain('waiting for your agent')
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Prepare prompt'),
    )
    const copyButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === 'Copy prompt',
    )
    expect(copyButton).toBeDefined()
    await click(copyButton)
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringContaining('Application request: Build an inventory dashboard.'),
    )
    expect(mocks.handoff).toHaveBeenCalledWith('org-1', 'Build an inventory dashboard.', expect.any(String))
    expect(mocks.markCopied).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Prompt copied. Continue in your coding agent.')
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === 'API service',
      ),
    )
    expect(document.body.textContent).not.toContain('Prompt copied. Continue in your coding agent.')
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Prepare prompt'),
    )
    mocks.copy.mockResolvedValueOnce(false)
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === 'Copy prompt',
      ),
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save or copy')
    expect(document.body.textContent).not.toContain('Prompt copied.')
    expect(progress).not.toHaveBeenCalled()
  })

  it('offers two actions instead of asking the user to choose their use case again', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <OnboardingGuideDialog
          open
          onOpenChange={() => {}}
          onProgressChange={() => {}}
          progress={{ boxCreated: false, sdkConnected: false }}
          preview={{
            recipe: quickstartRecipeFor('code-execution'),
            onRecipeChange: () => {},
            onConsole: () => {},
            creditCents: 10000,
          }}
        />,
      )
    })
    await flush()
    const buttons = [...document.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(buttons).toContain('Run code')
    expect(buttons).toContain('Build an app')
    expect(document.querySelector('[aria-label="Quickstart use case"]')).toBeNull()
    expect(document.querySelector('[aria-label="Example"]')).toBeNull()
  })

  it('keeps execution focused on Hello World and preserves the key and interface across actions', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const renderRecipe = async (id: string) => {
      await act(async () => {
        root ??= createRoot(host)
        root.render(
          <OnboardingGuideDialog
            open
            onOpenChange={() => {}}
            onProgressChange={() => {}}
            progress={{ boxCreated: false, sdkConnected: false }}
            preview={{
              recipe: quickstartRecipeFor(id),
              onRecipeChange: () => {},
              onConsole: () => {},
              creditCents: 10000,
            }}
          />,
        )
      })
      await flush()
    }
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
    await renderRecipe('code-execution')
    await click(button('Create key'))
    await click(button('Copied · Next →'))
    for (const name of ['Python', 'Node', 'Go', 'Rust', 'C', 'CLI', 'REST']) expect(button(name)).toBeDefined()
    await click(button('CLI'))
    await renderRecipe('application-deployments')
    await renderRecipe('code-execution')
    expect(button('CLI')?.getAttribute('aria-pressed')).toBe('true')
    await click(button('Installed · Next →'))
    expect(document.querySelector('[aria-label="Example"]')).toBeNull()
    expect(document.body.textContent).not.toContain('More examples')
    expect(document.body.textContent).not.toContain('Example:')
    expect(document.body.textContent).toContain('Hello from BoxLite')
    expect(document.body.textContent).toContain('blk_live_theOnlyCopy')
    expect(mocks.createApiKey).toHaveBeenCalledTimes(1)
  })

  it('keeps a created key when the user looks at the other job and comes back', async () => {
    // The plaintext key is returned exactly once. Changing tabs used to reset
    // the walkthrough, so this round trip discarded it for good and left a
    // live key in the account that the user never saw.
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<OnboardingGuideDialog open onOpenChange={() => {}} onProgressChange={() => {}} />)
    })
    await flush()

    await click(tabNamed('Run untrusted code'))
    const createKey = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.textContent ?? '').trim() === 'Create key',
    )
    await click(createKey)
    expect(document.body.textContent).toContain('blk_live_theOnlyCopy')

    await click(tabNamed('Build an app online'))
    await click(tabNamed('Run untrusted code'))

    expect(document.body.textContent).toContain('blk_live_theOnlyCopy')
    expect(mocks.createApiKey).toHaveBeenCalledTimes(1)
  })
})

it('copies each SDK/CLI step with a named key and switches all supported interfaces', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <OnboardingGuideDialog
        inline
        open
        onOpenChange={() => {}}
        onProgressChange={() => {}}
        preview={{
          inline: true,
          recipe: quickstartRecipeFor('code-execution'),
          onRecipeChange: () => {},
          onConsole: () => {},
          creditCents: 0,
        }}
      />,
    ),
  )
  const name = document.querySelector('input[aria-label="Quickstart API key name"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'named-example')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click([...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create key'))
  expect(mocks.createApiKey).toHaveBeenCalledWith(expect.objectContaining({ name: 'named-example' }), 'org-1')
  for (const label of ['Python', 'Node', 'Go', 'Rust', 'C', 'CLI', 'REST']) {
    await click(tabNamed(label))
    const copies = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent === 'Copy' || b.textContent === 'Copy full example',
    )
    expect(copies.length).toBeGreaterThanOrEqual(5)
    mocks.copy.mockClear()
    for (const copy of copies) await click(copy)
    const copied = mocks.copy.mock.calls.map(([value]) => value as string)
    const full = copied.at(-1)!
    expect(full).toContain('Preview URL:')
    expect(full).not.toContain('Press Enter')
    // The three independently copied code parts must reproduce the complete program.
    expect(copied.slice(-4, -1).join('\n\n')).toBe(full)
    expect(document.body.textContent).toContain('✓ Copied')
    await act(async () => vi.advanceTimersByTime(1400))
    expect(document.body.textContent).not.toContain('✓ Copied')
  }
  expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining('curl'))
  expect(mocks.copy).toHaveBeenCalledWith('blk_live_theOnlyCopy')
})

it('finishes the staged walkthrough, supports back navigation and copies setup/code', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const close = vi.fn(),
    progress = vi.fn()
  await act(async () =>
    root!.render(
      <OnboardingGuideDialog
        open
        onOpenChange={close}
        onProgressChange={progress}
        preview={{
          recipe: quickstartRecipeFor('code-execution'),
          onRecipeChange: () => {},
          onConsole: () => {},
          creditCents: 0,
        }}
      />,
    ),
  )
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
  const input = document.querySelector('input[aria-label="Quickstart API key name"]')!
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await click(button('Copy'))
  await click(button('↻ Regenerate'))
  await click(button('Copied · Next →'))
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="SDK or interface"]')!
  await act(async () => {
    select.value = 'rest'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(button('Copy'))
  await click(button('Installed · Next →'))
  await click(button('Copy'))
  await click(button('Finish walkthrough'))
  expect(progress).toHaveBeenCalled()
  await click(button('Open Fleet →'))
  expect(close).toHaveBeenCalledWith(false)
})

it('keeps the key form available after a failed creation and blocks roles without permission', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.createApiKey.mockRejectedValueOnce(new Error('server unavailable'))
  const render = async () =>
    act(async () =>
      root!.render(
        <OnboardingGuideDialog
          inline
          open
          onOpenChange={() => {}}
          onProgressChange={() => {}}
          preview={{
            inline: true,
            recipe: quickstartRecipeFor('code-execution'),
            onRecipeChange: () => {},
            onConsole: () => {},
            creditCents: 0,
          }}
        />,
      ),
    )
  await render()
  await click([...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create key'))
  expect(document.querySelector('input[aria-label="Quickstart API key name"]')).not.toBeNull()
  mocks.hasPermission.mockReturnValue(false)
  await render()
  expect(
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create key')!.disabled,
  ).toBe(true)
  mocks.hasPermission.mockReturnValue(true)
})

it('retries a failed prompt save before copying and reuses the prepared handoff on copy again', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.listBoxes.mockResolvedValue({ data: { items: [] } })
  await act(async () =>
    root!.render(
      <OnboardingGuideDialog
        inline
        open
        onOpenChange={() => {}}
        onProgressChange={() => {}}
        preview={{
          inline: true,
          recipe: quickstartRecipeFor('application-deployments'),
          onRecipeChange: () => {},
          onConsole: () => {},
          creditCents: 0,
        }}
      />,
    ),
  )
  await flush()
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
  await click(button('Internal dashboard'))
  mocks.saveDraft.mockRejectedValueOnce(new Error('offline'))
  await click(button('Prepare prompt'))
  expect(document.body.textContent).toContain('Could not save')
  expect(mocks.copy).not.toHaveBeenCalled()
  await click(button('Retry'))
  expect(document.body.textContent).not.toContain('Could not save. Your text')
  mocks.handoff.mockRejectedValueOnce(new Error('offline'))
  await click(button('Prepare prompt'))
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  await click(button('Prepare prompt'))
  await click(button('Copy prompt'))
  expect(document.body.textContent).toContain('Prompt copied.')
  const preparedId = mocks.handoff.mock.calls.at(-1)![2]
  const keysIssued = mocks.createApiKey.mock.calls.length
  await click(button('Copy again'))
  expect(mocks.handoff.mock.calls.at(-1)![2]).toBe(preparedId)
  expect(mocks.createApiKey).toHaveBeenCalledTimes(keysIssued)
})

it.each(['code-execution', 'application-deployments'])(
  'allows leaving the %s preview for later or the console',
  async (recipe) => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const close = vi.fn(),
      consoleAction = vi.fn(),
      change = vi.fn()
    await act(async () =>
      root!.render(
        <OnboardingGuideDialog
          open
          onOpenChange={close}
          onProgressChange={() => {}}
          preview={{
            recipe: quickstartRecipeFor(recipe),
            onRecipeChange: change,
            onConsole: consoleAction,
            creditCents: 0,
          }}
        />,
      ),
    )
    await flush()
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
    await click(button('Maybe later'))
    expect(close).toHaveBeenCalledWith(false)
    await click(button('Try in console →'))
    expect(consoleAction).toHaveBeenCalledTimes(1)
    await click(button(recipe === 'code-execution' ? 'Run code' : 'Build an app'))
    expect(change).not.toHaveBeenCalled()
    await click(button(recipe === 'code-execution' ? 'Build an app' : 'Run code'))
    expect(change).toHaveBeenCalledWith(recipe === 'code-execution' ? 'application-deployments' : 'code-execution')
  },
)

it('isolates SDK keys across organizations including late key responses', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const render = async () =>
    act(async () =>
      root!.render(
        <OnboardingGuideDialog
          inline
          open
          onOpenChange={() => {}}
          onProgressChange={() => {}}
          preview={{
            inline: true,
            recipe: quickstartRecipeFor('code-execution'),
            onRecipeChange: () => {},
            onConsole: () => {},
            creditCents: 0,
          }}
        />,
      ),
    )
  const create = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create key')
  await render()
  await click(create())
  expect(document.body.textContent).toContain('blk_live_theOnlyCopy')
  mocks.orgId = 'org-2'
  await render()
  expect(document.body.textContent).not.toContain('blk_live_theOnlyCopy')
  let resolve!: (value: unknown) => void
  mocks.createApiKey.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  await click(create())
  mocks.orgId = 'org-3'
  await render()
  await act(async () => resolve({ data: { value: 'blk_late_other_org' } }))
  expect(document.body.textContent).not.toContain('blk_late_other_org')
  expect(create()).toBeDefined()
})

it('prepares a persisted handoff before a fresh copy gesture and reports acknowledgement failures separately', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.listBoxes.mockResolvedValue({ data: { items: [] } })
  await act(async () =>
    root!.render(
      <OnboardingGuideDialog
        inline
        open
        onOpenChange={() => {}}
        onProgressChange={() => {}}
        preview={{
          inline: true,
          recipe: quickstartRecipeFor('application-deployments'),
          onRecipeChange: () => {},
          onConsole: () => {},
          creditCents: 0,
        }}
      />,
    ),
  )
  await flush()
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
  await click(button('Personal website'))
  await click(button('Prepare prompt'))
  expect(mocks.handoff).toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(button('Copy prompt')).toBeDefined()
  mocks.markCopied.mockRejectedValueOnce(new Error('ack offline'))
  let synchronousCopy = false
  mocks.copy.mockImplementationOnce(async () => {
    synchronousCopy = true
    return true
  })
  await act(async () => {
    button('Copy prompt')!.click()
    expect(synchronousCopy).toBe(true)
  })
  expect(document.body.textContent).toContain('Prompt copied.')
  expect(document.body.textContent).not.toContain('Could not save or copy')
  expect(button('Retry confirmation')).toBeDefined()
  await click(button('Retry confirmation'))
  expect(button('Retry confirmation')).toBeUndefined()
})

it('ignores a late acknowledgement failure after editing the copied prompt', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.listBoxes.mockResolvedValue({ data: { items: [] } })
  await act(async () =>
    root!.render(
      <OnboardingGuideDialog
        inline
        open
        onOpenChange={() => {}}
        onProgressChange={() => {}}
        preview={{
          inline: true,
          recipe: quickstartRecipeFor('application-deployments'),
          onRecipeChange: () => {},
          onConsole: () => {},
          creditCents: 0,
        }}
      />,
    ),
  )
  await flush()
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
  await click(button('Personal website'))
  await click(button('Prepare prompt'))
  expect(mocks.handoff).toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(button('Copy prompt')).toBeDefined()
  let rejectAcknowledgement!: (error: Error) => void
  mocks.markCopied.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectAcknowledgement = reject
      }),
  )
  await click(button('Copy prompt'))
  const copiedId = mocks.markCopied.mock.calls[0][1]
  const textarea = host.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      'Build a different application',
    )
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => rejectAcknowledgement(new Error('late acknowledgement failure')))
  expect(button('Retry confirmation')).toBeUndefined()
  await click(button('Prepare prompt'))
  expect(button('Copy prompt')).toBeDefined()
  expect(mocks.markCopied).toHaveBeenCalledTimes(1)
  await click(button('Copy prompt'))
  expect(mocks.markCopied).toHaveBeenCalledTimes(2)
  expect(mocks.markCopied.mock.calls[1][1]).not.toBe(copiedId)
})
