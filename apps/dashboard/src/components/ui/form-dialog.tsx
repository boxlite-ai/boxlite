import { type ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { DialogContent, DialogHeader, DialogFooter } from './dialog'

/** Bounds the dialog to the viewport while allowing its body to shrink and scroll. */
export function FormDialogContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn(
        'form-dialog flex max-h-[calc(100svh-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]',
        className,
      )}
      {...props}
    />
  )
}

/** Keeps the form title visible above the scrolling fields. */
export function FormDialogHeader({ className, ...props }: ComponentProps<typeof DialogHeader>) {
  return (
    <DialogHeader
      className={cn('form-dialog-header shrink-0 border-b border-border px-6 py-5 text-left', className)}
      {...props}
    />
  )
}

/** Provides the shared scroll region for fields, pricing, and validation messages. */
export function FormDialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('form-dialog-body', className)} {...props} />
}

/** Keeps form actions visible below the scrolling content. */
export function FormDialogFooter({ className, ...props }: ComponentProps<typeof DialogFooter>) {
  return (
    <DialogFooter
      className={cn(
        'form-dialog-footer shrink-0 flex-row justify-end gap-3 border-t border-border px-6 py-4',
        className,
      )}
      {...props}
    />
  )
}
