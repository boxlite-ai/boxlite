#!/usr/bin/env node
// Development only: an SMTP server on 127.0.0.1:2525 of the dev control plane's Box that accepts
// any login and keeps each message as a file, so the live e2e can sign in with email codes
// (e2e/email-live.mjs). Never part of a production control plane: the CP allows it as a sender only with SMTP_DEV_SINK=127.0.0.1:2525.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const DIR = process.env.SINK_DIR ?? '/home/boxlite/cp/data/smtp-sink'
const KEEP = 50
mkdirSync(DIR, { recursive: true })

createServer((sock) => {
  let buf = ''
  let to = ''
  let data = null
  let authStep = 0
  sock.setTimeout(30_000, () => sock.destroy())
  sock.write('220 dev-sink ESMTP\r\n')
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (data !== null) {
        if (line !== '.') { data += `${line}\n`; continue }
        const name = `${Date.now()}-${to.replace(/[^\w@.-]/g, '_')}.eml`
        writeFileSync(join(DIR, name), data)
        for (const old of readdirSync(DIR).sort().slice(0, -KEEP)) rmSync(join(DIR, old), { force: true })
        data = null
        sock.write('250 kept\r\n')
        continue
      }
      if (authStep > 0) { authStep = authStep === 1 ? 2 : 0; sock.write(authStep ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'); continue }
      if (/^(EHLO|HELO)/i.test(line)) sock.write('250-dev-sink\r\n250 AUTH PLAIN LOGIN\r\n')
      else if (/^AUTH PLAIN/i.test(line)) sock.write('235 ok\r\n')
      else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n') }
      else if (/^RCPT TO:/i.test(line)) { to = (/<([^>]*)>/.exec(line) ?? [])[1] ?? ''; sock.write('250 ok\r\n') }
      else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go\r\n') }
      else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n')
      else sock.write('250 ok\r\n')
    }
  })
  sock.on('error', () => {})
}).listen(2525, '127.0.0.1', () => console.log(`smtp sink on 127.0.0.1:2525 → ${DIR}`))
