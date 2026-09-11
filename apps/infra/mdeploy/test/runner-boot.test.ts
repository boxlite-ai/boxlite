/*
 * The boot script, which is the one piece of BoxLite that has to be right on a
 * machine nobody will log into.
 *
 * A runner is created once and its script is then ignored for the life of the
 * host, so a mistake here is not repaired by the next deploy. What is checked
 * is the shape a person cannot see by reading the string: that the checksum
 * gate is fatal, that the KVM check runs before anything installs, that the
 * unit's settings land somewhere systemd will read them, and that no secret is
 * written into a value the instance metadata exposes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { renderRunnerBoot, type BootPlatform } from '../stack/runner-boot.ts'

const platform = (overrides: Partial<BootPlatform> = {}): BootPlatform => ({
  hostAddress: 'HOST_IP=$(curl -s http://metadata/ip)',
  installVolumeMount: 'apt-get install -y some-volume-mount',
  prepareKvm: '',
  startWrapper: null,
  unitEnvironment: {},
  ...overrides,
})

const render = (overrides: Partial<Parameters<typeof renderRunnerBoot>[0]> = {}): string =>
  Buffer.from(
    renderRunnerBoot({
      apiUrl: 'https://api.dev.boxlite.ai/',
      otlpUrl: 'http://collector:4318',
      binary: {
        tarballUrl: 'https://example.invalid/runner-v0.10.0.tar.gz',
        checksumUrl: 'https://example.invalid/runner-v0.10.0.tar.gz.sha256',
        tarballName: 'runner-v0.10.0.tar.gz',
        transport: 'https',
      },
      port: 3003,
      environment: { BOXLITE_RUNNER_NAME: 'default' },
      platform: platform(),
      ...overrides,
    }),
    'base64',
  ).toString('utf8')

test('the script fails fast, and logs where a person can find it', () => {
  const script = render()
  assert.match(script, /^#!\/bin\/bash/)
  assert.match(script, /exec > \/var\/log\/runner-setup\.log 2>&1/)
  assert.match(script, /set -euo pipefail/)
  const fails = script.indexOf('set -euo pipefail')
  const installs = script.indexOf('apt-get update')
  assert.ok(fails < installs, 'a half-finished bootstrap must not survive its first failure')
})

test('a checksum mismatch is fatal, and is checked before the binary is installed', () => {
  const script = render()
  const verifies = script.indexOf('runner checksum mismatch')
  const installs = script.indexOf('tar -xzf')
  assert.notEqual(verifies, -1, 'the digest has to be compared, not merely fetched')
  assert.ok(verifies < installs, 'it runs as root; verifying after installing verifies nothing')
  assert.match(script, /exit 1/)
  assert.match(script, /\[ "\$EXPECTED" = "\$ACTUAL" \]/, 'the manifest digest is compared to the bytes')
})

test('the manifest this host verifies against is the one it fetched beside the tarball', () => {
  // That the verification *works* is proved by running it — see
  // `runner-payload.test.ts`, which also covers the wrong-name and
  // uppercase-digest cases. What matters here is that a boot script renders it
  // at all, and against the file it just downloaded rather than some other one.
  const script = render()
  assert.match(script, /EXPECTED=\$\(awk .* "\/tmp\/boxlite-runner\.sha256"\)/)
  assert.match(script, /ACTUAL=\$\(sha256sum "\/tmp\/boxlite-runner\.tar\.gz"/)
})

test('the manifest is fetched beside the tarball, not derived on the host', () => {
  const script = render()
  assert.match(script, /runner-v0\.10\.0\.tar\.gz\.sha256/)
  const fetches = script.indexOf('runner-v0.10.0.tar.gz.sha256')
  const verifies = script.indexOf('EXPECTED=$(awk')
  assert.ok(fetches < verifies)
})

test('an s3 address is read with the host’s own role, and needs a region', () => {
  // A build-mode binary is staged rather than published, so nothing here is
  // fetched anonymously — and the region reaches a shell, so it is checked.
  const staged = {
    tarballUrl: 's3://boxlite-app-dev-artifacts/runner/abc/runner.tar.gz',
    checksumUrl: 's3://boxlite-app-dev-artifacts/runner/abc/runner.tar.gz.sha256',
    tarballName: 'runner.tar.gz',
    transport: 's3' as const,
  }
  assert.match(render({ binary: staged, region: 'ap-southeast-1' }), /aws .*s3 cp --region ap-southeast-1/)
  assert.throws(() => render({ binary: staged }), /needs the region that bucket lives in/)
})

test('a host without /dev/kvm refuses to finish rather than registering', () => {
  // A box is a microVM. A host that registers and cannot start one is a silent
  // failure; one that never registers is a visible one.
  const script = render()
  const checks = script.indexOf('/dev/kvm is absent')
  const starts = script.indexOf('systemctl start boxlite-runner')
  assert.notEqual(checks, -1)
  assert.ok(checks < starts)
})

test('the KVM hook runs before the check that depends on it', () => {
  // On GCP the device exists but is not readable by the account the runner runs
  // as, and preparing it after the check would fail a host that was fine.
  const script = render({ platform: platform({ prepareKvm: 'usermod -aG kvm root' }) })
  assert.ok(script.indexOf('usermod -aG kvm root') < script.indexOf('/dev/kvm is absent'))
})

test('the unit reads its settings from a file, not from lines appended after [Install]', () => {
  // The host's own address is not known until the script runs. Appending it to
  // the unit would land it inside `[Install]`, where systemd reads it as part
  // of that section and the runner never sees it.
  const script = render()
  assert.match(script, /EnvironmentFile=\/etc\/boxlite\/runner\.env/)
  assert.match(script, /printf 'RUNNER_DOMAIN=%s\\n' "\$HOST_IP" >> \/etc\/boxlite\/runner\.env/)
  const install = script.indexOf('[Install]')
  const appends = script.indexOf("printf 'RUNNER_DOMAIN")
  assert.ok(appends > install, 'the append is outside the unit file entirely, which is the point')
  assert.doesNotMatch(script, /Environment=RUNNER_DOMAIN/, 'never as a unit line')
})

test('the API URL is normalised once, here, rather than at every caller', () => {
  const script = render()
  assert.match(script, /BOXLITE_API_URL=https:\/\/api\.dev\.boxlite\.ai\/api$/m, 'one slash, not two')
})

test('a start wrapper replaces the binary as ExecStart, and only when there is one', () => {
  const without = render()
  assert.match(without, /ExecStart=\/usr\/local\/bin\/boxlite-runner$/m)

  const wrapped = render({
    platform: platform({
      startWrapper: { path: '/usr/local/bin/boxlite-runner-start.sh', script: '# fetches secrets' },
    }),
  })
  assert.match(wrapped, /ExecStart=\/usr\/local\/bin\/boxlite-runner-start\.sh$/m)
  assert.match(wrapped, /# fetches secrets/)
})

test('a secret delivered as an address stays an address, and is fetched rather than written', () => {
  // What runs on a runner is untrusted code by design, and instance metadata is
  // readable by all of it. Everything the store marks as an address therefore
  // reaches the unit through the wrapper's own fetch.
  //
  // The registration token is the one deliberate exception and is asserted
  // separately below — `stack/runner-boot.ts` records why it was accepted. This
  // test guards everything else, which is the part that must not drift.
  const script = render({
    environment: { BOXLITE_RUNNER_NAME: 'default', GHCR_TOKEN_ARN: 'arn:aws:secretsmanager:::secret:ghcr' },
    platform: platform({
      startWrapper: {
        path: '/usr/local/bin/boxlite-runner-start.sh',
        script: 'fetch GHCR_TOKEN "$GHCR_TOKEN_ARN"',
      },
    }),
  })
  assert.match(script, /GHCR_TOKEN_ARN=arn:aws:secretsmanager:::secret:ghcr/, 'the address may be written')
  assert.doesNotMatch(script, /^GHCR_TOKEN=/m, 'the value may not')
})

test('the registration token is written into the unit file, which is the accepted trade', () => {
  // Deliberate, and asserted so the decision is visible rather than implied by
  // its absence: pairing is token-based and the value has to be the one the API
  // seeded the row from, so it is delivered as a value. The cost — metadata is
  // readable on the host and off the API — is recorded in `runner-boot.ts`.
  //
  // Asserted here because a provider that quietly stopped delivering it is the
  // failure that crash-loops a host, and the one nothing else would catch.
  const script = render({ environment: { BOXLITE_RUNNER_NAME: 'default', BOXLITE_RUNNER_TOKEN: 'host-token' } })
  assert.match(script, /^BOXLITE_RUNNER_TOKEN=host-token$/m)
  // Inside the heredoc that writes the EnvironmentFile, which is the only place
  // systemd will read it from. Anchored on the heredoc itself rather than on
  // `[Install]`: the script mentions that section in a comment long before the
  // unit exists, so an index comparison against it proves nothing.
  const opens = script.indexOf("runner.env << 'RUNNERENV'")
  const closes = script.indexOf('RUNNERENV', opens + "runner.env << 'RUNNERENV'".length)
  const wrote = script.indexOf('BOXLITE_RUNNER_TOKEN=host-token')
  assert.ok(opens !== -1 && closes !== -1)
  assert.ok(wrote > opens && wrote < closes, 'it lands inside the EnvironmentFile, not loose in the script')
})

test('the platform’s own unit settings win over what the caller passed', () => {
  // A cloud names things only it can name — a region, a project — and a caller
  // that happened to set the same key must not silently retarget the host.
  const script = render({
    environment: { AWS_REGION: 'us-east-1' },
    platform: platform({ unitEnvironment: { AWS_REGION: 'ap-southeast-1' } }),
  })
  assert.match(script, /^AWS_REGION=ap-southeast-1$/m)
  assert.doesNotMatch(script, /^AWS_REGION=us-east-1$/m)
})
