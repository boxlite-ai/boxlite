/*
 * That no provider writes a cloud name by hand.
 *
 * The names themselves are `naming/test/names.test.ts`'s. What this asks is
 * whether the providers go through it, which no other test can see: the stack
 * tests drive recording providers, so the real ones — where every name is
 * written — are never evaluated. Fifty names moved in one change with nothing
 * to catch a mistake, and this is that thing.
 *
 * Source rather than behaviour, because these modules cannot be imported at
 * all outside an apply: they read `gcp`, `$app` and `$util`, which sst and the
 * Pulumi program inject. `deploy.test.ts` reads `sst.config.ts` the same way.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SERVICE_ACCOUNT_LIMIT, identityFor, instanceFor } from 'naming'

const providers = (cloud: 'aws' | 'gcp'): { file: string; text: string }[] => {
  const directory = fileURLToPath(new URL(`../stack/providers/${cloud}/`, import.meta.url))
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .map((file) => ({ file: `${cloud}/${file}`, text: readFileSync(`${directory}${file}`, 'utf8') }))
}

/** Lines that are only commentary, which may name anything while explaining it. */
const code = (text: string): { line: string; number: number }[] =>
  text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))

/** What `mstage.env.json` declares. Read rather than repeated: it is the declaration. */
const declared = JSON.parse(
  readFileSync(new URL('../../mstage.env.json', import.meta.url), 'utf8'),
) as { app: string; appShort: string; artifacts: Record<string, unknown> }

/** The app and the stage joined by hand, which is what `instanceFor` replaced. */
const BY_HAND = /\$\{\$app\.name\}-\$\{\$app\.stage\}/

/*
 * The AWS names still written out, and the file that has to say why.
 *
 * All three are IAM: `identityFor` would rename them, AWS has no rename
 * primitive, and dev and prod run on that account today — so the rename is a
 * delete and recreate of a role a live host is attached to. Held as an
 * enumerated exception so it stays argued rather than becoming a literal
 * somebody tidies away or copies into a fourth place.
 */
const AWS_IAM_NAMES: Record<string, number> = { 'aws/clickhouse.ts': 2, 'aws/storage.ts': 1 }

test('no provider composes a name from the app and the stage by hand', () => {
  // The literal was `${$app.name}-${$app.stage}` in fifty places, each one free
  // to drift by a character. `instanceFor` is the one answer.
  for (const cloud of ['aws', 'gcp'] as const) {
    for (const { file, text } of providers(cloud)) {
      const written = code(text).filter(({ line }) => BY_HAND.test(line))
      assert.equal(
        written.length,
        AWS_IAM_NAMES[file] ?? 0,
        `${file} joins the app and the stage by hand: ${written.map(({ number }) => number).join(', ')}`,
      )
      if (!AWS_IAM_NAMES[file]) continue
      assert.match(text, /An IAM role name/, `${file} keeps a literal role name with nothing saying why`)
    }
  }
})

test('an identity is named from the abbreviation, never from the app in full', () => {
  /*
   * The failure this shape makes possible. `identityFor` takes `appShort` and
   * `instanceFor` takes `app`, and both are in scope in the same file — handing
   * the full app to the first produces `boxlite-prod-otel-collector-run`, which
   * `naming` refuses at 31 characters. Refused there, so this is about catching
   * it in review rather than in an apply.
   */
  for (const { file, text } of providers('gcp')) {
    for (const { line, number } of code(text)) {
      if (!/(identityFor|poolFor)\(/.test(line)) continue
      assert.doesNotMatch(
        line,
        /(identityFor|poolFor)\(\{[^}]*app:/,
        `${file}:${number} names an identity from the app in full: ${line.trim()}`,
      )
      assert.match(
        line,
        /(identityFor|poolFor)\(\{ appShort/,
        `${file}:${number} names an identity from something other than appShort: ${line.trim()}`,
      )
    }
  }
})

test('no GCP identity is spelled out where the limit is what decides it', () => {
  /*
   * A service account id takes 30 characters and the project is shared with the
   * rest of BoxLite, so the spelling is `naming`'s to choose. `.slice(0, 30)`
   * is the one this replaced — a truncation, which silently gives two long
   * artifacts the same identity instead of refusing either.
   */
  for (const { file, text } of providers('gcp')) {
    for (const { line, number } of code(text)) {
      if (!/(accountId|workloadIdentityPoolId|workloadIdentityPoolProviderId):/.test(line)) continue
      assert.match(
        line,
        /(identityFor|poolFor)\(/,
        `${file}:${number} names an identity without going through naming: ${line.trim()}`,
      )
    }
  }
})

test('an artifact reaches the name through the helper, not around it', () => {
  /*
   * What the first pass of a rename like this produces: the helper called for
   * the prefix and the artifact concatenated after it. The name comes out right
   * and the form is no longer expressed anywhere.
   *
   * A separator followed by an interpolation is not that, and is allowed: a
   * Secrets Manager `namePrefix` and an availability zone are suffixes the
   * cloud or the deploy appends, not segments this repository chose.
   */
  for (const cloud of ['aws', 'gcp'] as const) {
    for (const { file, text } of providers(cloud)) {
      for (const { line, number } of code(text)) {
        assert.doesNotMatch(
          line,
          /\$\{instanceFor\(\{[^}]*\}\)\}-[a-z0-9]/,
          `${file}:${number} appends a segment after the helper: ${line.trim()}`,
        )
      }
    }
  }
})

test('every artifact this repository builds can be named, and the identity still fits', () => {
  /*
   * The declaration, not a list here: an artifact added to `mstage.env.json`
   * and given no name is a container nothing addresses.
   *
   * The identity is checked as well as the instance, because this app has one
   * character of headroom — `bl-app-prod-otel-collector-run` is 30 of 30. The
   * next artifact with a longer name is a `NameError`, and it should be this
   * test that says so rather than a bootstrap that stops halfway.
   */
  const named = Object.keys(declared.artifacts)
  assert.ok(named.length > 0, 'mstage.env.json declares no artifacts, so this checks nothing')
  for (const artifact of named) {
    assert.equal(
      instanceFor({ app: declared.app, stage: 'prod', artifact }),
      `${declared.app}-prod-${artifact}`,
    )
    const identity = identityFor({ appShort: declared.appShort, stage: 'prod', artifact, action: 'run' })
    assert.ok(identity.length <= SERVICE_ACCOUNT_LIMIT, `${identity} is ${identity.length}`)
  }
})
