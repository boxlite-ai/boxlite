import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The host loads the mod as ESM even though this repository defaults to CommonJS.
const source = readFileSync(new URL('../../../plugins/boxlite-claude/hooks/transfer.js', import.meta.url))
const {register} = await import('data:text/javascript;base64,' + source.toString('base64'))
let download
register((event, filter, handler) => {
  if (event === 'tool.run' && filter.tool === 'mcp__boxlite__download') download = handler
  return Promise.resolve()
})

const args = {connection: 'fixture', box_id: 'box', remote_source: '/src', local_destination: '/dest'}
for (const [reply, hint] of [
  [{structuredContent: {statusCode: 403, message: 'private detail'}}, /write:boxes/],
  [{structuredContent: {error: {code: 'not_found', message: 'private detail'}}}, /Box ID/],
  [{content: [{type: 'text', text: 'private detail'}]}, /completion is unknown/],
]) {
  const host = {
    plugin: {root: '.'},
    process: {spawn: () => ({next: async () => ({done: true, value: {code: 0}}), return: async () => {}})},
    mcp: {call: async () => ({isError: true, ...reply})},
  }
  const {deny} = await download(host, args)
  assert.match(deny, hint)
  assert.doesNotMatch(deny, /private detail/)
}
