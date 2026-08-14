/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { SeverityBadge } from '@/components/telemetry/SeverityBadge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BOXLITE_DOCS_URL } from '@/constants/ExternalLinks'
import { cn } from '@/lib/utils'
import { LogEntry } from '@boxlite-ai/api-client'
import { format } from 'date-fns'
import { ChevronDown, FileText, RefreshCw } from '@/components/ui/icon'
import React, { useState } from 'react'

function formatTimestamp(timestamp: string) {
  try {
    return format(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss.SSS')
  } catch {
    return timestamp
  }
}

export function LogTable({
  logs,
  isLoading,
  isError,
  onRetry,
}: {
  logs?: LogEntry[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
}) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null)

  if (isLoading) {
    return (
      <TableShell
        rows={Array.from({ length: 10 }).map((_, i) => (
          <SkeletonRow key={i} index={i} />
        ))}
      />
    )
  }
  if (isError) {
    return (
      <State>
        <EmptyHeader>
          <EmptyTitle>Failed to load logs</EmptyTitle>
          <EmptyDescription>Something went wrong while fetching logs.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      </State>
    )
  }
  if (!logs?.length) {
    return (
      <State>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText className="size-4" />
          </EmptyMedia>
          <EmptyTitle>No logs found</EmptyTitle>
          <EmptyDescription>
            Try adjusting your time range or filters.{' '}
            <a href={`${BOXLITE_DOCS_URL}/en/experimental/otel-collection`} target="_blank" rel="noopener noreferrer">
              Learn more about observability
            </a>
            .
          </EmptyDescription>
        </EmptyHeader>
      </State>
    )
  }

  return (
    <ScrollArea
      fade="mask"
      horizontal
      className="flex-1 min-h-0 border rounded-md [&_[data-slot=scroll-area-viewport]>div]:!overflow-visible [&_[data-slot=scroll-area-viewport]>div>div]:!overflow-visible"
    >
      <Table>
        <LogHeader />
        <TableBody>
          {logs.map((log, index) => (
            <React.Fragment key={`${log.timestamp}-${index}`}>
              <TableRow
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setExpandedRow(expandedRow === index ? null : index)}
              >
                <TableCell>
                  <ChevronDown
                    className={cn('size-4 transition-transform duration-200', expandedRow === index && 'rotate-180')}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">{formatTimestamp(log.timestamp)}</TableCell>
                <TableCell>
                  <SeverityBadge severity={log.severityText} />
                </TableCell>
                <TableCell className="max-w-md truncate font-mono text-xs">{log.body}</TableCell>
              </TableRow>
              {expandedRow === index && (
                <TableRow>
                  <TableCell colSpan={4} className="bg-muted/30 p-4">
                    <LogDetails log={log} />
                  </TableCell>
                </TableRow>
              )}
            </React.Fragment>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  )
}

function TableShell({ rows }: { rows: React.ReactNode[] }) {
  return (
    <div className="flex-1 min-h-0 border rounded-md">
      <Table>
        <LogHeader />
        <TableBody>{rows}</TableBody>
      </Table>
    </div>
  )
}

function LogHeader() {
  return (
    <TableHeader className="sticky top-0 z-10 bg-background">
      <TableRow>
        <TableHead className="w-10" />
        <TableHead className="w-48">Timestamp</TableHead>
        <TableHead className="w-24">Severity</TableHead>
        <TableHead>Message</TableHead>
      </TableRow>
    </TableHeader>
  )
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <TableRow>
      <TableCell>
        <Skeleton className="size-4" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4 w-36" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-14 rounded-full" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-4" style={{ width: `${45 + (index % 4) * 12}%` }} />
      </TableCell>
    </TableRow>
  )
}

function State({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 border rounded-md flex">
      <Empty className="flex-1 border-0">{children}</Empty>
    </div>
  )
}

function LogDetails({ log }: { log: LogEntry }) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium mb-1">Full Message</h4>
        <pre className="text-xs bg-background p-2 rounded overflow-x-auto whitespace-pre-wrap">{log.body}</pre>
      </div>
      {log.traceId && (
        <div>
          <h4 className="text-sm font-medium mb-1">Trace ID</h4>
          <code className="text-xs bg-background p-1 rounded">{log.traceId}</code>
        </div>
      )}
      {log.spanId && (
        <div>
          <h4 className="text-sm font-medium mb-1">Span ID</h4>
          <code className="text-xs bg-background p-1 rounded">{log.spanId}</code>
        </div>
      )}
      {Object.keys(log.logAttributes || {}).length > 0 && (
        <Attributes title="Log attributes" attributes={log.logAttributes} />
      )}
      {Object.keys(log.resourceAttributes || {}).length > 0 && (
        <Attributes title="Resource attributes" attributes={log.resourceAttributes} />
      )}
    </div>
  )
}

function Attributes({ title, attributes }: { title: string; attributes: Record<string, unknown> }) {
  const value = JSON.stringify(attributes, null, 2)
  return (
    <div>
      <h4 className="text-sm font-medium mb-1">{title}</h4>
      <div className="relative">
        <CopyButton value={value} tooltipText="Copy" size="icon-xs" className="absolute top-1.5 right-1.5" />
        <pre className="text-xs bg-background p-2 rounded overflow-x-auto">{value}</pre>
      </div>
    </div>
  )
}
