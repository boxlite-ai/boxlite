/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useTheme } from '@/contexts/ThemeContext'
import { AlertTriangle, CheckCircle, Info, XCircle } from '@/components/ui/icon'
import { Toaster as Sonner } from 'sonner'

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <CheckCircle className="size-4 text-success" />,
        error: <XCircle className="size-4 text-destructive" />,
        warning: <AlertTriangle className="size-4 text-warning" />,
        info: <Info className="size-4 text-foreground" />,
      }}
      toastOptions={{
        classNames: {
          // Square corners + mono font + bordered popover surface — matches the ASCII/terminal shell.
          toast:
            'group toast font-mono rounded-none group-[.toaster]:rounded-none group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: '!text-muted-foreground',
          actionButton: 'rounded-none group-[.toast]:rounded-none group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'rounded-none group-[.toast]:rounded-none group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          closeButton: 'rounded-none group-[.toast]:rounded-none group-[.toast]:border',
        },
      }}
      closeButton
      {...props}
    />
  )
}

export { Toaster }
