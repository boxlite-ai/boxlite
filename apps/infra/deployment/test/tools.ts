// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { accessSync, constants, mkdtempSync, statSync, symlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

const hostPath = process.env.PATH ?? ''

/** Resolve before restricting child PATH, including on non-FHS hosts. */
export function hostExecutable(name: string): string {
  for (const directory of hostPath.split(delimiter)) {
    const executable = resolve(directory, name)
    try {
      if (!statSync(executable).isFile()) continue
      accessSync(executable, constants.X_OK)
      return executable
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new Error(`Required test executable is missing from host PATH: ${name}`)
}

/** Allow only named utilities; installed build/cloud tools must stay invisible. */
export function toolPath(directory: string, names: string[]): string {
  const bin = mkdtempSync(join(directory, 'tools-'))
  for (const name of names) symlinkSync(hostExecutable(name), join(bin, name))
  return bin
}
