#!/usr/bin/env node
// Adds client version metadata and preserves the product client's public model names.
// Usage: postprocess.mjs <project-root> <package-name> <client-name>
//
// Node rather than sed: GNU `sed -i` and BSD `sed -i` disagree on whether the
// suffix argument is optional, so a sed implementation silently works on CI and
// fails on macOS.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

const [projectRoot, packageName, clientName] = process.argv.slice(2)

if (!projectRoot || !packageName || !clientName) {
  console.error('Usage: postprocess.mjs <project-root> <package-name> <client-name>')
  process.exit(1)
}

// HTTP list and detail schemas differ, but Go callers share the creator type.
// Use the generated optional-field implementation without changing their signatures.
const overviewPath = `${projectRoot}/model_admin_organization_overview.go`
if (clientName === 'api-client-go' && existsSync(overviewPath)) {
  const creatorPath = `${projectRoot}/model_admin_organization_creator.go`
  const verifiedFile = 'model_admin_organization_verified_creator.go'
  const verifiedPath = `${projectRoot}/${verifiedFile}`
  const indexPath = `${projectRoot}/.openapi-generator/FILES`
  const creator = readFileSync(creatorPath, 'utf8')
  const verified = readFileSync(verifiedPath, 'utf8')
  const overview = readFileSync(overviewPath, 'utf8')
  const index = readFileSync(indexPath, 'utf8').split('\n')
  if (
    !creator.includes('type AdminOrganizationCreator struct {') ||
    !verified.includes('type AdminOrganizationVerifiedCreator struct {') ||
    !verified.includes('EmailVerified *bool `json:"emailVerified,omitempty"`') ||
    !overview.includes('Creator NullableAdminOrganizationVerifiedCreator `json:"creator"`') ||
    !index.includes(verifiedFile)
  ) {
    throw new Error('Unexpected generated organization creator models; cannot preserve Go caller compatibility')
  }
  writeFileSync(creatorPath, verified.replaceAll('AdminOrganizationVerifiedCreator', 'AdminOrganizationCreator'))
  writeFileSync(overviewPath, overview.replaceAll('AdminOrganizationVerifiedCreator', 'AdminOrganizationCreator'))
  unlinkSync(verifiedPath)
  writeFileSync(indexPath, index.filter((file) => file !== verifiedFile).join('\n'))
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
