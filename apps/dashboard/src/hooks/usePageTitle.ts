/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect } from 'react'

const PRODUCT = 'BoxLite'

/** The browser tab title for a page: "<Page> · BoxLite", or the product name alone while the page name is unknown. */
export function formatPageTitle(title: string | undefined): string {
  const page = title?.trim()
  return page ? `${page} · ${PRODUCT}` : PRODUCT
}

/**
 * Names the browser tab after the page being shown, so tabs and history entries can be told apart.
 * The previous title comes back on unmount, which keeps a nested page from leaking its name.
 */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    const previous = document.title
    document.title = formatPageTitle(title)
    return () => {
      document.title = previous
    }
  }, [title])
}
