import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE_URL = (__ENV.BOXLITE_API_URL || 'https://api.dev.boxlite.ai/api').replace(/\/$/, '')
const TOKEN = __ENV.BOXLITE_TOKEN || __ENV.BOXLITE_API_KEY || ''
const PREFIX = __ENV.BOXLITE_PREFIX || ''
const BOX_ID = __ENV.BOXLITE_BOX_ID || ''

const RATE_START = Number(__ENV.BOXLITE_STRESS_START_RATE || 10)
const RATE_1 = Number(__ENV.BOXLITE_STRESS_RATE_1 || 50)
const RATE_2 = Number(__ENV.BOXLITE_STRESS_RATE_2 || 100)
const RATE_3 = Number(__ENV.BOXLITE_STRESS_RATE_3 || 200)
const PREALLOCATED_VUS = Number(__ENV.BOXLITE_STRESS_PREALLOCATED_VUS || 50)
const MAX_VUS = Number(__ENV.BOXLITE_STRESS_MAX_VUS || 300)

export const options = {
  scenarios: {
    api_read: {
      executor: 'ramping-arrival-rate',
      startRate: RATE_START,
      timeUnit: '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: __ENV.BOXLITE_STRESS_STAGE_1 || '2m', target: RATE_1 },
        { duration: __ENV.BOXLITE_STRESS_STAGE_2 || '3m', target: RATE_2 },
        { duration: __ENV.BOXLITE_STRESS_STAGE_3 || '3m', target: RATE_3 },
        { duration: __ENV.BOXLITE_STRESS_RAMP_DOWN || '2m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: [`rate<${__ENV.BOXLITE_STRESS_MAX_FAILURE_RATE || '0.01'}`],
    http_req_duration: [
      `p(95)<${__ENV.BOXLITE_STRESS_P95_MS || '500'}`,
      `p(99)<${__ENV.BOXLITE_STRESS_P99_MS || '1500'}`,
    ],
  },
}

function authParams() {
  return TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {}
}

function checkStatus(name, response, statuses) {
  return check(response, {
    [`${name} ${statuses.join('/')}`]: (res) => statuses.includes(res.status),
  })
}

export function setup() {
  if (!TOKEN) {
    throw new Error('Set BOXLITE_TOKEN or BOXLITE_API_KEY for authenticated API stress checks.')
  }
  if (!PREFIX) {
    throw new Error('Set BOXLITE_PREFIX to the organization/path prefix returned by `boxlite auth whoami`.')
  }

  return { baseUrl: BASE_URL, prefix: PREFIX, boxId: BOX_ID, auth: authParams() }
}

export default function (cfg) {
  checkStatus('health', http.get(`${cfg.baseUrl}/health`), [200])
  checkStatus('config', http.get(`${cfg.baseUrl}/v1/config`), [200])
  checkStatus('me', http.get(`${cfg.baseUrl}/v1/me`, cfg.auth), [200])
  checkStatus('boxes list', http.get(`${cfg.baseUrl}/v1/${cfg.prefix}/boxes`, cfg.auth), [200])

  if (cfg.boxId) {
    checkStatus('box get', http.get(`${cfg.baseUrl}/v1/${cfg.prefix}/boxes/${cfg.boxId}`, cfg.auth), [200])
    checkStatus('box head', http.head(`${cfg.baseUrl}/v1/${cfg.prefix}/boxes/${cfg.boxId}`, cfg.auth), [204])
  }

  sleep(Number(__ENV.BOXLITE_STRESS_SLEEP_SECONDS || 1))
}
