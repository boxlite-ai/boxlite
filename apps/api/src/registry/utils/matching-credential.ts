/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegistryCredential } from '../entities/registry-credential.entity'

/** Whole path segments, with the most specific registered login winning. */
export function matchingCredential(candidates: RegistryCredential[], repository: string): RegistryCredential | null {
  const path = `${repository}/`
  let longest: RegistryCredential | null = null
  for (const candidate of candidates) {
    if (
      path.startsWith(candidate.repositoryPrefix) &&
      (!longest || candidate.repositoryPrefix.length > longest.repositoryPrefix.length)
    ) {
      longest = candidate
    }
  }
  return longest
}
