/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The one call that starts a box from an image, per SDK. The runtime setup
 * before it is the Quickstart's; these are the lines a reader changes.
 */
export const IMAGE_SNIPPET_LANGUAGES = [
  { id: 'python', label: 'Python', codeLanguage: 'python' },
  { id: 'typescript', label: 'Node', codeLanguage: 'typescript' },
  { id: 'go', label: 'Go', codeLanguage: 'go' },
  { id: 'cli', label: 'CLI', codeLanguage: 'bash' },
] as const

export type ImageSnippetLanguage = (typeof IMAGE_SNIPPET_LANGUAGES)[number]['id']

function doubleQuoted(ref: string): string {
  return `"${ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderImageSnippet(language: ImageSnippetLanguage, ref: string): string {
  const q = doubleQuoted(ref)
  switch (language) {
    case 'python':
      return `box = await rt.create(BoxOptions(image=${q}))
await box.start()`
    case 'typescript':
      return `const box = await rt.create({ image: ${q.replace(/"/g, "'")} })
await box.start()`
    case 'go':
      return `box, err := rt.Create(ctx, ${q})
if err != nil {
    log.Fatal(err)
}
if err := box.Start(ctx); err != nil {
    log.Fatal(err)
}`
    case 'cli':
      return `boxlite run --rm ${ref} echo "hello from this image"`
  }
}
