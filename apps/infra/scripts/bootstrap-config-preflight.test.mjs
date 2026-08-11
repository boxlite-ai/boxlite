// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const INFRA_ROOT = new URL('..', import.meta.url)

test('preflights the worst-case runtime generation payload before lock or provider mutation', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-config-preflight-'))
  const environmentPath = join(fixture, 'operator.env')
  const fakeAws = join(fixture, 'aws')
  const fakeGh = join(fixture, 'gh')
  const mutationMarker = join(fixture, 'mutation-called')
  // This fits with the short generated-pending markers but exceeds the Standard
  // Parameter limit when every Secrets Manager VersionId reaches its allowed
  // 64 characters. The conservative preflight must therefore reject it before
  // acquiring the SSM bootstrap lock.
  const oversizedAudience = 'x'.repeat(3400)

  writeFileSync(
    environmentPath,
    [
      'STACK_DOMAIN=dev.example.test',
      'OIDC_ISSUER_BASE_URL=https://auth.example.test/',
      `OIDC_AUDIENCE=${oversizedAudience}`,
      '',
    ].join('\n'),
  )
  writeFileSync(
    fakeAws,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "aws-cli/2.32.0 Python/3.13.0 synthetic"
  exit 0
fi
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  echo '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:role/bootstrap-test"}'
  exit 0
fi
if [ "$1" = "secretsmanager" ] && [ "$2" = "describe-secret" ]; then
  echo 'ResourceNotFoundException: synthetic missing secret' >&2
  exit 254
fi
if [ "$1" = "iam" ] && [ "$2" = "list-open-id-connect-providers" ]; then
  echo '{"OpenIDConnectProviderList":[]}'
  exit 0
fi
printf 'aws mutation: %s\n' "$*" >> "$SYNTHETIC_BOOTSTRAP_MUTATION_MARKER"
exit 97
`,
  )
  writeFileSync(
    fakeGh,
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
printf 'gh mutation: %s\n' "$*" >> "$SYNTHETIC_BOOTSTRAP_MUTATION_MARKER"
exit 98
`,
  )
  chmodSync(fakeAws, 0o755)
  chmodSync(fakeGh, 0o755)

  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bootstrap-environment.mjs',
        '--stage',
        'dev',
        '--repo',
        'boxlite-ai/boxlite',
        '--reviewers',
        '123',
        '--env-file',
        environmentPath,
      ],
      {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: `${fixture}:${process.env.PATH}`,
          AWS_CLI_PATH: fakeAws,
          SYNTHETIC_BOOTSTRAP_MUTATION_MARKER: mutationMarker,
        },
      },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /4096|AppConfig/i)
    assert.equal(existsSync(mutationMarker), false, 'oversized config must fail before AWS/GitHub mutation')
    assert.equal(`${result.stdout}${result.stderr}`.includes(oversizedAudience), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

for (const invalidConsumer of [
  {
    name: 'an HTTP Proxy template URL',
    lines: ['PROXY_DOMAIN=proxy.dev.example.test', 'PROXY_TEMPLATE_URL=http://proxy.dev.example.test'],
    error: /PROXY_TEMPLATE_URL.*HTTPS origin/i,
  },
  {
    name: 'a Proxy template URL for another host',
    lines: ['PROXY_DOMAIN=proxy.dev.example.test', 'PROXY_TEMPLATE_URL=https://detached.dev.example.test'],
    error: /PROXY_TEMPLATE_URL.*host.*PROXY_DOMAIN/i,
  },
  { name: 'public MailDev', lines: ['MAILDEV_PUBLIC=true'], error: /MAILDEV_PUBLIC.*not supported/i },
  { name: 'public Jaeger', lines: ['JAEGER_PUBLIC=true'], error: /JAEGER_PUBLIC.*not supported/i },
  {
    name: 'ClickHouse export without an endpoint',
    lines: ['CLICKHOUSE_EXPORTER_ENABLED=true'],
    error: /CLICKHOUSE.*ENDPOINT.*required/i,
  },
  {
    name: 'ClickHouse export without an explicit writer password seed',
    lines: [
      'CLICKHOUSE_EXPORTER_ENABLED=true',
      'CLICKHOUSE_WRITER_ENDPOINT=https://clickhouse.example.test:8443',
    ],
    error: /CLICKHOUSE_WRITER_PASSWORD.*required.*CLICKHOUSE_EXPORTER_ENABLED/i,
  },
  {
    name: 'a ClickHouse reader URL without an explicit reader password seed',
    lines: ['CLICKHOUSE_READER_URL=https://clickhouse.example.test'],
    error: /CLICKHOUSE_READER_PASSWORD.*required.*reader/i,
  },
  {
    name: 'a ClickHouse reader host without an explicit reader password seed',
    lines: ['CLICKHOUSE_HOST=clickhouse.example.test'],
    error: /CLICKHOUSE_READER_PASSWORD.*required.*reader/i,
  },
  {
    name: 'GHCR activation without an explicit token seed',
    lines: ['GHCR_USERNAME=boxlite-ci'],
    error: /GHCR_TOKEN.*required.*GHCR_USERNAME/i,
  },
]) {
  test(`rejects ${invalidConsumer.name} before any fake AWS or GitHub mutation`, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-consumer-preflight-'))
    const environmentPath = join(fixture, 'operator.env')
    const fakeAws = join(fixture, 'aws')
    const fakeGh = join(fixture, 'gh')
    const mutationMarker = join(fixture, 'mutation-called')

    writeFileSync(
      environmentPath,
      [
        'STACK_DOMAIN=dev.example.test',
        'OIDC_ISSUER_BASE_URL=https://auth.example.test/',
        'OIDC_AUDIENCE=boxlite-api',
        ...invalidConsumer.lines,
        '',
      ].join('\n'),
    )
    writeFileSync(
      fakeAws,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "aws-cli/2.32.0 Python/3.13.0 synthetic"
  exit 0
fi
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  echo '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:role/bootstrap-test"}'
  exit 0
fi
if [ "$1" = "secretsmanager" ] && [ "$2" = "describe-secret" ]; then
  echo 'ResourceNotFoundException: synthetic missing secret' >&2
  exit 254
fi
if [ "$1" = "iam" ] && [ "$2" = "list-open-id-connect-providers" ]; then
  echo '{"OpenIDConnectProviderList":[]}'
  exit 0
fi
printf 'aws mutation: %s\n' "$*" >> "$SYNTHETIC_BOOTSTRAP_MUTATION_MARKER"
exit 97
`,
    )
    writeFileSync(
      fakeGh,
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
printf 'gh mutation: %s\n' "$*" >> "$SYNTHETIC_BOOTSTRAP_MUTATION_MARKER"
exit 98
`,
    )
    chmodSync(fakeAws, 0o755)
    chmodSync(fakeGh, 0o755)

    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/bootstrap-environment.mjs',
          '--stage',
          'dev',
          '--repo',
          'boxlite-ai/boxlite',
          '--reviewers',
          '123',
          '--env-file',
          environmentPath,
        ],
        {
          cwd: INFRA_ROOT,
          encoding: 'utf8',
          env: {
            PATH: `${fixture}:${process.env.PATH}`,
            AWS_CLI_PATH: fakeAws,
            SYNTHETIC_BOOTSTRAP_MUTATION_MARKER: mutationMarker,
          },
        },
      )

      assert.notEqual(result.status, 0)
      assert.match(result.stderr, invalidConsumer.error)
      assert.equal(existsSync(mutationMarker), false, 'consumer validation must run before all external mutation')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
}

