#!/usr/bin/env node
// Normalizes generated TypeScript API clients: adds the package-version
// User-Agent, prunes unused template imports, and repairs parameter docs the
// upstream generator renders ambiguously.
// Usage: postprocess.mjs <src-dir> <client-name>
//
// Node rather than sed: the generator's output needs structured edits across
// configuration, API, and documentation files. GNU and BSD sed disagree on
// in-place editing (`-i` takes a mandatory suffix on BSD) and on `a\` line
// insertion, so a sed implementation silently works on CI and fails on macOS.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

const [srcDir, clientName] = process.argv.slice(2)

if (!srcDir || !clientName) {
  console.error('Usage: postprocess.mjs <src-dir> <client-name>')
  process.exit(1)
}

const configPath = `${srcDir}/configuration.ts`
let config = readFileSync(configPath, 'utf8')

function importedIdentifier(specifier) {
  return specifier.replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)
}

function pruneUnusedImports(source, modulePath) {
  const escapedModulePath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const importPattern = new RegExp(`^import \\{ ([^\\n]+) \\} from '${escapedModulePath}';$`, 'm')
  const match = source.match(importPattern)

  if (!match) return source

  const sourceWithoutImport = source
    .replace(match[0], '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  const usedSpecifiers = match[1]
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => {
      const identifier = importedIdentifier(specifier)
      return identifier && new RegExp(`\\b${identifier}\\b`).test(sourceWithoutImport)
    })

  return source.replace(match[0], usedSpecifiers.length ? `import { ${usedSpecifiers.join(', ')} } from '${modulePath}';` : '')
}

function fixParameterDocumentation(source) {
  return source
    .split('\n')
    .map((line) => {
      if (line.startsWith('let ') && !line.includes('(optional)')) {
        line = line.replace(' (default to undefined)', '')
      }

      if (line.startsWith('| **')) {
        line = line.replace(/\[\*\*(.+?)\*\*\]\*\*Array<[^>\n]+>\*\*/g, (_match, scalarType) => {
          return `[**${scalarType.replaceAll(' | ', ' &#124; ')}**]`
        })
        line = line.replace(/\*\*Array<([^>\n]+)>\*\*/g, (arrayType, members) => {
          const fallbackMember = '&#39;11184809&#39;'
          const memberList = members.split(' &#124; ')
          const validMembers = memberList.filter((member) => member !== fallbackMember)

          return validMembers.length === memberList.length
            ? arrayType
            : `**Array<${validMembers.join(' &#124; ')}>**`
        })

        if (!line.includes('(optional)')) {
          line = line.replace('| defaults to undefined|', '| |')
        }
      }

      return line
    })
    .join('\n')
}

// The generated User-Agent value is a TS template literal, so the
// `${packageJson.version}` below must reach the file verbatim.
const userAgent = '`' + clientName + '/${packageJson.version}`'

// 1. Import the version right after the generator's "do not edit" header.
const header = /(Do not edit the class manually\.\n \*\/\n)/
if (!header.test(config)) {
  console.error(`ERROR: generator header not found in ${configPath}`)
  process.exit(1)
}
config = config.replace(header, `$1\nimport * as packageJson from '../package.json';\n`)

// 2. Set the User-Agent — replacing the generator's own header if it emitted
//    one, otherwise inserting ours ahead of the caller-supplied spread.
const existing = /'User-Agent': `[^`]*`/
const spread = '...param.baseOptions?.headers,'

if (existing.test(config)) {
  config = config.replace(existing, `'User-Agent': ${userAgent}`)
} else if (config.includes(spread)) {
  config = config.replace(spread, `'User-Agent': ${userAgent},\n                ${spread}`)
} else {
  console.error(`ERROR: no User-Agent header and no baseOptions spread in ${configPath}`)
  process.exit(1)
}

writeFileSync(configPath, config)

const apiDir = `${srcDir}/api`
if (existsSync(apiDir)) {
  for (const fileName of readdirSync(apiDir).filter((fileName) => fileName.endsWith('.ts'))) {
    const apiPath = `${apiDir}/${fileName}`
    const generatedApi = readFileSync(apiPath, 'utf8')
    const prunedApi = pruneUnusedImports(pruneUnusedImports(generatedApi, '../common'), '../base')

    if (prunedApi !== generatedApi) writeFileSync(apiPath, prunedApi)
  }
}

const docsDir = `${srcDir}/docs`
if (existsSync(docsDir)) {
  for (const fileName of readdirSync(docsDir).filter((fileName) => fileName.endsWith('.md'))) {
    const docsPath = `${docsDir}/${fileName}`
    const generatedDocs = readFileSync(docsPath, 'utf8')
    const fixedDocs = fixParameterDocumentation(generatedDocs)

    if (fixedDocs !== generatedDocs) writeFileSync(docsPath, fixedDocs)
  }
}

console.log(`Postprocessed TypeScript client at ${srcDir}`)
