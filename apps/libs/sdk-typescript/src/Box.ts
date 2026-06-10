/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BoxState,
  BoxApi,
  Box as BoxDto,
  PaginatedBoxes as PaginatedBoxesDto,
  PortPreviewUrl,
  BoxVolume,
  Configuration,
  SshAccessDto,
  SshAccessValidationDto,
  SignedPortPreviewUrl,
  ResizeBox,
} from '@boxlite-ai/api-client'
import { Resources } from './BoxLite'
import {
  FileSystemApi,
  GitApi,
  ProcessApi,
  LspApi,
  InfoApi,
  ComputerUseApi,
  InterpreterApi,
} from '@boxlite-ai/toolbox-api-client'
import { FileSystem } from './FileSystem'
import { Git } from './Git'
import { CodeRunParams, Process } from './Process'
import { LspLanguageId, LspServer } from './LspServer'
import { BoxliteError, BoxLiteNotFoundError } from './errors/BoxliteError'
import { ComputerUse } from './ComputerUse'
import { AxiosInstance } from 'axios'
import { CodeInterpreter } from './CodeInterpreter'
import { WithInstrumentation } from './utils/otel.decorator'

/**
 * Interface defining methods that a code toolbox must implement
 * @interface
 */
export interface BoxCodeToolbox {
  /** Generates a command to run the provided code */
  getRunCommand(code: string, params?: CodeRunParams): string
}

/**
 * Represents a BoxLite Box.
 *
 * @property {FileSystem} fs - File system operations interface
 * @property {Git} git - Git operations interface
 * @property {Process} process - Process execution interface
 * @property {CodeInterpreter} codeInterpreter - Stateful interpreter interface for executing code.
 *   Currently supports only Python. For other languages, use the `process.codeRun` method.
 * @property {ComputerUse} computerUse - Computer use operations interface for desktop automation
 * @property {string} id - Unique identifier for the Box
 * @property {string} boxId - Public Box ID shown to users and SDK clients
 * @property {string} organizationId - Organization ID of the Box
 * @property {string} user - OS user running in the Box
 * @property {Record<string, string>} env - Environment variables set in the Box
 * @property {Record<string, string>} labels - Custom labels attached to the Box
 * @property {boolean} public - Whether the Box is publicly accessible
 * @property {string} target - Target location of the runner where the Box runs
 * @property {number} cpu - Number of CPUs allocated to the Box
 * @property {number} gpu - Number of GPUs allocated to the Box
 * @property {number} memory - Amount of memory allocated to the Box in GiB
 * @property {number} disk - Amount of disk space allocated to the Box in GiB
 * @property {BoxState} state - Current state of the Box (e.g., "started", "stopped")
 * @property {string} [errorReason] - Error message if Box is in error state
 * @property {boolean} [recoverable] - Whether the Box error is recoverable.
 * @property {number} [autoStopInterval] - Auto-stop interval in minutes
 * @property {number} [autoDeleteInterval] - Auto-delete interval in minutes
 * @property {Array<BoxVolume>} [volumes] - Volumes attached to the Box
 * @property {string} [createdAt] - When the Box was created
 * @property {string} [updatedAt] - When the Box was last updated
 * @property {boolean} networkBlockAll - Whether to block all network access for the Box
 * @property {string} [networkAllowList] - Comma-separated list of allowed CIDR network addresses for the Box
 *
 * @class
 */
export class Box implements BoxDto {
  public readonly fs: FileSystem
  public readonly git: Git
  public readonly process: Process
  public readonly computerUse: ComputerUse
  public readonly codeInterpreter: CodeInterpreter

  public id!: string
  public boxId!: string
  public name!: string
  public organizationId!: string
  public user!: string
  public env!: Record<string, string>
  public labels!: Record<string, string>
  public public!: boolean
  public target!: string
  public cpu!: number
  public gpu!: number
  public memory!: number
  public disk!: number
  public state?: BoxState
  public errorReason?: string
  public recoverable?: boolean
  public autoStopInterval?: number
  public autoDeleteInterval?: number
  public volumes?: Array<BoxVolume>
  public createdAt?: string
  public updatedAt?: string
  public networkBlockAll!: boolean
  public networkAllowList?: string
  public toolboxProxyUrl: string

