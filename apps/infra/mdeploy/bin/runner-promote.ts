#!/usr/bin/env node
import { promoteRunner } from '../src/runner-promote.ts'

const main = async (): Promise<number> => {
  try {
    return await promoteRunner({ argv: process.argv.slice(2) })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

process.exitCode = await main()
