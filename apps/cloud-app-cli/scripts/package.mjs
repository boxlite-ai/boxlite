import { mkdirSync, writeFileSync, copyFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '../dist/apps/cloud-app-artifacts')
const staging = mkdtempSync(join(tmpdir(), 'boxlite-app-package-'))
try {
  mkdirSync(join(staging, 'package/dist'), { recursive: true })
  mkdirSync(output, { recursive: true })
  copyFileSync(join(root, 'dist/boxlite-app.cjs'), join(staging, 'package/dist/boxlite-app.cjs'))
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(
    join(staging, 'package/package.json'),
    JSON.stringify({
      name: 'boxlite-app',
      version,
      bin: { 'boxlite-app': './dist/boxlite-app.cjs' },
      engines: { node: '>=20' },
    }) + '\n',
  )
  await create({ gzip: true, portable: true, cwd: staging, file: join(output, 'boxlite-app.tgz') }, ['package'])
  copyFileSync(join(root, 'agent/SKILL.md'), join(output, 'agent.md'))
  copyFileSync(join(root, 'agent/prompt-template.md'), join(output, 'prompt-template.md'))
} finally {
  rmSync(staging, { recursive: true, force: true })
}