  private infoApi: InfoApi

  /**
   * Creates a new Box instance
   *
   * @param {BoxDto} boxDto - The API Box instance
   * @param {BoxApi} boxApi - API client for Box operations
   * @param {InfoApi} infoApi - API client for info operations
   * @param {BoxCodeToolbox} codeToolbox - Language-specific toolbox implementation
   */
  constructor(
    boxDto: BoxDto,
    private readonly clientConfig: Configuration,
    private readonly axiosInstance: AxiosInstance,
    private readonly boxApi: BoxApi,
    private readonly codeToolbox: BoxCodeToolbox,
  ) {
    this.processBoxDto(boxDto)

    // Set the toolbox base URL
    let baseUrl = this.toolboxProxyUrl
    if (!baseUrl.endsWith('/')) {
      baseUrl += '/'
    }
    this.axiosInstance.defaults.baseURL = baseUrl + this.id
    this.clientConfig.basePath = this.axiosInstance.defaults.baseURL

    // Initialize Services
    const getPreviewToken = async () => (await this.getPreviewLink(1)).token

    this.fs = new FileSystem(this.clientConfig, new FileSystemApi(this.clientConfig, '', this.axiosInstance))
    this.git = new Git(new GitApi(this.clientConfig, '', this.axiosInstance))
    this.process = new Process(
      this.clientConfig,
      this.codeToolbox,
      new ProcessApi(this.clientConfig, '', this.axiosInstance),
      getPreviewToken,
    )
    this.codeInterpreter = new CodeInterpreter(
      this.clientConfig,
      new InterpreterApi(this.clientConfig, '', this.axiosInstance),
      getPreviewToken,
    )
    this.computerUse = new ComputerUse(new ComputerUseApi(this.clientConfig, '', this.axiosInstance))
    this.infoApi = new InfoApi(this.clientConfig, '', this.axiosInstance)
  }

  /**
   * Gets the user's home directory path for the logged in user inside the Box.
   *
   * @returns {Promise<string | undefined>} The absolute path to the Box user's home directory for the logged in user
   *
   * @example
   * const userHomeDir = await box.getUserHomeDir();
   * console.log(`Box user home: ${userHomeDir}`);
   */
  @WithInstrumentation()
  public async getUserHomeDir(): Promise<string | undefined> {
    const response = await this.infoApi.getUserHomeDir()
    return response.data.dir
  }

  /**
   * @deprecated Use `getUserHomeDir` instead. This method will be removed in a future version.
   */
  @WithInstrumentation()
  public async getUserRootDir(): Promise<string | undefined> {
    return this.getUserHomeDir()
  }

  /**
   * Gets the working directory path inside the Box.
   *
   * @returns {Promise<string | undefined>} The absolute path to the Box working directory. Uses the WORKDIR specified
   * in the Dockerfile if present, or falling back to the user's home directory if not.
   *
   * @example
   * const workDir = await box.getWorkDir();
   * console.log(`Box working directory: ${workDir}`);
   */
  @WithInstrumentation()
  public async getWorkDir(): Promise<string | undefined> {
    const response = await this.infoApi.getWorkDir()
    return response.data.dir
  }

  /**
   * Creates a new Language Server Protocol (LSP) server instance.
   *
   * The LSP server provides language-specific features like code completion,
   * diagnostics, and more.
   *
   * @param {LspLanguageId} languageId - The language server type (e.g., "typescript")
   * @param {string} pathToProject - Path to the project root directory. Relative paths are resolved based on the box working directory.
   * @returns {LspServer} A new LSP server instance configured for the specified language
   *
   * @example
   * const lsp = await box.createLspServer('typescript', 'workspace/project');
   */
  @WithInstrumentation()
  public async createLspServer(languageId: LspLanguageId | string, pathToProject: string): Promise<LspServer> {
    return new LspServer(
      languageId as LspLanguageId,
      pathToProject,
      new LspApi(this.clientConfig, '', this.axiosInstance),
    )
  }

