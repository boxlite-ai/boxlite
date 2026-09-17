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
    if (!/\.tsx?$/.test(name) || /\.(test|stories)\.tsx?$/.test(name)) return []
    return [full]
  })
}

describe('docs links', () => {
  /**
   * The console links to the docs root only. Five call sites once built deep
   * links inline as `${BOXLITE_DOCS_URL}/en/…`, a path scheme docs.boxlite.ai
   * has never served — all of them 404'd, across three box tabs, and nothing
   * here could notice. A deep link is fine to add back, but it has to be
   * named in ExternalLinks.ts, where one short list can be checked against
   * the sitemap when the docs move.
   */
  it('are never built inline from BOXLITE_DOCS_URL', () => {
    // Where deep links are supposed to be declared, if there are any.
    const home = join(__dirname, 'ExternalLinks.ts')

    const offenders = sourceFiles(SRC)
      .filter((file) => file !== home)
      .flatMap((file) => {
        const inlinePaths = readFileSync(file, 'utf8').match(/BOXLITE_DOCS_URL\}\/[a-zA-Z0-9/_-]+/g) ?? []
        return inlinePaths.map((hit) => `${relative(SRC, file)}: ${hit}`)
      })

    expect(
      offenders,
      `Confirm each path resolves on docs.boxlite.ai, then declare it in constants/ExternalLinks.ts:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