test('rejects a credential-bearing usage export URL before any fake AWS or GitHub mutation', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-bootstrap-url-preflight-'))
  const environmentPath = join(fixture, 'operator.env')
  const fakeAws = join(fixture, 'aws')
  const fakeGh = join(fixture, 'gh')
  const mutationMarker = join(fixture, 'mutation-called')
  const sentinel = 'usage-export-password-sentinel-45c17a'

  writeFileSync(
    environmentPath,
    [
      'STACK_DOMAIN=dev.example.test',
      'OIDC_ISSUER_BASE_URL=https://auth.example.test/',
      'OIDC_AUDIENCE=boxlite-api',
      `USAGE_EXPORT_URL=https://publisher:${sentinel}@commerce.example.test`,
      '',
    ].join('\n'),
  )
  writeFileSync(
    fakeAws,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "aws-cli/2.32.0 Python/3.13.0 synthetic"
  exit 0
fi
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  echo '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:role/bootstrap-test"}'
  exit 0
fi
printf 'aws call: %s\n' "$*" >> "$SYNTHETIC_BOOTSTRAP_MUTATION_MARKER"
exit 97
`,
  )
  writeFileSync(
    fakeGh,
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
printf 'gh call: %s\n' "$*" >> "$SYNTHETIC_BOOTSTRAP_MUTATION_MARKER"
exit 98
`,
  )
  chmodSync(fakeAws, 0o755)
  chmodSync(fakeGh, 0o755)

  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bootstrap-environment.mjs',
        '--stage',
        'dev',
        '--repo',
        'boxlite-ai/boxlite',
        '--reviewers',
        '123',
        '--env-file',
        environmentPath,
      ],
      {
        cwd: INFRA_ROOT,
        encoding: 'utf8',
        env: {
          PATH: `${fixture}:${process.env.PATH}`,
          AWS_CLI_PATH: fakeAws,
          SYNTHETIC_BOOTSTRAP_MUTATION_MARKER: mutationMarker,
        },
      },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /USAGE_EXPORT_URL/)
    assert.equal(existsSync(mutationMarker), false, 'invalid URL config must fail before AWS/GitHub calls')
    assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
