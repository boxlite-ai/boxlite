/**
 * Credential abstraction for the BoxLite REST client.
 *
 * `Credential` is a structural interface: every credential class (today
 * `ApiKeyCredential`, a future `OAuthCredential`) structurally satisfies
 * it without a nominal `implements`. Callers type against `Credential`
 * and never change when new credential kinds are added.
 */

import type {
  ApiKeyCredential as NativeApiKeyCredential,
  JsAccessToken,
} from "./native-contracts.js";
import { getApiKeyCredential } from "./native.js";

/** A bearer token plus its expiry. */
export type AccessToken = JsAccessToken;

/** Anything that can produce a bearer token for `Boxlite.rest()`. */
export interface Credential {
  getToken(): AccessToken;
}

/**
 * Long-lived opaque API key credential. Concrete `Credential`.
 *
 * @example
 * ```ts
 * import { Boxlite, ApiKeyCredential } from '@boxlite/sdk';
 * const client = Boxlite.rest('http://localhost:8100',
 *                             new ApiKeyCredential('sk_...'));
 * ```
 */
export const ApiKeyCredential = getApiKeyCredential();

/** Instance type of {@link ApiKeyCredential}. */
export type ApiKeyCredential = NativeApiKeyCredential;
