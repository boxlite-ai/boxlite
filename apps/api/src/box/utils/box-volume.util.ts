/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BoxVolume, BoxVolumeFilestoreRef } from '../dto/box.dto'

export function boxVolumeForDispatch(volume: BoxVolume): BoxVolume {
  return {
    volumeId: volume.volumeId,
    mountPath: volume.mountPath,
    subpath: volume.subpath,
    ...(volume.filestore ? { filestore: volume.filestore } : {}),
  }
}

export function boxVolumeForPublic(volume: BoxVolume): BoxVolume {
  return {
    ...boxVolumeForDispatch(volume),
    ...(volume.filestore
      ? { filestore: { instance: volume.filestore.instance } as BoxVolumeFilestoreRef }
      : {}),
  }
}
