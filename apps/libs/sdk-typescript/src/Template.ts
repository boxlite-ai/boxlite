/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BoxTemplateDto,
  BoxTemplateState,
  Configuration,
  CreateBoxTemplate,
  ObjectStorageApi,
  TemplatesApi,
} from '@boxlite-ai/api-client'
import { BoxliteError } from './errors/BoxliteError'
import { Image } from './Image'
import { Resources } from './BoxLite'
import { processStreamingResponse } from './utils/Stream'
import { dynamicImport } from './utils/Import'
import { WithInstrumentation } from './utils/otel.decorator'

/**
 * Represents a BoxLite template which is a prepared definition for creating boxes.
 */
export type Template = BoxTemplateDto & { __brand: 'Template' }

/**
 * Represents a paginated list of BoxLite templates.
 */
export interface PaginatedTemplates {
  items: Template[]
  total: number
  page: number
  totalPages: number
}

/**
 * Parameters for creating a new template.
 */
export type CreateTemplateParams = {
  name: string
  image: string | Image
  resources?: Resources
  entrypoint?: string[]
  regionId?: string
  general?: boolean
}

/**
 * Service for managing BoxLite templates.
 */
export class TemplateService {
  constructor(
    private clientConfig: Configuration,
    private templatesApi: TemplatesApi,
    private objectStorageApi: ObjectStorageApi,
    private defaultRegionId?: string,
  ) {}

  /**
   * List templates available to the current organization.
   */
  @WithInstrumentation()
  async list(page?: number, limit?: number): Promise<PaginatedTemplates> {
    const response = await this.templatesApi.listBoxTemplates(undefined, page, limit)
    const data = response.data as unknown

    if (Array.isArray(data)) {
      return {
        items: data.map((template) => template as Template),
        total: data.length,
        page: page ?? 1,
        totalPages: 1,
      }
    }

    const paginated = data as PaginatedTemplates
    return {
      items: paginated.items.map((template) => template as Template),
      total: paginated.total,
      page: paginated.page,
      totalPages: paginated.totalPages,
    }
  }

  /**
   * Gets a template by its ID or name.
   */
  @WithInstrumentation()
  async get(idOrName: string): Promise<Template> {
    const response = await this.templatesApi.getBoxTemplate(idOrName)
    return response.data as Template
  }

  /**
   * Deletes a template.
   */
  @WithInstrumentation()
  async delete(template: Template): Promise<void> {
    await this.templatesApi.removeBoxTemplate(template.id)
  }

