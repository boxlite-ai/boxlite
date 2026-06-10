/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  DEFAULT_CPU_RESOURCES,
  DEFAULT_DISK_RESOURCES,
  DEFAULT_MEMORY_RESOURCES,
  BOX_TEMPLATE_DEFAULT_VALUE,
} from '@/constants/Playground'
import {
  ActionRuntimeError,
  PlaygroundActionParams,
  PlaygroundActionParamValueSetter,
  PlaygroundContext,
  RunningActionMethodName,
  RunPlaygroundActionBasic,
  RunPlaygroundActionWithParams,
  BoxParams,
  SetPlaygroundActionParamValue,
  SetBoxParamsValue,
  SetVNCInteractionOptionsParamValue,
  ValidatePlaygroundActionRequiredParams,
  ValidatePlaygroundActionWithParams,
  VNCInteractionOptionsParams,
} from '@/contexts/PlaygroundContext'
import { MouseButton, MouseScrollDirection, BoxParametersSections, ScreenshotFormatOption } from '@/enums/Playground'
import { getLanguageCodeToRun, objectHasAnyValue } from '@/lib/playground'
import { CreateBoxBaseParams, CreateBoxFromImageParams, CreateBoxFromTemplateParams, Image } from '@boxlite-ai/sdk'
import { useCallback, useState } from 'react'

const PARAM_SECTION_MAP: Partial<Record<keyof BoxParams, BoxParametersSections>> = {
  listFilesParams: BoxParametersSections.FILE_SYSTEM,
  createFolderParams: BoxParametersSections.FILE_SYSTEM,
  deleteFileParams: BoxParametersSections.FILE_SYSTEM,
  gitCloneParams: BoxParametersSections.GIT_OPERATIONS,
  gitStatusParams: BoxParametersSections.GIT_OPERATIONS,
  gitBranchesParams: BoxParametersSections.GIT_OPERATIONS,
  codeRunParams: BoxParametersSections.PROCESS_CODE_EXECUTION,
  shellCommandRunParams: BoxParametersSections.PROCESS_CODE_EXECUTION,
}

