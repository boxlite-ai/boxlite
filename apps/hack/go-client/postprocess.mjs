#!/usr/bin/env node
// Adds a go:embed-backed version and a custom UserAgent to generated Go API clients.
// Usage: postprocess.mjs <project-root> <package-name> <client-name>
//
// Node rather than sed: GNU `sed -i` and BSD `sed -i` disagree on whether the
// suffix argument is optional, so a sed implementation silently works on CI and
// fails on macOS.

import { readFileSync, writeFileSync } from 'node:fs'

const [projectRoot, packageName, clientName] = process.argv.slice(2)

if (!projectRoot || !packageName || !clientName) {
  console.error('Usage: postprocess.mjs <project-root> <package-name> <client-name>')
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
console.log(`Postprocessed Go client at ${projectRoot}`)
