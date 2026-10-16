/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Binary units, because a manifest declares layer sizes in bytes and every
// registry UI reports them this way. `null` is not zero: a curated image's
// bytes were never measured by this system, and "0 B" would claim they were.
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

// Coarse on purpose: these columns answer "is this stale?", not "when exactly".
// `never` rather than an empty cell, because a volume or image nothing has
// touched is a fact worth reading, not missing data.
export function timeAgo(value?: string | null): string {
  if (!value) return 'never'
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
