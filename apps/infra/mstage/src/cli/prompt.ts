/**
 * Asking the operator a yes/no question.
 *
 * Every sign-in mstage can start opens a browser, so it cannot complete
 * unattended and is offered only where there is someone to guide. CI supplies
 * credentials through OIDC instead, and a prompt there hangs the job.
 */

import { createInterface } from 'node:readline/promises'

export type Confirm = (question: string) => Promise<boolean>

export const isInteractive = (stream: { isTTY?: boolean } = process.stdin): boolean => Boolean(stream.isTTY)

export const confirm: Confirm = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

/**
 * The value for `env set KEY=` when the assignment leaves it empty.
 *
 * Matches `sst secret set` (cmd/sst/secret.go:335-362): a terminal is prompted
 * for one line with its newline stripped, a redirect is read whole. The file's
 * trailing newline is kept because SST keeps it, and both write one object.
 */
export const readValue = async (stream: NodeJS.ReadStream = process.stdin): Promise<string> => {
  if (stream.isTTY) {
    const rl = createInterface({ input: stream, output: process.stdout })
    try {
      return await rl.question('Enter value: ')
    } finally {
      rl.close()
    }
  }
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

/**
 * Whatever a redirect carries, or nothing when there is no redirect. Unlike
 * `readValue`, a terminal must answer "nothing" rather than wait for a JSON
 * object the caller never meant to type.
 */
export const readRedirect = async (stream: NodeJS.ReadStream = process.stdin): Promise<string> => {
  if (stream.isTTY) return ''
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}
