/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import CodeBlock from '@/components/CodeBlock'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RoutePath } from '@/enums/RoutePath'
import { IMAGE_SNIPPET_LANGUAGES, renderImageSnippet, type ImageSnippetLanguage } from '@/lib/image-snippets'
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const STORAGE_KEY = 'images-snippet-language'

function readLanguage(): ImageSnippetLanguage {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
  return IMAGE_SNIPPET_LANGUAGES.some((l) => l.id === stored) ? (stored as ImageSnippetLanguage) : 'python'
}

interface UseImageSheetProps {
  /** The reference to start from; null keeps the sheet closed. */
  imageRef: string | null
  onClose: () => void
}

/**
 * The create call for a reference, in the reader's SDK.
 *
 * Images enter the catalog by being used, so this is the page's primary
 * action: it answers both how an image gets here and what to do with one that
 * is. The reference stays editable so a tag or digest can be swapped before
 * copying.
 */
export function UseImageSheet({ imageRef, onClose }: UseImageSheetProps) {
  const [language, setLanguage] = useState<ImageSnippetLanguage>(readLanguage)
  const [ref, setRef] = useState('')

  useEffect(() => {
    if (imageRef !== null) setRef(imageRef)
  }, [imageRef])

  const selectLanguage = (value: string) => {
    const next = value as ImageSnippetLanguage
    setLanguage(next)
    globalThis.localStorage?.setItem(STORAGE_KEY, next)
  }

  const active = IMAGE_SNIPPET_LANGUAGES.find((l) => l.id === language) ?? IMAGE_SNIPPET_LANGUAGES[0]

  return (
    <Sheet open={imageRef !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-5 sm:max-w-[560px]">
        <SheetHeader>
          <SheetTitle>Use an image</SheetTitle>
          <SheetDescription>
            A box starts from any public image, or a private one its registry credential covers. The first start pulls
            it; after that it is listed here.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-1">
          <Label htmlFor="use-image-ref">Image</Label>
          <Input
            id="use-image-ref"
            value={ref}
            onChange={(event) => setRef(event.target.value)}
            spellCheck={false}
            className="font-mono"
          />
        </div>

        <Tabs value={language} onValueChange={selectLanguage}>
          <TabsList variant="segmented">
            {IMAGE_SNIPPET_LANGUAGES.map((option) => (
              <TabsTrigger key={option.id} value={option.id}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <CodeBlock code={renderImageSnippet(language, ref)} language={active.codeLanguage} />

        <p className="font-mono text-meta text-muted-foreground">
          <code className="text-foreground">rt</code> is the runtime from the{' '}
          <Link to={RoutePath.ONBOARDING} className="text-foreground underline-offset-4 hover:underline">
            Quickstart
          </Link>
          . Pin production boxes to a digest (<code className="text-foreground">name@sha256:…</code>) so a moved tag
          cannot change what they run.
        </p>
      </SheetContent>
    </Sheet>
  )
}
