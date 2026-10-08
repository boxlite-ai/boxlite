/**
 * Options for copying files between host and container.
 *
 * To copy a directory's contents rather than the directory, end the source
 * path with `/.` as `docker cp` does (`"/app/."`). Build it as a string —
 * `path.join` drops the trailing `.`.
 */
export interface CopyOptions {
  /** Copy directories recursively (default: true). */
  recursive?: boolean;

  /** Overwrite existing files (default: true). */
  overwrite?: boolean;

  /** Follow symbolic links instead of copying the link itself. */
  followSymlinks?: boolean;
}
