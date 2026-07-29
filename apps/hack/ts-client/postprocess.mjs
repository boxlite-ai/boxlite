#!/usr/bin/env node
// Adds a custom User-Agent to generated TypeScript API clients, sourced from
// the client package.json version.
// Usage: postprocess.mjs <src-dir> <client-name>
//
// Node rather than sed: the generator's output is edited with three separate
// substitutions, one of which inserts a line. GNU and BSD sed disagree on both
// in-place editing (`-i` takes a mandatory suffix on BSD) and on `a\` line
// insertion, so a sed implementation silently works on CI and fails on macOS.

import { readFileSync, writeFileSync } from 'node:fs'

const [srcDir, clientName] = process.argv.slice(2)

if (!srcDir || !clientName) {
  console.error('Usage: postprocess.mjs <src-dir> <client-name>')
  process.exit(1)
}

const configPath = `${srcDir}/configuration.ts`
let config = readFileSync(configPath, 'utf8')

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
console.log(`Postprocessed TypeScript client at ${srcDir}`)
