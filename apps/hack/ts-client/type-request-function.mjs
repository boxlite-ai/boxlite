#!/usr/bin/env node
// Gives a generated client's createRequestFunction an explicit return type.
// axios 1.19 made an unexported `unique symbol` the default response type of
// request(), so the type the generator leaves to inference cannot be written
// into the declaration files the library builds emit (TS2527).
// openapi-generator 7.25.0 emits the same annotation
// (OpenAPITools/openapi-generator#24526); once openapitools.json pins it, this
// step finds nothing to patch, fails, and should be removed.
// Usage: type-request-function.mjs <src-dir>

import { readFileSync, writeFileSync } from 'node:fs'

const [srcDir] = process.argv.slice(2)

if (!srcDir) {
  console.error('Usage: type-request-function.mjs <src-dir>')
  process.exit(1)
}

const path = `${srcDir}/common.ts`
const edits = [
  ['basePath: string = BASE_PATH) => {', 'basePath: string = BASE_PATH): Promise<R> => {'],
  ['return axios.request<T, R>(axiosRequestArgs);', 'return axios.request<T, R>(axiosRequestArgs) as Promise<R>;'],
]

let source = readFileSync(path, 'utf8')
for (const [from, to] of edits) {
  if (source.split(from).length !== 2) {
    console.error(`${path}: expected one '${from}'; drop this step if the generator already types createRequestFunction`)
    process.exit(1)
  }
  source = source.replace(from, to)
}
writeFileSync(path, source)
