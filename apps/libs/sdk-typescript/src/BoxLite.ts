/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Configuration,
  ObjectStorageApi,
  BoxApi,
  BoxState,
  VolumesApi,
  BoxVolume,
  ConfigApi,
} from '@boxlite-ai/api-client'
import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios'
import { BoxPythonCodeToolbox } from './code-toolbox/BoxPythonCodeToolbox'
import { BoxTsCodeToolbox } from './code-toolbox/BoxTsCodeToolbox'
import { BoxJsCodeToolbox } from './code-toolbox/BoxJsCodeToolbox'
import { BoxliteError, BoxLiteNotFoundError, BoxLiteRateLimitError } from './errors/BoxliteError'
import { Image } from './Image'
import { Box, PaginatedBoxes } from './Box'
import { VolumeService } from './Volume'
import * as packageJson from '../package.json'
import { processStreamingResponse } from './utils/Stream'
import { BoxliteEnvReader, RUNTIME, Runtime } from './utils/Runtime'
import { WithInstrumentation } from './utils/otel.decorator'
import { context, trace, propagation, SpanStatusCode } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'

/**
 * Represents a volume mount for a Box.
 *
 * @interface
 * @property {string} volumeId - ID of the Volume to mount
 * @property {string} mountPath - Path on the Box to mount the Volume
 */

export interface VolumeMount extends BoxVolume {
  volumeId: string
  mountPath: string
}

/**
 * Configuration options for initializing the BoxLite client.
 *
 * @interface
 * @property {string} apiKey - API key for authentication with the BoxLite API
 * @property {string} jwtToken - JWT token for authentication with the BoxLite API. If not set, it must be provided
 * via the environment variable `BOXLITE_JWT_TOKEN`, or an API key must be provided instead.
 * @property {string} organizationId - Organization ID used for JWT-based authentication. Required if a JWT token
 * is provided, and must be set either here or in the environment variable `BOXLITE_ORGANIZATION_ID`.
 * @property {string} apiUrl - URL of the BoxLite API. Defaults to 'https://app.boxlite.io/api'
 * if not set here and not set in environment variable BOXLITE_API_URL.
 * @property {string} target - Target location for Boxes
 * @property {boolean} otelEnabled - OpenTelemetry tracing enabled.
 * If set, all SDK operations will be traced.
 *
 * @example
 * const config: BoxliteConfig = {
 *     apiKey: "your-api-key",
 *     apiUrl: "https://your-api.com",
 *     target: "us"
 * };
 * const boxlite = new BoxLite(config);
 */
export interface BoxliteConfig {
  /** API key for authentication with the BoxLite API */
  apiKey?: string
  /** JWT token for authentication with the BoxLite API */
  jwtToken?: string
  /** Organization ID for authentication with the BoxLite API */
  organizationId?: string
  /** URL of the BoxLite API.
   */
  apiUrl?: string
  /**
   * @deprecated Use `apiUrl` instead. This property will be removed in future versions.
   */
  serverUrl?: string
  /** Target environment for boxes */
  target?: string
  /** Configuration for experimental features */
  _experimental?: Record<string, any>
}

/**
 * Supported programming languages for code execution
 *
 * Python is used as the default box language when no language is explicitly specified.
 */
export enum CodeLanguage {
  PYTHON = 'python',
  TYPESCRIPT = 'typescript',
  JAVASCRIPT = 'javascript',
}

/**
 * Resource allocation for a Box.
 *
 * @interface
 * @property {number} [cpu] - CPU allocation for the Box in cores
 * @property {number} [gpu] - GPU allocation for the Box in units
 * @property {number} [memory] - Memory allocation for the Box in GiB
 * @property {number} [disk] - Disk space allocation for the Box in GiB
 *
 * @example
 * const resources: BoxResources = {
 *     cpu: 2,
 *     memory: 4,  // 4GiB RAM
 *     disk: 20    // 20GiB disk
 * };
 */
export interface Resources {
  /** CPU allocation for the Box */
  cpu?: number
  /** GPU allocation for the Box */
  gpu?: number
  /** Memory allocation for the Box in GiB */
  memory?: number
  /** Disk space allocation for the Box in GiB */
  disk?: number
}

/**
 * Resource overrides supported when creating a Box from a template.
 */
export type TemplateResources = Pick<Resources, 'cpu' | 'memory' | 'disk'>

