#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repo = path.resolve(__dirname, '../../..')
const appsRequire = createRequire(path.join(repo, 'apps', 'package.json'))

let parseYaml
try {
  ;({ parse: parseYaml } = appsRequire('yaml'))
} catch (err) {
  console.error('Unable to load the apps workspace "yaml" dependency.')
  console.error('Run: make _ensure-apps-deps')
  console.error(String(err?.message || err))
  process.exit(2)
}

const specPath = path.join(repo, 'openapi', 'box.openapi.yaml')
const outDir = path.join(repo, 'target', 'rest-test-report')
const outMarkdown = path.join(outDir, 'rest-inventory.md')
const outJson = path.join(outDir, 'rest-inventory.json')
const httpMethods = new Set(['get', 'put', 'post', 'patch', 'delete', 'options', 'head', 'trace'])

const scanRoots = [
  'scripts/test/e2e/cases',
  'scripts/test/rest',
  'src/cli/tests',
  'apps/api/src/boxlite-rest',
]

const unsupportedOperations = {
  cloneBox: 'cloud REST controller does not expose clone; capability is false in /v1/config',
  createSnapshot: 'cloud REST controller does not expose snapshots; capability is false in /v1/config',
  listSnapshots: 'cloud REST controller does not expose snapshots; capability is false in /v1/config',
  getSnapshot: 'cloud REST controller does not expose snapshots; capability is false in /v1/config',
  removeSnapshot: 'cloud REST controller does not expose snapshots; capability is false in /v1/config',
  restoreSnapshot: 'cloud REST controller does not expose snapshots; capability is false in /v1/config',
  exportBox: 'cloud REST controller does not expose export; capability is false in /v1/config',
  importBox: 'cloud REST controller does not expose import; capability is false in /v1/config',
  pullImage: 'cloud REST controller does not expose image operations',
  listImages: 'cloud REST controller does not expose image operations',
  getImage: 'cloud REST controller does not expose image operations',
  imageExists: 'cloud REST controller does not expose image operations',
  getRuntimeMetrics: 'cloud REST controller exposes per-box metrics only, not runtime-wide metrics',
}

