/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Tooltip } from '@/components/Tooltip'
import { Label } from '@/components/ui/label'
import { SANDBOX_TEMPLATE_DEFAULT_VALUE } from '@/constants/Playground'
import { NumberParameterFormItem, ParameterFormItem } from '@/contexts/PlaygroundContext'
import { usePlayground } from '@/hooks/usePlayground'
import { getLanguageCodeToRun } from '@/lib/playground'
import { BoxTemplateDto } from '@boxlite-ai/api-client'
import { CodeLanguage, Resources } from '@boxlite-ai/sdk'
import { HelpCircleIcon } from 'lucide-react'
import InlineInputFormControl from '../../Inputs/InlineInputFormControl'
import FormNumberInput from '../../Inputs/NumberInput'
import FormSelectInput from '../../Inputs/SelectInput'
import StackedInputFormControl from '../../Inputs/StackedInputFormControl'
import { useEffect } from 'react'

// TODO - Currently, image selection is not supported in the Playground, so props are hardcoded to an empty array and false for loading. We keep image parts commented to enable it in future if requested by users. Also, sandbox creation and code snippet generation support template selection, so they will work when image selection is enabled in the UI without requiring any additional changes. Currently, the image value is fixed to 'Default'
type SandboxManagementParametersProps = {
  templatesData: Array<BoxTemplateDto>
  templatesLoading: boolean
}

const SandboxManagementParameters: React.FC<SandboxManagementParametersProps> = ({
  templatesData,
  templatesLoading,
}) => {
  const { sandboxParametersState, setSandboxParameterValue } = usePlayground()
  const sandboxLanguage = sandboxParametersState['language']
  const sandboxTemplateName = sandboxParametersState['templateName']
  const resources = sandboxParametersState['resources']
  const sandboxFromImageParams = sandboxParametersState['createSandboxBaseParams']

  const languageFormData: ParameterFormItem = {
    label: 'Language',
    key: 'language',
    placeholder: 'Select sandbox language',
  }

  // const sandboxTemplateFormData: ParameterFormItem = {
  //   label: 'Image',
  //   key: 'templateName',
  //   placeholder: 'Select sandbox image',
  // }

  // Available languages
  const languageOptions = [
    {
      value: CodeLanguage.PYTHON,
      label: 'Python (default)',
    },
    {
      value: CodeLanguage.TYPESCRIPT,
      label: 'TypeScript',
    },
    {
      value: CodeLanguage.JAVASCRIPT,
      label: 'JavaScript',
    },
  ]
  const resourcesFormData: (NumberParameterFormItem & { key: keyof Resources })[] = [
    { label: 'Compute (vCPU)', key: 'cpu', min: 1, max: Infinity, placeholder: '1' },
    { label: 'Memory (GiB)', key: 'memory', min: 1, max: Infinity, placeholder: '1' },
    { label: 'Storage (GiB)', key: 'disk', min: 1, max: Infinity, placeholder: '3' },
  ]

  const lifecycleParamsFormData: (NumberParameterFormItem & {
    key: 'autoStopInterval' | 'autoArchiveInterval' | 'autoDeleteInterval'
  })[] = [
    { label: 'Stop (min)', key: 'autoStopInterval', min: 0, max: Infinity, placeholder: '15' },
    { label: 'Archive (min)', key: 'autoArchiveInterval', min: 0, max: Infinity, placeholder: '7' },
    { label: 'Delete (min)', key: 'autoDeleteInterval', min: -1, max: Infinity, placeholder: '' },
  ]

  // Change code to run based on selected sandbox language
  useEffect(() => {
    setSandboxParameterValue('codeRunParams', {
      languageCode: getLanguageCodeToRun(sandboxParametersState.language),
    })
  }, [sandboxParametersState.language, setSandboxParameterValue])

  const nonDefaultTemplateSelected = sandboxTemplateName && sandboxTemplateName !== SANDBOX_TEMPLATE_DEFAULT_VALUE

  return (
    <>
      <StackedInputFormControl formItem={languageFormData}>
        <FormSelectInput
          selectOptions={languageOptions}
          selectValue={sandboxLanguage}
          formItem={languageFormData}
          onChangeHandler={(value) => {
            setSandboxParameterValue(languageFormData.key as 'language', value as CodeLanguage)
          }}
        />
      </StackedInputFormControl>
      {/* <StackedInputFormControl formItem={sandboxTemplateFormData}>
        <FormSelectInput
          selectOptions={[
            { value: SANDBOX_TEMPLATE_DEFAULT_VALUE, label: 'Default' },
            ...templatesData.map((template) => ({
              value: template.name,
              label: template.name,
            })),
          ]}
          loading={templatesLoading}
          selectValue={sandboxTemplateName}
          formItem={sandboxTemplateFormData}
          onChangeHandler={(templateName) => {
            setSandboxParameterValue(sandboxTemplateFormData.key as 'templateName', templateName)
          }}
        />
      </StackedInputFormControl> */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="resources" className="text-sm text-muted-foreground">
            Resources
          </Label>
          {nonDefaultTemplateSelected && (
            <Tooltip
              content={
                <div className="text-balance text-center max-w-[300px]">
                  Resources cannot be modified when a non-default image is selected.
                </div>
              }
              label={
                <button className="rounded-full">
                  <HelpCircleIcon className="h-4 w-4 text-muted-foreground" />
                </button>
              }
            />
          )}
        </div>
        <div id="resources" className="space-y-2">
          {resourcesFormData.map((resourceParamFormItem) => (
            <InlineInputFormControl key={resourceParamFormItem.key} formItem={resourceParamFormItem}>
              <FormNumberInput
                disabled={Boolean(nonDefaultTemplateSelected)}
                numberValue={resources[resourceParamFormItem.key]}
                numberFormItem={resourceParamFormItem}
                onChangeHandler={(value) => {
                  setSandboxParameterValue('resources', { ...resources, [resourceParamFormItem.key]: value })
                }}
              />
            </InlineInputFormControl>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="lifecycle" className="text-sm text-muted-foreground">
          Lifecycle
        </Label>
        <div id="lifecycle" className="space-y-2">
          {lifecycleParamsFormData.map((lifecycleParamFormItem) => (
            <InlineInputFormControl key={lifecycleParamFormItem.key} formItem={lifecycleParamFormItem}>
              <FormNumberInput
                numberValue={sandboxFromImageParams[lifecycleParamFormItem.key]}
                numberFormItem={lifecycleParamFormItem}
                onChangeHandler={(value) => {
                  setSandboxParameterValue('createSandboxBaseParams', {
                    ...sandboxFromImageParams,
                    [lifecycleParamFormItem.key]: value,
                  })
                }}
              />
            </InlineInputFormControl>
          ))}
        </div>
      </div>
    </>
  )
}

export default SandboxManagementParameters
