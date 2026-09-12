#!/usr/bin/env node
import { buildRunner } from '../src/runner-build.ts'

const main = async (): Promise<number> => {
  try {
    return await buildRunner({ argv: process.argv.slice(2) })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

process.exitCode = await main()
