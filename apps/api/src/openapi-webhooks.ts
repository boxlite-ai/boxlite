/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OpenAPIObject, getSchemaPath } from '@nestjs/swagger'
import { WebhookEvent } from './webhook/constants/webhook-events.constants'
import {
  SandboxCreatedWebhookDto,
  SandboxStateUpdatedWebhookDto,
  BoxTemplateCreatedWebhookDto,
  BoxTemplateStateUpdatedWebhookDto,
  BoxTemplateRemovedWebhookDto,
  VolumeCreatedWebhookDto,
  VolumeStateUpdatedWebhookDto,
} from './webhook/dto/webhook-event-payloads.dto'

export interface OpenAPIObjectWithWebhooks extends OpenAPIObject {
  webhooks?: {
    [key: string]: {
      post: {
        requestBody: {
          description: string
          content: {
            'application/json': {
              schema: any
            }
          }
        }
        responses: {
          [statusCode: string]: {
            description: string
          }
        }
      }
    }
  }
}

export function addWebhookDocumentation(document: OpenAPIObject): OpenAPIObjectWithWebhooks {
  return {
    ...document,
    webhooks: {
      [WebhookEvent.SANDBOX_CREATED]: {
        post: {
          requestBody: {
            description: 'Sandbox created event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(SandboxCreatedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
      [WebhookEvent.SANDBOX_STATE_UPDATED]: {
        post: {
          requestBody: {
            description: 'Sandbox state updated event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(SandboxStateUpdatedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
      [WebhookEvent.TEMPLATE_CREATED]: {
        post: {
          requestBody: {
            description: 'BoxTemplate created event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(BoxTemplateCreatedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
      [WebhookEvent.TEMPLATE_STATE_UPDATED]: {
        post: {
          requestBody: {
            description: 'BoxTemplate state updated event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(BoxTemplateStateUpdatedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
      [WebhookEvent.TEMPLATE_REMOVED]: {
        post: {
          requestBody: {
            description: 'BoxTemplate removed event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(BoxTemplateRemovedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
      [WebhookEvent.VOLUME_CREATED]: {
        post: {
          requestBody: {
            description: 'Volume created event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(VolumeCreatedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
      [WebhookEvent.VOLUME_STATE_UPDATED]: {
        post: {
          requestBody: {
            description: 'Volume state updated event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(VolumeStateUpdatedWebhookDto) },
              },
            },
          },
          responses: {
            '200': {
              description: 'Webhook received successfully',
            },
          },
        },
      },
    },
  }
}
