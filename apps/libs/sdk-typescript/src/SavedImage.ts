/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SavedImageDto,
  SavedImageState,
  Configuration,
  CreateSavedImage,
  ObjectStorageApi,
  SavedImagesApi,
} from '@boxlite-ai/api-client'
import { BoxliteError } from './errors/BoxliteError'
import { Image } from './Image'
import { Resources } from './BoxLite'
import { processStreamingResponse } from './utils/Stream'
import { dynamicImport } from './utils/Import'
import { WithInstrumentation } from './utils/otel.decorator'

/**
 * Represents a BoxLite savedImage which is a prepared definition for creating boxes.
 */
export type SavedImage = SavedImageDto & { __brand: 'SavedImage' }

/**
 * Represents a paginated list of BoxLite savedImages.
 */
export interface PaginatedSavedImages {
  items: SavedImage[]
  total: number
  page: number
  totalPages: number
}

/**
 * Parameters for creating a new savedImage.
 */
export type CreateSavedImageParams = {
  name: string
  image: string | Image
  resources?: Resources
  entrypoint?: string[]
  regionId?: string
  general?: boolean
}

/**
 * Service for managing BoxLite savedImages.
 */
export class SavedImageService {
  constructor(
    private clientConfig: Configuration,
    private savedImagesApi: SavedImagesApi,
    private objectStorageApi: ObjectStorageApi,
    private defaultRegionId?: string,
  ) {}

  /**
   * List savedImages available to the current organization.
   */
  @WithInstrumentation()
  async list(page?: number, limit?: number): Promise<PaginatedSavedImages> {
    const response = await this.savedImagesApi.listSavedImages(undefined, page, limit)
    const data = response.data as unknown

    if (Array.isArray(data)) {
      return {
        items: data.map((savedImage) => savedImage as SavedImage),
        total: data.length,
        page: page ?? 1,
        totalPages: 1,
      }
    }

    const paginated = data as PaginatedSavedImages
    return {
      items: paginated.items.map((savedImage) => savedImage as SavedImage),
      total: paginated.total,
      page: paginated.page,
      totalPages: paginated.totalPages,
    }
  }

  /**
   * Gets a savedImage by its ID or name.
   */
  @WithInstrumentation()
  async get(idOrName: string): Promise<SavedImage> {
    const response = await this.savedImagesApi.getSavedImage(idOrName)
    return response.data as SavedImage
  }

  /**
   * Deletes a savedImage.
   */
  @WithInstrumentation()
  async delete(savedImage: SavedImage): Promise<void> {
    await this.savedImagesApi.removeSavedImage(savedImage.id)
  }

  /**
   * Creates and registers a new savedImage from the given image definition.
   */
  @WithInstrumentation()
  public async create(
    params: CreateSavedImageParams,
    options: { onLogs?: (chunk: string) => void; timeout?: number } = {},
  ): Promise<SavedImage> {
    const createSavedImageReq: CreateSavedImage = {
      name: params.name,
      general: params.general,
    }

    if (typeof params.image === 'string') {
      createSavedImageReq.imageName = params.image
      createSavedImageReq.entrypoint = params.entrypoint
    } else {
      const contextHashes = await SavedImageService.processImageContext(this.objectStorageApi, params.image)
      createSavedImageReq.buildInfo = {
        contextHashes,
        dockerfileContent: params.entrypoint
          ? params.image.entrypoint(params.entrypoint).dockerfile
          : params.image.dockerfile,
      }
    }

    if (params.resources) {
      createSavedImageReq.cpu = params.resources.cpu
      createSavedImageReq.gpu = params.resources.gpu
      createSavedImageReq.memory = params.resources.memory
      createSavedImageReq.disk = params.resources.disk
    }

    createSavedImageReq.regionId = params.regionId || this.defaultRegionId

    let createdSavedImage = (
      await this.savedImagesApi.createSavedImage(createSavedImageReq, undefined, {
        timeout: (options.timeout || 0) * 1000,
      })
    ).data

    if (!createdSavedImage) {
      throw new BoxliteError("Failed to create savedImage. Didn't receive a savedImage from the server API.")
    }

    const terminalStates: SavedImageState[] = [
      SavedImageState.ACTIVE,
      SavedImageState.ERROR,
      SavedImageState.BUILD_FAILED,
    ]
    const savedImageRef = { createdSavedImage: createdSavedImage }
    let streamPromise: Promise<void> | undefined

    const startLogStreaming = async (onChunk: (chunk: string) => void = () => {}) => {
      if (!streamPromise) {
        const response = await this.savedImagesApi.getSavedImageBuildLogsUrl(createdSavedImage.id)

        const url = `${response.data.url}?follow=true`

        streamPromise = processStreamingResponse(
          () => fetch(url, { method: 'GET', headers: this.clientConfig.baseOptions.headers }),
          (chunk) => onChunk(chunk.trimEnd()),
          async () => terminalStates.includes(savedImageRef.createdSavedImage.state),
        )
      }
    }

    if (options.onLogs) {
      options.onLogs(`Creating savedImage ${createdSavedImage.name} (${createdSavedImage.state})`)

      if (
        createSavedImageReq.buildInfo &&
        createdSavedImage.state !== SavedImageState.PENDING &&
        !terminalStates.includes(createdSavedImage.state)
      ) {
        await startLogStreaming(options.onLogs)
      }
    }

    let previousState = createdSavedImage.state
    while (!terminalStates.includes(createdSavedImage.state)) {
      if (options.onLogs && previousState !== createdSavedImage.state) {
        if (createSavedImageReq.buildInfo && createdSavedImage.state !== SavedImageState.PENDING && !streamPromise) {
          await startLogStreaming(options.onLogs)
        }
        options.onLogs(`Creating savedImage ${createdSavedImage.name} (${createdSavedImage.state})`)
        previousState = createdSavedImage.state
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      createdSavedImage = await this.get(createdSavedImage.id)
      savedImageRef.createdSavedImage = createdSavedImage
    }

    if (options.onLogs) {
      if (streamPromise) {
        await streamPromise
      }
      if (createdSavedImage.state === SavedImageState.ACTIVE) {
        options.onLogs(`Created savedImage ${createdSavedImage.name} (${createdSavedImage.state})`)
      }
    }

    if (createdSavedImage.state === SavedImageState.ERROR || createdSavedImage.state === SavedImageState.BUILD_FAILED) {
      const errMsg = `Failed to create savedImage. Name: ${createdSavedImage.name} Reason: ${createdSavedImage.errorReason}`
      throw new BoxliteError(errMsg)
    }

    return createdSavedImage as SavedImage
  }

  /**
   * Activates a savedImage.
   */
  @WithInstrumentation()
  async activate(savedImage: SavedImage): Promise<SavedImage> {
    return (await this.savedImagesApi.activateSavedImage(savedImage.id)).data as SavedImage
  }

  /**
   * Deactivates a savedImage.
   */
  @WithInstrumentation()
  async deactivate(savedImage: SavedImage): Promise<void> {
    await this.savedImagesApi.deactivateSavedImage(savedImage.id)
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
