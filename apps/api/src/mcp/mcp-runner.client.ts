/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Injectable, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import WebSocket from 'ws'
import { Box } from '../box/entities/box.entity'
import { RunnerService } from '../box/services/runner.service'

export interface McpCommand {
  box_id: string
  command: string
  args: string[]
  working_dir?: string
  timeout_seconds: number
}

@Injectable()
export class McpRunnerClient {
  constructor(private readonly runners: RunnerService) {}

  async start(box: Box, command: McpCommand, signal: AbortSignal): Promise<string> {
    const target = await this.target(box, '/exec')
    const { data } = await axios.post(
      target.url,
      {
        command: command.command,
        args: command.args,
        working_dir: command.working_dir,
        timeout_seconds: command.timeout_seconds,
        tty: false,
      },
      { headers: target.headers, signal, timeout: 15000, maxRedirects: 0, maxContentLength: 16384 },
    )
    if (typeof data.execution_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.execution_id)) {
      throw new Error('Invalid runner execution response')
    }
    return data.execution_id
  }

  async cancel(box: Box, executionId: string): Promise<void> {
    const target = await this.target(box, `/executions/${encodeURIComponent(executionId)}`)
    await axios.delete(target.url, { headers: target.headers, timeout: 5000, maxRedirects: 0, maxContentLength: 16384 })
  }

  async status(box: Box, executionId: string): Promise<{ status: string; exit_code?: number }> {
    const target = await this.target(box, `/executions/${encodeURIComponent(executionId)}`)
    const { data } = await axios.get(target.url, {
      headers: target.headers,
      timeout: 5000,
      maxRedirects: 0,
      maxContentLength: 16384,
    })
    if (
      !['running', 'completed', 'killed', 'timed_out'].includes(data.status) ||
      (data.exit_code !== undefined && !Number.isInteger(data.exit_code))
    )
      throw new Error('Invalid runner status')
    return data
  }

  async collect(
    box: Box,
    executionId: string,
    signal: AbortSignal,
    receive: (stream: 'stdout' | 'stderr', bytes: Buffer) => Promise<void>,
  ): Promise<number> {
    const target = await this.target(box, `/executions/${encodeURIComponent(executionId)}/attach`)
    const url = new URL(target.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (signal.aborted) throw new Error('Collector stopped')
    return new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: target.headers,
        handshakeTimeout: 5000,
        maxPayload: 1024 * 1024,
        followRedirects: false,
      })
      let queuedBytes = 0
      let finished = false
      let exited = false
      let pending = Promise.resolve()
      const finish = (error?: Error, code?: number) => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        socket.terminate()
        if (error) reject(error)
        else resolve(code!)
      }
      const abort = () => finish(new Error('Collector stopped'))
      signal.addEventListener('abort', abort, { once: true })
      socket.on('error', () => finish(new Error('Runner attach unavailable')))
      socket.on('close', () => {
        void pending.finally(() => {
          if (!exited) finish(new Error('Runner attach ended without exit'))
        })
      })
      socket.on('message', (data, binary) => {
        if (finished || exited) return
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        queuedBytes += bytes.length
        if (queuedBytes > 1024 * 1024) return finish(new Error('Collector backpressure exceeded'))
        socket.pause()
        pending = pending
          .then(async () => {
            if (finished) return
            if (binary) {
              if (bytes[0] !== 1 && bytes[0] !== 2) throw new Error('Invalid runner output stream')
              await receive(bytes[0] === 1 ? 'stdout' : 'stderr', bytes.subarray(1))
            } else {
              const frame = JSON.parse(bytes.toString())
              if (frame.type !== 'exit' || !Number.isInteger(frame.exit_code))
                throw new Error('Invalid runner control frame')
              exited = true
              finish(undefined, frame.exit_code)
            }
            queuedBytes -= bytes.length
            if (!finished && queuedBytes === 0) socket.resume()
          })
          .catch(() => finish(new Error('Runner output collection failed')))
      })
    })
  }

  private async target(box: Box, suffix: string): Promise<{ url: string; headers: Record<string, string> }> {
    if (!box.runnerId) throw new NotFoundException('Box has no runner')
    const runner = await this.runners.findOne(box.runnerId)
    const address = runner?.apiUrl || runner?.proxyUrl
    if (!address || !runner?.apiKey) throw new NotFoundException('Runner unavailable')
    const url = new URL(address)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid runner route')
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/boxes/${encodeURIComponent(box.id)}${suffix}`
    return { url: url.href, headers: { authorization: `Bearer ${runner.apiKey}` } }
  }
}
