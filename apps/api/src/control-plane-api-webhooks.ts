/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OpenAPIObject, getSchemaPath } from '@nestjs/swagger'
import { WebhookEvent } from './webhook/constants/webhook-events.constants'
import {
  BoxCreatedWebhookDto,
  BoxStateUpdatedWebhookDto,
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
      [WebhookEvent.BOX_CREATED]: {
        post: {
          requestBody: {
            description: 'Box created event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(BoxCreatedWebhookDto) },
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
      [WebhookEvent.BOX_STATE_UPDATED]: {
        post: {
          requestBody: {
            description: 'Box state updated event',
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(BoxStateUpdatedWebhookDto) },
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
      // TODO(image-rewrite): TEMPLATE_* webhook docs removed with box_template.
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
