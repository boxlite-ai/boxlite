import { createServer } from 'node:http'

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Hello from a BoxLite App!\n')
}).listen(Number(process.env.PORT || 3000), '0.0.0.0')
