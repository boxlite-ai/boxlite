/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Tooltip } from '@/components/Tooltip'
import { Label } from '@/components/ui/label'
import { BOX_TEMPLATE_DEFAULT_VALUE } from '@/constants/Playground'
import { NumberParameterFormItem, ParameterFormItem } from '@/contexts/PlaygroundContext'
import { usePlayground } from '@/hooks/usePlayground'
import { getLanguageCodeToRun } from '@/lib/playground'
import { CodeLanguage, Resources } from '@boxlite-ai/sdk'
import { HelpCircleIcon } from 'lucide-react'
import InlineInputFormControl from '../../Inputs/InlineInputFormControl'
import FormNumberInput from '../../Inputs/NumberInput'
import FormSelectInput from '../../Inputs/SelectInput'
import StackedInputFormControl from '../../Inputs/StackedInputFormControl'
import { useEffect } from 'react'

// TODO(image-rewrite): template selection UI was removed with the image/template subsystem.
// Props are kept (hardcoded to an empty list) so the playground compiles; rebuild template
// selection here once the new image/template model lands.
type BoxManagementParametersProps = {
  templatesData: Array<{ name: string }>
  templatesLoading: boolean
}

const BoxManagementParameters: React.FC<BoxManagementParametersProps> = ({ templatesData, templatesLoading }) => {
  const { boxParametersState, setBoxParameterValue } = usePlayground()
  const boxLanguage = boxParametersState['language']
  const boxTemplateName = boxParametersState['templateName']
  const resources = boxParametersState['resources']
  const boxFromImageParams = boxParametersState['createBoxBaseParams']

  const languageFormData: ParameterFormItem = {
    label: 'Language',
    key: 'language',
    placeholder: 'Select box language',
  }

  // const boxTemplateFormData: ParameterFormItem = {
  //   label: 'Image',
  //   key: 'templateName',
  //   placeholder: 'Select box image',
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
    key: 'autoStopInterval' | 'autoDeleteInterval'
  })[] = [
    { label: 'Stop (min)', key: 'autoStopInterval', min: 0, max: Infinity, placeholder: '15' },
    { label: 'Delete (min)', key: 'autoDeleteInterval', min: -1, max: Infinity, placeholder: '' },
  ]

  // Change code to run based on selected box language
  useEffect(() => {
    setBoxParameterValue('codeRunParams', {
      languageCode: getLanguageCodeToRun(boxParametersState.language),
    })
  }, [boxParametersState.language, setBoxParameterValue])

  const nonDefaultTemplateSelected = boxTemplateName && boxTemplateName !== BOX_TEMPLATE_DEFAULT_VALUE

  return (
    <>
      <StackedInputFormControl formItem={languageFormData}>
        <FormSelectInput
          selectOptions={languageOptions}
          selectValue={boxLanguage}
          formItem={languageFormData}
          onChangeHandler={(value) => {
            setBoxParameterValue(languageFormData.key as 'language', value as CodeLanguage)
          }}
        />
      </StackedInputFormControl>
      {/* <StackedInputFormControl formItem={boxTemplateFormData}>
        <FormSelectInput
          selectOptions={[
            { value: BOX_TEMPLATE_DEFAULT_VALUE, label: 'Default' },
            ...templatesData.map((template) => ({
              value: template.name,
              label: template.name,
            })),
          ]}
          loading={templatesLoading}
          selectValue={boxTemplateName}
          formItem={boxTemplateFormData}
          onChangeHandler={(templateName) => {
            setBoxParameterValue(boxTemplateFormData.key as 'templateName', templateName)
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
                  setBoxParameterValue('resources', { ...resources, [resourceParamFormItem.key]: value })
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
                numberValue={boxFromImageParams[lifecycleParamFormItem.key]}
                numberFormItem={lifecycleParamFormItem}
                onChangeHandler={(value) => {
                  setBoxParameterValue('createBoxBaseParams', {
                    ...boxFromImageParams,
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

export default BoxManagementParameters