  /**
   * Sets labels for the Box.
   *
   * Labels are key-value pairs that can be used to organize and identify Boxes.
   *
   * @param {Record<string, string>} labels - Dictionary of key-value pairs representing Box labels
   * @returns {Promise<void>}
   *
   * @example
   * // Set box labels
   * await box.setLabels({
   *   project: 'my-project',
   *   environment: 'development',
   *   team: 'backend'
   * });
   */
  @WithInstrumentation()
  public async setLabels(labels: Record<string, string>): Promise<Record<string, string>> {
    this.labels = (await this.boxApi.replaceLabels(this.id, { labels })).data.labels
    return this.labels
  }

  /**
   * Start the Box.
   *
   * This method starts the Box and waits for it to be ready.
   *
   * @param {number} [timeout] - Maximum time to wait in seconds. 0 means no timeout.
   *                            Defaults to 60-second timeout.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - `BoxliteError` - If Box fails to start or times out
   *
   * @example
   * const box = await boxlite.getCurrentBox('my-box');
   * await box.start(40);  // Wait up to 40 seconds
   * console.log('Box started successfully');
   */
  @WithInstrumentation()
  public async start(timeout = 60): Promise<void> {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    const startTime = Date.now()
    const response = await this.boxApi.startBox(this.id, undefined, { timeout: timeout * 1000 })
    this.processBoxDto(response.data)
    const timeElapsed = Date.now() - startTime
    await this.waitUntilStarted(timeout ? Math.max(0.001, timeout - timeElapsed / 1000) : timeout)
  }

  /**
   * Recover the Box from a recoverable error and wait for it to be ready.
   *
   * @param {number} [timeout] - Maximum time to wait in seconds. 0 means no timeout.
   *                            Defaults to 60-second timeout.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - `BoxliteError` - If Box fails to recover or times out
   *
   * @example
   * const box = await boxlite.get('my-box-id');
   * await box.recover();
   * console.log('Box recovered successfully');
   */
  public async recover(timeout = 60): Promise<void> {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    const startTime = Date.now()
    const response = await this.boxApi.recoverBox(this.id, undefined, { timeout: timeout * 1000 })
    this.processBoxDto(response.data)
    const timeElapsed = Date.now() - startTime
    await this.waitUntilStarted(timeout ? Math.max(0.001, timeout - timeElapsed / 1000) : timeout)
  }

