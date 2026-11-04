/** Recognize Web Responses returned by authentication and gateway handlers. */
export function isResponse(x: unknown): x is Response {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Response).status === 'number' &&
    typeof (x as Response).arrayBuffer === 'function' &&
    (x as Response).headers instanceof Headers
  )
}
