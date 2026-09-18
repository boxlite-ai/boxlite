import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export async function startOidcProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const key = { ...(await exportJWK(publicKey)), kid: 'referral-browser', use: 'sig', alg: 'RS256' }
  const codes = new Map<
    string,
    { redirect: string; challenge: string; nonce: string; subject: string; verified: boolean }
  >()
  let identity = { subject: 'browser-' + randomUUID(), verified: true }
  let issuer: string
  const sign = (audience: string, subject: string, verified: boolean, nonce?: string) =>
    new SignJWT({
      email: 'browser@test.invalid',
      name: 'Browser test',
      email_verified: verified,
      ...(nonce ? { nonce } : {}),
    })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('10m')
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .sign(privateKey)
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4390')
    response.setHeader('Access-Control-Allow-Headers', 'content-type')
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'OPTIONS') {
      response.end()
      return
    }
    const url = new URL(request.url, issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['openid', 'profile', 'email'],
        }),
      )
    } else if (url.pathname === '/jwks') {
      response.end(JSON.stringify({ keys: [key] }))
    } else if (url.pathname === '/authorize') {
      if (
        url.searchParams.get('client_id') !== 'referral-browser' ||
        url.searchParams.get('redirect_uri') !== 'http://127.0.0.1:4390' ||
        url.searchParams.get('code_challenge_method') !== 'S256'
      ) {
        response.statusCode = 400
        response.end('{}')
        return
      }
      const code = randomUUID()
      codes.set(code, {
        redirect: url.searchParams.get('redirect_uri'),
        challenge: url.searchParams.get('code_challenge'),
        nonce: url.searchParams.get('nonce'),
        ...identity,
      })
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', url.searchParams.get('state'))
      response.writeHead(302, { Location: callback.toString() })
      response.end()
    } else if (url.pathname === '/token') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const input = new URLSearchParams(Buffer.concat(chunks).toString())
      const code = codes.get(input.get('code'))
      if (
        !code ||
        input.get('redirect_uri') !== code.redirect ||
        createHash('sha256')
          .update(input.get('code_verifier') || '')
          .digest('base64url') !== code.challenge
      ) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      codes.delete(input.get('code'))
      response.end(
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'openid profile email',
          access_token: await sign('referral-test', code.subject, code.verified),
          id_token: await sign('referral-browser', code.subject, code.verified, code.nonce),
        }),
      )
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  return {
    issuer,
    setIdentity: (next: typeof identity) => {
      identity = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
