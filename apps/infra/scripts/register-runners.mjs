// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Post-deploy registration of extra runners with the control plane.
 *
 * The API only auto-seeds the single default runner (from DEFAULT_RUNNER_*), so
 * additional runners declared via RUNNERS must be registered through the admin
 * API. This script is invoked by the `RegisterExtraRunners` command in
 * sst.config.ts after the extra runner EC2s and the API service are up.
 *
 * Pairing is token-based: the runner row's apiKey must equal the
 * BOXLITE_RUNNER_TOKEN baked into the matching EC2's user-data. SST mints one
 * token per runner and passes the (name, token) pairs here via RUNNERS.
 *
 * Idempotent: a 409 (runner already exists in the region) is treated as
 * success, so redeploys are safe.
 *
 * Env:
 *   API_URL        base URL of the API service (e.g. https://api.example.com)
 *   ADMIN_API_KEY  admin-scoped API key (Bearer) for POST /api/admin/runners
 *   REGION_ID      region to register the runners in (default "us")
 *   RUNNERS        JSON array of { name, apiKey }
 */

const { API_URL, ADMIN_API_KEY, REGION_ID = 'us', RUNNERS } = process.env

const runners = JSON.parse(RUNNERS || '[]')
if (runners.length === 0) {
  process.exit(0)
}
if (!API_URL || !ADMIN_API_KEY) {
  console.error('register-runners: API_URL and ADMIN_API_KEY are required')
  process.exit(1)
}

const base = API_URL.replace(/\/+$/, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Wait for the API to start serving. /api/health returns 200 only after the
// HTTP server is listening, which (in onApplicationBootstrap) is after the
// default region and admin user have been seeded — both prerequisites for the
// admin POST below.
async function waitForApi() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await sleep(5000)
  }
  throw new Error(`register-runners: ${base}/api/health not ready after 5 minutes`)
}

async function register({ name, apiKey }) {
  const res = await fetch(`${base}/api/admin/runners`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_API_KEY}`,
    },
    body: JSON.stringify({ name, apiKey, apiVersion: '2', regionId: REGION_ID }),
  })

  if (res.status === 201) {
    console.log(`register-runners: ${name} registered`)
    return
  }
  if (res.status === 409) {
    console.log(`register-runners: ${name} already registered`)
    return
  }
  const body = await res.text().catch(() => '')
  throw new Error(`register-runners: ${name} failed (${res.status}): ${body}`)
}

await waitForApi()
for (const runner of runners) {
  await register(runner)
}
console.log(`register-runners: done (${runners.length} runner(s))`)
