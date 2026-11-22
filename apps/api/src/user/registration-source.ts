export const REGISTRATION_SOURCE_HEADER = 'X-BoxLite-Registration-Source'

export interface RegistrationSource {
  referring_domain: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
}

/** Attribution is optional client input and must never prevent account creation. */
export function parseRegistrationSource(header?: string): RegistrationSource | null {
  if (!header || header.length > 768) return null
  try {
    const input = JSON.parse(header)
    const host = input.referring_domain
    if (typeof host !== 'string' || !host || host.length > 253) return null
    if (host !== 'direct/unknown' && new URL('https://' + host).hostname !== host) return null

    const source: RegistrationSource = { referring_domain: host }
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign'] as const) {
      const value = input[key]
      if (typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value)) source[key] = value
    }
    return source
  } catch {
    return null
  }
}
