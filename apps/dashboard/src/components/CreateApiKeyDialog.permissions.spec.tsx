// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateApiKeyPermissionsEnum as P } from '@boxlite-ai/api-client'
import { SUPPORTED_API_KEY_PERMISSIONS } from '@/lib/api-key-permissions'
import { CreateApiKeyDialog } from './CreateApiKeyDialog'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/hooks/mutations/useCreateApiKeyMutation', () => ({
  useCreateApiKeyMutation: () => ({ mutateAsync: mocks.create }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
let root: Root
const all = [P.WRITE_BOXES, P.DELETE_BOXES, P.WRITE_MEMBERS]
function button(text: string) {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
}
async function render(permissions = all, organizationId = 'org-1') {
  await act(async () =>
    root.render(<CreateApiKeyDialog organizationId={organizationId} apiUrl="" availablePermissions={permissions} />),
  )
}
async function open() {
  await act(async () => button('New API key').click())
  const input = document.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'agent')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  await act(async () =>
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.create.mockReset().mockResolvedValue({ value: 'test-secret', permissions: [P.WRITE_BOXES] })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})
describe('API key permission contract', () => {
  it('selects all available permissions in the dropdown and submits the full supported set', async () => {
    await render(SUPPORTED_API_KEY_PERMISSIONS)
    await open()
    expect(document.querySelector('[aria-label="Access"]')!.textContent).toBe('All available permissions')
    await openAccessMenu()
    const allPermissions = accessOption('All available permissions')
    expect(allPermissions?.dataset.state).toBe('checked')
    await act(async () => allPermissions!.click())

    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual(
      Object.values(P).filter((permission) => permission !== P.UNKNOWN_DEFAULT_OPEN_API),
    )
  })
  it('labels each previously hidden grant and lets the owner remove it before creation', async () => {
    await render(SUPPORTED_API_KEY_PERMISSIONS)
    await open()
    await act(async () => button('Adjust permissions').click())

    const newlyVisibleGrants = [
      ['Manage legacy templates', P.WRITE_TEMPLATES],
      ['Delete legacy templates', P.DELETE_TEMPLATES],
      ['Manage regions', P.WRITE_REGIONS],
      ['Delete regions', P.DELETE_REGIONS],
      ['View runners', P.READ_RUNNERS],
      ['Manage runners', P.WRITE_RUNNERS],
      ['Delete runners', P.DELETE_RUNNERS],
      ['View audit logs', P.READ_AUDIT_LOGS],
    ] as const
    for (const [label, permission] of newlyVisibleGrants) {
      const checkboxLabel = [...document.querySelectorAll('label')].find((item) => item.textContent === label)
      expect(checkboxLabel?.htmlFor).toContain(permission)
      const checkbox = document.getElementById(checkboxLabel!.htmlFor)!
      const group = checkbox.closest('details')!
      if (!group.open) await act(async () => group.querySelector('summary')!.click())
      expect(checkbox.getAttribute('aria-checked')).toBe('true')
      await act(async () => checkbox.click())
      expect(checkbox.getAttribute('aria-checked')).toBe('false')
    }

    await submit()
    const removedPermissions = new Set<P>(newlyVisibleGrants.map(([, permission]) => permission))
    expect(mocks.create.mock.calls[0][0].permissions).toEqual(
      SUPPORTED_API_KEY_PERMISSIONS.filter((permission) => !removedPermissions.has(permission)),
    )
  })
  it('sets a finite thirty-day expiry', async () => {
    await render([P.WRITE_BOXES])
    await open()
    const before = Date.now()
    await submit()
    const expiresAt = mocks.create.mock.calls[0][0].expiresAt
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 86400000)
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86400000)
  })
  it('grants only the available subset when Box operations cannot be granted', async () => {
    await render([P.READ_APPS])
    await open()
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual([P.READ_APPS])
  })
  it('discards a secret returned after the organization changes', async () => {
    let resolve!: (value: unknown) => void
    mocks.create.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    await render()
    await open()
    await submit()
    await render(all, 'org-2')
    await act(async () => resolve({ value: 'old-org-secret' }))
    expect(document.body.textContent).not.toContain('old-org-secret')
  })
  it('keeps a failed request draft and sends the exact custom subset on retry', async () => {
    mocks.create.mockRejectedValueOnce({ response: { status: 400 } })
    await render([P.WRITE_BOXES, P.DELETE_BOXES])
    await open()
    await act(async () => button('Adjust permissions').click())
    const checkbox = (label: string) =>
      document.getElementById(
        [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.htmlFor,
      )!
    await act(async () => checkbox('Operate boxes').click())
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual([P.DELETE_BOXES])
    expect(document.querySelector('input')!.value).toBe('agent')
    expect(document.body.textContent).toContain('The key could not be created')
    await submit()
    expect(mocks.create.mock.calls[1][0].permissions).toEqual([P.DELETE_BOXES])
  })
  it('blocks revoked selections instead of silently changing the request', async () => {
    await render()
    await open()
    await render([P.WRITE_MEMBERS])
    await submit()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('no longer available')
  })
  it('keeps the draft grants when a membership refresh adds permissions', async () => {
    await render([P.READ_APPS])
    await open()
    await render([P.READ_APPS, P.WRITE_APPS])
    expect(document.querySelector('[aria-label="Access"]')!.textContent).toBe('Custom access')
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual([P.READ_APPS])
  })
  it('does not issue two requests for simultaneous submissions', async () => {
    mocks.create.mockImplementation(() => new Promise(() => {}))
    await render()
    await open()
    await act(async () => {
      const form = document.querySelector('form')!
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })
  it('discards a secret after closing and reopening the same organization', async () => {
    let resolve!: (value: unknown) => void
    mocks.create.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    await render()
    await open()
    await submit()
    await act(async () => button('Close').click())
    await open()
    await act(async () => resolve({ value: 'closed-session-secret', permissions: [] }))
    expect(document.body.textContent).not.toContain('closed-session-secret')
  })
  it('blocks blind retries when the outcome is unknown', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Network error'))
    await render()
    await open()
    await submit()
    await submit()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('check the key list')
  })
})

