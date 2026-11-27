import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite } from '@boxlite-ai/boxlite'
import { SocketAddress } from 'node:net'

const apiKey = {{API_KEY_TS}}
if (!apiKey) throw new Error('Set BOXLITE_API_KEY before running this script')
const rt = JsBoxlite.rest(new BoxliteRestOptions({
url: process.env.BOXLITE_REST_URL ?? '{{REST_API_URL}}',
credential: new ApiKeyCredential(apiKey),
}))
const box = await rt.create({
image: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
network: { inbound: { mode: 'enabled' } },
}, `sdk-quickstart-node-${Date.now()}`)
console.log(`Created Box: ${box.id}`)
await box.start()
{{STEP_EXECUTION}}
const exec = await box.exec({{COMMAND_LITERAL}}, [{{ARGUMENT_LITERALS}}])
const stdout = await exec.stdout()
let output = ''
let chunk: string | null
while ((chunk = await stdout.next()) !== null) output += chunk
const result = await exec.wait()
console.log(output)
if (result.exitCode !== 0) throw new Error(`Command exited with ${result.exitCode}`)
{{STEP_PREVIEW}}
const serverCode = {{SERVER_TS}}
// Start the server without waiting for it to exit.
const server = await box.exec('python3', ['-u', '-c', serverCode])
const preview = await box.network.tunnel(new SocketAddress({ address: '127.0.0.1', port: 3000 }))
const url = preview.uri()
if (!url) throw new Error('Cloud did not return a preview URL')
console.log('Preview URL:', url)
