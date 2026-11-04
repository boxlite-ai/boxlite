/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ListenerState } from './state/store'
import { Json, StateConflict, StateCorrupt } from './state/database'

export interface WakeHint {
  installationId: number
  accountId: number
  repositoryId: number
  job: { id: number; runId: number } | null
}
export class WebhookError extends Error {
  constructor(
    readonly status: 400 | 401 | 409,
    message: string,
  ) {
    super(message)
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

/** Event headers are unsigned. They must match a supported signed structure and never grant execution authority. */
export function ciWakeHint(event: string, value: unknown): WakeHint | null {
  if (!record(value)) throw new WebhookError(400, 'Invalid GitHub event body')
  const body = value
  if (event === 'workflow_job') {
    if (body.action !== 'queued') return null
    const job = body.workflow_job,
      repo = body.repository
    if (
      !record(job) ||
      !id(job.id) ||
      !id(job.run_id) ||
      job.status !== 'queued' ||
      !record(repo) ||
      !id(repo.id) ||
      !record(repo.owner) ||
      !id(repo.owner.id) ||
      !record(body.installation) ||
      !id(body.installation.id) ||
      !Array.isArray(job.labels) ||
      job.labels.length > 100 ||
      !job.labels.every((label: unknown) => typeof label === 'string' && label.length <= 128)
    )
      throw new WebhookError(400, 'Invalid workflow job notification')
    if (!job.labels.some((label) => typeof label === 'string' && label.toLowerCase() === 'boxlite-ci-runner'))
      return null
    return {
      installationId: body.installation.id,
      accountId: repo.owner.id,
      repositoryId: repo.id,
      job: { id: job.id, runId: job.run_id },
    }
  }
  const actions =
    event === 'installation'
      ? ['created', 'deleted', 'new_permissions_accepted', 'suspend', 'unsuspend']
      : event === 'installation_repositories'
        ? ['added', 'removed']
        : []
  if (!actions.some((action) => action === body.action)) return null
  if (
    !record(body.installation) ||
    !id(body.installation.id) ||
    !record(body.installation.account) ||
    !id(body.installation.account.id)
  )
    throw new WebhookError(400, 'Invalid installation notification')
  if (
    event === 'installation_repositories' &&
    ![body.repositories_added, body.repositories_removed].every(
      (repos) => Array.isArray(repos) && repos.every((repo) => record(repo) && id(repo.id)),
    )
  )
    throw new WebhookError(400, 'Invalid installation repository notification')
  return { installationId: body.installation.id, accountId: body.installation.account.id, repositoryId: 0, job: null }
}
export interface VerifiedWebhook {
  delivery: string
  digest: string
  event: string
  hint: WakeHint
}
export function verifyWebhook(
  input: { raw: Buffer; signature: string; delivery: string; event: string },
  secret: Buffer,
): VerifiedWebhook | null {
  const { raw, signature, event } = input
  if (!Buffer.isBuffer(raw) || raw.length > 1_048_576) throw new WebhookError(400, 'Raw webhook body required')
  if (secret.length < 32 || secret.length > 256) throw new Error('Invalid webhook secret configuration')
  if (
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(signature.slice(7), 'hex'))
  )
    throw new WebhookError(401, 'Invalid webhook signature')
  if (!/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(input.delivery))
    throw new WebhookError(400, 'Invalid delivery identifier')
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new WebhookError(400, 'Invalid webhook JSON')
  }
  const hint = ciWakeHint(event, value)
  return hint
    ? { delivery: input.delivery.toLowerCase(), digest: createHash('sha256').update(raw).digest('hex'), event, hint }
    : null
}

