/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
export function startHTTPServer(): never {
  throw new Error('Standalone MCP listener is not allowed; Nest owns the HTTP socket')
}
