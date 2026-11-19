import { createServer } from 'node:http'

createServer((request, response) => {
  if (request.method === 'GET' && request.url.split('?')[0] === '/api/version') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ version: 'v3' }))
    return
  }

  response.writeHead(404).end('Not found\n')
}).listen(Number(process.env.PORT || 3000), '0.0.0.0')
