/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { FlatButton, TEXT_INPUT, DIALOG_FRAME } from './spec'
import { cn } from '@/lib/utils'

// One confirmation for every App screen. It names what the action touches and
// what it leaves alone; irreversible actions ask the user to type the name of
// what they are removing, so a misclick cannot delete an environment.

export interface ConfirmOptions {
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  /** Irreversible: the confirm button stays off until this exact text is typed. */
  typeToConfirm?: string
}

export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [typed, setTyped] = useState('')
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((next: ConfirmOptions) => {
    setTyped('')
    setOptions(next)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = (ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setOptions(null)
  }

  const blocked = !!options?.typeToConfirm && typed !== options.typeToConfirm

  const element = (
    <Dialog open={!!options} onOpenChange={(open) => !open && close(false)}>
      {options && (
        <DialogContent className={cn(DIALOG_FRAME, 'max-w-[480px] font-mono text-body')}>
          <DialogHeader>
            <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">{options.title}</DialogTitle>
          </DialogHeader>
          <div className="text-body leading-[1.6] text-muted-foreground">{options.body}</div>
          {options.typeToConfirm && (
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-muted-foreground">
                Type <span className="text-foreground">{options.typeToConfirm}</span> to confirm
              </span>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !blocked && close(true)}
                className={cn(TEXT_INPUT, 'h-10')}
              />
            </label>
          )}
          <DialogFooter className="gap-1">
            <FlatButton onClick={() => close(false)}>Cancel</FlatButton>
            <FlatButton
              variant={options.danger ? 'dangerSolid' : 'primary'}
              disabled={blocked}
              onClick={() => close(true)}
            >
              {options.confirmLabel}
            </FlatButton>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )

  return [confirm, element]
}
