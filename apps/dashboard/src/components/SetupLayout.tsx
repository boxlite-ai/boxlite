/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LogoText } from '@/assets/Logo'
import { RoutePath } from '@/enums/RoutePath'

export function SetupHeader() {
  return (
    <header className="flex min-h-[60px] items-center justify-between gap-4 border-b border-border px-6 py-3 sm:px-10">
      <LogoText className="h-9 w-auto" />
      <span className="text-label text-muted-foreground">GET STARTED WITH BOXLITE</span>
    </header>
  )
}

export function SetupLayout({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="min-h-svh bg-background font-sans text-foreground">
      <SetupHeader />
      <main className="mx-auto w-full max-w-[560px] px-6 pb-12 pt-12 sm:pt-20">
        <p className="mb-4 text-label text-muted-foreground">Account setup</p>
        <h1 className="text-page font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-body leading-6 text-muted-foreground">{description}</p>
        <div className="mt-8">{children}</div>
        <div className="mt-10 border-t border-border pt-5">
          <Link
            to={RoutePath.LOGOUT}
            className="text-body text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Use another account
          </Link>
        </div>
      </main>
    </div>
  )
}

export function SetupPending({ title = 'Preparing your organization' }: { title?: string }) {
  return (
    <SetupLayout title={title} description="We’re checking your account and finding your next step.">
      <p role="status" className="flex items-center gap-3 text-body text-muted-foreground">
        <span aria-hidden className="size-3 border border-current motion-safe:animate-pulse" />
        Please wait…
      </p>
    </SetupLayout>
  )
}
