/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { type ComponentProps } from 'react'
import { BannerStack } from './Banner'

function PageLayout({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('group/page flex h-full flex-col', className)} {...props} />
}

function PageHeader({ className, children, ...props }: ComponentProps<'header'>) {
  return (
    <header
      className={cn('page-container flex min-h-10 flex-wrap items-center gap-3 gap-y-3 pt-7 pb-2', className)}
      {...props}
    >
      {children}
    </header>
  )
}

function PageTitle({ className, children, ...props }: ComponentProps<'h1'>) {
  return (
    <h1
      className={cn('text-meta font-medium uppercase tracking-[0.18em] leading-none text-muted-foreground', className)}
      {...props}
    >
      {children}
    </h1>
  )
}

function PageDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-body text-muted-foreground', className)} {...props} />
}

function PageBanner({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="page-banner" className={cn('w-full relative z-30 empty:hidden', className)} {...props}>
      {children}
    </div>
  )
}

function PageContent({ className, ...props }: ComponentProps<'main'>) {
  return (
    <>
      <PageBanner>
        <BannerStack bannerClassName="page-container" />
      </PageBanner>
      <main className={cn('page-container flex flex-col gap-4 pb-8', className)} {...props} />
    </>
  )
}

export { PageContent, PageDescription, PageHeader, PageLayout, PageTitle }