async function openAccessMenu() {
  await act(async () =>
    document
      .querySelector('[aria-label="Access"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
}

function accessOption(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label,
  )
}

async function chooseAccess(label: string) {
  await openAccessMenu()
  const option = accessOption(label)
  expect(option).toBeTruthy()
  await act(async () => option!.click())
}
describe('API key access presets', () => {
  it.each([
    ['Manage box lifecycle', [P.WRITE_BOXES, P.DELETE_BOXES]],
    ['Use boxes with volumes', [P.WRITE_BOXES, P.READ_VOLUMES, P.WRITE_VOLUMES]],
  ] as const)('submits the complete %s bundle without extra grants', async (label, permissions) => {
    await render([...all, P.READ_VOLUMES, P.WRITE_VOLUMES])
    await open()
    await chooseAccess(label)
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual(permissions)
  })
  it('disables a composite preset when any required permission is unavailable', async () => {
    await render([P.WRITE_BOXES, P.READ_VOLUMES])
    await open()
    await openAccessMenu()
    const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
      item.textContent?.startsWith('Use boxes with volumes'),
    )!
    expect(option.getAttribute('aria-disabled')).toBe('true')
    expect(option.textContent).toContain('Manage volumes')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual([P.WRITE_BOXES, P.READ_VOLUMES])
  })
  it('can return to all available permissions after choosing a narrower preset', async () => {
    await render()
    await open()
    await chooseAccess('Operate boxes')
    await chooseAccess('All available permissions')
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual(all)
  })
  it('marks manual changes as custom and replaces the set when choosing a preset', async () => {
    await render()
    await open()
    await act(async () => button('Adjust permissions').click())
    const label = [...document.querySelectorAll('label')].find((item) => item.textContent?.startsWith('Delete boxes'))!
    await act(async () => document.getElementById(label.htmlFor)!.click())
    expect(document.querySelector('[aria-label="Access"]')!.textContent).toBe('Custom access')
    await chooseAccess('Operate boxes')
    await submit()
    expect(mocks.create.mock.calls[0][0].permissions).toEqual([P.WRITE_BOXES])
  })
})

it('preserves the completed secret during a membership refresh', async () => {
  await render()
  await open()
  await submit()
  await act(async () =>
    root.render(
      <CreateApiKeyDialog organizationId="org-1" apiUrl="" availablePermissions={all} permissionsStatus="loading" />,
    ),
  )
  expect(document.body.textContent).toContain('test-secret')
  await render()
  expect(document.body.textContent).toContain('test-secret')
})

it('allows an explicit permanent key with a custom access selection', async () => {
  await render([P.WRITE_BOXES])
  await open()
  await chooseAccess('Custom access')
  expect(document.body.textContent).toContain('Technical scopes')
  await act(async () =>
    document
      .querySelectorAll('[role="combobox"]')[1]
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === 'No expiration',
  )!
  await act(async () => option.click())
  await submit()
  expect(mocks.create.mock.calls[0][0].expiresAt).toBeNull()
  expect(mocks.create.mock.calls[0][0].permissions).toEqual([P.WRITE_BOXES])
})

it.each([
  [403, 'You can no longer grant these permissions'],
  [409, 'A key with this name already exists'],
  [503, 'Creation could not be confirmed'],
])('explains HTTP %s without discarding the name', async (status, message) => {
  mocks.create.mockRejectedValueOnce({ cause: { response: { status } } })
  await render()
  await open()
  await submit()
  expect(document.body.textContent).toContain(message)
  expect(document.querySelector<HTMLInputElement>('input[placeholder="Name"]')!.value).toBe('agent')
})

it('exposes a failed membership retry and keeps submission blocked', async () => {
  const retry = vi.fn().mockRejectedValue(new Error('offline'))
  await act(async () =>
    root.render(
      <CreateApiKeyDialog
        organizationId="org-1"
        apiUrl=""
        availablePermissions={[]}
        permissionsStatus="error"
        onRetryPermissions={retry}
      />,
    ),
  )
  await open()
  await act(async () => button('Refresh permissions').click())
  expect(retry).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('Could not load permissions. Try again.')
  await submit()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('disables creation when the loaded grantable set is empty', async () => {
  await render([])
  await open()
  expect(document.body.textContent).toContain('You have no permissions available to grant.')
  await submit()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('discards an in-flight secret when permissions change and prevents blind retry', async () => {
  let resolve!: (value: unknown) => void
  mocks.create.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  await render()
  await open()
  await submit()
  await render([P.WRITE_BOXES])
  await act(async () => resolve({ value: 'revoked-context-secret', permissions: [P.WRITE_BOXES] }))
  expect(document.body.textContent).not.toContain('revoked-context-secret')
  expect(document.body.textContent).toContain('Permissions changed during creation')
  await submit()
  expect(mocks.create).toHaveBeenCalledTimes(1)
})
