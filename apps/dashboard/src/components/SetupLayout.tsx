/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LogoText } from '@/assets/Logo'
import { accountSwitchPath } from '@/lib/auth-session'

export function SetupHeader({ showCaption = true, identity }: { showCaption?: boolean; identity?: ReactNode }) {
  return (
    <header className="flex min-h-[60px] items-center justify-between gap-4 border-b border-border px-6 py-3 sm:px-10">
      <LogoText className="h-9 w-auto" />
      {identity ?? (showCaption && <span className="text-label text-muted-foreground">GET STARTED WITH BOXLITE</span>)}
    </header>
  )
}

export function AccountEntryLayout({
  label,
  identity,
  size = 'default',
  centered = false,
  showSetupCaption = false,
  title,
  description,
  descriptionRole,
  children,
  footer,
}: {
  label?: string
  identity?: ReactNode
  size?: 'default' | 'compact'
  centered?: boolean
  showSetupCaption?: boolean
  title: string
  description?: string
  descriptionRole?: 'alert' | 'status'
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className={`min-h-svh bg-background font-sans text-foreground ${centered ? 'flex flex-col' : ''}`}>
      <SetupHeader showCaption={showSetupCaption} identity={identity} />
      <main
        className={`mx-auto w-full px-6 ${centered ? 'my-auto py-12 sm:-translate-y-6' : 'pb-12 pt-12 sm:pt-20'} ${size === 'compact' ? 'max-w-[408px]' : 'max-w-[560px]'}`}
      >
        {label && <p className="mb-4 text-label text-muted-foreground">{label}</p>}
        <h1 className="text-page font-semibold tracking-tight">{title}</h1>
        {description && (
          <p role={descriptionRole} className="mt-3 text-body leading-6 text-muted-foreground">
            {description}
          </p>
        )}
        <div className={size === 'compact' ? 'mt-6' : 'mt-8'}>{children}</div>
        {footer && <div className="mt-10 border-t border-border pt-5">{footer}</div>}
      </main>
    </div>
  )
}

export function SetupLayout(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <AccountEntryLayout
      {...props}
      label="Account setup"
      showSetupCaption
      footer={
        <Link
          to={accountSwitchPath(window.location.pathname + window.location.search)}
          className="text-body text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Use another account
        </Link>
      }
    />
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
