/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  FileSystemActions,
  GitOperationsActions,
  KeyboardActions,
  MouseActions,
  MouseButton,
  MouseScrollDirection,
  PlaygroundActions,
  ProcessCodeExecutionActions,
  BoxParametersSections,
  ScreenshotActions,
  ScreenshotFormatOption,
} from '@/enums/Playground'
import {
  CodeLanguage,
  ComputerUse,
  CreateBoxBaseParams,
  CreateBoxFromImageParams,
  CreateBoxFromTemplateParams,
  Resources,
  ScreenshotOptions,
  ScreenshotRegion,
} from '@boxlite-ai/sdk'
import { createContext, ReactNode } from 'react'

export interface ParameterFormItem {
  label: string
  placeholder: string
  key: string
  required?: boolean
}

export interface NumberParameterFormItem extends ParameterFormItem {
  min: number
  max: number
  step?: number
}

// keyof (A | B | C) gives intersections of types i.e. type = common properties to A,B,C
// KeysOf gives us keyof A | keyof B | keyof C behaviour
export type KeysOf<T> = T extends any ? keyof T : never

export type ParameterFormData<T> = ((ParameterFormItem | NumberParameterFormItem) & { key: KeysOf<T> })[]

// Form data structure for actions which don't require any parameters for their execution
export interface PlaygroundActionFormDataBasic<A> {
  label: string
  description: string
  methodName: A
  onChangeParamsValidationDisabled?: boolean
}

// Form data structure for actions which use certain parameters for their execution
export type PlaygroundActionWithParamsFormData<A, T> = PlaygroundActionFormDataBasic<A> & {
  parametersFormItems: ParameterFormData<T>
  parametersState: T
}

// --- VNC param types ---

export type KeyboardHotKey = {
  keys: string
}

export type KeyboardPress = {
  key: string
  modifiers?: string
}

export type KeyboardType = {
  text: string
  delay?: number
}

export type MouseClick = {
  x: number
  y: number
  button?: MouseButton
  double?: boolean
}

export type MouseDrag = {
  startX: number
  startY: number
  endX: number
  endY: number
  button?: MouseButton
}

export type MouseMove = {
  x: number
  y: number
}

export type MouseScroll = {
  x: number
  y: number
  direction: MouseScrollDirection
  amount?: number
}

export interface CustomizedScreenshotOptions extends Omit<ScreenshotOptions, 'format'> {
  format?: ScreenshotFormatOption
}

// --- VNC component types ---

export type WrapVNCInvokeApiType = (
  invokeApi: PlaygroundActionInvokeApi,
) => <A, T>(
  actionFormData: PlaygroundActionFormDataBasic<A> | PlaygroundActionWithParamsFormData<A, T>,
) => Promise<void>

export type VNCInteractionOptionsSectionComponentProps = {
  disableActions: boolean
  ComputerUseClient: ComputerUse | null
  wrapVNCInvokeApi: WrapVNCInvokeApiType
}

// --- Action-specific form data types ---

export type KeyboardActionFormData<T extends KeyboardHotKey | KeyboardPress | KeyboardType> =
  PlaygroundActionWithParamsFormData<KeyboardActions, T>

export type MouseActionFormData<T extends MouseClick | MouseDrag | MouseMove | MouseScroll> =
  PlaygroundActionWithParamsFormData<MouseActions, T>

export type ScreenshotActionFormData<T extends ScreenshotRegion | CustomizedScreenshotOptions> =
  PlaygroundActionWithParamsFormData<ScreenshotActions, T>

// --- Box param types ---

export type ListFilesParams = {
  directoryPath: string
}

export type CreateFolderParams = {
  folderDestinationPath: string
  permissions: string
}

export type DeleteFileParams = {
  filePath: string
  recursive?: boolean
}

export type GitCloneParams = {
  repositoryURL: string
  cloneDestinationPath: string
  branchToClone?: string
  commitToClone?: string
  authUsername?: string
  authPassword?: string
}

export type GitStatusParams = {
  repositoryPath: string
}

export type GitBranchesParams = {
  repositoryPath: string
}

export type CodeRunParams = {
  languageCode?: string
}

export type ShellCommandRunParams = {
  shellCommand?: string
}

export type FileSystemActionFormData<T extends ListFilesParams | CreateFolderParams | DeleteFileParams> =
  PlaygroundActionWithParamsFormData<FileSystemActions, T>

export type GitOperationsActionFormData<T extends GitCloneParams | GitStatusParams | GitBranchesParams> =
  PlaygroundActionWithParamsFormData<GitOperationsActions, T>

export type ProcessCodeExecutionOperationsActionFormData<T extends CodeRunParams | ShellCommandRunParams> =
  PlaygroundActionWithParamsFormData<ProcessCodeExecutionActions, T>

