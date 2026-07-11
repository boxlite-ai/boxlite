#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import process from 'node:process'
import readline from 'node:readline'
import { promisify } from 'node:util'
import {
  assertMatchingStripeAccounts,
  assertMatchingWebhookSecrets,
  assertStripeSandboxSecrets,
  redactStripeSecrets,
  stripeListenArguments,
} from './billing-stripe-sandbox-config.mjs'

const execFileAsync = promisify(execFile)
const secretKey = process.env.STRIPE_SECRET_KEY
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
const forwardUrl = process.env.STRIPE_WEBHOOK_FORWARD_URL || 'http://localhost:3001/api/billing/webhooks/payment'

assertStripeSandboxSecrets(secretKey, webhookSecret)

const cliEnvironment = { ...process.env }
delete cliEnvironment.STRIPE_API_KEY
const [apiAccountId, cliAccountId, cliWebhookSecret] = await Promise.all([
  stripeAccountId({ ...cliEnvironment, STRIPE_API_KEY: secretKey }),
  stripeAccountId(cliEnvironment),
  stripeWebhookSecret(cliEnvironment),
])
assertStripeSandboxSecrets(secretKey, cliWebhookSecret)
assertMatchingStripeAccounts(apiAccountId, cliAccountId)
assertMatchingWebhookSecrets(webhookSecret, cliWebhookSecret)

const listener = spawn('stripe', stripeListenArguments(forwardUrl), {
  env: cliEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
})
pipeRedactedLines(listener.stdout, process.stdout)
pipeRedactedLines(listener.stderr, process.stderr)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => listener.kill(signal))
}

const exit = await new Promise((resolve, reject) => {
  listener.once('error', reject)
  listener.once('exit', (code, signal) => resolve({ code, signal }))
})
if (exit.code !== 0 && exit.signal !== 'SIGINT' && exit.signal !== 'SIGTERM') {
  throw new Error(`Stripe listener stopped unexpectedly (${exit.signal ?? `exit ${exit.code}`})`)
}

async function stripeAccountId(environment) {
  const { stdout } = await execFileAsync('stripe', ['get', '/v1/account', '--color', 'off'], {
    env: environment,
    maxBuffer: 1024 * 1024,
  })
  const account = JSON.parse(stdout)
  return account.id
}

async function stripeWebhookSecret(environment) {
  const { stdout } = await execFileAsync('stripe', ['listen', '--skip-update', '--print-secret', '--color', 'off'], {
    env: environment,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

function pipeRedactedLines(input, output) {
  const lines = readline.createInterface({ input })
  lines.on('line', (line) => output.write(`${redactStripeSecrets(line)}\n`))
}
