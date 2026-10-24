// The error matrix's app (errors-live.mjs): healthy by default, and misbehaves on request the way
// real app code does, so the suite can check what the CLI tells an agent about each failure.
const http = require('node:http')
const hog = []
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/healthz') return res.end('ok')
  if (url.pathname === '/') return res.end('errors v' + (process.env.APP_VERSION ?? '1'))
  if (url.pathname === '/boom') throw new Error('boom-marker: cannot read the price of an empty cart')
  if (url.pathname === '/crash') {
    res.end('crashing')
    console.error('fatal: crash-marker, the payment queue is corrupt')
    return setTimeout(() => process.exit(1), 50)
  }
  if (url.pathname === '/oom') {
    res.end('allocating')
    const grow = () => { hog.push(Buffer.alloc(64 * 1024 * 1024, 1)); setImmediate(grow) }
    return grow()
  }
  if (url.pathname === '/jobs/fail') {
    console.error('job-marker: the digest job could not reach the mail provider')
    res.statusCode = 500
    return res.end('failed')
  }
  res.statusCode = 404
  res.end('not found')
})
process.on('uncaughtException', (err) => { console.error(err.stack); process.exit(1) })
server.listen(Number(process.env.PORT), '0.0.0.0')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
