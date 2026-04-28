/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { type ComponentProps } from 'react'
import { BannerStack } from './Banner'

type PageSize = 'default' | 'full'

function PageLayout({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('group/page flex h-full flex-col', className)} {...props} />
}

function PageHeader({
  className,
  children,
  size = 'default',
  ...props
}: ComponentProps<'header'> & { size?: PageSize }) {
  return (
    <header
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-3 gap-y-3 px-4 pt-7 pb-2 sm:px-5 2xl:px-0',
        {
          'mx-auto max-w-[960px]': size === 'default',
          'mx-auto max-w-[1440px]': size === 'full',
        },
        className,
      )}
      {...props}
    >
      {children}
    </header>
  )
}

function PageTitle({ className, children, ...props }: ComponentProps<'h1'>) {
  return (
    <h1
      className={cn(
        'text-[11px] font-medium uppercase tracking-[0.18em] leading-none text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </h1>
  )
}

function PageDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function PageBanner({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="page-banner" className={cn('w-full relative z-30 empty:hidden', className)} {...props}>
      {children}
    </div>
  )
}

function PageContent({ className, size = 'default', ...props }: ComponentProps<'main'> & { size?: PageSize }) {
  return (
    <>
      <PageBanner>
        <BannerStack bannerClassName={cn({ 'max-w-5xl mx-auto': size === 'default' })} />
      </PageBanner>
      <main
        className={cn(
          'flex w-full flex-col gap-4 px-4 pb-8 sm:px-5 2xl:px-0',
          {
            'mx-auto max-w-[960px]': size === 'default',
            'mx-auto max-w-[1440px]': size === 'full',
          },
          className,
        )}
        {...props}
      />
    </>
  )
}

export { PageContent, PageDescription, PageHeader, PageLayout, PageTitle }
