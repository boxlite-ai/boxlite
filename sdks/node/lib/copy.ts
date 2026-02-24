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
