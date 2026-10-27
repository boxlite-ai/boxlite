#!/usr/bin/env node
import { drainRunners } from '../src/runner-drain.ts'

try {
  process.exitCode = await drainRunners({ argv: process.argv.slice(2) })
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exitCode = 1
}
