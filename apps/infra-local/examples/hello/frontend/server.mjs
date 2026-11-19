import { lookup } from 'node:dns'
import { createServer, get } from 'node:http'
import { json } from 'node:stream/consumers'

const backendUrl = new URL(process.env.BACKEND_URL)

async function readVersion() {
  const upstream = await new Promise((resolve, reject) => {
    get(backendUrl, {
      // Inside a Box, dial the host proxy while preserving the App domain in the Host header.
      lookup: (hostname, options, callback) => lookup(process.env.LOCAL_PROXY_HOST || hostname, options, callback),
      signal: AbortSignal.timeout(5000),
    }, resolve).on('error', reject)
  })
  if (upstream.statusCode !== 200) {
    upstream.resume()
    throw new Error(`HTTP ${upstream.statusCode} from ${backendUrl}`)
  }
  const { version } = await json(upstream)
  if (typeof version !== 'string' || !version) throw new Error('Expected a version string')
  return version
}

createServer(async (request, response) => {
  const path = request.url.split('?')[0]
  if (request.method === 'GET' && path === '/healthz') {
    response.writeHead(200).end('ok\n')
    return
  }
  if (request.method !== 'GET' || path !== '/') {
    response.writeHead(404).end('Not found\n')
    return
  }

  try {
    const version = await readVersion()
    const text = version.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hello from a BoxLite App!</title>
<main>
  <h1>Hello from a BoxLite App!</h1>
  <p>Version: ${text}</p>
</main>
</html>
`)
  } catch (error) {
    console.error('Could not fetch the backend version:', error.message)
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('Backend version unavailable\n')
  }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0')
