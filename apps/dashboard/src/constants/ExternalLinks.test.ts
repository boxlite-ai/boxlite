/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'mocks' ? [] : sourceFiles(full)
    if (!/\.tsx?$/.test(name) || /\.(test|spec|stories)\.tsx?$/.test(name)) return []
    return [full]
  })
}

describe('docs links', () => {
  /**
   * Topic guides must be named in ExternalLinks.ts so they can be reviewed
   * against the live sitemap and page content. This catches scattered literals
   * as well as appended paths; it cannot establish whether a guide is accurate.
   */
  it('are declared centrally instead of using literals or appended paths', () => {
    // Where deep links are supposed to be declared, if there are any.
    const home = join(__dirname, 'ExternalLinks.ts')

    const offenders = sourceFiles(SRC)
      .filter((file) => file !== home)
      .flatMap((file) => {
        const inlinePaths =
          readFileSync(file, 'utf8').match(
            /https:\/\/docs\.boxlite\.ai[^\s'"<>`]*|BOXLITE_DOCS_URL\}\/[a-zA-Z0-9/_-]+/g,
          ) ?? []
        return inlinePaths.map((hit) => `${relative(SRC, file)}: ${hit}`)
      })

    expect(
      offenders,
      `Confirm each path resolves on docs.boxlite.ai, then declare it in constants/ExternalLinks.ts:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
