import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { getOnboardingCodeExamples } from '../onboarding-code-examples'

const mocks = `
curl() {
  case "$*" in
    *api.github.com/repos/boxlite-ai/boxlite/releases*) printf '%s' "$TEST_RELEASES" ;;
    *) printf 'DOWNLOAD %s\\n' "$*" ;;
  esac
}
tar() { :; }
mv() { :; }
rm() { :; }
`

function install(releases: unknown, platform: string) {
  return spawnSync('bash', ['-c', mocks + getOnboardingCodeExamples().c.install], {
    env: { ...process.env, TEST_RELEASES: JSON.stringify(releases), PLATFORM: platform },
    encoding: 'utf8',
    timeout: 5000,
  })
}

it.each(['darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu'])(
  'downloads the newest stable C release with an existing %s archive', (platform) => {
    const release = (tag: string, assetPlatform: string, prerelease = false, draft = false, state = 'uploaded') => ({
      tag_name: tag,
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
      release('v9.9.6', platform),
      release('v9.9.5', platform),
    ], platform)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`DOWNLOAD -fsSL https://github.com/boxlite-ai/boxlite/releases/download/v9.9.6/boxlite-c-v9.9.6-${platform}.tar.gz`)
    expect(result.stdout).not.toContain('releases/download/v9.9.9/')
  },
)

it('stops before downloading when no stable C archive is available', () => {
  const result = install([], 'darwin-arm64')
  expect(result.status).not.toBe(0)
  expect(result.stdout).not.toContain('DOWNLOAD')
})