export const PlaygroundProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [openedParametersSections, setOpenedParametersSections] = useState<BoxParametersSections[]>([
    BoxParametersSections.BOX_MANAGEMENT,
  ])
  const [enabledSections, setEnabledSections] = useState<BoxParametersSections[]>([
    BoxParametersSections.BOX_MANAGEMENT,
  ])
  const [pendingScrollSection, setPendingScrollSection] = useState<BoxParametersSections | null>(null)

  const enableSection = useCallback((section: BoxParametersSections) => {
    setEnabledSections((prev) => (prev.includes(section) ? prev : [...prev, section]))
    setOpenedParametersSections((prev) => (prev.includes(section) ? prev : [...prev, section]))
    setPendingScrollSection(section)
  }, [])

  const disableSection = useCallback((section: BoxParametersSections) => {
    setEnabledSections((prev) => prev.filter((s) => s !== section))
    setOpenedParametersSections((prev) => prev.filter((s) => s !== section))
  }, [])

  const clearPendingScrollSection = useCallback(() => setPendingScrollSection(null), [])

  const [boxParametersState, setBoxParametersState] = useState<BoxParams>({
    templateName: BOX_TEMPLATE_DEFAULT_VALUE,
    resources: {
      cpu: DEFAULT_CPU_RESOURCES,
      memory: DEFAULT_MEMORY_RESOURCES,
      disk: DEFAULT_DISK_RESOURCES,
    },
    createBoxBaseParams: {
      autoStopInterval: 5,
      autoDeleteInterval: 0,
    },
    listFilesParams: {
      directoryPath: 'workspace/new-dir',
    },
    createFolderParams: {
      folderDestinationPath: 'workspace/new-dir',
      permissions: '755',
    },
    deleteFileParams: {
      filePath: 'workspace/new-dir',
      recursive: true,
    },
    gitCloneParams: {
      repositoryURL: 'https://github.com/octocat/Hello-World.git',
      cloneDestinationPath: 'workspace/repo',
    },
    gitStatusParams: {
      repositoryPath: 'workspace/repo',
    },
    gitBranchesParams: {
      repositoryPath: 'workspace/repo',
    },
    codeRunParams: {
      languageCode: getLanguageCodeToRun(),
    },
    shellCommandRunParams: {
      shellCommand: 'ls -la', // Current default and fixed value
    },
  })
  const [VNCInteractionOptionsParamsState, setVNCInteractionOptionsParamsState] = useState<VNCInteractionOptionsParams>(
    {
      keyboardHotKeyParams: { keys: '' },
      keyboardPressParams: { key: '' },
      keyboardTypeParams: { text: '' },
      mouseClickParams: {
        x: 100,
        y: 100,
        button: MouseButton.LEFT,
        double: false,
      },
      mouseDragParams: {
        startX: 100,
        startY: 100,
        endX: 200,
        endY: 200,
        button: MouseButton.LEFT,
      },
      mouseMoveParams: {
        x: 100,
        y: 100,
      },
      mouseScrollParams: {
        x: 100,
        y: 100,
        direction: MouseScrollDirection.DOWN,
        amount: 1,
      },
      screenshotOptionsConfig: {
        showCursor: false,
        format: ScreenshotFormatOption.PNG,
        quality: 100,
        scale: 1,
      },
      screenshotRegionConfig: {
        x: 100,
        y: 100,
        width: 300,
        height: 200,
      },
    },
  )

  const setBoxParameterValue: SetBoxParamsValue = useCallback((key, value) => {
    setBoxParametersState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const setVNCInteractionOptionsParamValue: SetVNCInteractionOptionsParamValue = useCallback((key, value) => {
    setVNCInteractionOptionsParamsState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const setPlaygroundActionParamValue: SetPlaygroundActionParamValue = useCallback(
    (key, value) => {
      if (key in boxParametersState) {
        setBoxParameterValue(key as keyof BoxParams, value as BoxParams[keyof BoxParams])
      } else if (key in VNCInteractionOptionsParamsState) {
        setVNCInteractionOptionsParamValue(
          key as keyof VNCInteractionOptionsParams,
          value as VNCInteractionOptionsParams[keyof VNCInteractionOptionsParams],
        )
      } else {
        console.error(`Unknown parameter key: ${String(key)}`)
      }
    },
    [setBoxParameterValue, setVNCInteractionOptionsParamValue, boxParametersState, VNCInteractionOptionsParamsState],
  )

  const [runningActionMethod, setRunningActionMethod] = useState<RunningActionMethodName>(null)
  const [actionRuntimeError, setActionRuntimeError] = useState<ActionRuntimeError>({})

  const validatePlaygroundActionRequiredParams: ValidatePlaygroundActionRequiredParams = useCallback(
    (actionParamsFormData, actionParamsState) => {
      if (actionParamsFormData.some((formItem) => formItem.required)) {
        const emptyFormItem = actionParamsFormData
          .filter((formItem) => formItem.required)
          .find((formItem) => {
            const value = actionParamsState[formItem.key]
            return value === '' || value === undefined
          })

        if (emptyFormItem) {
          return `${emptyFormItem.label} parameter is required for this action`
        }
      }

      return undefined
    },
    [],
  )

  const runPlaygroundAction: RunPlaygroundActionBasic = useCallback(async (actionFormData, invokeApi) => {
    setRunningActionMethod(actionFormData.methodName)
    // Reset error if exists
    setActionRuntimeError((prev) => ({
      ...prev,
      [actionFormData.methodName]: undefined,
    }))
    try {
      await invokeApi(actionFormData)
    } catch (error: unknown) {
      console.error('API call error', error)
      setActionRuntimeError((prev) => ({
        ...prev,
        [actionFormData.methodName]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setRunningActionMethod(null)
    }
  }, [])

  const runPlaygroundActionWithParams: RunPlaygroundActionWithParams = useCallback(
    async (actionFormData, invokeApi) => {
      const validationError = validatePlaygroundActionRequiredParams(
        actionFormData.parametersFormItems,
        actionFormData.parametersState,
      )
      if (validationError) {
        setActionRuntimeError((prev) => ({
          ...prev,
          [actionFormData.methodName]: validationError,
        }))
        setRunningActionMethod(null)
        return
      }
      return await runPlaygroundAction(actionFormData, invokeApi)
    },
    [runPlaygroundAction, validatePlaygroundActionRequiredParams],
  )

  const validatePlaygroundActionWithParams: ValidatePlaygroundActionWithParams = useCallback(
    (actionFormData, parametersState) => {
      const validationError = validatePlaygroundActionRequiredParams(
        actionFormData.parametersFormItems,
        parametersState,
      )
      if (validationError) {
        setActionRuntimeError((prev) => ({
          ...prev,
          [actionFormData.methodName]: validationError,
        }))
      } // Reset error
      else
        setActionRuntimeError((prev) => ({
          ...prev,
          [actionFormData.methodName]: undefined,
        }))
    },
    [validatePlaygroundActionRequiredParams],
  )

  const playgroundActionParamValueSetter: PlaygroundActionParamValueSetter = useCallback(
    (actionFormData, paramFormData, actionParamsKey, value) => {
      const prev =
        actionParamsKey in boxParametersState
          ? boxParametersState[actionParamsKey as keyof BoxParams]
          : VNCInteractionOptionsParamsState[actionParamsKey as keyof VNCInteractionOptionsParams]
      const newState = Object.assign({}, prev, { [paramFormData.key]: value })

      setPlaygroundActionParamValue(actionParamsKey, newState as PlaygroundActionParams[typeof actionParamsKey])
      if (!actionFormData.onChangeParamsValidationDisabled)
        validatePlaygroundActionWithParams(actionFormData, newState as typeof actionFormData.parametersState)

      // Auto-enable the section that owns this param if it's currently disabled
      const section = PARAM_SECTION_MAP[actionParamsKey as keyof BoxParams]
      if (section && !enabledSections.includes(section)) enableSection(section)
    },
    [
      setPlaygroundActionParamValue,
      validatePlaygroundActionWithParams,
      boxParametersState,
      VNCInteractionOptionsParamsState,
      enabledSections,
      enableSection,
    ],
  )

  const getBoxParametersInfo = useCallback(() => {
    const useLanguageParam = !!boxParametersState['language']
    const resourceValuesExist = objectHasAnyValue(boxParametersState['resources'])
    const useResourcesCPU = resourceValuesExist && boxParametersState['resources']['cpu'] !== undefined
    const useResourcesMemory = resourceValuesExist && boxParametersState['resources']['memory'] !== undefined
    const useResourcesDisk = resourceValuesExist && boxParametersState['resources']['disk'] !== undefined
    const useDefaultResourceValues = !(
      (useResourcesCPU && boxParametersState['resources']['cpu'] !== DEFAULT_CPU_RESOURCES) ||
      (useResourcesMemory && boxParametersState['resources']['memory'] !== DEFAULT_MEMORY_RESOURCES) ||
      (useResourcesDisk && boxParametersState['resources']['disk'] !== DEFAULT_DISK_RESOURCES)
    )

    const createBoxParamsExist = objectHasAnyValue(boxParametersState['createBoxBaseParams'])
    const useAutoStopInterval =
      createBoxParamsExist && boxParametersState['createBoxBaseParams']['autoStopInterval'] !== undefined
    const useAutoDeleteInterval =
      createBoxParamsExist && boxParametersState['createBoxBaseParams']['autoDeleteInterval'] !== undefined

    const createBoxFromImageParams: CreateBoxFromImageParams = { image: Image.debianSlim('3.13') } // Default and fixed image if CreateBoxFromImageParams are used
    const templateName = boxParametersState['templateName']
    const useCustomImageName = templateName !== undefined && templateName !== BOX_TEMPLATE_DEFAULT_VALUE
    // TODO(image-rewrite): templateId param was removed with the image/template subsystem.
    const createBoxFromTemplateParams: CreateBoxFromTemplateParams = {}
    const createBoxFromTemplate = useCustomImageName || useDefaultResourceValues

    const createBoxFromImage = !useDefaultResourceValues && !useCustomImageName

    // We specify resources for box creation if there is any specified resource value which has value different from the default one and useCustomImageName is false
    const useResources = !useCustomImageName && resourceValuesExist && !useDefaultResourceValues
    const useBoxCreateParams =
      useLanguageParam || useResources || createBoxParamsExist || useCustomImageName || createBoxFromImage

    if (createBoxFromImage) {
      // Set CreateBoxFromImageParams specific params
      if (useResources) {
        createBoxFromImageParams.resources = {}
        if (useResourcesCPU) createBoxFromImageParams.resources.cpu = boxParametersState['resources']['cpu']
        if (useResourcesMemory) createBoxFromImageParams.resources.memory = boxParametersState['resources']['memory']
        if (useResourcesDisk) createBoxFromImageParams.resources.disk = boxParametersState['resources']['disk']
      }
    }
    let createBoxParams: CreateBoxBaseParams | CreateBoxFromImageParams | CreateBoxFromTemplateParams = {}
    if (createBoxFromTemplate) createBoxParams = createBoxFromTemplateParams
    else if (createBoxFromImage) createBoxParams = createBoxFromImageParams
    // Set CreateBoxBaseParams params which are common for both params types
    if (useLanguageParam) createBoxParams.language = boxParametersState['language']
    if (useAutoStopInterval)
      createBoxParams.autoStopInterval = boxParametersState['createBoxBaseParams']['autoStopInterval']
    if (useAutoDeleteInterval)
      createBoxParams.autoDeleteInterval = boxParametersState['createBoxBaseParams']['autoDeleteInterval']
    createBoxParams.labels = { 'boxlite-playground': 'true' }
    if (useLanguageParam)
      createBoxParams.labels['boxlite-playground-language'] = boxParametersState['language'] as string // useLanguageParam guarantees that value isn't undefined so we put as string to silence TS compiler
    return {
      useLanguageParam,
      useResources,
      useResourcesCPU,
      useResourcesMemory,
      useResourcesDisk,
      createBoxParamsExist,
      useAutoStopInterval,
      useAutoDeleteInterval,
      useBoxCreateParams,
      useCustomImageName,
      createBoxFromImage,
      createBoxFromTemplate,
      createBoxParams,
    }
  }, [boxParametersState])

  return (
    <PlaygroundContext.Provider
      value={{
        boxParametersState,
        setBoxParameterValue,
        VNCInteractionOptionsParamsState,
        setVNCInteractionOptionsParamValue,
        runPlaygroundActionWithParams,
        runPlaygroundActionWithoutParams: runPlaygroundAction,
        validatePlaygroundActionWithParams,
        playgroundActionParamValueSetter,
        runningActionMethod,
        actionRuntimeError,
        getBoxParametersInfo,
        openedParametersSections,
        setOpenedParametersSections,
        enabledSections,
        enableSection,
        disableSection,
        pendingScrollSection,
        clearPendingScrollSection,
      }}
    >
      {children}
    </PlaygroundContext.Provider>
  )
}
