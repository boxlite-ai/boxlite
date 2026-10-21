import type { UploadManifest } from '@microcloud/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Api } from './api.js';

export const UPLOAD_CONCURRENCY = 8;

export interface UploadResult {
  snapshot_id: string;
  uploaded: number;
  uploadedBytes: number;
  files: number;
  bytes: number;
}

export interface UploadProgress {
  done: number;
  total: number;
  bytes: number;
}

/** manifest → missing → PUT each missing blob (8 at a time, one PUT per distinct sha256) → complete. */
export async function uploadSnapshot(api: Api, projectDir: string, manifest: UploadManifest, onProgress?: (p: UploadProgress) => void): Promise<UploadResult> {
  const { upload_id, missing } = await api.createUpload(manifest.files);
  const bySha = new Map(manifest.files.map((f) => [f.sha256, f]));
  const todo = [...new Set(missing)].map((sha) => bySha.get(sha)).filter((f) => f !== undefined);
  const bytes = todo.reduce((n, f) => n + f.size, 0);
  let done = 0;
  onProgress?.({ done, total: todo.length, bytes });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const file = todo[next++]!;
      await api.putFile(upload_id, file.sha256, await readFile(join(projectDir, file.path)));
      done++;
      onProgress?.({ done, total: todo.length, bytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, todo.length) }, worker));

  const completed = await api.completeUpload(upload_id);
  return { snapshot_id: completed.snapshot_id, uploaded: todo.length, uploadedBytes: bytes, files: completed.files ?? manifest.files.length, bytes: completed.bytes ?? manifest.bytes };
}
