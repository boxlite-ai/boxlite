import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite } from '@boxlite-ai/boxlite'

const apiKey = {{API_KEY_TS}}
if (!apiKey) {
  throw new Error('Set BOXLITE_API_KEY before running this script')
}

const rt = JsBoxlite.rest(
  new BoxliteRestOptions({
    url: process.env.BOXLITE_REST_URL ?? '{{REST_API_URL}}',
    credential: new ApiKeyCredential(apiKey),
  }),
)

const boxName = `sdk-quickstart-node-${Date.now()}`
const box = await rt.create(
  {
    image: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3',
  },
  boxName,
)
await box.start()

const exec = await box.exec('echo', ['Hello from BoxLite SDK'])
const stdout = await exec.stdout()
let output = ''
let chunk: string | null
while ((chunk = await stdout.next()) !== null) {
  output += chunk
}
const result = await exec.wait()
console.log('Exit code:', result.exitCode)
console.log(output)

await rt.remove(box.id, true)
