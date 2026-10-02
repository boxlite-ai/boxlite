## TL;DR

Guest service previews require a public box and an active tunnel declaration, regardless of URL form or credential.

## Problem

The original proxy forwarded signed preview hosts and authenticated private previews to guest ports without checking a tunnel declaration. A preview URL only identifies a port; it does not open one. The access decision must apply to every guest-port request, while the authenticated web terminal remains available on port 22222.

## Related work and lessons

- [`boxlite-proxy.controller.ts`](../../../apps/api/src/boxlite-rest/boxlite-proxy.controller.ts#L242) requires a public box before opening a remote tunnel; [`tunnel.service.ts`](../../../apps/api/src/box/services/tunnel.service.ts#L26) records the per-port declaration. URL issuance in [`box.service.ts`](../../../apps/api/src/box/services/box.service.ts#L784) is separate, so issuing a URL cannot enforce access.
- [`preview.controller.ts`](../../../apps/api/src/box/controllers/preview.controller.ts#L29) exposes the proxy-only tunnel check. [`tunnel.service.ts`](../../../apps/api/src/box/services/tunnel.service.ts#L40) checks the declaration, revocation, box visibility, and lifecycle state. Reusing this endpoint keeps the HTTP and CONNECT decisions aligned.
- [`get_box_target.go`](../../../apps/proxy/pkg/proxy/get_box_target.go#L49) routes HTTP/WebSocket previews; [`tunnel.go`](../../../apps/proxy/pkg/proxy/tunnel.go#L27) handles raw CONNECT separately. Both paths need the same access check, while terminal traffic takes a separate authenticated route.

## Approach

- After resolving the box ID, check the API's public tunnel endpoint for every HTTP/WebSocket guest service port and raw CONNECT. Keep port 22222 on its authenticated terminal path and reject raw CONNECT to it.
- Use the same API check on both paths. It confirms an active public declaration and public box state, and denies boxes being destroyed or archived (`apps/api/src/box/services/tunnel.service.ts:40`).
- Resolve signed hosts before checking the declaration. Do not trust the initial public lookup for a signed token as the box's visibility.
- Parse host ports into one numeric form, so `022222` cannot bypass the terminal rule. Return 404 for a missing declaration and 502 when the tunnel check is unavailable.
- Cache both API verdicts for 3 seconds in Redis; clear a denial when declaring a port. Do not cache the tunnel verdict in the proxy.
- Keep the URL APIs compatible; the proxy is the enforcement boundary, including for URLs issued before this change.
- Update proxy and networking documentation and focused tests for direct, signed, private, terminal, and failed API access.

## Alternatives and trade-offs

Checking declarations only when issuing URLs would leave old or manually constructed URLs accessible and cannot enforce revocation. Disabling signed preview URL issuance would disrupt legitimate signed previews. Checking the API on each new request adds one control-plane call; its 3-second cache limits database reads but allows a recently revoked declaration to admit new requests until the cached allowance expires. Existing connections remain open.

## Validation

Reproduce the old bypass with the focused proxy tests, then rerun them with the fix. Cover direct, signed, private, terminal, canonical-port, and API-failure paths; verify API cache invalidation separately. Run the proxy and API suites through repository Make targets and confirm the final diff matches the documented behavior.