const operationSignals = {
  listBoxes: [/test_cli_ls_returns_table/, /test_list_info/, /findalldeprecated/, /toboxdtos/],
  createBox: [/test_create_named_box/, /test_create_generates_unique_ids/, /\.create\(/, /createbox/],
  removeBox: [/test_remove_nonexistent/, /remove_unknown/, /\.remove\(/, /removebox/],
  getBox: [/test_get_info/, /get_info_returns/, /getbox/],
  boxExists: [/\bexists\(/, /boxexists/, /head.*boxes/],
  cloneBox: [/clonebox/, /\.clone\(/, /\/clone\b/],
  startExecution: [/test_.*exec/, /\.exec\(/, /proxyexec/, /startexecution/],
  killExecution: [/killexecution/, /test_exec_timeout/, /\bkill\b/],
  getExecution: [/getexecution/, /status.*execution/, /test_exec_result_shape/],
  attachExecution: [/attachexecution/, /test_reattach/, /matchattachpath/, /\battach\b/],
  resizeExecution: [/resizeexecution/, /test_resize/],
  signalExecution: [/signalexecution/, /\/signal\b/],
  exportBox: [/exportbox/, /\.export\(/, /\/export\b/],
  downloadFiles: [/downloadfiles/, /test_copy_out/, /copy_out/],
  uploadFiles: [/uploadfiles/, /test_copy_in/, /copy_in/],
  getBoxMetrics: [/getboxmetrics/, /box metrics/, /\/metrics\b/, /proxymetrics/, /stats --format/, /stats box/],
  listSnapshots: [/listsnapshots/, /snapshots\(\)\.list/, /\/snapshots\b/],
  createSnapshot: [/createsnapshot/, /snapshots\(\)\.create/, /snapshot\.create/],
  removeSnapshot: [/removesnapshot/, /snapshots\(\)\.remove/, /snapshot\.remove/],
  getSnapshot: [/getsnapshot/, /snapshots\(\)\.get/, /snapshot\.get/],
  restoreSnapshot: [/restoresnapshot/, /snapshots\(\)\.restore/, /restore_snapshot/],
  startBox: [/startbox/, /\.start\(/, /test_.*start/, /start box/],
  stopBox: [/stopbox/, /\.stop\(/, /test_.*stop/, /stop box/],
  importBox: [/importbox/, /\.import\(/, /\/import\b/],
  listImages: [/listimages/, /images\(\)\.list/, /\/images\b/],
  getImage: [/getimage/, /images\(\)\.get/, /\/images\/\{/],
  imageExists: [/imageexists/, /images\(\)\.exists/],
  pullImage: [/pullimage/, /image_pull_failed/, /images\(\)\.pull/],
  getRuntimeMetrics: [/getruntimemetrics/, /runtime metrics/, /\/metrics\b/],
  getConfig: [/getconfig/, /get \/config/, /\/config\b/, /fetch.*config/],
  getCurrentPrincipal: [/getcurrentprincipal/, /\bwhoami\b/, /\/v1\/me\b/, /\/me\b/],
}

function main() {
  const spec = parseYaml(fs.readFileSync(specPath, 'utf8'))
  const operations = collectOperations(spec)
  const testFiles = collectTestFiles()
  const rows = operations.map((operation) => classifyOperation(operation, testFiles))

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outJson, `${JSON.stringify(rows, null, 2)}\n`)
  fs.writeFileSync(outMarkdown, renderMarkdown(rows))

  const summary = summarize(rows)
  console.log(outMarkdown)
  console.log(
    `REST spec operations: ${summary.total}; active: ${summary.active}; ` +
      `candidates: ${summary.candidate}; missing: ${summary.missing}; unsupported: ${summary.unsupported}`,
  )
}

function collectOperations(spec) {
  const paths = spec?.paths || {}
  const operations = []
  for (const [apiPath, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods || {})) {
      if (!httpMethods.has(method)) continue
      operations.push({
        method: method.toUpperCase(),
        path: apiPath,
        operationId: String(operation?.operationId || ''),
        tags: Array.isArray(operation?.tags) ? operation.tags.map(String) : [],
        summary: String(operation?.summary || ''),
      })
    }
  }
  return operations.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))
}

function collectTestFiles() {
  const files = []
  for (const root of scanRoots) {
    const absRoot = path.join(repo, root)
    if (!fs.existsSync(absRoot)) continue
    const isRestTestUtility = root === 'scripts/test/rest'
    for (const file of walk(absRoot)) {
      if (!/\.(py|rs|ts|sh|md)$/.test(file)) continue
      if (isRestTestUtility && path.basename(file) !== 'run_cli_matrix.sh') continue
      if (!isRestTestUtility && !/(^|[./_-])(test|spec|auth|e2e)/.test(path.basename(file))) continue
      const rel = path.relative(repo, file).split(path.sep).join('/')
      files.push({
        path: rel,
        text: fs.readFileSync(file, 'utf8').toLowerCase(),
      })
    }
  }
  return files
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else {
      yield full
    }
  }
}

function classifyOperation(operation, testFiles) {
  if (unsupportedOperations[operation.operationId]) {
    return {
      ...operation,
      signals: [],
      status: 'unsupported',
      unsupportedReason: unsupportedOperations[operation.operationId],
      candidateTests: [],
    }
  }

  const signals = operationSignals[operation.operationId] || fallbackSignals(operation)
  const candidateTests = []
  for (const file of testFiles) {
    const hits = signals
      .filter((signal) => signal.test(file.text))
      .map((signal) => signal.source)
    if (hits.length > 0) {
      candidateTests.push({
        file: file.path,
        hits: [...new Set(hits)].sort(),
      })
    }
  }

  const status = candidateTests.length > 0 ? 'candidate' : 'missing'
  return {
    ...operation,
    signals: signals.map((signal) => signal.source),
    status,
    candidateTests,
  }
}

function fallbackSignals(operation) {
  const escapedOperationId = escapeRegExp(operation.operationId.toLowerCase())
  const escapedPath = escapeRegExp(operation.path.toLowerCase())
  return [new RegExp(escapedOperationId), new RegExp(escapedPath)]
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderMarkdown(rows) {
  const summary = summarize(rows)
  const lines = [
    '# REST API Coverage Inventory',
    '',
    'This report is generated from `openapi/box.openapi.yaml` and candidate test files.',
    '`candidate` means test evidence exists, not that the operation is fully asserted; `unsupported` means the current cloud REST controller does not expose the operation.',
    '',
    `- Spec operations: ${summary.total}`,
    `- Active operations: ${summary.active}`,
    `- Candidate coverage: ${summary.candidate}`,
    `- Missing active candidates: ${summary.missing}`,
    `- Unsupported / stale spec operations: ${summary.unsupported}`,
    '',
    '| Method | Path | operationId | Status | Evidence / reason |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    const evidence = row.status === 'unsupported'
      ? row.unsupportedReason
      : row.candidateTests
        .map((candidate) => `${candidate.file} (${candidate.hits.join(', ')})`)
        .join('<br>')
    lines.push(
      `| ${row.method} | \`${row.path}\` | \`${row.operationId || ''}\` | ${row.status} | ${evidence} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function summarize(rows) {
  const total = rows.length
  const candidate = rows.filter((row) => row.status === 'candidate').length
  const unsupported = rows.filter((row) => row.status === 'unsupported').length
  const missing = rows.filter((row) => row.status === 'missing').length
  return {
    total,
    active: total - unsupported,
    candidate,
    missing,
    unsupported,
  }
}

main()
