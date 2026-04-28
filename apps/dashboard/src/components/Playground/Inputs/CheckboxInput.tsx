/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Checkbox } from '@/components/ui/checkbox'
import { ParameterFormItem } from '@/contexts/PlaygroundContext'

type FormCheckboxInputProps = {
  checkedValue: boolean | undefined
  formItem: ParameterFormItem
  onChangeHandler: (checked: boolean) => void
}

const FormCheckboxInput: React.FC<FormCheckboxInputProps> = ({ checkedValue, formItem, onChangeHandler }) => {
  return (
    <div className="flex-1">
      <Checkbox id={formItem.key} checked={checkedValue} onCheckedChange={(value) => onChangeHandler(!!value)} />
    </div>
  )
}

export default FormCheckboxInput
