// @vitest-environment jsdom
/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateBoxDialog, resolvePerBoxLimits } from './CreateBoxDialog'
import { validateMountPath, validateMounts } from '@/lib/cloudBox'

// Mutable org returned by the mocked hook; each test sets `state.org`.
const state = vi.hoisted(() => ({ org: null as unknown }))

const mutationMocks = vi.hoisted(() => ({
  createBox: vi.fn(),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: state.org }),
}))
vi.mock('@/hooks/queries/useVolumesQuery', () => ({
  useVolumesQuery: () => ({ data: [{ id: 'vol-1', name: 'subtitle-models', state: 'ready' }] }),
}))
vi.mock('@/hooks/mutations/useCreateBoxMutation', () => ({
  useCreateBoxMutation: () => ({ mutateAsync: mutationMocks.createBox }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

function makeOrg(over: Record<string, unknown>) {
  return { id: 'org-1', name: 'Org', ...over }
}

// Drive a React controlled input the way a user typing would.
function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('resolvePerBoxLimits', () => {
  it('uses the organization per-box maxima when they are positive', () => {
    const limits = resolvePerBoxLimits(makeOrg({ maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }))
    expect(limits).toEqual({ cpu: 4, memory: 8, disk: 10 })
  })

  it('leaves a resource uncapped when a max is unset (<= 0) — backend treats <=0 as unlimited', () => {
    const limits = resolvePerBoxLimits(makeOrg({ maxCpuPerBox: 0, maxMemoryPerBox: undefined, maxDiskPerBox: -1 }))
    expect(limits).toEqual({ cpu: undefined, memory: undefined, disk: undefined })
  })

  it('leaves resources uncapped when no organization is loaded', () => {
    expect(resolvePerBoxLimits(null)).toEqual({ cpu: undefined, memory: undefined, disk: undefined })
    expect(resolvePerBoxLimits(undefined)).toEqual({ cpu: undefined, memory: undefined, disk: undefined })
  })
})

describe('CreateBoxDialog per-org resource cap', () => {
  let root: Root | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.org = makeOrg({ maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function renderOpen() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await rerenderOpen(host)
    // Reveal the CPU/Memory/Disk steppers: Size defaults to the "Small" chip,
    // and "Custom" is what exposes the raw fields. Scoped to the Size group —
    // Lifecycle has its own identically-labelled "Custom" chip.
    const sizeGroup = document.querySelector('[aria-label="Size"]')
    const custom = sizeGroup
      ? [...sizeGroup.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Custom/.test(b.textContent ?? ''))
      : undefined
    await act(async () => custom?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
  }

  async function rerenderOpen(
    host = document.body.firstElementChild ?? document.body.appendChild(document.createElement('div')),
  ) {
    await act(async () => {
      root ??= createRoot(host)
      root.render(<CreateBoxDialog open onOpenChange={() => {}} />)
    })
    await flush()
  }

  async function rerenderOpenWith(props: { prefillVolume?: string }) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root ??= createRoot(host)
      root.render(<CreateBoxDialog open onOpenChange={() => {}} {...props} />)
    })
    await flush()
  }

  function cpuInput() {
    return document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')[0]
  }

  function nameInput() {
    return document.querySelector<HTMLInputElement>('input[placeholder="my-new-box"]')
  }

  it('clamps an over-max CPU input to the org maximum and shows a red contact-support hint', async () => {
    await renderOpen()
    const input = cpuInput()
    expect(input).toBeTruthy()

    await act(async () => typeInto(input, '50'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    // auto-corrected to the org max (4), not any dashboard-local ceiling.
    expect(input.value).toBe('4')
    // the amber cap note names the capped resource + its max and the support mailbox
    expect(document.body.textContent).toContain('support@boxlite.ai')
    expect(document.body.textContent).toMatch(/CPU\s*4\s*vCPU/)
    const mailto = document.querySelector('a[href^="mailto:support@boxlite.ai"]')
    expect(mailto).toBeTruthy()
  })

  it('opens with the default values already clamped to the org max (no over-limit initial state)', async () => {
    // Org caps Disk at 3 GiB — tighter than the built-in DEFAULTS.disk = 10.
    state.org = makeOrg({ maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 3 })
    await renderOpen()
    const inputs = document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')
    // Disk (the third stepper) must open at 3, NOT the DEFAULTS.disk of 10.
    expect(inputs[2].value).toBe('3')
    // CPU / Memory defaults (1 each) are already under the caps — untouched.
    expect(inputs[0].value).toBe('1')
    expect(inputs[1].value).toBe('1')
  })

  it('pins the visible input at the org max the moment the typed value would overshoot (before any blur)', async () => {
    await renderOpen()
    const input = cpuInput()

    // No blur / focusout — this asserts the keystroke-time behaviour, which is
    // the fix for "the box still shows 123123 even with the amber note up".
    await act(async () => typeInto(input, '123123'))
    await flush()
    expect(input.value).toBe('4')
    expect(document.body.textContent).toContain('support@boxlite.ai')
    expect(document.body.textContent).toMatch(/CPU\s*4\s*vCPU/)
  })

  it('does not pin the input to a dashboard-local ceiling when the org max is unset', async () => {
    state.org = makeOrg({ maxCpuPerBox: 0, maxMemoryPerBox: undefined, maxDiskPerBox: -1 })
    await renderOpen()
    const input = cpuInput()

    await act(async () => typeInto(input, '123123'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    expect(input.value).toBe('123123')
    expect(document.body.textContent).not.toContain('support@boxlite.ai')
  })

  it('preserves open form state when an org change only tightens resource caps', async () => {
    await renderOpen()
    const name = nameInput()
    const input = cpuInput()

    expect(name).toBeTruthy()
    if (!name) throw new Error('expected name input to be rendered')
    await act(async () => typeInto(name, 'kept-name'))
    await act(async () => typeInto(input, '4'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    state.org = makeOrg({ maxCpuPerBox: 2, maxMemoryPerBox: 8, maxDiskPerBox: 10 })
    await rerenderOpen()

    expect(nameInput()?.value).toBe('kept-name')
    expect(document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]').length).toBe(3)
    expect(cpuInput().value).toBe('2')
    expect(document.body.textContent).toMatch(/CPU\s*2\s*vCPU/)
  })

  it('caps each of the three resource fields independently against its own max', async () => {
    await renderOpen()
    const inputs = document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')
    expect(inputs.length).toBe(3)

    for (const input of Array.from(inputs)) {
      await act(async () => typeInto(input, '999999'))
      await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
      await flush()
    }

    // Org limits from beforeEach: cpu 4, memory 8, disk 10
    expect(inputs[0].value).toBe('4')
    expect(inputs[1].value).toBe('8')
    expect(inputs[2].value).toBe('10')

    const note = document.body.textContent ?? ''
    expect(note).toMatch(/CPU\s*4\s*vCPU/)
    expect(note).toMatch(/Memory\s*8\s*GiB/)
    expect(note).toMatch(/Disk\s*10\s*GiB/)
  })

  // Size presets replaced the old collapsed "Advanced Options" toggle — this
  // pins that picking a named tier actually drives the three underlying values.
  it("applies a Size preset's cpu/memory/disk", async () => {
    await rerenderOpen()
    const sizeGroup = document.querySelector('[aria-label="Size"]')
    if (!sizeGroup) throw new Error('expected the Size group to be rendered')
    const medium = [...sizeGroup.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Medium',
    )
    expect(medium).toBeTruthy()

    await act(async () => medium?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(document.body.textContent).toMatch(/2 vCPU.*4 GiB.*10 GiB/)
  })

  // Regression guard for the Size preset clamp: picking "Large" (4/8/50) against
  // a tighter org cap must clamp immediately and say so, not leave the screen
  // showing a number the org will reject on submit.
  it('clamps a Size preset that exceeds the org cap and explains why immediately', async () => {
    state.org = makeOrg({ maxCpuPerBox: 2, maxMemoryPerBox: 8, maxDiskPerBox: 10 })
    await rerenderOpen()
    const sizeGroup = document.querySelector('[aria-label="Size"]')
    if (!sizeGroup) throw new Error('expected the Size group to be rendered')
    const large = [...sizeGroup.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Large')

    await act(async () => large?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    // Large asks for 4 vCPU; the org caps at 2 — clamped, not silently dropped.
    expect(document.body.textContent).toMatch(/2 vCPU.*8 GiB.*10 GiB/)
    expect(document.body.textContent).toContain('support@boxlite.ai')
    expect(document.body.textContent).toMatch(/CPU\s*2\s*vCPU/)
  })

  it('clears the hint once the value is brought back under the max', async () => {
    await renderOpen()
    const input = cpuInput()
    await act(async () => typeInto(input, '50'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()
    expect(document.body.textContent).toContain('support@boxlite.ai')

    const decrease = document.querySelector<HTMLButtonElement>('button[aria-label="decrease"]')
    await act(async () => decrease?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(input.value).toBe('3')
    expect(document.body.textContent).not.toContain('support@boxlite.ai')
  })

  // Radix's DropdownMenuTrigger opens on `pointerdown`, not `click` (see
  // @radix-ui/react-dropdown-menu's Trigger) — a plain click dispatch leaves it
  // closed. jsdom has no PointerEvent constructor, but React only reads
  // `button`/`ctrlKey` off the event, so a MouseEvent typed as 'pointerdown'
  // satisfies it. Selecting an item, in contrast, *is* a plain click
  // (@radix-ui/react-menu's Item).
  async function openDropdown(ariaLabel: string) {
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`)
    expect(trigger).toBeTruthy()
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
    )
    await flush()
  }

  async function selectMenuItem(text: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === text)
    expect(item).toBeTruthy()
    await act(async () => item?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()
  }

  async function submit() {
    const createButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Create Box',
    )
    expect(createButton?.disabled).toBe(false)
    await act(async () => createButton?.click())
    await flush()
  }

  it('defaults auto-resume to enabled and submits the toggle state with create params', async () => {
    await renderOpen()

    const name = nameInput()
    expect(name).toBeTruthy()
    if (!name) throw new Error('expected name input to be rendered')
    await act(async () => typeInto(name, 'resume-test'))

    const autoResumeSwitch = document.querySelector<HTMLButtonElement>('button[aria-label="Wake on access"]')
    expect(autoResumeSwitch).toBeTruthy()
    expect(autoResumeSwitch?.getAttribute('data-state')).toBe('checked')

    await act(async () => autoResumeSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(autoResumeSwitch?.getAttribute('data-state')).toBe('unchecked')

    await submit()

    expect(mutationMocks.createBox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'resume-test',
        autoResume: false,
      }),
    )
  })

  it('defaults to stop-when-idle with no auto-delete, matching the previous defaults', async () => {
    await renderOpen()
    await submit()

    expect(mutationMocks.createBox).toHaveBeenCalledWith(
      expect.objectContaining({ autoStopIntervalSeconds: 900, autoDelete: 0, autoResume: true }),
    )
  })

  // The delete is entered as a delay *after* the stop, so the absolute value the
  // API receives is always strictly later than the stop threshold — the
  // relationship `validateLifecyclePolicy` enforces cannot be violated from the
  // UI, which is why the Create button no longer needs to block on it.
  it('submits auto-delete as an absolute value strictly later than auto-stop', async () => {
    await renderOpen()

    await openDropdown('Delete after stopping')
    await selectMenuItem('1 hour')

    await submit()

    const params = mutationMocks.createBox.mock.calls.at(-1)?.[0]
    expect(params.autoStopIntervalSeconds).toBe(900)
    // 15m stop + the 1h delay picked above.
    expect(params.autoDelete).toBe(900 + 3600)
    expect(params.autoDelete).toBeGreaterThan(params.autoStopIntervalSeconds)
  })

  // Stop/Delete are already plain-English rows with real values ("15 min",
  // "1 hour") — a third line re-deriving their sum, plus a raw `auto_delete=`
  // payload line, restated what those two rows already say. Cut entirely
  // rather than reworded; the submitted value is covered by the test above.
  it('does not restate the stop+delay sum or the raw auto_delete payload', async () => {
    await renderOpen()

    await openDropdown('Delete after stopping')
    await selectMenuItem('1 hour')

    expect(document.body.textContent).not.toContain('Deletes')
    expect(document.body.textContent).not.toContain('auto_delete=')
  })

  // "Never" (0) must be reachable only by deliberately picking it from a fixed
  // list — the whole point of moving off free text was to make the old bug
  // (clearing an input to retype silently sent 0) structurally impossible.
  it('sends auto_stop=0 when "Never" is deliberately selected, and only then', async () => {
    await renderOpen()
    await submit()
    expect(mutationMocks.createBox.mock.calls.at(-1)?.[0].autoStopIntervalSeconds).toBe(900)

    await openDropdown('Stop when idle')
    await selectMenuItem('Never')
    await submit()

    expect(mutationMocks.createBox.mock.calls.at(-1)?.[0].autoStopIntervalSeconds).toBe(0)
  })

  // Delete is framed as "after stopping" only while a stop is set; with Stop
  // on "Never" there is no stop to be after, so the label switches to the
  // idle-relative framing instead — same field, same aria-label, different copy.
  it('relabels the delete field to "when idle" once Stop is set to Never', async () => {
    await renderOpen()
    await openDropdown('Stop when idle')
    await selectMenuItem('Never')

    expect(document.body.textContent).toContain('Delete when idle')
    expect(document.body.textContent).not.toContain('Delete after stopping')
  })

  // The mount path rules are enforced server-side; replicating them in the form
  // is only useful if the replica actually matches, so pin the set that must be
  // rejected against apps/api/src/box/utils/volume-mount-path-validation.util.ts.
  it('rejects exactly the mount paths the API rejects', () => {
    expect(validateMountPath('/data')).toBeNull()
    expect(validateMountPath('/mnt/models')).toBeNull()

    expect(validateMountPath('')).toBeTruthy()
    expect(validateMountPath('data')).toBeTruthy() // not absolute
    expect(validateMountPath('/')).toBeTruthy()
    expect(validateMountPath('//')).toBeTruthy()
    expect(validateMountPath('/a/../b')).toBeTruthy()
    expect(validateMountPath('/a/./b')).toBeTruthy()
    expect(validateMountPath('/a//b')).toBeTruthy()
    for (const dir of ['/proc', '/sys', '/dev', '/boot', '/etc', '/bin', '/sbin', '/lib', '/lib64']) {
      expect(validateMountPath(dir)).toBeTruthy()
      expect(validateMountPath(`${dir}/nested`)).toBeTruthy()
    }
  })

  it('refuses two volumes on one mount path', () => {
    expect(
      validateMounts([
        { volumeId: 'a', mountPath: '/data' },
        { volumeId: 'b', mountPath: '/data' },
      ]),
    ).toMatch(/mount path/i)
    expect(
      validateMounts([
        { volumeId: 'a', mountPath: '/data' },
        { volumeId: 'b', mountPath: '/models' },
      ]),
    ).toBeNull()
  })

  // Mounts exist only at create time, so whatever the form holds has to reach
  // the create call — there is no later chance to attach it.
  it('submits the mounts it was pre-filled with', async () => {
    await rerenderOpenWith({ prefillVolume: 'vol-1' })

    const name = nameInput()
    if (!name) throw new Error('expected name input to be rendered')
    await act(async () => typeInto(name, 'with-volume'))

    await submit()

    expect(mutationMocks.createBox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'with-volume',
        volumes: [{ volumeId: 'vol-1', mountPath: '/data' }],
      }),
    )
  })

  // Data-loss guard, not a preference. The API validates a mount by id OR name
  // but persists the string verbatim, while its delete guard matches
  // `box.volumes @> [{volumeId: <uuid>}]`. Submitting the name would store a
  // value that guard cannot see, letting a mounted volume be deleted with no
  // 409 — so picking from the list must yield the id.
  it('submits the volume id, never the display name', async () => {
    await rerenderOpen()

    const addMount = [...document.querySelectorAll('button')].find((b) => /Mount a volume/.test(b.textContent ?? ''))
    await act(async () => addMount?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    await openDropdown('Volume')
    await selectMenuItem('subtitle-models')

    const name = nameInput()
    if (!name) throw new Error('expected name input to be rendered')
    await act(async () => typeInto(name, 'picked-from-list'))
    await submit()

    const params = mutationMocks.createBox.mock.calls.at(-1)?.[0]
    expect(params.volumes).toEqual([{ volumeId: 'vol-1', mountPath: '/data' }])
    expect(JSON.stringify(params.volumes)).not.toContain('subtitle-models')
  })

  it('explains a volume without restating what Disk above already says', async () => {
    await rerenderOpen()
    expect(document.body.textContent).toContain('A volume persists independently of this box')
    expect(document.body.textContent).not.toContain('scratch space')
  })

  // "Custom…" is a per-field escape hatch for a value the fixed list doesn't
  // cover — not a second bundled-preset system. Picking it must swap in a
  // plain amount+unit entry and actually change what gets submitted.
  it('lets Stop when idle take an arbitrary value via "Custom…"', async () => {
    await renderOpen()

    await openDropdown('Stop when idle')
    await selectMenuItem('Custom…')

    const stopInput = document.querySelector<HTMLInputElement>('input[aria-label="Stop when idle"]')
    expect(stopInput).toBeTruthy()
    if (!stopInput) throw new Error('expected the custom stop input to be rendered')

    await act(async () => typeInto(stopInput, '45'))
    await act(async () => stopInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    await submit()

    const params = mutationMocks.createBox.mock.calls.at(-1)?.[0]
    expect(params.autoStopIntervalSeconds).toBe(45 * 60)
  })

  // After committing a custom value, the control must revert to its normal
  // dropdown form (not stay stuck in text-entry mode) so the field still reads
  // and behaves like the others once a value is set.
  it('returns to dropdown form after a custom value is committed, showing that value', async () => {
    await renderOpen()

    await openDropdown('Stop when idle')
    await selectMenuItem('Custom…')
    const stopInput = document.querySelector<HTMLInputElement>('input[aria-label="Stop when idle"]')
    if (!stopInput) throw new Error('expected the custom stop input to be rendered')
    await act(async () => typeInto(stopInput, '45'))
    await act(async () => stopInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Stop when idle"]')
    expect(trigger).toBeTruthy()
    expect(trigger?.textContent).toBe('45m')
  })
})
