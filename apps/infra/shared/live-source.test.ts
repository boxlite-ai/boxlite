// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { liveText } from './live-source.js'

test('shell: a comment cannot keep a guard passing, wherever it opens', () => {
  const payload = [
    '#[ "$EXPECTED" = "$ACTUAL" ] || exit 1',
    'true;#[ "$LEADING" = "$SEMICOLON" ]',
    'true |#[ "$LEADING" = "$PIPE" ]',
    'printf x  #[ "$TRAILING" = "$SPACE" ]',
    'echo a >#[ "$AFTER" = "$REDIRECT" ]',
    'cat <#[ "$AFTER" = "$INFILE" ]',
    'case x in artifact)#[ "$AFTER" = "$CASEARM" ]',
  ].join('\n')
  const live = liveText('shell', payload)

  for (const removed of ['$ACTUAL', '$SEMICOLON', '$PIPE', '$SPACE', '$REDIRECT', '$INFILE', '$CASEARM']) {
    assert.doesNotMatch(live, new RegExp(removed.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('shell: a `#` that does not open a comment is kept', () => {
  // A word character before `#` means it is part of the word, not the start of a comment —
  // `>out#x` redirects to a file literally named `out#x`, which bash confirms by exiting 0.
  const live = liveText('shell', 'echo "$#" && echo ghcr.io/boxlite/img:sha#tag && echo a >out#x')

  assert.match(live, /\$#/)
  assert.match(live, /sha#tag/)
  assert.match(live, />out#x/)
})

test('script: line comments go, `https://` in a string stays', () => {
  const live = liveText(
    'script',
    ['// dependsOn: [runnerArtifactPolicy],', "url: 'https://example.invalid',", '},  // protect: true'].join('\n'),
  )

  assert.doesNotMatch(live, /dependsOn/)
  assert.doesNotMatch(live, /protect: true/)
  assert.match(live, /https:\/\/example\.invalid/)
})

test('script: a block comment only opens at the start of a line', () => {
  // The regression this module shipped: `/*` inside prose or a string paired with a `*/` inside
  // an unrelated ARN deleted 12KB of live config, so guards read a document without the code
  // they pin. Anything between such a pair must survive.
  const source = [
    '    /* commented: dependsOn: [runnerArtifactPolicy] */',
    '    // Router still exists for routing /* to Api.',
    "    const grant = 'arn:aws:s3:::boxlite-volume-*/*'",
    '    protect: true,',
  ].join('\n')
  const live = liveText('script', source)

  assert.doesNotMatch(live, /dependsOn/, 'a line-leading block comment must be stripped')
  assert.match(live, /protect: true/, 'code after an incidental /* … */ pair must survive')
  assert.match(live, /boxlite-volume/)
})

test('scriptEmittingShell: both syntaxes are live in the same text', () => {
  const source = ['const userData = `', '#[ "$EXPECTED" = "$ACTUAL" ] || exit 1', '`', '// protect: true'].join('\n')
  const live = liveText('scriptEmittingShell', source)

  assert.doesNotMatch(live, /\$ACTUAL/)
  assert.doesNotMatch(live, /protect: true/)
  assert.match(live, /const userData/)
})

test('an unknown kind throws instead of silently failing open', () => {
  assert.throws(() => liveText('yaml', '# x'), /unknown contract source kind 'yaml'/)
})
