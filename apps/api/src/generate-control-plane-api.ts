#!/usr/bin/env ts-node
import * as fs from 'fs'
import * as path from 'path'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { SwaggerModule } from '@nestjs/swagger'
import { getControlPlaneApiConfig } from './control-plane-api.config'
import { addWebhookDocumentation } from './control-plane-api-webhooks'
import {
  BoxCreatedWebhookDto,
  BoxStateUpdatedWebhookDto,
  VolumeCreatedWebhookDto,
  VolumeStateUpdatedWebhookDto,
} from './webhook/dto/webhook-event-payloads.dto'

async function generateOpenAPI() {
  try {
    const app = await NestFactory.create(AppModule, {
      logger: ['error'], // Reduce logging noise
    })

    const config = getControlPlaneApiConfig('http://localhost:3000')

    const document = {
      ...SwaggerModule.createDocument(app, config),
    }
    const specPath = './dist/apps/api/control-plane-api.json'
    fs.mkdirSync(path.dirname(specPath), { recursive: true })
    fs.writeFileSync(specPath, JSON.stringify(document, null, 2))

    // Generate 3.1.0 version of the OpenAPI specification
    // Needed for the webhook documentation
    const document_3_1_0 = {
      ...SwaggerModule.createDocument(app, config, {
        extraModels: [
          BoxCreatedWebhookDto,
          BoxStateUpdatedWebhookDto,
          VolumeCreatedWebhookDto,
          VolumeStateUpdatedWebhookDto,
        ],
      }),
      openapi: '3.1.0',
    }
    const documentWithWebhooks = addWebhookDocumentation(document_3_1_0)
    const spec310Path = './dist/apps/api/control-plane-api.3.1.0.json'
    fs.mkdirSync(path.dirname(spec310Path), { recursive: true })
    fs.writeFileSync(spec310Path, JSON.stringify(documentWithWebhooks, null, 2))

    await app.close()
    console.log('OpenAPI specification generated successfully!')
    clearTimeout(timeout)
    process.exit(0)
  } catch (error) {
    console.error('Failed to generate OpenAPI specification:', error)
    clearTimeout(timeout)
    process.exit(1)
  }
}

// Add timeout to prevent hanging
const timeout = setTimeout(() => {
  console.error('Generation timed out after 30 seconds')
  process.exit(1)
}, 30000)

// Clear timeout if process exits normally
process.on('exit', () => {
  clearTimeout(timeout)
})

generateOpenAPI()
