// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from './dialog'

it('honors showCloseButton without removing dialog content', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <Dialog open>
          <DialogContent showCloseButton={false} aria-describedby={undefined}>
            <DialogTitle>Create resource</DialogTitle>
          </DialogContent>
        </Dialog>,
      ),
    )
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
