// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

const { execFileSync } = require('node:child_process')

const [commit, ...rest] = process.argv.slice(2)
if (!/^[0-9a-f]{40}$/.test(commit ?? '') || rest.length) {
  throw new Error('Provide the full reviewed migration commit SHA')
}

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  })
if (git('cat-file', '-t', commit).trim() !== 'commit') throw new Error('Expected a migration commit')

const root = 'apps/api/src/migrations/'
const phases = { baseline: [], 'pre-deploy': [], 'post-deploy': [] }
const seen = new Set()
for (const file of git('ls-tree', '--full-tree', '-rz', '--name-only', commit, '--', root).split('\0')) {
  const filename = file.split('/').at(-1)
  if (filename.endsWith('.spec.ts') || !/^(?:\d.*|.*-migration)\.(?:ts|js)$/.test(filename)) continue
  const path = /^(?:(pre-deploy|post-deploy)\/)?(\d{13})(?:-[a-zA-Z0-9-]+)?-migration\.(?:ts|js)$/.exec(
    file.slice(root.length),
  )
  if (!path) throw new Error(`Invalid migration path ${JSON.stringify(file)}`)

  const classes = [...git('show', `${commit}:${file}`).matchAll(/^export class (\w+\d{13})\b/gm)]
  const name = classes[0]?.[1]
  if (classes.length !== 1 || !name.endsWith(path[2]) || seen.has(name)) {
    throw new Error(`Invalid or duplicate migration identity in ${file}`)
  }
  seen.add(name)
  phases[path[1] ?? 'baseline'].push(name)
}

if (seen.size === 0) throw new Error('Reviewed commit has no migrations')
for (const names of Object.values(phases)) names.sort()
process.stdout.write(JSON.stringify(phases) + '\n')
