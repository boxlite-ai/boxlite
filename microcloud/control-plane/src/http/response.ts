/** `isResponse`: recognising a Response by shape (node-server swaps the global class). */
/**
 * Recognising a Response. `instanceof Response` is not reliable here: @hono/node-server swaps the
 * global Response for its own class at startup, but `Response.json()` (inherited static) still
 * builds a native one. A native Response failed the check and the request went on to the app, so
 * /.boxlite/auth/me reached app code for signed-in users. Recognise a response by shape instead.
 */
export function isResponse(x: unknown): x is Response {
  return typeof x === 'object' && x !== null && typeof (x as Response).status === 'number' && typeof (x as Response).arrayBuffer === 'function' && (x as Response).headers instanceof Headers;
}
