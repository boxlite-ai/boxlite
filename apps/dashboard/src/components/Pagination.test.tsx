// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getCoreRowModel, getPaginationRowModel, useReactTable } from '@tanstack/react-table'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { Pagination } from './Pagination'

const data = Array.from({ length: 53 }, (_, id) => ({ id }))
const columns = [{ accessorKey: 'id' }]
function MemberList() {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
  })
  return (
    <>
      <output>
        {table
          .getRowModel()
          .rows.map((row) => row.original.id)
          .join(',')}
      </output>
      <Pagination table={table} entityName="Members" />
    </>
  )
}
let root: Root | undefined
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})
it('connects shared navigation to the actual TanStack page state and boundaries', () => {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
    root.render(<MemberList />)
  })
  const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  expect(host.textContent).toContain('Members: 53')
  expect(button('Previous').disabled).toBe(true)
  act(() => button('Next').click())
  expect(host.querySelector('output')?.textContent).toMatch(/^25,26/)
  expect(host.textContent).toContain('Page 2 of 3')
  act(() => button('Last').click())
  expect(host.querySelector('output')?.textContent).toBe('50,51,52')
  expect(button('Next').disabled).toBe(true)
  act(() => button('First').click())
  expect(host.querySelector('output')?.textContent).toMatch(/^0,1,2/)
  expect(button('First').disabled).toBe(true)
})
