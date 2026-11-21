import { connect, createServer, Server, Socket } from 'node:net'

/** Real PostgreSQL frames: drop COMMIT before delivery, or drop its server completion reply. */
export class PostgresCommitProxy {
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private fault?: 'before' | 'after'
  rejectConnections = false
  rejectAfterCut = false
  cuts = 0

  constructor(host: string, port: number) {
    this.server = createServer((client) => {
      if (this.rejectConnections) return client.destroy()
      const upstream = connect({ host, port })
      for (const socket of [client, upstream]) {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      }
      const close = () => {
        client.destroy()
        upstream.destroy()
      }
      const cut = () => {
        this.cuts++
        this.rejectConnections = this.rejectAfterCut
        if (this.rejectConnections) for (const socket of this.sockets) socket.destroy()
        close()
      }
      client.on('error', close)
      upstream.on('error', close)
      client.on('end', () => upstream.end())
      upstream.on('end', () => client.end())
      let startup = true
      let front = Buffer.alloc(0)
      let back = Buffer.alloc(0)
      let afterCommit = false
      client.on('data', (chunk) => {
        front = Buffer.concat([front, chunk])
        for (;;) {
          if (front.length < (startup ? 4 : 5)) return
          const length = front.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1)
          if (length < 4 || length > 1024 * 1024) return close()
          if (front.length < length) return
          const frame = front.subarray(0, length)
          front = front.subarray(length)
          if (!startup && frame[0] === 81 && frame.subarray(5).toString() === 'COMMIT\0' && this.fault) {
            const fault = this.fault
            this.fault = undefined
            if (fault === 'before') return cut()
            afterCommit = true
          }
          startup = false
          upstream.write(frame)
        }
      })
      upstream.on('data', (chunk) => {
        back = Buffer.concat([back, chunk])
        while (back.length >= 5) {
          const length = back.readUInt32BE(1) + 1
          if (length < 5 || length > 1024 * 1024) return close()
          if (back.length < length) return
          const frame = back.subarray(0, length)
          back = back.subarray(length)
          if (afterCommit && frame[0] === 67 && frame.subarray(5).toString() === 'COMMIT\0') return cut()
          client.write(frame)
        }
      })
    })
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing proxy address')
    return address.port
  }

  arm(fault: 'before' | 'after') {
    this.fault = fault
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