export interface BoxParams {
  language?: CodeLanguage
  templateName?: string
  resources: Resources
  createBoxBaseParams: CreateBoxBaseParams
  // File system operations params
  listFilesParams: ListFilesParams
  createFolderParams: CreateFolderParams
  deleteFileParams: DeleteFileParams
  // Git operations params
  gitCloneParams: GitCloneParams
  gitStatusParams: GitStatusParams
  gitBranchesParams: GitBranchesParams
  // Process and Code Execution params
  codeRunParams: CodeRunParams
  shellCommandRunParams: ShellCommandRunParams
}

export type SetBoxParamsValue = <K extends keyof BoxParams>(key: K, value: BoxParams[K]) => void

export interface VNCInteractionOptionsParams {
  keyboardHotKeyParams: KeyboardHotKey
  keyboardPressParams: KeyboardPress
  keyboardTypeParams: KeyboardType
  mouseClickParams: MouseClick
  mouseDragParams: MouseDrag
  mouseMoveParams: MouseMove
  mouseScrollParams: MouseScroll
  screenshotOptionsConfig: CustomizedScreenshotOptions
  screenshotRegionConfig: ScreenshotRegion
  responseContent?: string | ReactNode
}

export type SetVNCInteractionOptionsParamValue = <K extends keyof VNCInteractionOptionsParams>(
  key: K,
  value: VNCInteractionOptionsParams[K],
) => void

export type PlaygroundActionParams = BoxParams & VNCInteractionOptionsParams

export type SetPlaygroundActionParamValue = <K extends keyof PlaygroundActionParams>(
  key: K,
  value: PlaygroundActionParams[K],
) => void

// Currently running action, or none
export type RunningActionMethodName = PlaygroundActions | null

// Mapping between action and runtime error message (if any)
export type ActionRuntimeError = Partial<Record<PlaygroundActions, string>>

// Method for validation of required params for a given action
export type ValidatePlaygroundActionRequiredParams = <T>(
  actionParamsFormData: ParameterFormData<T>,
  actionParamsState: T,
) => string | undefined

// Basic method which runs an action that has no params
export type RunPlaygroundActionBasic = <A extends PlaygroundActions>(
  actionFormData: PlaygroundActionFormDataBasic<A>,
  invokeApi: PlaygroundActionInvokeApi,
) => Promise<void>

// Runs an action that requires params
export type RunPlaygroundActionWithParams = <A extends PlaygroundActions, T>(
  actionFormData: PlaygroundActionWithParamsFormData<A, T>,
  invokeApi: PlaygroundActionInvokeApi,
) => Promise<void>

export type PlaygroundActionInvokeApi = <A, T>(
  actionFormData: PlaygroundActionFormDataBasic<A> | PlaygroundActionWithParamsFormData<A, T>,
) => Promise<void>

export type ValidatePlaygroundActionWithParams = <A extends PlaygroundActions, T>(
  actionFormData: PlaygroundActionWithParamsFormData<A, T>,
  parametersState: T,
) => void

export type PlaygroundActionParamValueSetter = <A extends PlaygroundActions, T>(
  actionFormData: PlaygroundActionWithParamsFormData<A, T>,
  paramFormData: ParameterFormItem,
  actionParamsKey: keyof PlaygroundActionParams,
  value: any,
) => void

export type BoxParametersInfo = {
  useLanguageParam: boolean
  useResources: boolean
  useResourcesCPU: boolean
  useResourcesMemory: boolean
  useResourcesDisk: boolean
  createBoxParamsExist: boolean
  useAutoStopInterval: boolean
  useAutoDeleteInterval: boolean
  useBoxCreateParams: boolean
  useCustomImageName: boolean
  createBoxFromImage: boolean
  createBoxFromTemplate: boolean
  createBoxParams: CreateBoxBaseParams | CreateBoxFromImageParams | CreateBoxFromTemplateParams
}

export interface IPlaygroundContext {
  boxParametersState: BoxParams
  setBoxParameterValue: SetBoxParamsValue
  VNCInteractionOptionsParamsState: VNCInteractionOptionsParams
  setVNCInteractionOptionsParamValue: SetVNCInteractionOptionsParamValue
  runPlaygroundActionWithParams: RunPlaygroundActionWithParams
  runPlaygroundActionWithoutParams: RunPlaygroundActionBasic
  validatePlaygroundActionWithParams: ValidatePlaygroundActionWithParams
  playgroundActionParamValueSetter: PlaygroundActionParamValueSetter
  runningActionMethod: RunningActionMethodName
  actionRuntimeError: ActionRuntimeError
  getBoxParametersInfo: () => BoxParametersInfo
  openedParametersSections: BoxParametersSections[]
  setOpenedParametersSections: React.Dispatch<React.SetStateAction<BoxParametersSections[]>>
  enabledSections: BoxParametersSections[]
  enableSection: (section: BoxParametersSections) => void
  disableSection: (section: BoxParametersSections) => void
  pendingScrollSection: BoxParametersSections | null
  clearPendingScrollSection: () => void
}

export const PlaygroundContext = createContext<IPlaygroundContext | null>(null)
