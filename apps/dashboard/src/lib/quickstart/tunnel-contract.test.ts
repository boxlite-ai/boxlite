/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderOnboardingCodeExample } from '../onboarding-code-examples'

const root = fileURLToPath(new URL('../../../../..', import.meta.url))

describe('Quickstart tunnel contracts', () => {
  it('typechecks the rendered Node tunnel call against the SDK interface', () => {
    const code = renderOnboardingCodeExample('typescript', { restApiUrl: 'https://api.test' })
    const call = code.split('\n').find((line) => line.includes('await box.network.tunnel('))
    expect(call).toBeDefined()
    const imports = code.split('\n').filter((line) => line.startsWith('import ') && line.includes('node:'))
    const directory = mkdtempSync(join(root, 'apps/dashboard/.quickstart-contract-'))
    try {
      const path = join(directory, 'check.ts')
      writeFileSync(
        path,
        `${imports.join('\n')}\nimport type { JsNetworkHandle } from '../../../sdks/node/lib/native-contracts';\ndeclare const box: { network: JsNetworkHandle };\nasync function preview() { ${call} }\n`,
      )
      const program = ts.createProgram([path], {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: ['node'],
        typeRoots: [resolve(root, 'apps/node_modules/@types')],
      })
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      expect(errors).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('compiles the rendered C example against the SDK header', () => {
    const code = renderOnboardingCodeExample('c', { restApiUrl: 'https://api.test' })
    const result = spawnSync(
      process.env.CC || 'cc',
      ['-std=c11', '-fsyntax-only', '-Werror', '-x', 'c', '-I', join(root, 'sdks/c/include'), '-'],
      {
        input: code,
        encoding: 'utf8',
        timeout: 15_000,
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
})
