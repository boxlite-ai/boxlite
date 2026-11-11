/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-none border border-transparent font-mono text-meta font-medium leading-none shadow-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary font-semibold text-primary-foreground hover:[&:not(:disabled)]:opacity-85',
        destructive: 'bg-destructive-solid font-semibold text-white hover:[&:not(:disabled)]:opacity-85',
        outline:
          'border-border bg-transparent text-foreground hover:[&:not(:disabled)]:border-brand hover:[&:not(:disabled)]:bg-card aria-expanded:[&:not(:disabled)]:border-brand aria-expanded:[&:not(:disabled)]:bg-card',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:[&:not(:disabled)]:border-brand',
        danger:
          'border-border bg-transparent text-destructive hover:[&:not(:disabled)]:border-destructive hover:[&:not(:disabled)]:bg-destructive/10',
        ghost: 'border-transparent hover:[&:not(:disabled)]:bg-accent hover:[&:not(:disabled)]:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:[&:not(:disabled)]:underline',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-7 gap-1.5 px-2.5 text-meta',
        lg: 'h-10 px-6',
        icon: 'size-9',
        'icon-xs': 'size-6 text-meta',
        'icon-sm': 'size-7 p-0',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

type ButtonProps = React.ComponentPropsWithoutRef<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

/**
 * Owns shared action styles while forwarding native props and the DOM ref.
 * With asChild, Radix Slot composes them onto the supplied navigation or trigger element.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'

  return <Comp ref={ref} data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
})

export { Button, buttonVariants }
