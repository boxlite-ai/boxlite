/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiClient } from '@/api/apiClient'
import type {
  Box as ApiBox,
  BoxVolume,
  CompressedScreenshotResponse,
  CreateBox,
  DisplayInfoResponse,
  ExecuteResponse,
  FileInfo,
  GitStatus,
  ListBranchResponse,
  MouseClickResponse,
  MouseDragResponse,
  MouseMoveResponse,
  MousePosition,
  RegionScreenshotResponse,
  ScreenshotResponse,
  WindowsResponse,
} from '@boxlite-ai/api-client'

export enum CodeLanguage {
  PYTHON = 'python',
  TYPESCRIPT = 'typescript',
  JAVASCRIPT = 'javascript',
}

export interface Resources {
  cpu?: number
  gpu?: number
  memory?: number
  disk?: number
}

export type VolumeMount = BoxVolume
export type TemplateResources = Pick<Resources, 'cpu' | 'memory' | 'disk'>

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

export type CreateBoxFromImageParams = CreateBoxBaseParams & {
  image: string
  resources?: Resources
}

export type CreateBoxFromTemplateParams = CreateBoxBaseParams & {
  templateId?: string
  resources?: TemplateResources
}

export type CreateBoxParams = CreateBoxBaseParams | CreateBoxFromImageParams | CreateBoxFromTemplateParams

export interface CodeRunParams {
  argv?: string[]
  env?: Record<string, string>
}

export interface ScreenshotRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenshotOptions {
  showCursor?: boolean
  format?: string
  quality?: number
  scale?: number
}

export type CloudBoxProcess = {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<ExecuteResponse>
  codeRun(code: string, params?: CodeRunParams, timeout?: number): Promise<ExecuteResponse>
}

export type CloudBoxFileSystem = {
  createFolder(path: string, mode: string): Promise<void>
  deleteFile(path: string, recursive?: boolean): Promise<void>
  listFiles(path: string): Promise<FileInfo[]>
}

export type CloudBoxGit = {
  clone(
    url: string,
    path: string,
    branch?: string,
    commitId?: string,
    username?: string,
    password?: string,
  ): Promise<void>
  status(path: string): Promise<GitStatus>
  branches(path: string): Promise<ListBranchResponse>
}

export type CloudBoxComputerUse = {
  mouse: {
    getPosition(): Promise<MousePosition>
    move(x: number, y: number): Promise<MouseMoveResponse>
    click(x: number, y: number, button?: string, double?: boolean): Promise<MouseClickResponse>
    drag(startX: number, startY: number, endX: number, endY: number, button?: string): Promise<MouseDragResponse>
    scroll(x: number, y: number, direction: 'up' | 'down', amount?: number): Promise<boolean>
  }
  keyboard: {
    hotkey(keys: string): Promise<void>
    press(key: string, modifiers?: string[]): Promise<void>
    type(text: string, delay?: number): Promise<void>
  }
  screenshot: {
    takeCompressed(options?: ScreenshotOptions): Promise<CompressedScreenshotResponse>
    takeCompressedRegion(region: ScreenshotRegion, options?: ScreenshotOptions): Promise<CompressedScreenshotResponse>
    takeFullScreen(showCursor?: boolean): Promise<ScreenshotResponse>
    takeRegion(region: ScreenshotRegion, showCursor?: boolean): Promise<RegionScreenshotResponse>
  }
  display: {
    getInfo(): Promise<DisplayInfoResponse>
    getWindows(): Promise<WindowsResponse>
  }
}

export type CloudBox = ApiBox & {
  process: CloudBoxProcess
  fs: CloudBoxFileSystem
  git: CloudBoxGit
  computerUse: CloudBoxComputerUse
}

export type Box = CloudBox

type CreateBoxRequest = CreateBox & {
  image?: string
}

const CODE_LANGUAGE_LABEL = 'code-toolbox-language'
const STARTED_STATE = 'started'
const ERROR_STATE = 'error'
const DEFAULT_CREATE_TIMEOUT_SECONDS = 60
const POLL_INTERVAL_MS = 100

