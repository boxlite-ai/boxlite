// The smallest app behind email code sign-in: /app greets the signed-in visitor by the platform's headers.
import http from 'node:http'

http
  .createServer((req, res) => {
    if (req.url === '/healthz') return res.end('ok')
    const email = req.headers['x-boxlite-user-email']
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(req.url.startsWith('/app') ? `hello ${email} via ${req.headers['x-boxlite-user-provider']}` : 'home')
  })
  .listen(Number(process.env.PORT), '0.0.0.0')
