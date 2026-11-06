// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

export function checkpointConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawLimit = env.CHECKPOINT_MAX_PER_ORGANIZATION?.trim()
  const maxPerOrganization = rawLimit ? Number(rawLimit) : 10
  if ((rawLimit && !/^\d+$/.test(rawLimit)) || !Number.isSafeInteger(maxPerOrganization) || maxPerOrganization < 1) {
    throw new Error('CHECKPOINT_MAX_PER_ORGANIZATION must be a positive safe integer')
  }
  const raw = env.CHECKPOINT_ARCHIVE_PREFIX?.trim()
  if (!raw) return { archivePrefix: undefined as string | undefined, maxPerOrganization }
  const match = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(raw)
  const suffix = match?.[2]?.replace(/\/+$/, '') ?? ''
  const segments = suffix ? suffix.split('/') : []
  if (!match || !segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error('CHECKPOINT_ARCHIVE_PREFIX must be gs://<bucket>/<prefix> without empty or traversal segments')
  }
  return { archivePrefix: `gs://${match[1]}/${segments.length ? segments.join('/') + '/' : ''}`, maxPerOrganization }
}