export function toCreateBoxRequest(params?: CreateBoxParams, target?: string): CreateBoxRequest {
  const resolvedParams = params ?? { language: CodeLanguage.PYTHON }
  const labels = { ...(resolvedParams.labels ?? {}) }

  if (resolvedParams.language) {
    labels[CODE_LANGUAGE_LABEL] = String(resolvedParams.language)
  }

  if ('templateId' in resolvedParams && resolvedParams.templateId !== undefined) {
    throw new Error('Box templates were removed from the API; remove the templateId parameter.')
  }

  if ('image' in resolvedParams && typeof resolvedParams.image !== 'string') {
    throw new Error('Declarative Image objects are no longer supported by the API; pass a curated image key.')
  }

  const resources = 'resources' in resolvedParams ? resolvedParams.resources : undefined
  const autoDeleteInterval = resolvedParams.ephemeral ? 0 : resolvedParams.autoDeleteInterval

  return {
    name: resolvedParams.name,
    user: resolvedParams.user,
    env: resolvedParams.envVars ?? {},
    labels,
    public: resolvedParams.public,
    networkBlockAll: resolvedParams.networkBlockAll,
    networkAllowList: resolvedParams.networkAllowList,
    target,
    cpu: resources?.cpu,
    gpu: (resources as Resources | undefined)?.gpu,
    memory: resources?.memory,
    disk: resources?.disk,
    autoStopInterval: resolvedParams.autoStopInterval,
    autoDeleteInterval,
    volumes: resolvedParams.volumes,
    ...('image' in resolvedParams ? { image: resolvedParams.image } : {}),
  }
}

export function createCloudBox(boxDto: ApiBox, api: ApiClient, organizationId?: string): CloudBox {
  const boxId = boxDto.id
  const language = boxDto.labels?.[CODE_LANGUAGE_LABEL] as CodeLanguage | undefined

  return {
    ...boxDto,
    process: createProcessClient(api, boxId, organizationId, language),
    fs: createFileSystemClient(api, boxId, organizationId),
    git: createGitClient(api, boxId, organizationId),
    computerUse: createComputerUseClient(api, boxId, organizationId),
  }
}

export async function waitUntilStarted(
  box: ApiBox,
  api: ApiClient,
  organizationId?: string,
  timeoutSeconds = DEFAULT_CREATE_TIMEOUT_SECONDS,
): Promise<ApiBox> {
  if (timeoutSeconds < 0) {
    throw new Error('Timeout must be a non-negative number')
  }

  const startTime = Date.now()
  let currentBox = box

  while (currentBox.state !== STARTED_STATE) {
    currentBox = (await api.boxApi.getBox(currentBox.id, organizationId)).data

    if (currentBox.state === STARTED_STATE) {
      return currentBox
    }

    if (currentBox.state === ERROR_STATE) {
      throw new Error(
        `Box ${currentBox.id} failed to start with status: ${currentBox.state}, error reason: ${currentBox.errorReason}`,
      )
    }

    if (timeoutSeconds !== 0 && Date.now() - startTime > timeoutSeconds * 1000) {
      throw new Error('Box failed to become ready within the timeout period')
    }

    await delay(POLL_INTERVAL_MS)
  }

  return currentBox
}

function createProcessClient(
  api: ApiClient,
  boxId: string,
  organizationId?: string,
  language?: CodeLanguage,
): CloudBoxProcess {
  return {
    async executeCommand(command, cwd, env, timeout) {
      const response = await api.toolboxApi.executeCommandDeprecated(
        boxId,
        {
          command: withEnvironment(command, env),
          cwd,
          timeout,
        },
        organizationId,
      )

      return response.data
    },
    async codeRun(code, params, timeout) {
      const command = getRunCommand(code, language, params)
      return this.executeCommand(command, undefined, params?.env, timeout)
    },
  }
}

function createFileSystemClient(api: ApiClient, boxId: string, organizationId?: string): CloudBoxFileSystem {
  return {
    async createFolder(path, mode) {
      await api.toolboxApi.createFolderDeprecated(boxId, path, mode, organizationId)
    },
    async deleteFile(path, recursive) {
      await api.toolboxApi.deleteFileDeprecated(boxId, path, organizationId, recursive)
    },
    async listFiles(path) {
      return (await api.toolboxApi.listFilesDeprecated(boxId, organizationId, path)).data
    },
  }
}

function createGitClient(api: ApiClient, boxId: string, organizationId?: string): CloudBoxGit {
  return {
    async clone(url, path, branch, commitId, username, password) {
      await api.toolboxApi.gitCloneRepositoryDeprecated(
        boxId,
        {
          url,
          path,
          branch,
          commit_id: commitId,
          username,
          password,
        },
        organizationId,
      )
    },
    async status(path) {
      return (await api.toolboxApi.gitGetStatusDeprecated(boxId, path, organizationId)).data
    },
    async branches(path) {
      return (await api.toolboxApi.gitListBranchesDeprecated(boxId, path, organizationId)).data
    },
  }
}

