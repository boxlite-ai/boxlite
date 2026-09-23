#!/usr/bin/env node
// Adds a go:embed-backed version and a custom UserAgent to generated Go API clients,
// and optionally renames the spec copy the generator drops at api/openapi.yaml.
// Usage: postprocess.mjs <project-root> <package-name> <client-name> [spec-name]
//
// Node rather than sed: GNU `sed -i` and BSD `sed -i` disagree on whether the
// suffix argument is optional, so a sed implementation silently works on CI and
// fails on macOS.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const [projectRoot, packageName, clientName, specName] = process.argv.slice(2)

if (!projectRoot || !packageName || !clientName) {
  console.error('Usage: postprocess.mjs <project-root> <package-name> <client-name> [spec-name]')
  process.exit(1)
}

writeFileSync(
  `${projectRoot}/version.go`,
  `package ${packageName}

import (
\t_ "embed"
\t"strings"
)

//go:embed VERSION
var _clientVersion string

var ClientVersion = strings.TrimSpace(_clientVersion)
`,
)

const configPath = `${projectRoot}/configuration.go`
const config = readFileSync(configPath, 'utf8')
const userAgent = /UserAgent: *"[^"]*"/

if (!userAgent.test(config)) {
  console.error(`ERROR: UserAgent string not found in ${configPath}`)
  process.exit(1)
}

writeFileSync(configPath, config.replace(userAgent, `UserAgent:        "${clientName}/" + ClientVersion`))

// The generator always writes its spec copy to api/openapi.yaml. A client whose
// spec describes one named API renames it, so the file says which API it is; the
// manifest is rewritten in the same step, or the next run's drift check sees a
// name the tree no longer has.
if (specName) {
  const specPath = `${projectRoot}/api/openapi.yaml`
  const manifestPath = `${projectRoot}/.openapi-generator/FILES`

  // Both checks run before either write: a half-renamed tree fails the drift
  // check with no hint of which half moved.
  if (!existsSync(specPath)) {
    console.error(`ERROR: ${specPath} not found; run the generator before postprocessing`)
    process.exit(1)
  }

  const manifest = readFileSync(manifestPath, 'utf8')

  if (!manifest.includes('api/openapi.yaml')) {
    console.error(`ERROR: api/openapi.yaml not listed in ${manifestPath}`)
    process.exit(1)
  }

  renameSync(specPath, `${projectRoot}/api/${specName}`)
  writeFileSync(manifestPath, manifest.replace('api/openapi.yaml', `api/${specName}`))
}

console.log(`Postprocessed Go client at ${projectRoot}`)
