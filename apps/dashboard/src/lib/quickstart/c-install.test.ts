import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getOnboardingCodeExamples } from '../onboarding-code-examples'

const mocks = `
curl() {
  case "$*" in
    *api.github.com/repos/boxlite-ai/boxlite/releases*) printf '%s' "$TEST_RELEASES" ;;
    *) printf 'DOWNLOAD %s\\n' "$*"
       if [ -n "$TEST_ARCHIVE" ]; then command cp "$TEST_ARCHIVE" "\${!#}"; fi ;;
  esac
}
tar() {
  command tar "$@" || return
  if [ "$TEST_TAR_FAIL" = true ]; then return 1; fi
}
mv() {
  case "$1" in
    */new) if [ "$TEST_MOVE_FAIL" = true ]; then return 1; fi ;;
  esac
  command mv "$@"
}
`

function install(releases: unknown, platform: string, cwd?: string, archive = '', failure = 'none'): SpawnSyncReturns<string> & { installedHeader?: string } {
  if (!cwd) {
    const temp = mkdtempSync(join(tmpdir(), 'quickstart-c-install-'))
    try {
      const root = `boxlite-c-v9.9.6-${platform}`
      mkdirSync(join(temp, root, 'include'), { recursive: true })
      writeFileSync(join(temp, root, 'include', 'boxlite.h'), 'new SDK')
      const fixture = join(temp, 'fixture.tar.gz')
      const packed = spawnSync('tar', ['czf', fixture, '-C', temp, root], { encoding: 'utf8' })
      expect(packed.status, packed.stderr).toBe(0)
      const result = install(releases, platform, temp, fixture)
      const header = join(temp, 'boxlite-c-sdk', 'include', 'boxlite.h')
      return { ...result, installedHeader: existsSync(header) ? readFileSync(header, 'utf8') : undefined }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  return spawnSync('bash', ['-c', mocks + getOnboardingCodeExamples().c.install], {
    cwd,
    env: { ...process.env, TEST_RELEASES: JSON.stringify(releases), PLATFORM: platform, TEST_ARCHIVE: archive, TEST_TAR_FAIL: String(failure === 'tar'), TEST_MOVE_FAIL: String(failure === 'replace') },
    encoding: 'utf8',
    timeout: 5000,
  })
}

it.each(['darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu'])(
  'downloads the newest stable C release with an existing %s archive', (platform) => {
    const release = (tag: string, assetPlatform: string, prerelease = false, draft = false, state = 'uploaded') => ({
      tag_name: tag,
      published_at: `2026-11-0${tag.split('.')[2].split('-')[0]}T00:00:00Z`,
      prerelease,
      draft,
      assets: [{
        state,
        name: `boxlite-c-${tag}-${assetPlatform}.tar.gz`,
        browser_download_url: `https://github.com/boxlite-ai/boxlite/releases/download/${tag}/boxlite-c-${tag}-${assetPlatform}.tar.gz`,
      }],
    })
    const result = install([
      release('v9.9.9', 'unavailable-platform'),
      release('v9.9.9-uploading', platform, false, false, 'new'),
      release('v9.9.8', platform, true),
      release('v9.9.7', platform, false, true),
      release('v9.9.5', platform),
      release('v9.9.6', platform),
    ], platform)
    expect(result.stdout).toContain(`DOWNLOAD -fsSL https://github.com/boxlite-ai/boxlite/releases/download/v9.9.6/boxlite-c-v9.9.6-${platform}.tar.gz`)
    expect(result.status, result.stderr).toBe(0)
    expect(result.installedHeader).toBe('new SDK')
    expect(result.stdout).not.toContain('releases/download/v9.9.9/')
  },
)

it('stops before downloading when no stable C archive is available', () => {
  const result = install([], 'darwin-arm64')
  expect(result.status).not.toBe(0)
  expect(result.stdout).not.toContain('DOWNLOAD')
})

it.each(['none', 'tar', 'replace'])('replaces an existing C SDK header only after successful extraction (failure=%s)', (failure) => {
  const cwd = mkdtempSync(join(tmpdir(), 'quickstart-c-install-'))
  const root = 'boxlite-c-v9.9.6-darwin-arm64'
  try {
    mkdirSync(join(cwd, root, 'include'), { recursive: true })
    writeFileSync(join(cwd, root, 'include', 'boxlite.h'), 'new SDK')
    const archive = join(cwd, 'fixture.tar.gz')
    const packed = spawnSync('tar', ['czf', archive, '-C', cwd, root], { encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    mkdirSync(join(cwd, 'boxlite-c-sdk', 'include'), { recursive: true })
    writeFileSync(join(cwd, 'boxlite-c-sdk', 'include', 'boxlite.h'), 'old SDK')
    const result = install([{
      tag_name: 'v9.9.6', draft: false, prerelease: false,
      assets: [{ state: 'uploaded', name: `${root}.tar.gz`, browser_download_url: `https://github.com/boxlite-ai/boxlite/releases/download/v9.9.6/${root}.tar.gz` }],
    }], 'darwin-arm64', cwd, archive, failure)
    expect(result.status, result.stderr).toBe(failure === 'none' ? 0 : 1)
    expect(readFileSync(join(cwd, 'boxlite-c-sdk', 'include', 'boxlite.h'), 'utf8')).toBe(failure === 'none' ? 'new SDK' : 'old SDK')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