  /**
   * Creates and registers a new template from the given image definition.
   */
  @WithInstrumentation()
  public async create(
    params: CreateTemplateParams,
    options: { onLogs?: (chunk: string) => void; timeout?: number } = {},
  ): Promise<Template> {
    const createTemplateReq: CreateBoxTemplate = {
      name: params.name,
      general: params.general,
    }

    if (typeof params.image === 'string') {
      createTemplateReq.imageName = params.image
      createTemplateReq.entrypoint = params.entrypoint
    } else {
      const contextHashes = await TemplateService.processImageContext(this.objectStorageApi, params.image)
      createTemplateReq.buildInfo = {
        contextHashes,
        dockerfileContent: params.entrypoint
          ? params.image.entrypoint(params.entrypoint).dockerfile
          : params.image.dockerfile,
      }
    }

    if (params.resources) {
      createTemplateReq.cpu = params.resources.cpu
      createTemplateReq.gpu = params.resources.gpu
      createTemplateReq.memory = params.resources.memory
      createTemplateReq.disk = params.resources.disk
    }

    createTemplateReq.regionId = params.regionId || this.defaultRegionId

    let createdTemplate = (
      await this.templatesApi.createBoxTemplate(createTemplateReq, undefined, {
        timeout: (options.timeout || 0) * 1000,
      })
    ).data

    if (!createdTemplate) {
      throw new BoxliteError("Failed to create template. Didn't receive a template from the server API.")
    }

    const terminalStates: BoxTemplateState[] = [
      BoxTemplateState.ACTIVE,
      BoxTemplateState.ERROR,
      BoxTemplateState.BUILD_FAILED,
    ]
    const templateRef = { createdTemplate: createdTemplate }
    let streamPromise: Promise<void> | undefined

    const startLogStreaming = async (onChunk: (chunk: string) => void = () => {}) => {
      if (!streamPromise) {
        const response = await this.templatesApi.getBoxTemplateBuildLogsUrl(createdTemplate.id)

        const url = `${response.data.url}?follow=true`

        streamPromise = processStreamingResponse(
          () => fetch(url, { method: 'GET', headers: this.clientConfig.baseOptions.headers }),
          (chunk) => onChunk(chunk.trimEnd()),
          async () => terminalStates.includes(templateRef.createdTemplate.state),
        )
      }
    }

    if (options.onLogs) {
      options.onLogs(`Creating template ${createdTemplate.name} (${createdTemplate.state})`)

      if (
        createTemplateReq.buildInfo &&
        createdTemplate.state !== BoxTemplateState.PENDING &&
        !terminalStates.includes(createdTemplate.state)
      ) {
        await startLogStreaming(options.onLogs)
      }
    }

    let previousState = createdTemplate.state
    while (!terminalStates.includes(createdTemplate.state)) {
      if (options.onLogs && previousState !== createdTemplate.state) {
        if (createTemplateReq.buildInfo && createdTemplate.state !== BoxTemplateState.PENDING && !streamPromise) {
          await startLogStreaming(options.onLogs)
        }
        options.onLogs(`Creating template ${createdTemplate.name} (${createdTemplate.state})`)
        previousState = createdTemplate.state
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      createdTemplate = await this.get(createdTemplate.id)
      templateRef.createdTemplate = createdTemplate
    }

    if (options.onLogs) {
      if (streamPromise) {
        await streamPromise
      }
      if (createdTemplate.state === BoxTemplateState.ACTIVE) {
        options.onLogs(`Created template ${createdTemplate.name} (${createdTemplate.state})`)
      }
    }

    if (createdTemplate.state === BoxTemplateState.ERROR || createdTemplate.state === BoxTemplateState.BUILD_FAILED) {
      const errMsg = `Failed to create template. Name: ${createdTemplate.name} Reason: ${createdTemplate.errorReason}`
      throw new BoxliteError(errMsg)
    }

    return createdTemplate as Template
  }

  /**
   * Activates a template.
   */
  @WithInstrumentation()
  async activate(template: Template): Promise<Template> {
    return (await this.templatesApi.activateBoxTemplate(template.id)).data as Template
  }

  /**
   * Deactivates a template.
   */
  @WithInstrumentation()
  async deactivate(template: Template): Promise<void> {
    await this.templatesApi.deactivateBoxTemplate(template.id)
  }

  /**
   * Processes the image contexts by uploading them to object storage.
   */
  @WithInstrumentation()
  static async processImageContext(objectStorageApi: ObjectStorageApi, image: Image): Promise<string[]> {
    if (!image.contextList || !image.contextList.length) {
      return []
    }

    const ObjectStorageModule = await dynamicImport('ObjectStorage', '"processImageContext" is not supported: ')
    const pushAccessCreds = (await objectStorageApi.getPushAccess()).data
    const objectStorage = new ObjectStorageModule.ObjectStorage({
      endpointUrl: pushAccessCreds.storageUrl,
      accessKeyId: pushAccessCreds.accessKey,
      secretAccessKey: pushAccessCreds.secret,
      sessionToken: pushAccessCreds.sessionToken,
      bucketName: pushAccessCreds.bucket,
    })

    const contextHashes = []
    for (const context of image.contextList) {
      const contextHash = await objectStorage.upload(
        context.sourcePath,
        pushAccessCreds.organizationId,
        context.archivePath,
      )
      contextHashes.push(contextHash)
    }

    return contextHashes
  }
}
