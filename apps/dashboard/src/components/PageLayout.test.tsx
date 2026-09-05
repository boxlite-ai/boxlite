// @vitest-environment jsdom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { BannerProvider } from './Banner'
import { DashboardBannerSlot, PageContent } from './PageLayout'

async function render(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(element)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { container, root }
}

const notification = {
  id: 'verify-email',
  title: 'Verification Required',
  description: 'Please verify your email address to access all features.',
}

describe('dashboard banner placement', () => {
  const roots: Root[] = []

  afterEach(() => {
    roots.splice(0).forEach((root) => root.unmount())
    document.body.replaceChildren()
  })

  it('renders dashboard banners from the shell slot', async () => {
    const { container, root } = await render(
      <BannerProvider defaultNotifications={[notification]}>
        <DashboardBannerSlot />
      </BannerProvider>,
    )
    roots.push(root)

    expect(container.textContent).toContain('Verification Required')
  })

  it('does not render a second banner from PageContent', async () => {
    const { container, root } = await render(
      <BannerProvider defaultNotifications={[notification]}>
        <DashboardBannerSlot />
        <PageContent>Boxes</PageContent>
      </BannerProvider>,
    )
    roots.push(root)

    expect(container.textContent?.match(/Verification Required/g)).toHaveLength(1)
  })
})
