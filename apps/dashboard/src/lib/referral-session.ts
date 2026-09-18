export type RegistrationSource = 'link' | 'direct'
export type RegistrationIdentity = { issuer: string; userId: string }
export type RegistrationDraft = {
  contextId: string
  source: RegistrationSource
  referredCode?: string
  confirmed: true
  createdAt: number
  identity?: RegistrationIdentity
  rejected?: boolean
  blocked?: string
}
export const REGISTRATION_STORAGE_KEY = 'boxlite.registration'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/

export function parseRegistrationLink(search: string): Pick<RegistrationDraft, 'source' | 'referredCode'> {
  const query = new URLSearchParams(search)
  if ([...query.keys()].some((key) => key.startsWith('referredCode['))) {
    throw new Error('This invitation link is invalid. Open a new invitation link.')
  }
  if (!query.has('referredCode')) return { source: 'direct' }
  const codes = query.getAll('referredCode')
  const code = codes[0]?.trim().toUpperCase()
  if (codes.length !== 1 || !code || !CODE.test(code))
    throw new Error('This invitation link is invalid. Open a new invitation link.')
  return { source: 'link', referredCode: code }
}

export class RegistrationSession {
  constructor(private readonly storage: () => Storage = () => window.sessionStorage) {}

  hasContext(): boolean {
    return this.storage().getItem(REGISTRATION_STORAGE_KEY) !== null
  }

  read(): RegistrationDraft | null {
    const raw = this.storage().getItem(REGISTRATION_STORAGE_KEY)
    if (!raw) return null
    let draft: RegistrationDraft
    try {
      draft = JSON.parse(raw)
    } catch {
      throw new Error('Registration context is unreadable. Reopen your invitation link.')
    }
    if (draft.blocked) throw new Error(draft.blocked)
    if (
      !draft.contextId ||
      draft.confirmed !== true ||
      !Number.isFinite(draft.createdAt) ||
      draft.createdAt > Date.now() ||
      Date.now() - draft.createdAt >= MAX_AGE_MS ||
      !['link', 'direct'].includes(draft.source) ||
      (draft.source === 'link' && (!draft.referredCode || !CODE.test(draft.referredCode))) ||
      (draft.source === 'direct' && draft.referredCode !== undefined)
    ) {
      throw new Error(
        'Registration context expired or is invalid. Reopen your invitation link or restart registration.',
      )
    }
    return draft
  }

  prepare(input: Pick<RegistrationDraft, 'source' | 'referredCode'>): RegistrationDraft {
    let previous: RegistrationDraft | null = null
    try {
      previous = this.read()
    } catch {
      /* Explicitly starting from a new valid link can replace an unusable context. */
    }
    if (previous && !previous.rejected) {
      if (previous.source !== input.source || previous.referredCode !== input.referredCode) {
        throw new Error('A registration is already in progress. Retry the original invitation.')
      }
      return previous
    }
    const draft: RegistrationDraft = {
      ...input,
      contextId: crypto.randomUUID(),
      confirmed: true,
      createdAt: Date.now(),
    }
    this.write(draft)
    return draft
  }

  oidcState(draft: RegistrationDraft) {
    return { registrationContextId: draft.contextId, registrationSource: draft.source, returnTo: '/register?resume=1' }
  }

  restore(state: unknown, identity: RegistrationIdentity): boolean {
    const callback = state as
      | { registrationContextId?: string; registrationSource?: string; returnTo?: string }
      | undefined
    if (
      !callback?.registrationContextId &&
      !callback?.registrationSource &&
      !callback?.returnTo?.startsWith('/register') &&
      !this.hasContext()
    )
      return false
    try {
      const draft = this.read()
      if (
        !draft ||
        draft.contextId !== callback?.registrationContextId ||
        draft.source !== callback.registrationSource
      ) {
        throw new Error('Registration context was lost during sign in. Reopen the original invitation link.')
      }
      this.assertIdentity(draft, identity)
      this.write({ ...draft, identity })
      return true
    } catch (error) {
      let original: Partial<RegistrationDraft> = {}
      try {
        original = JSON.parse(this.storage().getItem(REGISTRATION_STORAGE_KEY) || '{}')
      } catch {
        /* Invalid context. */
      }
      this.storage().setItem(
        REGISTRATION_STORAGE_KEY,
        JSON.stringify({ ...original, blocked: (error as Error).message }),
      )
      return true
    }
  }

  snapshot(identity: RegistrationIdentity): RegistrationDraft | null {
    const draft = this.read()
    if (draft) {
      if (!draft.identity) throw new Error('Finish signing in from your registration page first.')
      this.assertIdentity(draft, identity)
    }
    return draft
  }

  needsSignIn(): boolean {
    try {
      const draft = this.read()
      return !!draft && !draft.identity
    } catch {
      return true
    }
  }

  rejectLink(): void {
    const draft = this.read()
    if (draft) this.write({ ...draft, rejected: true })
  }

  complete(contextId?: string): void {
    const draft = this.read()
    if (draft && draft.contextId !== contextId) throw new Error('Registration context changed before completion')
    this.storage().removeItem(REGISTRATION_STORAGE_KEY)
  }

  ordinaryLogin(): void {
    this.storage().removeItem(REGISTRATION_STORAGE_KEY)
  }

  private assertIdentity(draft: RegistrationDraft, identity: RegistrationIdentity): void {
    if (
      !identity.issuer ||
      !identity.userId ||
      (draft.identity && (draft.identity.issuer !== identity.issuer || draft.identity.userId !== identity.userId))
    ) {
      throw new Error('The signed-in identity changed. Reopen the original invitation link to start again.')
    }
  }

  private write(draft: RegistrationDraft): void {
    this.storage().setItem(REGISTRATION_STORAGE_KEY, JSON.stringify(draft))
  }
}

export const registrationSession = new RegistrationSession()
