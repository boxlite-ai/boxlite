#!/usr/bin/env node
import { migrateAws } from '../src/migrate-aws.ts'
try {
  process.exitCode = await migrateAws({ argv: process.argv.slice(2) })
} catch (error) {
  process.stderr.write((error as Error).message + '\n')
  process.exitCode = 1
}