/**
 * Base parameters for creating a new Box.
 *
 * @interface
 * @property {string} [user] - Optional os user to use for the Box
 * @property {CodeLanguage | string} [language] - Programming language for direct code execution. Defaults to "python" if not specified.
 * @property {Record<string, string>} [envVars] - Optional environment variables to set in the Box
 * @property {Record<string, string>} [labels] - Box labels
 * @property {boolean} [public] - Is the Box port preview public
 * @property {number} [autoStopInterval] - Auto-stop interval in minutes (0 means disabled). Default is 15 minutes.
 * @property {number} [autoDeleteInterval] - Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping). By default, auto-delete is disabled.
 * @property {VolumeMount[]} [volumes] - Optional array of volumes to mount to the Box
 * @property {boolean} [networkBlockAll] - Whether to block all network access for the Box
 * @property {string} [networkAllowList] - Comma-separated list of allowed CIDR network addresses for the Box
 * @property {boolean} [ephemeral] - Whether the Box should be ephemeral. If true, autoDeleteInterval will be set to 0.
 */
export type CreateBoxBaseParams = {
  name?: string
  user?: string
  language?: CodeLanguage | string
  envVars?: Record<string, string>
  labels?: Record<string, string>
  public?: boolean
  autoStopInterval?: number
  autoDeleteInterval?: number
  volumes?: VolumeMount[]
  networkBlockAll?: boolean
  networkAllowList?: string
  ephemeral?: boolean
}

/**
 * Parameters for creating a new Box.
 *
 * @interface
 * @property {string | Image} [image] - Custom Docker image to use for the Box. If an Image object is provided,
 * the image will be dynamically built.
 * @property {Resources} [resources] - Resource allocation for the Box. If not provided, box will
 * have default resources.
 */
export type CreateBoxFromImageParams = CreateBoxBaseParams & {
  image: string | Image
  resources?: Resources
}

/**
 * Parameters for creating a new Box from a template.
 *
 * @interface
 * @property {string} [templateId] - ID or name of the template to use for the Box.
 * @property {TemplateResources} [resources] - Optional CPU, memory, and disk overrides for the Box.
 */
export type CreateBoxFromTemplateParams = CreateBoxBaseParams & {
  templateId?: string
  resources?: TemplateResources
}

/**
 * Main class for interacting with the BoxLite API.
 * Provides methods for creating, managing, and interacting with BoxLite Boxes.
 * Can be initialized either with explicit configuration or using environment variables.
 *
 * @property {VolumeService} volume - Service for managing BoxLite Volumes
 *
 * @example
 * // Using environment variables
 * // Uses BOXLITE_API_KEY, BOXLITE_API_URL, BOXLITE_TARGET
 * const boxlite = new BoxLite();
 * const box = await boxlite.create();
 *
 * @example
 * // Using explicit configuration
 * const config: BoxliteConfig = {
 *     apiKey: "your-api-key",
 *     apiUrl: "https://your-api.com",
 *     target: "us"
 * };
 * const boxlite = new BoxLite(config);
 *
 * @example
 * // Disposes boxlite and flushes traces when done
 * await using boxlite = new BoxLite({
 *   otelEnabled: true,
 * });
 * @class
 */
export class BoxLite implements AsyncDisposable {
  private readonly clientConfig: Configuration
  private readonly boxApi: BoxApi
  private readonly objectStorageApi: ObjectStorageApi
  private readonly configApi: ConfigApi
  private readonly target?: string
  private readonly apiKey?: string
  private readonly jwtToken?: string
  private readonly organizationId?: string
  private readonly apiUrl: string
  private otelSdk?: NodeSDK
  public readonly volume: VolumeService

