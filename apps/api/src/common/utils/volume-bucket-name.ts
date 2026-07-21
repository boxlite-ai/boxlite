/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const VOLUME_ID_LENGTH = 36
const MAX_S3_BUCKET_NAME_LENGTH = 63
const VOLUME_BUCKET_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

export function validateVolumeBucketPrefix(prefix: string): string {
  if (!VOLUME_BUCKET_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      'VOLUME_BUCKET_PREFIX must contain only lowercase letters, numbers, and hyphens, and start with a letter or number',
    )
  }

  if (prefix.length + VOLUME_ID_LENGTH > MAX_S3_BUCKET_NAME_LENGTH) {
    throw new Error(`VOLUME_BUCKET_PREFIX must be at most ${MAX_S3_BUCKET_NAME_LENGTH - VOLUME_ID_LENGTH} characters`)
  }

  return prefix
}

function validateVolumeBucketName(bucketName: string): string {
  if (!S3_BUCKET_NAME_PATTERN.test(bucketName)) {
    throw new Error('Volume bucket name must be a valid S3 bucket name')
  }

  return bucketName
}

export function resolveVolumeBucketName(prefix: string, volumeId: string): string {
  return validateVolumeBucketName(`${validateVolumeBucketPrefix(prefix)}${volumeId}`)
}
