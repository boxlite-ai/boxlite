/**
 * Options for copying files between host and container.
 */
export interface CopyOptions {
  /** Copy directories recursively (default: true). */
  recursive?: boolean;

  /** Overwrite existing files (default: true). */
  overwrite?: boolean;

  /** Follow symbolic links instead of copying the link itself. */
  followSymlinks?: boolean;

  /** Include the parent directory in the copy (default: true). */
  includeParent?: boolean;
}

/**
 * One container_src → host_dst pair for `Box.copyOutMany`. Callers
 * control per-file destinations, so duplicate `containerSrc` entries
 * don't collide.
 */
export interface CopyOutPair {
  /** Path inside the box to copy out. */
  containerSrc: string;
  /** Host destination path; parent dirs are created if missing. */
  hostDst: string;
}

/**
 * Per-pair result from `Box.copyOutMany`. `error === null` means the
 * file landed at `hostDst`; otherwise the string carries the server's
 * error text or the local write failure reason.
 */
export interface CopyOutOutcome {
  containerSrc: string;
  hostDst: string;
  error: string | null;
}
