/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Storage } from '@google-cloud/storage'
import { TypedConfigService } from '../../config/typed-config.service'

/** The provider token the snapshot services inject the store through. */
export const SNAPSHOT_ARCHIVE_STORE = 'SNAPSHOT_ARCHIVE_STORE'

/**
 * The control plane's side of a snapshot archive: deleting it. The snapshot
 * jobs write and read archives; only the API removes them, so cleanup never
 * depends on the runner that ran a job still being there.
 */
export interface SnapshotArchiveStore {
  /** Idempotent: an archive that is already gone resolves rather than throwing. */
  delete(archiveUri: string): Promise<void>
}

/**
 * The store for the configured prefix, or null when snapshots are off. The
 * prefix is validated at boot (boxSnapshotConfig), and gs:// is the only
 * scheme it accepts until an S3 store exists.
 */
export function createSnapshotArchiveStore(configService: TypedConfigService): SnapshotArchiveStore | null {
  if (!configService.get('boxSnapshot.archivePrefix')) {
    return null
  }
  return new GcsSnapshotArchiveStore(configService.get('gcs.projectId')?.trim() || undefined)
}

class GcsSnapshotArchiveStore implements SnapshotArchiveStore {
  // Application Default Credentials, as for volume buckets: the attached
  // service account in the cloud, `gcloud auth application-default login`
  // locally. Key files are deliberately not supported.
  private readonly storage: Storage

  constructor(projectId?: string) {
    this.storage = new Storage(projectId ? { projectId } : {})
  }

  async delete(archiveUri: string): Promise<void> {
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(archiveUri)
    if (!match) {
      throw new Error(`Not a Cloud Storage object URI: ${archiveUri}`)
    }
    await this.storage.bucket(match[1]).file(match[2]).delete({ ignoreNotFound: true })
  }
}
