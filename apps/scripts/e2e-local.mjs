#!/usr/bin/env node

import { parseCommand, runLocalDexEnvironment } from './local-dex-env.mjs'

runLocalDexEnvironment({
  mode: 'e2e',
  command: parseCommand(process.argv.slice(2)),
}).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
