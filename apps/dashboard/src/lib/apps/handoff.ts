/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// The App key exists in clear text only in the response that minted it (create, issue, rotate). This tab
// keeps that prompt in memory, never in storage, so "Copy prompt" on the app page can hand the
// working key to the agent right after creation; after a reload only the masked prompt is left and
// Copy issues one more key.

const fresh = new Map<string, string>()

export function rememberPrompt(appId: string, prompt: string): void {
  fresh.set(appId, prompt)
}

export function freshPrompt(appId: string): string | null {
  return fresh.get(appId) ?? null
}
