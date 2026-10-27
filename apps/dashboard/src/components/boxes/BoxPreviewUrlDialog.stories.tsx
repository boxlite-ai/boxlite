/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { BoxPreviewUrlDialog } from './BoxPreviewUrlDialog'

const TUNNEL_URL = 'https://3000-d-3874534e7a76373849495666.proxy.dev.boxlite.ai'

const meta: Meta<typeof BoxPreviewUrlDialog> = {
  title: 'Boxes/BoxPreviewUrlDialog',
  component: BoxPreviewUrlDialog,
}

export default meta
type Story = StoryObj<typeof BoxPreviewUrlDialog>

const noop = () => {}

/** Opened, nothing asked for yet. */
export const Empty: Story = {
  name: '1 · Asking for a port',
  args: { open: true, onOpenChange: noop, onFetchUrl: noop },
}

export const Fetching: Story = {
  name: '2 · Fetching',
  args: { open: true, onOpenChange: noop, isFetching: true, onFetchUrl: noop },
}

/** The URL opens for anyone: the wording has to make that reach unmissable. */
export const Result: Story = {
  name: '3 · URL',
  args: { open: true, onOpenChange: noop, url: TUNNEL_URL, onFetchUrl: noop },
}

export const Failed: Story = {
  name: '4 · Request failed',
  args: {
    open: true,
    onOpenChange: noop,
    error: 'Could not get a URL for that port.',
    onFetchUrl: noop,
  },
}

/** Type a port and watch the URL resolve, without a backend. */
export const Interactive: Story = {
  name: '5 · Interactive (type a port)',
  render: () => {
    const [url, setUrl] = useState<string | undefined>()
    const [isFetching, setIsFetching] = useState(false)

    return (
      <BoxPreviewUrlDialog
        open
        onOpenChange={noop}
        url={url}
        isFetching={isFetching}
        onFetchUrl={(port) => {
          setIsFetching(true)
          setUrl(undefined)
          setTimeout(() => {
            setUrl(`https://${port}-d-3874534e7a76373849495666.proxy.dev.boxlite.ai`)
            setIsFetching(false)
          }, 600)
        }}
      />
    )
  },
}
