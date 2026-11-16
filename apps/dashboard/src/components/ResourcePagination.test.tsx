// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ResourcePagination } from './ResourcePagination'
let root: Root
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})
function render(pageIndex: number, pageCount: number, totalItems: number, locked = false, showPageSizeSelector = true) {
  const host = document.createElement('div')
  document.body.append(host)
  const change = vi.fn()
  act(() => {
    root = createRoot(host)
    root.render(
      <ResourcePagination
        pageIndex={pageIndex}
        pageSize={25}
        pageCount={pageCount}
        totalItems={totalItems}
        isPagingLocked={locked}
        itemRangeLabel="Records"
        showPageSizeSelector={showPageSizeSelector}
        onPaginationChange={change}
      />,
    )
  })
  return { host, change }
}
it('omits pagination for a confirmed empty first page', () => {
  expect(render(0, 0, 0).host.textContent).toBe('')
})
it('keeps page size but no arrows for a single page', () => {
  const { host } = render(0, 1, 7)
  expect(host.querySelector('[aria-label="Rows per page"]')).not.toBeNull()
  expect(host.querySelector('[title="Next"]')).toBeNull()
})
it('can recover from an empty later page even when page count is unavailable', () => {
  const { host, change } = render(2, 0, 0)
  expect(host.textContent).toContain('Page 3')
  expect(host.textContent).not.toContain('of 1')
  act(() => host.querySelector<HTMLButtonElement>('[title="Previous"]')!.click())
  expect(change).toHaveBeenCalledWith({ pageIndex: 1, pageSize: 25 })
})
it('locks pagination during replacement requests', () => {
  const { host, change } = render(1, 3, 60, true)
  act(() => host.querySelector<HTMLButtonElement>('[title="Next"]')!.click())
  expect(change).not.toHaveBeenCalled()
})
it('keeps fixed-size paging without offering unsupported page sizes', () => {
  const { host, change } = render(0, 2, 26, false, false)
  expect(host.querySelector('[aria-label="Rows per page"]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[title="Next"]')!.click())
  expect(change).toHaveBeenCalledWith({ pageIndex: 1, pageSize: 25 })
})
