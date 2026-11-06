// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConsoleTemplatePicker } from './ConsoleTemplatePicker'
const state = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  isError: false,
  canCreate: true,
  memberLoaded: true,
  reload: vi.fn(),
}))
vi.mock('@/hooks/mutations/useCreateBoxMutation', () => ({
  useCreateBoxMutation: () => ({ mutateAsync: state.create, reset: vi.fn(), isPending: false, isError: state.isError }),
}))
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => state.navigate,
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    authenticatedUserHasPermission: () => state.canCreate,
    authenticatedUserOrganizationMember: state.memberLoaded ? { id: 'member-1' } : null,
  }),
}))
let host: HTMLDivElement, root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  state.isError = false
  state.canCreate = true
  state.memberLoaded = true
  vi.stubGlobal('location', { reload: state.reload, assign: state.reload })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function mount(url = '/') {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <ConsoleTemplatePicker />
      </MemoryRouter>,
    ),
  )
}
async function click(label: string) {
  const b = Array.from(host.querySelectorAll('button')).find(
    (e) => e.getAttribute('aria-label') === label || e.textContent === label,
  )!
  await act(async () => b.click())
}
async function input(label: string, value: string) {
  const e = host.querySelector(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, value)
    e.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('creates the chosen public image with its startup settings and navigates to the Box', async () => {
  state.create.mockResolvedValue({ id: 'box-1' })
  await mount()
  await click('Select Node.js')
  await input('Box name', 'my-node')
  await click('Create Box')
  expect(state.create).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'my-node',
      image: expect.stringContaining('node:'),
      resources: expect.objectContaining({ cpu: expect.any(Number) }),
    }),
  )
  expect(state.navigate).toHaveBeenCalledWith(expect.stringContaining('box-1'))
})
it('filters templates, shows empty searches, and blocks invalid names', async () => {
  await mount()
  await input('Search templates', 'no such image')
  expect(host.textContent).toContain('No templates found')
  await input('Search templates', 'Python')
  expect(host.querySelector('[aria-label="Select Python"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Select Node.js"]')).toBeNull()
  await input('Box name', 'invalid name')
  expect(Array.from(host.querySelectorAll('button')).find((e) => e.textContent === 'Create Box')!.disabled).toBe(true)
})
it('keeps the selection and exposes errors when creation fails', async () => {
  state.create.mockRejectedValue(new Error('offline'))
  state.isError = true
  await mount()
  await click('Create Box')
  expect(state.create).toHaveBeenCalledTimes(1)
  expect(state.navigate).not.toHaveBeenCalled()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not complete')
  expect(host.querySelector('[aria-label="Select Python"]')).not.toBeNull()
})
it('creates browser templates without asking the user for a token', async () => {
  state.create.mockResolvedValue({ id: 'browser-1' })
  await mount('/?template=browserless')
  await click('Create Box')
  expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ envVars: { TOKEN: expect.any(String) } }))
})

it('initializes pgvector with a generated PostgreSQL password', async () => {
  state.create.mockResolvedValue({ id: 'db-1' })
  await mount('/?template=pgvector')
  await click('Create Box')
  expect(state.create).toHaveBeenCalledWith(
    expect.objectContaining({ envVars: { POSTGRES_PASSWORD: expect.stringMatching(/.{16,}/) } }),
  )
})

it('retires Coder Universal from selection and search and falls back to Python for old links', async () => {
  state.create.mockResolvedValue({ id: 'python-1' })
  await mount('/?template=coder')
  expect(host.querySelector('[aria-label="Select Coder Universal"]')).toBeNull()
  expect(host.querySelector('[aria-label="Select Python"]')?.getAttribute('aria-pressed')).toBe('true')
  await click('Create Box')
  expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ image: 'docker.io/library/python:3.12-slim' }))
  await input('Search templates', 'coder')
  expect(host.textContent).toContain('No templates found')
})

it('blocks console creation without Box write permission', async () => {
  state.canCreate = false
  await mount()
  const button = Array.from(host.querySelectorAll('button')).find((e) => e.textContent === 'Create Box')!
  expect(button.disabled).toBe(true)
  expect(host.textContent).toContain('You need Box write permission to create a Box.')
  await click('Create Box')
  expect(state.create).not.toHaveBeenCalled()
})

it('offers a page reload when membership is unavailable without claiming denial', async () => {
  state.canCreate = false
  state.memberLoaded = false
  await mount()
  expect(host.textContent).toContain('Permissions are unavailable.')
  expect(host.textContent).not.toContain('You need Box write permission')
  await click('Reload page')
  expect(state.reload).toHaveBeenCalledTimes(1)
  expect(state.create).not.toHaveBeenCalled()
})

it('preserves the console template and name across permission recovery', async () => {
  state.canCreate = false
  state.memberLoaded = false
  await mount('/?from=images')
  await click('Select Node.js')
  await input('Box name', 'my-node')
  await click('Reload page')
  expect(state.reload).toHaveBeenCalledWith(expect.stringContaining('method=console'))
  const destination = new URL(state.reload.mock.calls[0][0], 'https://console.example')
  expect(destination.pathname).toBe('/dashboard/quickstart')
  expect(destination.searchParams.get('from')).toBe('images')
  expect([...destination.searchParams.keys()].sort()).toEqual(['boxName', 'from', 'method', 'template'])
  await act(async () => root.unmount())
  root = createRoot(host)
  await mount(destination.pathname + destination.search)
  expect(host.querySelector('[aria-label="Select Node.js"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelector<HTMLInputElement>('[aria-label="Box name"]')?.value).toBe('my-node')
})
it.each(['', 'invalid name'])('keeps invalid restored name %j blocked', async (name) => {
  await mount('/?boxName=' + encodeURIComponent(name))
  expect(host.querySelector<HTMLInputElement>('[aria-label="Box name"]')?.value).toBe(name)
  expect(Array.from(host.querySelectorAll('button')).find((e) => e.textContent === 'Create Box')!.disabled).toBe(true)
})
