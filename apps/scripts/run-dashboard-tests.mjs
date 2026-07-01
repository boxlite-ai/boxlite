#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const vitestBin = resolve(scriptDir, '../node_modules/vitest/vitest.mjs')
const vitestArgs = [vitestBin, 'run', '--config', 'vite.config.mts', '--passWithNoTests']
const childEnv = { ...process.env }

if (!childEnv.SHELL && process.platform !== 'win32') {
  childEnv.SHELL = '/bin/sh'
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--testNamePattern') {
    const pattern = args[index + 1]
    if (pattern) {
      vitestArgs.push('-t', pattern)
      index += 1
    }
  } else if (arg.startsWith('--testNamePattern=')) {
    vitestArgs.push('-t', arg.slice('--testNamePattern='.length))
  } else {
    vitestArgs.push(arg)
  }
}

const result = spawnSync(process.execPath, vitestArgs, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Failed to launch vitest at ${vitestBin}:`, result.error)
}

process.exit(result.status ?? 1)
