#!/usr/bin/env node

import { runLocalDexEnvironment } from './local-dex-env.mjs'

runLocalDexEnvironment({ mode: 'dev' }).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