  /**
   * Stops the Box.
   *
   * This method stops the Box and waits for it to be fully stopped.
   *
   * @param {number} [timeout] - Maximum time to wait in seconds. 0 means no timeout.
   *                            Defaults to 60-second timeout.
   * @param {boolean} [force] - If true, uses SIGKILL instead of SIGTERM. Defaults to false.
   * @returns {Promise<void>}
   *
   * @example
   * const box = await boxlite.get('my-box-id');
   * await box.stop();
   * console.log('Box stopped successfully');
   */
  @WithInstrumentation()
  public async stop(timeout = 60, force = false): Promise<void> {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }
    const startTime = Date.now()
    await this.boxApi.stopBox(this.id, undefined, force, { timeout: timeout * 1000 })
    await this.refreshDataSafe()
    const timeElapsed = Date.now() - startTime
    await this.waitUntilStopped(timeout ? Math.max(0.001, timeout - timeElapsed / 1000) : timeout)
  }

  /**
   * Deletes the Box.
   * @returns {Promise<void>}
   */
  @WithInstrumentation()
  public async delete(timeout = 60): Promise<void> {
    await this.boxApi.deleteBox(this.id, undefined, { timeout: timeout * 1000 })
    this.refreshDataSafe()
  }

  /**
   * Waits for the Box to reach the 'started' state.
   *
   * This method polls the Box status until it reaches the 'started' state
   * or encounters an error.
   *
   * @param {number} [timeout] - Maximum time to wait in seconds. 0 means no timeout.
   *                               Defaults to 60 seconds.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - `BoxliteError` - If the box ends up in an error state or fails to start within the timeout period.
   */
  @WithInstrumentation()
  public async waitUntilStarted(timeout = 60) {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    const checkInterval = 100 // Wait 100 ms between checks
    const startTime = Date.now()

    while (this.state !== 'started') {
      await this.refreshData()

      // @ts-expect-error this.refreshData() can modify this.state so this check is fine
      if (this.state === 'started') {
        return
      }

      if (this.state === 'error') {
        const errMsg = `Box ${this.id} failed to start with status: ${this.state}, error reason: ${this.errorReason}`
        throw new BoxliteError(errMsg)
      }

      if (timeout !== 0 && Date.now() - startTime > timeout * 1000) {
        throw new BoxliteError('Box failed to become ready within the timeout period')
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
  }

  /**
   * Wait for Box to reach 'stopped' state.
   *
   * This method polls the Box status until it reaches the 'stopped' state
   * or encounters an error.
   *
   * @param {number} [timeout] - Maximum time to wait in seconds. 0 means no timeout.
   *                               Defaults to 60 seconds.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - `BoxliteError` - If the box fails to stop within the timeout period.
   */
  @WithInstrumentation()
  public async waitUntilStopped(timeout = 60) {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    const checkInterval = 100 // Wait 100 ms between checks
    const startTime = Date.now()

    // Treat destroyed as stopped to cover ephemeral boxes that are automatically deleted after stopping
    while (this.state !== 'stopped' && this.state !== 'destroyed') {
      this.refreshDataSafe()

      // @ts-expect-error this.refreshData() can modify this.state so this check is fine
      if (this.state === 'stopped' || this.state === 'destroyed') {
        return
      }

      if (this.state === 'error') {
        const errMsg = `Box failed to stop with status: ${this.state}, error reason: ${this.errorReason}`
        throw new BoxliteError(errMsg)
      }

      if (timeout !== 0 && Date.now() - startTime > timeout * 1000) {
        throw new BoxliteError('Box failed to become stopped within the timeout period')
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
  }

  /**
   * Refreshes the Box data from the API.
   *
   * @returns {Promise<void>}
   *
   * @example
   * await box.refreshData();
   * console.log(`Box ${box.id}:`);
   * console.log(`State: ${box.state}`);
   * console.log(`Resources: ${box.cpu} CPU, ${box.memory} GiB RAM`);
   */
  @WithInstrumentation()
  public async refreshData(): Promise<void> {
    const response = await this.boxApi.getBox(this.id)
    this.processBoxDto(response.data)
  }

  /**
   * Refreshes the box activity to reset the timer for automated lifecycle management actions.
   *
   * This method updates the box's last activity timestamp without changing its state.
   * It is useful for keeping long-running sessions alive while there is still user activity.
   *
   * @returns {Promise<void>}
   *
   * @example
   * // Keep box activity alive
   * await box.refreshActivity();
   */
  public async refreshActivity(): Promise<void> {
    await this.boxApi.updateLastActivity(this.id)
  }

  /**
   * Set the auto-stop interval for the Box.
   *
   * The Box will automatically stop after being idle (no new events) for the specified interval.
   * Events include any state changes or interactions with the Box through the sdk.
   * Interactions using Box Previews are not included.
   *
   * @param {number} interval - Number of minutes of inactivity before auto-stopping.
   *                           Set to 0 to disable auto-stop. Default is 15 minutes.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - `BoxliteError` - If interval is not a non-negative integer
   *
   * @example
   * // Auto-stop after 1 hour
   * await box.setAutostopInterval(60);
   * // Or disable auto-stop
   * await box.setAutostopInterval(0);
   */
  @WithInstrumentation()
  public async setAutostopInterval(interval: number): Promise<void> {
    if (!Number.isInteger(interval) || interval < 0) {
      throw new BoxliteError('autoStopInterval must be a non-negative integer')
    }

    await this.boxApi.setAutostopInterval(this.id, interval)
    this.autoStopInterval = interval
  }

  /**
   * Set the auto-delete interval for the Box.
   *
   * The Box will automatically delete after being continuously stopped for the specified interval.
   *
   * @param {number} interval - Number of minutes after which a continuously stopped Box will be auto-deleted.
   *                           Set to negative value to disable auto-delete. Set to 0 to delete immediately upon stopping.
   *                           By default, auto-delete is disabled.
   * @returns {Promise<void>}
   *
   * @example
   * // Auto-delete after 1 hour
   * await box.setAutoDeleteInterval(60);
   * // Or delete immediately upon stopping
   * await box.setAutoDeleteInterval(0);
   * // Or disable auto-delete
   * await box.setAutoDeleteInterval(-1);
   */
  @WithInstrumentation()
  public async setAutoDeleteInterval(interval: number): Promise<void> {
    await this.boxApi.setAutoDeleteInterval(this.id, interval)
    this.autoDeleteInterval = interval
  }

  /**
   * Retrieves the preview link for the box at the specified port. If the port is closed,
   * it will be opened automatically. For private boxes, a token is included to grant access
   * to the URL.
   *
   * @param {number} port - The port to open the preview link on.
   * @returns {PortPreviewUrl} The response object for the preview link, which includes the `url`
   * and the `token` (to access private boxes).
   *
   * @example
   * const previewLink = await box.getPreviewLink(3000);
   * console.log(`Preview URL: ${previewLink.url}`);
   * console.log(`Token: ${previewLink.token}`);
   */
  @WithInstrumentation()
  public async getPreviewLink(port: number): Promise<PortPreviewUrl> {
    return (await this.boxApi.getPortPreviewUrl(this.id, port)).data
  }

  /**
   * Retrieves a signed preview url for the box at the specified port.
   *
   * @param {number} port - The port to open the preview link on.
   * @param {number} [expiresInSeconds] - The number of seconds the signed preview url will be valid for. Defaults to 60 seconds.
   * @returns {Promise<SignedPortPreviewUrl>} The response object for the signed preview url.
   */
  public async getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<SignedPortPreviewUrl> {
    return (await this.boxApi.getSignedPortPreviewUrl(this.id, port, undefined, expiresInSeconds)).data
  }

  /**
   * Expires a signed preview url for the box at the specified port.
   *
   * @param {number} port - The port to expire the signed preview url on.
   * @param {string} token - The token to expire the signed preview url on.
   * @returns {Promise<void>}
   */
  public async expireSignedPreviewUrl(port: number, token: string): Promise<void> {
    await this.boxApi.expireSignedPortPreviewUrl(this.id, port, token)
  }

  /**
   * Resizes the Box resources.
   *
   * Changes the CPU, memory, or disk allocation for the Box. Hot resize (on running
   * box) only allows CPU/memory increases. Disk resize requires a stopped box.
   *
   * @param {Resources} resources - New resource configuration. Only specified fields will be updated.
   *   - cpu: Number of CPU cores (minimum: 1). For hot resize, can only be increased.
   *   - memory: Memory in GiB (minimum: 1). For hot resize, can only be increased.
   *   - disk: Disk space in GiB (can only be increased, requires stopped box).
   * @param {number} [timeout=60] - Timeout in seconds for the resize operation. 0 means no timeout.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - If hot resize constraints are violated, disk resize attempted on running box,
   *   disk size decrease is attempted, no resource changes are specified, or resize operation times out.
   *
   * @example
   * // Increase CPU/memory on running box (hot resize)
   * await box.resize({ cpu: 4, memory: 8 });
   *
   * // Change disk (box must be stopped)
   * await box.stop();
   * await box.resize({ cpu: 2, memory: 4, disk: 30 });
   */
  @WithInstrumentation()
  public async resize(resources: Resources, timeout = 60): Promise<void> {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    const startTime = Date.now()
    const resizeRequest: ResizeBox = {
      cpu: resources.cpu,
      memory: resources.memory,
      disk: resources.disk,
    }
    const response = await this.boxApi.resizeBox(this.id, resizeRequest, this.organizationId, {
      timeout: timeout * 1000,
    })
    this.processBoxDto(response.data)
    const timeElapsed = Date.now() - startTime
    await this.waitForResizeComplete(timeout ? Math.max(0.001, timeout - timeElapsed / 1000) : timeout)
  }

  /**
   * Waits for the Box resize operation to complete.
   *
   * This method polls the Box status until the state is no longer 'resizing'.
   *
   * @param {number} [timeout=60] - Maximum time to wait in seconds. 0 means no timeout.
   * @returns {Promise<void>}
   * @throws {BoxliteError} - If the box ends up in an error state or resize times out.
   */
  @WithInstrumentation()
  public async waitForResizeComplete(timeout = 60): Promise<void> {
    if (timeout < 0) {
      throw new BoxliteError('Timeout must be a non-negative number')
    }

    const checkInterval = 100 // Wait 100 ms between checks
    const startTime = Date.now()

    while (this.state === BoxState.RESIZING) {
      await this.refreshData()

      // @ts-expect-error this.refreshData() can modify this.state so this check is fine
      if (this.state === BoxState.ERROR || this.state === BoxState.BUILD_FAILED) {
        throw new BoxliteError(
          `Box ${this.id} resize failed with state: ${this.state}, error reason: ${this.errorReason}`,
        )
      }

      if (this.state !== BoxState.RESIZING) {
        return
      }

      if (timeout !== 0 && Date.now() - startTime > timeout * 1000) {
        throw new BoxliteError('Box resize did not complete within the timeout period')
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
  }

  /**
   * Creates an SSH access token for the box.
   *
   * @param {number} expiresInMinutes - The number of minutes the SSH access token will be valid for.
   * @returns {Promise<SshAccessDto>} The SSH access token.
   */
  @WithInstrumentation()
  public async createSshAccess(expiresInMinutes?: number): Promise<SshAccessDto> {
    return (await this.boxApi.createSshAccess(this.id, undefined, expiresInMinutes)).data
  }

  /**
   * Revokes an SSH access token for the box.
   *
   * @param {string} token - The token to revoke.
   * @returns {Promise<void>}
   */
  @WithInstrumentation()
  public async revokeSshAccess(token: string): Promise<void> {
    await this.boxApi.revokeSshAccess(this.id, undefined, token)
  }

  /**
   * Validates an SSH access token for the box.
   *
   * @param {string} token - The token to validate.
   * @returns {Promise<SshAccessValidationDto>} The SSH access validation result.
   */
  @WithInstrumentation()
  public async validateSshAccess(token: string): Promise<SshAccessValidationDto> {
    return (await this.boxApi.validateSshAccess(token)).data
  }

  /**
   * Assigns the API box data to the Box object.
   *
   * @param {BoxDto} boxDto - The API box instance to assign data from
   * @returns {void}
   */
  private processBoxDto(boxDto: BoxDto) {
    this.id = boxDto.id
    this.boxId = boxDto.boxId
    this.name = boxDto.name
    this.organizationId = boxDto.organizationId
    this.user = boxDto.user
    this.env = boxDto.env
    this.labels = boxDto.labels
    this.public = boxDto.public
    this.target = boxDto.target
    this.cpu = boxDto.cpu
    this.gpu = boxDto.gpu
    this.memory = boxDto.memory
    this.disk = boxDto.disk
    this.state = boxDto.state
    this.errorReason = boxDto.errorReason
    this.recoverable = boxDto.recoverable
    this.autoStopInterval = boxDto.autoStopInterval
    this.autoDeleteInterval = boxDto.autoDeleteInterval
    this.volumes = boxDto.volumes
    this.createdAt = boxDto.createdAt
    this.updatedAt = boxDto.updatedAt
    this.networkBlockAll = boxDto.networkBlockAll
    this.networkAllowList = boxDto.networkAllowList
    this.toolboxProxyUrl = boxDto.toolboxProxyUrl
  }

  /**
   * Refreshes the Box data from the API, but does not throw an error if the box has been deleted.
   * Instead, it sets the state to destroyed.
   *
   * @returns {Promise<void>}
   */
  private async refreshDataSafe(): Promise<void> {
    try {
      await this.refreshData()
    } catch (error) {
      if (error instanceof BoxLiteNotFoundError) {
        this.state = BoxState.DESTROYED
      }
    }
  }
}

export interface PaginatedBoxes extends Omit<PaginatedBoxesDto, 'items'> {
  items: Box[]
}