  /**
   * Creates a new BoxLite client instance.
   *
   * @param {BoxliteConfig} [config] - Configuration options
   * @throws {BoxliteError} - `BoxliteError` - When API key is missing
   */
  constructor(config?: BoxliteConfig) {
    let apiUrl: string | undefined
    if (config) {
      this.apiKey = !config?.apiKey && config?.jwtToken ? undefined : config?.apiKey
      this.jwtToken = config?.jwtToken
      this.organizationId = config?.organizationId
      apiUrl = config?.apiUrl || config?.serverUrl
      this.target = config?.target
    }

    let _envReader: BoxliteEnvReader | null | undefined
    const envReader = (): BoxliteEnvReader | null => {
      if (_envReader === undefined) {
        _envReader = RUNTIME !== Runtime.BROWSER ? new BoxliteEnvReader() : null
      }
      return _envReader
    }

    if (
      !config ||
      (!(this.apiKey && apiUrl && this.target) && !(this.jwtToken && this.organizationId && apiUrl && this.target))
    ) {
      const reader = envReader()
      if (reader) {
        this.apiKey = this.apiKey || (this.jwtToken ? undefined : reader.get('BOXLITE_API_KEY'))
        this.jwtToken = this.jwtToken || reader.get('BOXLITE_JWT_TOKEN')
        this.organizationId = this.organizationId || reader.get('BOXLITE_ORGANIZATION_ID')
        apiUrl = apiUrl || reader.get('BOXLITE_API_URL') || reader.get('BOXLITE_SERVER_URL')
        this.target = this.target || reader.get('BOXLITE_TARGET')

        if (reader.get('BOXLITE_SERVER_URL') && !reader.get('BOXLITE_API_URL')) {
          console.warn(
            '[Deprecation Warning] Environment variable `BOXLITE_SERVER_URL` is deprecated and will be removed in future versions. Use `BOXLITE_API_URL` instead.',
          )
        }
      }
    }

    this.apiUrl = apiUrl || 'https://app.boxlite.io/api'

    const orgHeader: Record<string, string> = {}
    if (!this.apiKey) {
      if (!this.organizationId) {
        throw new BoxliteError('Organization ID is required when using JWT token')
      }
      orgHeader['X-BoxLite-Organization-ID'] = this.organizationId
    }

    const configuration = new Configuration({
      basePath: this.apiUrl,
      baseOptions: {
        headers: {
          Authorization: `Bearer ${this.apiKey || this.jwtToken}`,
          'X-BoxLite-Source': 'sdk-typescript',
          'X-BoxLite-SDK-Version': packageJson.version,
          'User-Agent': `sdk-typescript/${packageJson.version}`,
          ...orgHeader,
        },
      },
    })

    const axiosInstance = this.createAxiosInstance()

    this.boxApi = new BoxApi(configuration, '', axiosInstance)
    this.objectStorageApi = new ObjectStorageApi(configuration, '', axiosInstance)
    this.configApi = new ConfigApi(configuration, '', axiosInstance)
    this.volume = new VolumeService(new VolumesApi(configuration, '', axiosInstance))
    this.clientConfig = configuration

    if (!config?._experimental?.otelEnabled && envReader()?.get('BOXLITE_EXPERIMENTAL_OTEL_ENABLED') !== 'true') {
      return
    }

    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)

