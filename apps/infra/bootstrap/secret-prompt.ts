// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export function requireNonEmptySecret(label: string, value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

// node:readline has no masked-input mode. Keep secret entry on a TTY and force
// automation to use a dedicated environment variable instead of hanging.
export function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} has no value and stdin is not a TTY to prompt for one; set the matching env var instead`)
  }
  process.stdout.write(label)
  return new Promise((resolvePrompt, reject) => {
    const { stdin } = process
    stdin.resume()
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    let value = ''
    let settled = false

    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    // Raw mode delivers pasted text as one chunk, often including its newline.
    // Iterate characters so the terminator resolves the prompt without becoming
    // part of the stored secret.
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (settled) return
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            settled = true
            cleanup()
            process.stdout.write('\n')
            resolvePrompt(value)
            break
          case '\u0003':
            settled = true
            cleanup()
            process.stdout.write('\n')
            reject(new Error('interrupted'))
            break
          case '\u007f':
          case '\b':
            value = value.slice(0, -1)
            break
          default:
            value += char
        }
      }
    }

    stdin.on('data', onData)
  })
}
