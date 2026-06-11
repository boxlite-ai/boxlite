/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CodeLanguage } from '@/lib/cloudBox'
import { PythonSnippetGenerator } from './python'
import { CodeSnippetGenerator } from './types'

export const codeSnippetGenerators: Record<CodeLanguage.PYTHON, CodeSnippetGenerator> = {
  [CodeLanguage.PYTHON]: PythonSnippetGenerator,
}

export type { CodeSnippetActionFlags, CodeSnippetGenerator, CodeSnippetParams } from './types'
