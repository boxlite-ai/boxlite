/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BoxVolume, BoxVolumeFilestoreRef } from '../dto/box.dto'

export function boxVolumeForDispatch(volume: BoxVolume): BoxVolume {
  // A single trailing slash was accepted and effectively ignored by the old
  // Runner path join. Normalize that legacy spelling before persistence so a
  // later Runner does not reject metadata that this API previously accepted.
  // A double slash is not normalized because it was always invalid.
  const subpath =
    typeof volume.subpath === 'string' &&
    volume.subpath !== '' &&
    !volume.subpath.startsWith('/') &&
    volume.subpath.endsWith('/') &&
    !volume.subpath.endsWith('//')
      ? volume.subpath.slice(0, -1)
      : volume.subpath

  return {
    volumeId: volume.volumeId,
    mountPath: volume.mountPath,
    subpath,
    readOnly: volume.readOnly,
    ...(volume.filestore ? { filestore: volume.filestore } : {}),
  }
}

export function boxVolumeForPublic(volume: BoxVolume): BoxVolume {
  return {
    ...boxVolumeForDispatch(volume),
    ...(volume.filestore ? { filestore: { instance: volume.filestore.instance } as BoxVolumeFilestoreRef } : {}),
  }
}
