// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Strip commented-out code before a contract test matches against it.
 *
 * The deployment contract tests pin lines that no unit test can reach: a `dependsOn` edge, an
 * `if:` guard, the checksum comparison a host runs before it installs a root-owned binary.
 * Matched against raw text, every one of those guards keeps passing after the line it pins is
 * demoted to a comment — the text is still in the file, the behavior is not.
 *
 * The entry point takes the *kind of artifact* rather than a stripper, because the two comment
 * syntaxes have to be composed differently per artifact and composing them by hand at each call
 * site fails open: a caller that reaches for the weaker one gets a guard that still passes.
 * Name what you are reading; this module decides how to strip it.
 */

// A shell comment starts at the beginning of a word, so a delimiter or line start is enough to
// open one. `<` `>` `)` are delimiters too: bash reads `>#x` and `x)#y` as a redirect/case-arm
// followed by a comment, while `>out#x` keeps its `#` because a word character precedes it —
// same reason `$#` and `sha#tag` do.
const stripShell = (text: string) => text.replace(/(^|[\s;|&(<>)])#.*$/gm, '$1')

// A block comment is only recognized when `/*` opens a line. `/*` also occurs mid-line in prose
// and in string literals — `routing /* to Api` in a comment, `/assets/*)` in another — and the
// `*/` that closes such an accidental block is just as incidental (`arn:aws:s3:::boxlite-volume-*/*`).
// Matched anywhere, one such pair swallowed 12KB of live sst.config.ts, so guards were reading a
// document with the code they pin already deleted from it.
// Line comments: only a preceding `:` suppresses the rule, so `https://…` inside a string
// survives while a trailing `},  // x` does not.
const stripScript = (text: string) => text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const STRIPPERS = {
  // A workflow `run:` body, or a payload this repo emits and a host executes.
  shell: stripShell,
  // A `.mjs` / `.ts` file read as source.
  script: stripScript,
  // TypeScript whose template literals emit bash — sst.config.ts's user-data. Both syntaxes are
  // live in the same text, and stripping only one leaves the other's comments matchable.
  scriptEmittingShell: (text: string) => stripShell(stripScript(text)),
}
type ContractSourceKind = keyof typeof STRIPPERS

export function liveText(kind: string, text: string) {
  const strip = kind in STRIPPERS ? STRIPPERS[kind as ContractSourceKind] : undefined
  if (!strip) throw new Error(`unknown contract source kind '${kind}' (expected ${Object.keys(STRIPPERS).join('/')})`)
  return strip(text ?? '')
}
