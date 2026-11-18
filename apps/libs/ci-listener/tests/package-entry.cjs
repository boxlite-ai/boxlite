/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
const { accessSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const directory = resolve(process.argv[2])
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
accessSync(resolve(directory, manifest.types))
const library = require(directory)
for (const name of [
  'ListenerState',
  'createGitHubAppJwt',
  'githubRequest',
  'Listener',
  'InstallationCatalog',
  'GitHubExecutionBackend',
]) {
  if (typeof library[name] !== 'function') throw new Error(`Missing CI package export: ${name}`)
}
