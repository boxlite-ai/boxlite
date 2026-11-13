// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Box, BoxState, BoxProgressPhase } from '@boxlite-ai/api-client'
import { BoxStatusIndicator } from './box-presentation'

it.each([
  [BoxState.STARTED, 'Running'],
  [BoxState.STOPPED, 'Stopped'],
  [BoxState.ERROR, 'Error'],
  [BoxState.CREATING, 'Starting'],
  [BoxState.STARTING, 'Starting'],
  [BoxState.RESTORING, 'Starting'],
  [BoxState.STOPPING, 'Stopping'],
  [BoxState.DESTROYING, 'Deleting'],
  [BoxState.RESIZING, 'Resizing'],
  [BoxState.DESTROYED, 'Deleted'],
  [undefined, 'Unknown'],
  ['future_state', 'Future state'],
])('keeps lifecycle %s readable independently of icon color', (state, expected) => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<BoxStatusIndicator box={{ state } as Box} />)
  expect(host.textContent).toBe(expected)
  expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull()
})
it('distinguishes pulling an image from starting the box', () => {
  const markup = renderToStaticMarkup(
    <BoxStatusIndicator
      box={{ state: BoxState.CREATING, progress: { phase: BoxProgressPhase.PREPARING_IMAGE } } as Box}
    />,
  )
  expect(markup).toContain('Pulling image')
})
