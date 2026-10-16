// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ImageDetails from './ImageDetails'

const V1 = { id: 'ver-1', digest: `sha256:${'a'.repeat(64)}` }
const V2 = { id: 'ver-2', digest: `sha256:${'b'.repeat(64)}` }

const state = vi.hoisted(() => ({ image: undefined as unknown }))

vi.mock('@/hooks/queries/useImagesQuery', () => ({
  useImageQuery: () => ({ data: state.image, isLoading: false, error: null }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ idOrRef: 'img-1' }),
}))

const version = (base: { id: string; digest: string }, extra: Record<string, unknown> = {}) => ({
  ...base,
  sizeBytes: 4096,
  sourceRef: 'quay.io/acme/app:v1',
  aliases: [],
  lastUsedAt: null,
  upstreamMissingAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const image = (extra: Record<string, unknown> = {}) => ({
  id: 'img-1',
  name: 'quay.io/acme/app',
  curated: false,
  curatedRef: null,
  aliases: ['stable', 'v1'],
  versionCount: 2,
  sizeBytes: 8192,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  versions: [
    version(V2, { aliases: ['stable'] }),
    version(V1, { aliases: ['v1'], upstreamMissingAt: '2026-01-03T00:00:00.000Z' }),
  ],
  history: [],
  ...extra,
})

describe('ImageDetails', () => {
  let root: Root | null = null
  let container: HTMLDivElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container.remove()
  })

  const render = () => {
    act(() => {
      root = createRoot(container)
      root.render(<ImageDetails />)
    })
    return container.textContent ?? ''
  }

  /** What a version's row shows under `heading`, so a column is read by itself. */
  const cellOf = (digest: string, heading: string) => {
    // The versions table's header, the only row with a Aliases column: other
    // headings, Last used among them, also label the image's own summary.
    const header = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Aliases')?.parentElement
    const row = container.querySelector(`[title="${digest}"]`)?.closest('div')
    if (!header || !row) {
      throw new Error(`no '${heading}' column, or no row for ${digest}`)
    }
    const column = [...header.children].findIndex((cell) => cell.textContent === heading)
    return row.children[column].textContent
  }

  it('shows where each tag points, and marks a version its registry no longer has', () => {
    state.image = image()

    const text = render()

    expect(cellOf(V2.digest, 'Aliases')).toBe('stable')
    expect(cellOf(V1.digest, 'Aliases')).toBe('v1')
    // Only the version the pull found gone carries the mark.
    expect(container.querySelectorAll('[title^="A pull found it gone"]')).toHaveLength(1)
    expect(text).toContain('Needs a new pull')
  })

  it('shows no last use for a version recorded before it was tracked, rather than never', () => {
    state.image = image({
      versions: [version(V2, { lastUsedAt: '2026-01-02T00:00:00.000Z' }), version(V1)],
    })

    render()

    expect(cellOf(V2.digest, 'Last used')).toMatch(/ago$/)
    expect(cellOf(V1.digest, 'Last used')).toBe('—')
  })

  it('lists the moves of its aliases, naming the versions by digest and a pull as the actor it had', () => {
    state.image = image({
      history: [
        {
          aliasName: 'stable',
          fromVersionId: V1.id,
          toVersionId: V2.id,
          actorId: 'auth0|alice',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          aliasName: 'stable',
          fromVersionId: null,
          toVersionId: V1.id,
          actorId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const text = render()

    expect(text).toContain(`${V1.digest.slice(0, 19)}… → ${V2.digest.slice(0, 19)}…`)
    expect(text).toContain(`new → ${V1.digest.slice(0, 19)}…`)
    expect(text).toContain('auth0|alice')
    expect(text).toContain('a pull')
    expect(text).not.toContain('older ones are not listed')
  })

  it('says older events are left out once the history is as long as the detail carries', () => {
    const event = { aliasName: 'stable', fromVersionId: V1.id, toVersionId: V2.id, actorId: 'auth0|alice' }
    state.image = image({
      history: Array.from({ length: 100 }, (_, index) => ({
        ...event,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
    })

    expect(render()).toContain('Showing the latest 100 events; older ones are not listed.')
  })

  /**
   * The detail of an image with no history still renders. Aliases recorded
   * before history was kept have no event, which is not the same as no tag.
   */
  it('says aliases with no history were recorded before it was kept', () => {
    state.image = image()

    expect(render()).toContain('these aliases were recorded before registration history was kept')
  })

  it('says no tag has been recorded when an image has neither aliases nor history', () => {
    state.image = image({ aliases: [], versions: [version(V1)] })

    expect(render()).toContain('No alias has been recorded yet.')
  })

  it('says a curated image has no aliases to move', () => {
    state.image = image({ curated: true, curatedRef: 'ghcr.io/boxlite-ai/base:1', aliases: [], versions: [] })

    expect(render()).toContain('Curated images have no catalog aliases')
  })
})
