/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: Apache-2.0
 */

export { CodeLanguage, BoxLite } from './BoxLite'
export type {
  CreateSandboxBaseParams,
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  BoxliteConfig,
  Resources,
  VolumeMount,
} from './BoxLite'
export { FileSystem } from './FileSystem'
export { Git } from './Git'
export { LspLanguageId } from './LspServer'
export { Process } from './Process'
// export { LspServer } from './LspServer'
// export type { LspLanguageId, Position } from './LspServer'
export { BoxliteError, BoxLiteNotFoundError, BoxLiteRateLimitError, BoxLiteTimeoutError } from './errors/BoxliteError'
export { Image } from './Image'
export { Sandbox } from './Sandbox'
export type { SandboxCodeToolbox } from './Sandbox'
export type { CreateSnapshotParams } from './Snapshot'
export { ComputerUse, Mouse, Keyboard, Screenshot, Display } from './ComputerUse'
export type { ExecutionError, ExecutionResult, OutputMessage, RunCodeOptions } from './types/CodeInterpreter'

// Chart and artifact types
export { ChartType } from './types/Charts'
export type {
  BarChart,
  BoxAndWhiskerChart,
  Chart,
  CompositeChart,
  LineChart,
  PieChart,
  ScatterChart,
} from './types/Charts'

export { SandboxState } from '@boxlite-ai/api-client'
export type {
  FileInfo,
  GitStatus,
  ListBranchResponse,
  Match,
  ReplaceResult,
  SearchFilesResponse,
} from '@boxlite-ai/toolbox-api-client'

export type { ScreenshotRegion, ScreenshotOptions } from './ComputerUse'

export * from './Process'
export * from './PtyHandle'
export * from './types/Pty'
