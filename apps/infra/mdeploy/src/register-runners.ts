// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Post-deploy registration of the hosts the API does not seed itself.
 *
 * The API seeds one runner row at boot from `DEFAULT_RUNNER_*`; every host
 * beyond the first has no row, and a host with no row is answered 401 on every
 * poll, sync and health-check it makes. `stack/runner-registration.ts` says why
 * this runs at all and builds what it is handed; this is the half that talks to
 * the control plane.
 *
 * Invoked by the `RegisterExtraRunners` command each provider creates, through
 * the `.mjs` shim whose path the engine's state records.
 *
 * Idempotent by design: a 409 means the row is already there, which is the
 * ordinary case on every redeploy after the first. A 429 or 5xx is transient —
 * the API answered `/api/health` but a single request can still blip — so it is
 * retried with a growing pause. Any other 4xx is a real client error that no
 * retry fixes, so it fails immediately and names the status.
 *
 * Env:
 *   API_URL        base URL of the API service
 *   ADMIN_API_KEY  admin-scoped key for POST /api/admin/runners
 *   REGION_ID      region to register the hosts in (default "us")
 *   RUNNERS        JSON array of { name, apiKey }
 */

const { API_URL, ADMIN_API_KEY, REGION_ID = 'us', RUNNERS } = process.env

type Registration = { name: string; apiKey: string }

const runners: Registration[] = JSON.parse(RUNNERS || '[]')
// A single-host fleet is complete without this, so nothing to do is a success.
if (runners.length === 0) process.exit(0)

if (!API_URL || !ADMIN_API_KEY) {
  console.error('register-extra-runners: API_URL and ADMIN_API_KEY are required')
  process.exit(1)
}

const base = API_URL.replace(/\/+$/, '')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const REQUEST_TIMEOUT_MS = 10_000
const MAX_ATTEMPTS = 4
const isRetryable = (status: number) => status === 429 || status >= 500

/*
 * Wait for the API to serve before posting.
 *
 * `/api/health` answers 200 only once the HTTP server is listening, which in
 * `onApplicationBootstrap` is after the default region and the admin user are
 * seeded — and both are prerequisites for the admin POST below. Five minutes,
 * because a cold Cloud Run revision or a fresh ECS task can take minutes.
 */
const waitForApi = async (): Promise<void> => {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const answer = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (answer.ok) return
    } catch {
      // Not up yet. The bound below is what turns this into a failure.
    }
    await sleep(5000)
  }
  throw new Error(`register-extra-runners: ${base}/api/health not ready after 5 minutes`)
}

const register = async ({ name, apiKey }: Registration): Promise<void> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let answer: Response
    try {
      answer = await fetch(`${base}/api/admin/runners`, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_API_KEY}` },
        body: JSON.stringify({ name, apiKey, apiVersion: '2', regionId: REGION_ID }),
      })
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`register-extra-runners: ${name} failed (network)`, { cause })
      }
      await sleep(attempt * 2000)
      continue
    }

    if (answer.status === 201) {
      console.log(`register-extra-runners: ${name} registered`)
      return
    }
    // Already there, which every redeploy after the first will say.
    if (answer.status === 409) {
      console.log(`register-extra-runners: ${name} already registered`)
      return
    }
    if (isRetryable(answer.status) && attempt < MAX_ATTEMPTS) {
      console.warn(`register-extra-runners: ${name} attempt ${attempt} got ${answer.status}; retrying`)
      await sleep(attempt * 2000)
      continue
    }
    // No body in the message: a 4xx from this endpoint can echo the payload,
    // and the payload is a runner's key.
    throw new Error(`register-extra-runners: ${name} failed (${answer.status})`)
  }
}

await waitForApi()
for (const runner of runners) await register(runner)
console.log(`register-extra-runners: done (${runners.length} host(s))`)
