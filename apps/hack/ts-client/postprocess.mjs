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
  return specifier
    .replace(/^type\s+/, '')
    .split(/\s+as\s+/)
    .at(-1)
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

  return source.replace(
    match[0],
    usedSpecifiers.length ? `import { ${usedSpecifiers.join(', ')} } from '${modulePath}';` : '',
  )
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

          return validMembers.length === memberList.length ? arrayType : `**Array<${validMembers.join(' &#124; ')}>**`
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

// Generator 7.23 flattens this overlapping anyOf into the registration model,
// erasing the full response's statistics. Keep the two actual response types.
const organizationResponsePath = `${srcDir}/models/admin-list-organizations-overview200-response.ts`
if (existsSync(organizationResponsePath)) {
  const source = readFileSync(organizationResponsePath, 'utf8')
  const headerEnd = source.indexOf(' */') + 3
  if (
    headerEnd < 3 ||
    !source.includes('export interface AdminListOrganizationsOverview200Response') ||
    !source.includes("from './admin-organization-overview-page'") ||
    !source.includes("from './admin-organization-registration-page'")
  )
    throw new Error('Admin organization response generation changed; review the anyOf adapter')
  writeFileSync(
    organizationResponsePath,
    `${source.slice(0, headerEnd)}\n\nimport type { AdminOrganizationOverviewPage } from './admin-organization-overview-page';\nimport type { AdminOrganizationRegistrationPage } from './admin-organization-registration-page';\n\nexport type AdminListOrganizationsOverview200Response = AdminOrganizationOverviewPage | AdminOrganizationRegistrationPage;\n`,
  )
  writeFileSync(
    `${srcDir}/docs/AdminListOrganizationsOverview200Response.md`,
    '# AdminListOrganizationsOverview200Response\n\nA union of [AdminOrganizationOverviewPage](AdminOrganizationOverviewPage.md) and [AdminOrganizationRegistrationPage](AdminOrganizationRegistrationPage.md).\n\nOmitting `projection` returns the full overview; `projection=registration` returns metadata without statistics.\n',
  )
}

// Preserve sixth- and eighth-argument Axios options when adding opt-in org filters.
// Normalize only at the request creator; factory, functional and class clients forward it there.
const adminPath = `${srcDir}/api/admin-api.ts`
if (existsSync(adminPath)) {
  let admin = readFileSync(adminPath, 'utf8')
  if (admin.includes('boxCountScope?: AdminListOrganizationsOverviewBoxCountScopeEnum')) {
    const signature = 'boxCountScope?: AdminListOrganizationsOverviewBoxCountScopeEnum'
    if (admin.split(signature).length - 1 !== 4)
      throw new Error('Admin organization signature changed; review the compatibility adapter')
    admin = admin.replaceAll(signature, `${signature} | RawAxiosRequestConfig`)
    const projectionSignature = 'projection?: AdminListOrganizationsOverviewProjectionEnum'
    if (admin.split(projectionSignature).length - 1 !== 4)
      throw new Error('Admin organization projection signature changed; review the compatibility adapter')
    admin = admin.replaceAll(projectionSignature, `${projectionSignature} | RawAxiosRequestConfig`)
    const marker = 'const localVarPath = `/admin/organizations`;'
    if (admin.split(marker).length - 1 !== 1) throw new Error('Admin organization request creator changed')
    admin = admin.replace(
      marker,
      `if (typeof projection === 'object') { options = projection; projection = undefined; }\n            if (typeof boxCountScope === 'object') { options = boxCountScope; boxCountScope = undefined; }\n            ${marker}`,
    )
    admin = admin.replace(/\/\*\*[\s\S]*?\*\//g, (block) =>
      block.includes('boxCountScope') ? block.replace(/[ \t]+$/gm, '') : block,
    )
    writeFileSync(adminPath, admin)
  }
}

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

// Axios exposes ISO date-time strings. Keep this mapping local to the new
// onboarding contracts; other generated model timestamp contracts stay intact.
for (const [model, fields] of Object.entries({
  'onboarding-dto': ['submittedAt'],
  'prompt-draft-dto': ['updatedAt'],
  'prompt-handoff-dto': ['createdAt', 'copiedAt'],
})) {
  const modelPath = `${srcDir}/models/${model}.ts`
  if (!existsSync(modelPath)) continue
  let source = readFileSync(modelPath, 'utf8')
  for (const field of fields) {
    source = source.replace(new RegExp(`('${field}'\\??: )Date`, 'g'), '$1string')
  }
  writeFileSync(modelPath, source)
}

console.log(`Postprocessed TypeScript client at ${srcDir}`)
