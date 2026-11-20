// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Workbench } from './SubNav'

it('App secondary screens link tabs to panels and mount only the selected screen', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function Screen({ name }: { name: string }) {
    useEffect(() => {
      mounted(name)
      return () => unmounted(name)
    }, [name])
    return <p>{name} content</p>
  }
  function Example() {
    const [value, setValue] = useState('history')
    return (
      <Workbench
        items={[
          { id: 'history', label: 'History' },
          { id: 'services', label: 'Services' },
          { id: 'blocked', label: 'Blocked', disabled: true },
        ]}
        value={value}
        onChange={setValue}
      >
        <Screen name={value} />
      </Workbench>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<Example />))
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panel = host.querySelector('[role="tabpanel"][data-state="active"]')!
    expect(tabs[0].getAttribute('aria-controls')).toBe(panel.id)
    expect(mounted.mock.calls).toEqual([['history']])
    act(() => tabs[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(host.textContent).toContain('services content')
    expect(host.textContent).not.toContain('history content')
    expect(unmounted).toHaveBeenCalledWith('history')
    expect(mounted.mock.calls).toEqual([['history'], ['services']])
    expect(tabs[2].disabled).toBe(true)
    expect(mounted).not.toHaveBeenCalledWith('blocked')
    expect(tabs[1].getAttribute('aria-controls')).toBe(host.querySelector('[role="tabpanel"][data-state="active"]')!.id)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