function createComputerUseClient(api: ApiClient, boxId: string, organizationId?: string): CloudBoxComputerUse {
  return {
    mouse: {
      async getPosition() {
        return (await api.toolboxApi.getMousePositionDeprecated(boxId, organizationId)).data
      },
      async move(x, y) {
        return (await api.toolboxApi.moveMouseDeprecated(boxId, { x, y }, organizationId)).data
      },
      async click(x, y, button = 'left', double = false) {
        return (await api.toolboxApi.clickMouseDeprecated(boxId, { x, y, button, double }, organizationId)).data
      },
      async drag(startX, startY, endX, endY, button = 'left') {
        return (await api.toolboxApi.dragMouseDeprecated(boxId, { startX, startY, endX, endY, button }, organizationId))
          .data
      },
      async scroll(x, y, direction, amount = 1) {
        return (await api.toolboxApi.scrollMouseDeprecated(boxId, { x, y, direction, amount }, organizationId)).data
          .success
      },
    },
    keyboard: {
      async hotkey(keys) {
        await api.toolboxApi.pressHotkeyDeprecated(boxId, { keys }, organizationId)
      },
      async press(key, modifiers = []) {
        await api.toolboxApi.pressKeyDeprecated(boxId, { key, modifiers }, organizationId)
      },
      async type(text, delay) {
        await api.toolboxApi.typeTextDeprecated(boxId, { text, delay }, organizationId)
      },
    },
    screenshot: {
      async takeCompressed(options = {}) {
        return (
          await api.toolboxApi.takeCompressedScreenshotDeprecated(
            boxId,
            organizationId,
            options.scale,
            options.quality,
            options.format,
            options.showCursor,
          )
        ).data
      },
      async takeCompressedRegion(region, options = {}) {
        return (
          await api.toolboxApi.takeCompressedRegionScreenshotDeprecated(
            boxId,
            region.height,
            region.width,
            region.y,
            region.x,
            organizationId,
            options.scale,
            options.quality,
            options.format,
            options.showCursor,
          )
        ).data
      },
      async takeFullScreen(showCursor = false) {
        return (await api.toolboxApi.takeScreenshotDeprecated(boxId, organizationId, showCursor)).data
      },
      async takeRegion(region, showCursor = false) {
        return (
          await api.toolboxApi.takeRegionScreenshotDeprecated(
            boxId,
            region.height,
            region.width,
            region.y,
            region.x,
            organizationId,
            showCursor,
          )
        ).data
      },
    },
    display: {
      async getInfo() {
        return (await api.toolboxApi.getDisplayInfoDeprecated(boxId, organizationId)).data
      },
      async getWindows() {
        return (await api.toolboxApi.getWindowsDeprecated(boxId, organizationId)).data
      },
    },
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function getRunCommand(code: string, language = CodeLanguage.PYTHON, params?: CodeRunParams): string {
  const argv = params?.argv?.map(shellQuote).join(' ') ?? ''

  switch (language) {
    case CodeLanguage.JAVASCRIPT:
      return `printf '%s' '${base64Encode(`process.argv.splice(1, 1);\n${code}`)}' | base64 -d | node - ${argv}`
    case CodeLanguage.TYPESCRIPT:
      return [
        `_f=/tmp/dtn_$$.ts`,
        `printf '%s' '${base64Encode(`process.argv.splice(1, 1);\n${code}`)}' | base64 -d > "$_f"`,
        `npm_config_loglevel=error npx ts-node -T --ignore-diagnostics 5107 -O '{"module":"CommonJS"}' "$_f" ${argv}`,
        `_dtn_ec=$?`,
        `rm -f "$_f"`,
        `exit $_dtn_ec`,
      ].join('; ')
    case CodeLanguage.PYTHON:
    default:
      return `printf '%s' '${base64Encode(code)}' | base64 -d | python3 -u - ${argv}`
  }
}

function withEnvironment(command: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) {
    return command
  }

  const validKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
  const exports = Object.entries(env)
    .map(([key, value]) => {
      if (!validKeyPattern.test(key)) {
        throw new Error(`Invalid environment variable name: '${key}'`)
      }
      return `export ${key}="$(echo '${base64Encode(value)}' | base64 -d)"`
    })
    .join('; ')

  return `${exports}; ${command}`
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
