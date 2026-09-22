// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { RegistrationSession, REGISTRATION_STORAGE_KEY, parseRegistrationLink } from './referral-session'

describe('U01–U04 registration context', () => {
  let session: RegistrationSession
  const identity = { issuer: 'https://issuer.test', userId: 'user-1' }
  beforeEach(() => {
    sessionStorage.clear()
    session = new RegistrationSession(() => sessionStorage)
  })
  it('distinguishes an ordinary entry from a read-only invitation link', () => {
    expect(parseRegistrationLink('')).toEqual({ source: 'direct' })
    expect(parseRegistrationLink('?referredCode=abcd2345ef')).toEqual({ source: 'link', referredCode: 'ABCD2345EF' })
  })
  it.each([
    '?referredCode=',
    '?referredCode=bad',
    '?referredCode=ABCD2345EF&referredCode=ABCD2345EF',
    '?referredCode%5B%5D=ABCD2345EF',
  ])('rejects invalid link %s without creating a context', (query) => {
    expect(() => parseRegistrationLink(query)).toThrow('invalid')
    expect(session.hasContext()).toBe(false)
  })
  it('round-trips state, binds identity and removes the successful draft', () => {
    const draft = session.prepare(parseRegistrationLink('?referredCode=ABCD2345EF'))
    expect(session.needsSignIn()).toBe(true)
    expect(() => session.snapshot(identity)).toThrow('Finish signing in')
    expect(session.restore(session.oidcState(draft), identity)).toBe(true)
    expect(session.snapshot(identity)?.referredCode).toBe('ABCD2345EF')
    expect(session.needsSignIn()).toBe(false)
    session.complete(draft.contextId)
    expect(session.read()).toBeNull()
  })
  it('retains one locked snapshot across retries and refuses a different code', () => {
    const draft = session.prepare(parseRegistrationLink('?referredCode=ABCD2345EF'))
    expect(session.prepare({ source: 'link', referredCode: 'ABCD2345EF' }).contextId).toBe(draft.contextId)
    expect(() => session.prepare({ source: 'link', referredCode: 'ABCDEFGH23' })).toThrow('already in progress')
    expect(() => session.prepare({ source: 'direct' })).toThrow('already in progress')
    expect(session.read()?.referredCode).toBe('ABCD2345EF')
  })
  it('blocks context loss, mismatched state and a changed signed-in identity', () => {
    const draft = session.prepare({ source: 'link', referredCode: 'ABCD2345EF' })
    session.restore(session.oidcState(draft), identity)
    expect(() => session.snapshot({ ...identity, userId: 'other-user' })).toThrow('identity changed')
    session.restore({ ...session.oidcState(draft), registrationContextId: 'wrong-id' }, identity)
    expect(() => session.read()).toThrow('lost')
    sessionStorage.clear()
    session.restore(session.oidcState(draft), identity)
    expect(() => session.read()).toThrow('lost')
  })
  it('expires after 24 hours without silently becoming ordinary signup', () => {
    const draft = session.prepare({ source: 'direct' })
    sessionStorage.setItem(REGISTRATION_STORAGE_KEY, JSON.stringify({ ...draft, createdAt: Date.now() - 86400000 }))
    expect(() => session.read()).toThrow('expired')
    expect(session.needsSignIn()).toBe(true)
  })
  it('refuses a registration callback missing its context ID even when storage is empty', () => {
    expect(session.restore({ registrationSource: 'link', returnTo: '/register?resume=1' }, identity)).toBe(true)
    expect(() => session.read()).toThrow('lost')
  })
  it('permits a new valid link after an explicit server rejection', () => {
    session.prepare({ source: 'link', referredCode: 'ABCD2345EF' })
    session.rejectLink()
    expect(session.prepare({ source: 'link', referredCode: 'ABCDEFGH23' }).referredCode).toBe('ABCDEFGH23')
  })
})