    this.otelSdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_VERSION]: packageJson.version,
        [ATTR_SERVICE_NAME]: 'boxlite-typescript-sdk',
      }),
      instrumentations: [
        new HttpInstrumentation({
          requireParentforOutgoingSpans: false,
        }),
      ],
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            compression: CompressionAlgorithm.GZIP,
          }),
        ),
      ],
    })

    this.otelSdk.start()

    // Flush and shutdown OTEL on process exit
    process.on('SIGTERM', async () => {
      await this.otelSdk?.shutdown()
    })
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.otelSdk) {
      return
    }

    await this.otelSdk.shutdown()
  }

  /**
   * Creates Boxes from specified or default template. You can specify various parameters,
   * including language, image, environment variables, and volumes.
   *
   * @param {CreateBoxFromTemplateParams} [params] - Parameters for Box creation from template
   * @param {object} [options] - Options for the create operation
   * @param {number} [options.timeout] - Timeout in seconds (0 means no timeout, default is 60)
   * @returns {Promise<Box>} The created Box instance
   *
   * @example
   * const box = await boxlite.create();
   *
   * @example
   * // Create a custom box
   * const params: CreateBoxFromTemplateParams = {
   *     language: 'typescript',
   *     templateId: 'my-template-id',
   *     envVars: {
   *         NODE_ENV: 'development',
   *         DEBUG: 'true'
   *     },
   *     autoStopInterval: 60,
   *     autoDeleteInterval: 120
   * };
   * const box = await boxlite.create(params, { timeout: 100 });
   */
  public async create(params?: CreateBoxFromTemplateParams, options?: { timeout?: number }): Promise<Box>
  /**
   * Creates Boxes from specified image available on some registry or declarative BoxLite Image. You can specify various parameters,
   * including resources, language, image, environment variables, and volumes. BoxLite creates runtime build material from
   * provided image and uses it to create Box.
   *
   * @param {CreateBoxFromImageParams} [params] - Parameters for Box creation from image
   * @param {object} [options] - Options for the create operation
   * @param {number} [options.timeout] - Timeout in seconds (0 means no timeout, default is 60)
   * @param {function} [options.onTemplateCreateLogs] - Callback function to handle template creation logs.
   * @returns {Promise<Box>} The created Box instance
   *
   * @example
   * const box = await boxlite.create({ image: 'debian:12.9' }, { timeout: 90, onTemplateCreateLogs: console.log });
   *
   * @example
   * // Create a custom box
   * const image = Image.base('alpine:3.18').pipInstall('numpy');
   * const params: CreateBoxFromImageParams = {
   *     language: 'typescript',
   *     image,
   *     envVars: {
   *         NODE_ENV: 'development',
   *         DEBUG: 'true'
   *     },
   *     resources: {
   *         cpu: 2,
   *         memory: 4 // 4GB RAM
   *     },
   *     autoStopInterval: 60,
   *     autoDeleteInterval: 120
   * };
   * const box = await boxlite.create(params, { timeout: 100, onTemplateCreateLogs: console.log });
   */
  public async create(
    params?: CreateBoxFromImageParams,
    options?: { onTemplateCreateLogs?: (chunk: string) => void; timeout?: number },
  ): Promise<Box>
  @WithInstrumentation()
  public async create(
    params?: CreateBoxFromTemplateParams | CreateBoxFromImageParams,
    options: { onTemplateCreateLogs?: (chunk: string) => void; timeout?: number } = { timeout: 60 },
  ): Promise<Box> {
    const startTime = Date.now()

    options = typeof options === 'number' ? { timeout: options } : { ...options }
    if (options.timeout == undefined || options.timeout == null) {
      options.timeout = 60
    }

    if (params == null) {
      params = { language: 'python' }
    }

    const labels = params.labels || {}
    if (params.language) {
      labels['code-toolbox-language'] = params.language
    }

    if (options.timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    if (
      params.autoStopInterval !== undefined &&
      (!Number.isInteger(params.autoStopInterval) || params.autoStopInterval < 0)
    ) {
      throw new BoxliteError('autoStopInterval must be a non-negative integer')
    }

    if (params.ephemeral) {
      if (params.autoDeleteInterval !== undefined && params.autoDeleteInterval !== 0) {
        console.warn(
          "'ephemeral' and 'autoDeleteInterval' cannot be used together. If ephemeral is true, autoDeleteInterval will be ignored and set to 0.",
        )
      }
      params.autoDeleteInterval = 0
    }

    const codeToolbox = this.getCodeToolbox(params.language as CodeLanguage)

    try {
      let buildInfo: any | undefined
      let templateId: string | undefined
      let resources: Resources | undefined
      let gpu: number | undefined

      if ('templateId' in params) {
        templateId = params.templateId
      }

      if ('image' in params) {
        if (typeof params.image === 'string') {
          buildInfo = {
            dockerfileContent: Image.base(params.image).dockerfile,
          }
        } else if (params.image instanceof Image) {
          buildInfo = {
            dockerfileContent: params.image.dockerfile,
          }
        }
      }

      if ('resources' in params) {
        resources = params.resources as Resources | undefined
        gpu = 'image' in params ? resources?.gpu : undefined
      }

      const response = await this.boxApi.createBox(
        {
          name: params.name,
          templateId,
          buildInfo,
          user: params.user,
          env: params.envVars || {},
          labels: labels,
          public: params.public,
          target: this.target,
          cpu: resources?.cpu,
          gpu,
          memory: resources?.memory,
          disk: resources?.disk,
          autoStopInterval: params.autoStopInterval,
          autoDeleteInterval: params.autoDeleteInterval,
          volumes: params.volumes,
          networkBlockAll: params.networkBlockAll,
          networkAllowList: params.networkAllowList,
        },
        undefined,
        {
          timeout: options.timeout * 1000,
        },
      )

      let boxInstance = response.data

      if (boxInstance.state === BoxState.PENDING_BUILD && options.onTemplateCreateLogs) {
        const terminalStates: BoxState[] = [
          BoxState.STARTED,
          BoxState.STARTING,
          BoxState.ERROR,
          BoxState.BUILD_FAILED,
        ]

        while (boxInstance.state === BoxState.PENDING_BUILD) {
          if (options.timeout) {
            const elapsed = (Date.now() - startTime) / 1000
            if (elapsed > options.timeout) {
              throw new BoxliteError(
                `Box build has been pending for more than ${options.timeout} seconds. Please check the box state again later.`,
              )
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000))
          boxInstance = (await this.boxApi.getBox(boxInstance.id)).data
        }

        const response = await this.boxApi.getBuildLogsUrl(boxInstance.id)

        await processStreamingResponse(
          () =>
            fetch(response.data.url + '?follow=true', {
              method: 'GET',
              headers: this.clientConfig.baseOptions.headers,
            }),
          (chunk) => options.onTemplateCreateLogs?.(chunk.trimEnd()),
          async () => {
            boxInstance = (await this.boxApi.getBox(boxInstance.id)).data
            return boxInstance.state !== undefined && terminalStates.includes(boxInstance.state)
          },
        )
      }

      const box = new Box(
        boxInstance,
        new Configuration(structuredClone(this.clientConfig)),
        this.createAxiosInstance(),
        this.boxApi,
        codeToolbox,
      )

      if (box.state !== 'started') {
        const timeElapsed = Date.now() - startTime
        await box.waitUntilStarted(
          options.timeout ? Math.max(0.001, options.timeout - timeElapsed / 1000) : options.timeout,
        )
      }

      return box
    } catch (error) {
      if (error instanceof BoxliteError && error.message.includes('Operation timed out')) {
        const errMsg = `Failed to create and start box within ${options.timeout} seconds. Operation timed out.`
        throw new BoxliteError(errMsg)
      }
      throw error
    }
  }

  /**
   * Gets a Box by its ID or name.
   *
   * @param {string} boxIdOrName - The ID or name of the Box to retrieve
   * @returns {Promise<Box>} The Box
   *
   * @example
   * const box = await boxlite.get('my-box-id-or-name');
   * console.log(`Box state: ${box.state}`);
   */
  @WithInstrumentation()
  public async get(boxIdOrName: string): Promise<Box> {
    const response = await this.boxApi.getBox(boxIdOrName)
    const boxInstance = response.data
    const language = boxInstance.labels && boxInstance.labels['code-toolbox-language']
    const codeToolbox = this.getCodeToolbox(language as CodeLanguage)

    return new Box(
      boxInstance,
      structuredClone(this.clientConfig),
      this.createAxiosInstance(),
      this.boxApi,
      codeToolbox,
    )
  }

  /**
   * Returns paginated list of Boxes filtered by labels.
   *
   * @param {Record<string, string>} [labels] - Labels to filter Boxes
   * @param {number} [page] - Page number for pagination (starting from 1)
   * @param {number} [limit] - Maximum number of items per page
   * @returns {Promise<PaginatedBoxes>} Paginated list of Boxes that match the labels.
   *
   * @example
   * const result = await boxlite.list({ 'my-label': 'my-value' }, 2, 10);
   * for (const box of result.items) {
   *     console.log(`${box.id}: ${box.state}`);
   * }
   */
  @WithInstrumentation()
  public async list(labels?: Record<string, string>, page?: number, limit?: number): Promise<PaginatedBoxes> {
    const response = await this.boxApi.listBoxesPaginated(
      undefined,
      page,
      limit,
      undefined,
      undefined,
      labels ? JSON.stringify(labels) : undefined,
    )

    return {
      items: response.data.items.map((box) => {
        const language = box.labels?.['code-toolbox-language'] as CodeLanguage
        return new Box(
          box,
          structuredClone(this.clientConfig),
          this.createAxiosInstance(),
          this.boxApi,
          this.getCodeToolbox(language),
        )
      }),
      total: response.data.total,
      page: response.data.page,
      totalPages: response.data.totalPages,
    }
  }

  /**
   * Starts a Box and waits for it to be ready.
   *
   * @param {Box} box - The Box to start
   * @param {number} [timeout] - Optional timeout in seconds (0 means no timeout)
   * @returns {Promise<void>}
   *
   * @example
   * const box = await boxlite.get('my-box-id');
   * // Wait up to 60 seconds for the box to start
   * await boxlite.start(box, 60);
   */
  @WithInstrumentation()
  public async start(box: Box, timeout?: number) {
    await box.start(timeout)
  }

  /**
   * Stops a Box.
   *
   * @param {Box} box - The Box to stop
   * @returns {Promise<void>}
   *
   * @example
   * const box = await boxlite.get('my-box-id');
   * await boxlite.stop(box);
   */
  @WithInstrumentation()
  public async stop(box: Box) {
    await box.stop()
  }

  /**
   * Deletes a Box.
   *
   * @param {Box} box - The Box to delete
   * @param {number} timeout - Timeout in seconds (0 means no timeout, default is 60)
   * @returns {Promise<void>}
   *
   * @example
   * const box = await boxlite.get('my-box-id');
   * await boxlite.delete(box);
   */
  @WithInstrumentation()
  public async delete(box: Box, timeout = 60) {
    await box.delete(timeout)
  }

  /**
   * Gets the appropriate code toolbox based on language.
   *
   * @private
   * @param {CodeLanguage} [language] - Programming language for the toolbox
   * @returns {BoxCodeToolbox} The appropriate code toolbox instance
   * @throws {BoxliteError} - `BoxliteError` - When an unsupported language is specified
   */
  private getCodeToolbox(language?: CodeLanguage) {
    switch (language) {
      case CodeLanguage.JAVASCRIPT:
        return new BoxJsCodeToolbox()
      case CodeLanguage.TYPESCRIPT:
        return new BoxTsCodeToolbox()
      case CodeLanguage.PYTHON:
      case undefined:
        return new BoxPythonCodeToolbox()
      default: {
        const errMsg = `Unsupported language: ${language}, supported languages: ${Object.values(CodeLanguage).join(', ')}`
        throw new BoxliteError(errMsg)
      }
    }
  }

  private createAxiosInstance(): AxiosInstance {
    const axiosInstance = axios.create({
      timeout: 24 * 60 * 60 * 1000, // 24 hours
    })

    // Request interceptor: Inject trace context into headers
    axiosInstance.interceptors.request.use(
      (requestConfig: InternalAxiosRequestConfig) => {
        // Get the current active context (which may contain an active span)
        const currentContext = context.active()

        // Inject trace context into HTTP headers using W3C Trace Context propagation
        // This adds headers like 'traceparent' and 'tracestate'
        propagation.inject(currentContext, requestConfig.headers)

        // Store the start time for duration calculation
        ;(requestConfig as any).metadata = { startTime: Date.now() }

        return requestConfig
      },
      (error) => {
        return Promise.reject(error)
      },
    )

    axiosInstance.interceptors.response.use(
      (response) => {
        return response
      },
      (error) => {
        let errorMessage: string

        if (error instanceof AxiosError && error.message.includes('timeout of')) {
          errorMessage = 'Operation timed out'
        } else {
          errorMessage = error.response?.data?.message || error.response?.data || error.message || String(error)
        }

        if (typeof errorMessage === 'object') {
          try {
            errorMessage = JSON.stringify(errorMessage)
          } catch {
            errorMessage = String(errorMessage)
          }
        }

        const statusCode = error.response?.status
        const headers = error.response?.headers

        switch (statusCode) {
          case 404:
            throw new BoxLiteNotFoundError(errorMessage, statusCode, headers)
          case 429:
            throw new BoxLiteRateLimitError(errorMessage, statusCode, headers)
          default:
            throw new BoxliteError(errorMessage, statusCode, headers)
        }
      },
    )

    axiosInstance.interceptors.response.use(
      (response) => {
        const startTime = (response.config as any).metadata?.startTime
        if (startTime) {
          const duration = Date.now() - startTime

          // Get the active span to add attributes
          const activeSpan = trace.getActiveSpan()
          // Only modify the span if it's still recording (not ended)
          if (activeSpan && activeSpan.isRecording()) {
            // Add response metadata to the span
            activeSpan.setAttributes({
              'http.response.status_code': response.status,
              'http.response.duration_ms': duration,
              // 'http.response.size_bytes': JSON.stringify(response.data).length,
            })
          }
        }

        return response
      },
      (error) => {
        const startTime = (error.config as any)?.metadata?.startTime
        if (startTime) {
          const duration = Date.now() - startTime

          // Get the active span to record the error
          const activeSpan = trace.getActiveSpan()
          // Only modify the span if it's still recording (not ended)
          if (activeSpan && activeSpan.isRecording()) {
            activeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            })

            activeSpan.setAttributes({
              'http.response.duration_ms': duration,
              'error.type': error.name,
              'error.message': error.message,
            })

            if (error.response) {
              activeSpan.setAttribute('http.response.status_code', error.response.status)
            }

            // Record the exception on the span
            activeSpan.recordException(error)
          }
        }

        return Promise.reject(error)
      },
    )

    return axiosInstance
  }
}
