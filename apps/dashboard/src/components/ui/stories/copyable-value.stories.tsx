/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Meta, StoryObj } from '@storybook/react'
import { CheckIcon, EyeIcon } from 'lucide-react'
import { CopyableValue } from '../copyable-value'
import { Button } from '../button'

const meta: Meta<typeof CopyableValue> = {
  title: 'UI/CopyableValue',
  component: CopyableValue,
  decorators: [
    (Story) => (
      <div className="w-[320px] max-w-full">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof CopyableValue>

const sshCommand = 'ssh -p 2222 drbDvBTdVD8g38GJ2bdTw66ys94CAXaZ@ssh.dev.boxlite.ai'
const apiKey = 'bxl_live_1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const LongCommand: Story = {
  args: {
    displayValue: sshCommand,
    copyValue: sshCommand,
    copyLabel: 'SSH command',
    onCopy: () => {},
  },
}

export const Copied: Story = {
  args: {
    displayValue: apiKey,
    copyValue: apiKey,
    copyLabel: 'API key',
    copied: true,
    onCopy: () => {},
  },
}

export const WithMultipleActions: Story = {
  render: () => (
    <CopyableValue
      displayValue={apiKey}
      actionsClassName="gap-3"
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Reveal API key"
            className="h-6 w-6 text-current hover:bg-green-200/70 hover:text-current dark:hover:bg-green-800/70"
          >
            <EyeIcon className="h-4 w-4" />
          </Button>
          <CheckIcon className="h-4 w-4 shrink-0" />
        </>
      }
    />
  ),
}
