import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE_URL = (__ENV.BOXLITE_API_URL || 'https://api.dev.boxlite.ai/api').replace(/\/$/, '')
const TOKEN = __ENV.BOXLITE_TOKEN || __ENV.BOXLITE_API_KEY || ''
const PREFIX = __ENV.BOXLITE_PREFIX || ''
const IMAGE = __ENV.BOXLITE_STRESS_IMAGE || 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'
const NAME_PREFIX = __ENV.BOXLITE_STRESS_NAME_PREFIX || 'stress-api-vm'
const CLEANUP = (__ENV.BOXLITE_STRESS_CLEANUP || '1') !== '0'

const RUNNER_CPUS = Number(__ENV.BOXLITE_STRESS_RUNNER_CPUS || 0)
const VM_LIMIT = Number(__ENV.BOXLITE_STRESS_VM_LIMIT || 2)
const HARD_LIMIT_MULTIPLIER = Number(__ENV.BOXLITE_STRESS_VM_LIMIT_MULTIPLIER || 8)
const VUS = Number(__ENV.BOXLITE_STRESS_VUS || VM_LIMIT)
const DURATION = __ENV.BOXLITE_STRESS_DURATION || '2m'
const HOLD_SECONDS = Number(__ENV.BOXLITE_STRESS_HOLD_SECONDS || 30)
const WAIT_RUNNING_MS = Number(__ENV.BOXLITE_STRESS_WAIT_RUNNING_MS || 120000)
const POLL_SECONDS = Number(__ENV.BOXLITE_STRESS_POLL_SECONDS || 2)

if (RUNNER_CPUS > 0 && VM_LIMIT > RUNNER_CPUS * HARD_LIMIT_MULTIPLIER) {
  throw new Error(
    `BOXLITE_STRESS_VM_LIMIT=${VM_LIMIT} exceeds runner hard limit ${RUNNER_CPUS * HARD_LIMIT_MULTIPLIER} ` +
      `(${RUNNER_CPUS} CPUs * ${HARD_LIMIT_MULTIPLIER}).`,
  )
}

if (VUS > VM_LIMIT) {
  throw new Error(`BOXLITE_STRESS_VUS=${VUS} must be <= BOXLITE_STRESS_VM_LIMIT=${VM_LIMIT}.`)
}

export const options = {
  scenarios: {
    vm_lifecycle: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: __ENV.BOXLITE_STRESS_GRACEFUL_STOP || '2m',
    },
  },
  thresholds: {
    http_req_failed: [`rate<${__ENV.BOXLITE_STRESS_MAX_FAILURE_RATE || '0.05'}`],
    http_req_duration: [
      `p(95)<${__ENV.BOXLITE_STRESS_P95_MS || '60000'}`,
      `p(99)<${__ENV.BOXLITE_STRESS_P99_MS || '90000'}`,
    ],
  },
}

function authParams(timeout = __ENV.BOXLITE_STRESS_CREATE_TIMEOUT || '90s') {
  return {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout,
  }
}

function nameForIteration() {
  return `${NAME_PREFIX}-${__VU}-${__ITER}-${Date.now()}`
}

function jsonValue(res, path) {
  try {
    return res.json(path)
  } catch {
    return null
  }
}

function waitForRunning(cfg, boxId) {
  const deadline = Date.now() + WAIT_RUNNING_MS

  while (Date.now() <= deadline) {
    const info = http.get(`${cfg.baseUrl}/v1/${cfg.prefix}/boxes/${boxId}`, authParams('30s'))
    const status = jsonValue(info, 'status')

    check(info, {
      'poll vm box 200/404': (res) => res.status === 200 || res.status === 404,
    })

    if (info.status === 200 && status === 'running') {
      return true
    }
    if (info.status >= 400 && info.status !== 404) {
      return false
    }

    sleep(POLL_SECONDS)
  }

  return false
}

export function setup() {
  if (!TOKEN) {
    throw new Error('Set BOXLITE_TOKEN or BOXLITE_API_KEY for authenticated API stress checks.')
  }
  if (!PREFIX) {
    throw new Error('Set BOXLITE_PREFIX to the organization/path prefix returned by `boxlite auth whoami`.')
  }

  return { baseUrl: BASE_URL, prefix: PREFIX }
}

export default function (cfg) {
  const name = nameForIteration()
  let boxId = null

  try {
    const body = JSON.stringify({
      name,
      image: IMAGE,
      cpus: Number(__ENV.BOXLITE_STRESS_CPUS || 1),
      memory_mib: Number(__ENV.BOXLITE_STRESS_MEMORY_MIB || 256),
      disk_size_gb: Number(__ENV.BOXLITE_STRESS_DISK_SIZE_GB || 1),
      auto_remove: true,
      detach: true,
    })

    const create = http.post(`${cfg.baseUrl}/v1/${cfg.prefix}/boxes`, body, authParams())
    const createdBoxId = jsonValue(create, 'box_id')
    check(create, {
      'create vm box 201': (res) => res.status === 201,
      'create vm box returns box_id': () => Boolean(createdBoxId),
    })

    boxId = createdBoxId || name
    if (create.status !== 201 || !createdBoxId) {
      return
    }

    const running = waitForRunning(cfg, boxId)
    check({ running }, {
      'vm box reached running': (result) => result.running,
    })
    if (!running) {
      return
    }

    sleep(HOLD_SECONDS)
  } finally {
    if (boxId && CLEANUP) {
      const remove = http.del(`${cfg.baseUrl}/v1/${cfg.prefix}/boxes/${boxId}`, null, authParams('60s'))
      check(remove, {
        'delete vm box 204/404': (res) => res.status === 204 || res.status === 404,
      })
    }
  }
}
