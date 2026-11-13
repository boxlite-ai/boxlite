/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { type ReactNode } from 'react'
import { AsciiButton } from '@/components/ascii'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from '@/components/ui/icon'
import { PAGE_SIZE_OPTIONS } from '@/constants/Pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Shared presentation; callers own fetching, totals and recovery semantics. */
export function ResourcePagination({
  pageIndex,
  pageSize,
  pageCount,
  totalItems,
  isPagingLocked = false,
  isPageFetching = false,
  itemRangeLabel,
  onPaginationChange,
}: {
  pageIndex: number
  pageSize: number
  pageCount: number
  totalItems: number
  isPagingLocked?: boolean
  isPageFetching?: boolean
  itemRangeLabel: ReactNode
  onPaginationChange: (pagination: { pageIndex: number; pageSize: number }) => void
}) {
  const canPrev = pageIndex > 0
  const canNext = pageCount > 0 && pageIndex < pageCount - 1
  const goTo = (index: number) => {
    if (!isPagingLocked && index >= 0 && index !== pageIndex && (index < pageCount || index < pageIndex))
      onPaginationChange({ pageIndex: index, pageSize })
  }
  const handlePageSizeChange = (value: string) => {
    const size = Number(value)
    if (!isPagingLocked && Number.isFinite(size) && size > 0 && size !== pageSize)
      onPaginationChange({ pageIndex: 0, pageSize: size })
  }
  if (totalItems === 0 && pageIndex === 0 && !isPagingLocked) return null
  return (
    <div className="flex flex-none flex-col gap-3 px-0 py-4 font-mono text-meta text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <span>{itemRangeLabel}</span>
        <div className="flex items-center gap-2">
          <span className="normal-case tracking-normal">Show</span>
          <Select value={`${pageSize}`} onValueChange={handlePageSizeChange} disabled={isPagingLocked}>
            <SelectTrigger
              aria-label="Rows per page"
              size="sm"
              className="h-8 w-[76px] border-border bg-background px-2 font-mono text-meta"
              loading={isPagingLocked}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={`${option}`}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="normal-case tracking-normal">per page</span>
        </div>
      </div>
      <div className="flex items-center gap-[7px]">
        <span className="inline-flex min-w-[92px] items-center justify-end gap-1 normal-case tracking-normal">
          {isPageFetching ? (
            <>
              <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              Loading page {pageIndex + 1}
            </>
          ) : (
            `Page ${pageIndex + 1}${pageCount > 0 ? ` of ${pageCount}` : ''}`
          )}
        </span>
        {(pageCount > 1 || pageIndex > 0) && (
          <>
            <PagerButton disabled={isPagingLocked || !canPrev} title="First" onClick={() => goTo(0)}>
              <ChevronsLeft className="size-3.5" />
            </PagerButton>
            <PagerButton disabled={isPagingLocked || !canPrev} title="Previous" onClick={() => goTo(pageIndex - 1)}>
              <ChevronLeft className="size-3.5" />
            </PagerButton>
            <PagerButton disabled={isPagingLocked || !canNext} title="Next" onClick={() => goTo(pageIndex + 1)}>
              <ChevronRight className="size-3.5" />
            </PagerButton>
            <PagerButton disabled={isPagingLocked || !canNext} title="Last" onClick={() => goTo(pageCount - 1)}>
              <ChevronsRight className="size-3.5" />
            </PagerButton>
          </>
        )}
      </div>
    </div>
  )
}

function PagerButton({
  disabled,
  title,
  onClick,
  children,
}: {
  disabled: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <AsciiButton size="icon" className="size-9" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </AsciiButton>
  )
}