/** Both hosts use this inbox. Its database adapter must enforce the live binding in the ingress transaction. */
export class ListenerInbox {
  constructor(private readonly state: ListenerState) {}
  /** Request discovery only; this creates neither a delivery receipt nor an executable job notice. */
  async inventory(supplied: { installationId: number; accountId: number }): Promise<void> {
    const { installationId, accountId } = supplied
    if (!id(installationId) || !id(accountId)) throw new WebhookError(400, 'Invalid inventory identity')
    const key = `wake/${installationId}/0`
    for (let attempt = 0; attempt < 4; attempt++) {
      const [prior] = await this.state.read([key])
      if (
        prior &&
        (!record(prior.payload) ||
          prior.payload.installationId !== installationId ||
          prior.payload.accountId !== accountId ||
          prior.payload.repositoryId !== 0)
      )
        throw new StateCorrupt()
      try {
        await this.state.ingest([
          { key, expected: prior?.version ?? null, payload: { installationId, accountId, repositoryId: 0 } },
        ])
        return
      } catch (error) {
        if (!(error instanceof StateConflict) || attempt === 3) throw error
      }
    }
  }
  async receive(notification: VerifiedWebhook): Promise<'stored' | 'duplicate'> {
    const { digest, event, delivery } = notification,
      supplied = notification.hint
    const hint: WakeHint = {
      installationId: supplied.installationId,
      accountId: supplied.accountId,
      repositoryId: supplied.repositoryId,
      job: supplied.job ? { id: supplied.job.id, runId: supplied.job.runId } : null,
    }
    if (
      !['workflow_job', 'installation', 'installation_repositories'].includes(event) ||
      (event === 'workflow_job') !== (hint.job !== null)
    )
      throw new WebhookError(400, 'Unsupported notification event')
    // Revalidate even internal callers: compensation and HTTP hosts share this boundary.
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(delivery) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !id(hint.installationId) ||
      !id(hint.accountId) ||
      !Number.isSafeInteger(hint.repositoryId) ||
      hint.repositoryId < 0 ||
      !hint.job !== (hint.repositoryId === 0) ||
      (hint.job && (!id(hint.job.id) || !id(hint.job.runId)))
    )
      throw new WebhookError(400, 'Invalid verified notification')
    const receipt = `receipt/${delivery}`,
      wake = `wake/${hint.installationId}/${hint.repositoryId}`,
      notice = hint.job ? `notice/${hint.installationId}/${hint.job.id}` : undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      const rows = new Map(
        (await this.state.read([receipt, wake, ...(notice ? [notice] : [])])).map((row) => [row.key, row]),
      )
      const previous = rows.get(receipt)
      if (previous) {
        if (
          !record(previous.payload) ||
          typeof previous.payload.digest !== 'string' ||
          typeof previous.payload.event !== 'string'
        )
          throw new StateCorrupt()
        if (previous.payload.digest !== digest || previous.payload.event !== event)
          throw new WebhookError(409, 'Delivery identifier conflicts with a previous body or event')
        return 'duplicate'
      }
      const priorWake = rows.get(wake),
        priorNotice = notice ? rows.get(notice) : undefined
      if (
        priorWake &&
        (!record(priorWake.payload) ||
          priorWake.payload.installationId !== hint.installationId ||
          priorWake.payload.accountId !== hint.accountId ||
          priorWake.payload.repositoryId !== hint.repositoryId)
      )
        throw new StateCorrupt()
      if (
        priorNotice &&
        (!record(priorNotice.payload) ||
          priorNotice.payload.installationId !== hint.installationId ||
          priorNotice.payload.accountId !== hint.accountId ||
          priorNotice.payload.repositoryId !== hint.repositoryId ||
          !record(priorNotice.payload.job) ||
          priorNotice.payload.job.id !== hint.job!.id ||
          priorNotice.payload.job.runId !== hint.job!.runId)
      )
        throw new WebhookError(409, 'Job identity conflicts with a previous notification')
      try {
        await this.state.ingest([
          { key: receipt, expected: null, payload: { digest, event } },
          {
            key: wake,
            expected: priorWake?.version ?? null,
            payload: {
              installationId: hint.installationId,
              accountId: hint.accountId,
              repositoryId: hint.repositoryId,
            },
          },
          ...(notice
            ? [{ key: notice, expected: priorNotice?.version ?? null, payload: hint as unknown as Json }]
            : []),
        ])
        return 'stored'
      } catch (error) {
        if (!(error instanceof StateConflict) || attempt === 3) throw error
      }
    }
    throw new StateConflict()
  }
}
