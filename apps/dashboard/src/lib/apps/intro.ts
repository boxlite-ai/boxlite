/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

const storageKey = 'boxlite.app-hosting.intro-seen'
let seenWithoutStorage: boolean | undefined

export function hasSeenAppHostingIntro(): boolean {
  if (seenWithoutStorage !== undefined) return seenWithoutStorage
  try {
    return sessionStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}

export function setAppHostingIntroSeen(seen: boolean) {
  try {
    sessionStorage.setItem(storageKey, String(seen))
    seenWithoutStorage = undefined
  } catch {
    // Keep navigation between the list and detail pages working when storage is unavailable.
    seenWithoutStorage = seen
  }
}
