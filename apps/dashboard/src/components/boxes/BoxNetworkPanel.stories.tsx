/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Meta, StoryObj } from '@storybook/react'
import { useState, type ReactNode } from 'react'
import { BoxNetworkPanel } from './BoxNetworkPanel'

/**
 * Reproduces the real detail-page column: 340px wide, monospace 13px, and the
 * neighbouring spec sections. Without this the section renders in a vacuum and
 * you cannot tell whether it belongs on the page.
 */
function SidebarContext({ children }: { children: ReactNode }) {
  return (
    <div className="w-[340px] bg-background px-4 py-4 font-mono text-[13px] text-foreground">
      <div className="mb-[10px] mt-0 flex items-center gap-[9px]">
        <span className="size-[6px] flex-none bg-brand" />
        <span className="text-[11px] uppercase tracking-[2px]">general</span>
        <span className="flex-1 border-t border-dashed border-border" />
      </div>
      {[
        ['box id', 'aB3cD4eF5gH6'],
        ['image', 'boxlite/base'],
        ['region', 'US'],
      ].map(([label, value]) => (
        <div key={label} className="mb-[6px] flex items-baseline gap-2">
          <span className="whitespace-nowrap text-muted-foreground">{label}</span>
          <span className="-translate-y-1 flex-1 border-b border-dotted border-border" />
          <span className="min-w-0 max-w-[66%] truncate text-right">{value}</span>
        </div>
      ))}
      {children}
      <div className="mb-[10px] mt-[34px] flex items-center gap-[9px]">
        <span className="size-[6px] flex-none bg-brand" />
        <span className="text-[11px] uppercase tracking-[2px]">activity</span>
        <span className="flex-1 border-t border-dashed border-border" />
      </div>
      <div className="mb-[6px] flex items-baseline gap-2">
        <span className="whitespace-nowrap text-muted-foreground">created</span>
        <span className="-translate-y-1 flex-1 border-b border-dotted border-border" />
        <span className="text-right">2 hours ago</span>
      </div>
    </div>
  )
}

const meta: Meta<typeof BoxNetworkPanel> = {
  title: 'Boxes/BoxNetworkPanel',
  component: BoxNetworkPanel,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <SidebarContext>
        <Story />
      </SidebarContext>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof BoxNetworkPanel>

const noop = () => {}

/** The default: preview URLs require an organization sign-in. */
export const Restricted: Story = {
  name: '1 · Restricted to the organization',
  args: { isPublic: false, canManage: true, onTogglePublic: noop, onGetUrl: noop },
}

/** Anonymous access, so the value is the only amber thing on the sheet. */
export const Public: Story = {
  name: '2 · Public',
  args: { isPublic: true, canManage: true, onTogglePublic: noop, onGetUrl: noop },
}

export const Saving: Story = {
  name: '3 · Saving',
  args: { isPublic: false, canManage: true, isPublicPending: true, onTogglePublic: noop, onGetUrl: noop },
}

/** Viewers see the state but get no control that changes exposure. */
export const ReadOnlyViewer: Story = {
  name: '4 · Viewer (read-only)',
  args: { isPublic: true, canManage: false, onTogglePublic: noop, onGetUrl: noop },
}

/** Click through the confirmation dialog without a backend. */
export const Interactive: Story = {
  name: '5 · Interactive (click through)',
  render: () => {
    const [isPublic, setIsPublic] = useState(false)
    return <BoxNetworkPanel isPublic={isPublic} canManage onTogglePublic={setIsPublic} onGetUrl={noop} />
  },
}
