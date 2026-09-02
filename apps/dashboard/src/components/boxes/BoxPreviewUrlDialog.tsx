/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useState } from 'react'

export type BoxPreviewUrlDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** True while anyone with the URL can open it, i.e. the box is public. */
  isPublic: boolean
  /** Resolved URL for the port last submitted, if any. */
  url?: string
  isFetching?: boolean
  error?: string
  onFetchUrl: (port: number) => void
}

/**
 * Asks for a port and returns that port's preview URL.
 *
 * The port has to be asked for: the console cannot enumerate what is listening
 * inside a guest. `POST /exec` returns only an `execution_id` and its output is
 * reachable solely over a WebSocket attach whose `Authorization` header a
 * browser cannot set; neither the box record, the metrics endpoint nor file
 * transfer (which refuses `/proc`) carries port data. Rather than guess with a
 * list of common ports, the port is asked for here, out of the detail sheet
 * until wanted.
 */
export function BoxPreviewUrlDialog({
  open,
  onOpenChange,
  isPublic,
  url,
  isFetching = false,
  error,
  onFetchUrl,
}: BoxPreviewUrlDialogProps) {
  const [value, setValue] = useState('')

  const port = Number(value)
  const valid = Number.isInteger(port) && port > 0 && port <= 65535

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="font-mono sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Get a preview URL</DialogTitle>
          <DialogDescription>
            Make sure a server is already listening on that port inside the box.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) onFetchUrl(port)
          }}
        >
          <label className="text-[13px] text-muted-foreground" htmlFor="preview-url-port">
            port
          </label>
          <Input
            id="preview-url-port"
            autoFocus
            inputMode="numeric"
            placeholder="3000"
            value={value}
            onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
            className="w-[110px] font-mono"
          />
          <Button type="submit" size="sm" disabled={!valid || isFetching}>
            {isFetching ? 'Getting…' : 'Get URL'}
          </Button>
        </form>

        {error ? <p className="text-[12px] text-destructive-foreground">{error}</p> : null}

        {url ? (
          <div className="space-y-2">
            <div className="group/copy-button flex min-w-0 items-center gap-1 border border-border bg-[hsl(var(--code-background))] px-[8px] py-[6px]">
              <span className="min-w-0 flex-1 truncate text-[12px]" title={url}>
                {url.replace(/^https?:\/\//, '')}
              </span>
              <CopyButton value={url} size="icon-xs" tooltipText="Copy URL" className="flex-none" />
            </div>

            {/* Who can use it matters at the moment of copying, which is here
                rather than back on the sheet. */}
            <p className="text-[11px] uppercase tracking-[1px] text-muted-foreground">
              {isPublic ? 'anyone with this url can open it' : 'only your organization can open it'}
            </p>

            {/* Stated here because it cannot be diagnosed afterwards: the URL
                opens in a new tab, so a failure there is invisible to the
                console. A server on 127.0.0.1 is listening but unreachable
                through the tunnel — the most common reason this looks broken. */}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Not loading? Your server has to bind <span className="text-foreground">0.0.0.0</span>, not{' '}
              <span className="text-foreground">127.0.0.1</span>.
            </p>
          </div>
        ) : null}

        {/* `Open` occupies the footer's primary slot and stays disabled until a
            URL exists, so the dialog's main action is the one the user came
            for. Dismissal is the header's × / Escape — a Close button here
            would compete with it for the same slot. */}
        <DialogFooter>
          {url ? (
            <Button asChild size="sm">
              <a href={url} target="_blank" rel="noreferrer noopener">
                Open ↗
              </a>
            </Button>
          ) : (
            <Button size="sm" disabled>
              Open ↗
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
