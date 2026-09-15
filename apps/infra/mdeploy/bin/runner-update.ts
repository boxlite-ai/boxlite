#!/usr/bin/env node
import { updateRunners } from '../src/runner-update.ts'

const main = async (): Promise<number> => {
  try {
    return await updateRunners({ argv: process.argv.slice(2) })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

process.exitCode = await main()
