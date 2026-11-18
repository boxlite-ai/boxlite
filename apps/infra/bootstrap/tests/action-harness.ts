// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

/** Run the deployed Action in isolation, mapping coverage through hydrated constants to its template. */
export function runAction(source: string, template: URL, context: Record<string, unknown>): void {
  if (!process.env.NODE_V8_COVERAGE) {
    runInNewContext(source, context)
    return
  }
  const directory = new URL('../../../../target/coverage/infra/actions/', import.meta.url)
  mkdirSync(directory, { recursive: true })
  // Each hydration has different offsets; merging their V8 ranges before remapping would misattribute coverage.
  const generated = new URL(`${createHash('sha256').update(source).digest('hex')}.js`, directory)
  const compiled = ts.transpileModule(source, {
    fileName: fileURLToPath(template),
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, sourceMap: true, inlineSources: true },
  })
  const map = JSON.parse(compiled.sourceMapText!)
  map.sources = [template.href]
  const code = compiled.outputText.replace(/\/\/# sourceMappingURL=.*$/, '') +
    `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
  // c8 reads the generated source after the test process exits, so keep it with the coverage artifacts.
  writeFileSync(generated, code)
  runInNewContext(code, context, { filename: fileURLToPath(generated) })
}
