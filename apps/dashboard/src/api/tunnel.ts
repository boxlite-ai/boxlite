/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
export interface TunnelDescriptor {
  uri: string
  isPublic: boolean
  token: string | null
}

export class TunnelRequestError extends Error {
  constructor(
    message: string,
    public readonly outcome: 'refused' | 'unknown' = 'refused',
  ) {
    super(message)
  }
}

/** Never carry the response or its secret into an error, log, or mutation cache. */
export function readTunnelDescriptor(value: unknown): TunnelDescriptor {
  const invalid = () =>
    new TunnelRequestError(
      'Could not confirm tunnel access. This port may be exposed. Revoke it to remove access.',
      'unknown',
    )
  if (!value || typeof value !== 'object') throw invalid()
  const result = value as Partial<TunnelDescriptor>
  if (typeof result.uri !== 'string') throw invalid()
  let url: URL
  try {
    url = new URL(result.uri)
  } catch {
    throw invalid()
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || result.isPublic !== true)
    throw invalid()
  if (result.token !== null) throw invalid()
  return { uri: result.uri, isPublic: true, token: null }
}

/** Classify the shared Axios wrapper without retaining request credentials or response data. */
export function tunnelOperationError(error: unknown, action: 'create' | 'revoke'): TunnelRequestError {
  if (error instanceof TunnelRequestError) return error
  const wrapped = error as {
    cause?: { response?: { status?: number } }
    response?: { status?: number }
    message?: string
  }
  const status = wrapped?.cause?.response?.status ?? wrapped?.response?.status
  if (status === 401 || status === 403)
    return new TunnelRequestError('You do not have permission to manage this tunnel.')
  if (status === 404) return new TunnelRequestError('This Box is no longer available.')
  if (status === 409) {
    if (wrapped.message?.includes('access mode differs'))
      return new TunnelRequestError(
        'This port already uses a different access mode. Revoke its tunnel before changing access.',
      )
    if (wrapped.message?.includes('inbound access disabled'))
      return new TunnelRequestError('Enable inbound access before creating a tunnel.')
    if (wrapped.message?.includes('not running'))
      return new TunnelRequestError('Start this Box before creating a tunnel.')
    return new TunnelRequestError('The Box cannot create a tunnel in its current state.')
  }
  if (status === 400) return new TunnelRequestError('Check the port and access settings, then try again.')
  return new TunnelRequestError(
    action === 'create'
      ? 'Could not confirm creation. This port may be exposed. Revoke it to remove access.'
      : 'Could not confirm revocation. Retry revoking this port.',
    'unknown',
  )
}
