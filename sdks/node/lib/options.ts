/**
 * REST options for the BoxLite client.
 *
 * `BoxliteRestOptions` is the single options bag passed to
 * `JsBoxlite.rest(...)`. The name and shape are intentionally identical
 * across every SDK (C/Go/Node/Python) for cross-SDK parity:
 *
 * @example
 * ```ts
 * import { JsBoxlite, BoxliteRestOptions, ApiKeyCredential } from '@boxlite-ai/boxlite';
 *
 * const rt = JsBoxlite.rest(new BoxliteRestOptions({
 *   url: 'https://api.example.com',
 *   credential: new ApiKeyCredential('blk_live_...'),
 * }));
 * ```
 */

import type { Credential } from "./credential.js";

/** Configuration for connecting to a remote BoxLite REST API server. */
export class BoxliteRestOptions {
  /** REST API base URL (e.g. `https://api.example.com`). */
  readonly url: string;

  /** Bearer credential. Omit for an unauthenticated runtime. */
  readonly credential?: Credential;

  /** API path prefix (server default: `v1`). */
  readonly prefix?: string;

  constructor(options: {
    url: string;
    credential?: Credential;
    prefix?: string;
  }) {
    this.url = options.url;
    this.credential = options.credential;
    this.prefix = options.prefix;
  }
}
