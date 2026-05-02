/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const CustomHeaders: {
  [key: string]: {
    name: string
    description?: string
    required?: boolean
    schema?: {
      type?: string
    }
  }
} = {
  ORGANIZATION_ID: {
    name: 'X-BoxLite-Organization-ID',
    description: 'Use with JWT to specify the organization ID',
    required: false,
    schema: {
      type: 'string',
    },
  },
  SOURCE: {
    name: 'X-BoxLite-Source',
    description: 'Use to specify the source of the request',
    required: false,
    schema: {
      type: 'string',
    },
  },
  SDK_VERSION: {
    name: 'X-BoxLite-SDK-Version',
    description: 'Use to specify the version of the SDK',
    required: false,
    schema: {
      type: 'string',
    },
  },
}
