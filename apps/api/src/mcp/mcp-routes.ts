/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** One Express router layer, as Express 5 keeps them on `app.router.stack`. */
interface RouterLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> }
}

/** `/api/v1/boxes/:boxId` and `/api/v1/boxes/{box_id}` both become `/api/v1/boxes/*`. */
export function routeShape(path: string): string {
  return `/${path}`
    .replace(/\/+/g, '/')
    .replace(/(.)\/$/, '$1')
    .split('/')
    .map((segment) => (/^[:{]/.test(segment) ? '*' : segment))
    .join('/')
}

/**
 * Whether the API serves an OpenAPI operation, read from the routes the Express
 * app registered: a spec can describe routes this deployment does not implement
 * (the v1 spec is shared with `boxlite serve`), and listing those would hand
 * agents tools that always 404. WebSocket operations are served by the upgrade
 * handler, so `webSocketServed` decides them.
 */
export function servedOperations(
  expressApp: unknown,
  webSocketServed: (path: string) => boolean,
): (op: { method: string; path: string; webSocket: boolean }) => boolean {
  const routes = new Set<string>()
  const stack = (expressApp as { router?: { stack?: RouterLayer[] } }).router?.stack ?? []
  for (const layer of stack) {
    if (!layer.route) continue
    for (const path of [layer.route.path].flat()) {
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) routes.add(`${method === '_all' ? '*' : method} ${routeShape(path)}`)
      }
    }
  }
  return ({ method, path, webSocket }) => {
    if (webSocket) return webSocketServed(path.replace(/\{[^}]+\}/g, 'x'))
    return routes.has(`${method} ${routeShape(path)}`) || routes.has(`* ${routeShape(path)}`)
  }
}
