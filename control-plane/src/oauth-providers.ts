/**
 * OAuth providers for end-user sign-in. Adding one means adding an entry here plus
 * `<NAME>_CLIENT_ID` / `<NAME>_CLIENT_SECRET` in the CP's env; the callback URL is
 * `${PUBLIC_URL}/auth/callback/<name>`.
 */

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProfile {
  /** Stable id at the provider (GitHub numeric id, Google `sub`). */
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** The account's handle where the provider has one (GitHub login). */
  login?: string;
}

export interface OAuthProvider {
  name: string;
  label: string;
  authorizeUrl(a: { creds: OAuthCredentials; redirectUri: string; state: string; codeChallenge: string }): string;
  /** Code → access token (PKCE verifier included) → profile. */
  signIn(a: { creds: OAuthCredentials; redirectUri: string; code: string; codeVerifier: string; fetch: typeof fetch }): Promise<OAuthProfile>;
}

export class OAuthError extends Error {
  override name = 'OAuthError';
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OAuthError(`${what}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new OAuthError(`${what}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return body as T;
}

const UA = 'boxlite-microcloud';

const github: OAuthProvider = {
  name: 'github',
  label: 'GitHub',
  authorizeUrl({ creds, redirectUri, state, codeChallenge }) {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.search = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true',
    }).toString();
    return u.toString();
  },
  async signIn({ creds, redirectUri, code, codeVerifier, fetch }) {
    const tok = await json<{ access_token?: string; error?: string; error_description?: string }>(
      await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
      }),
      'GitHub token exchange',
    );
    // GitHub answers 200 with {error} for a bad or reused code.
    if (!tok.access_token) throw new OAuthError(`GitHub token exchange: ${tok.error_description ?? tok.error ?? 'no access_token'}`);
    const headers = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': UA };
    const user = await json<{ id: number; login: string; name: string | null; avatar_url: string | null }>(await fetch('https://api.github.com/user', { headers }), 'GitHub /user');
    const emails = await json<{ email: string; primary: boolean; verified: boolean }[]>(await fetch('https://api.github.com/user/emails', { headers }), 'GitHub /user/emails');
    const verified = Array.isArray(emails) ? emails.filter((e) => e.verified) : [];
    const email = (verified.find((e) => e.primary) ?? verified[0])?.email ?? null;
    return { id: String(user.id), email, name: user.name || user.login, avatarUrl: user.avatar_url ?? null, login: user.login };
  },
};

const google: OAuthProvider = {
  name: 'google',
  label: 'Google',
  authorizeUrl({ creds, redirectUri, state, codeChallenge }) {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return u.toString();
  },
  async signIn({ creds, redirectUri, code, codeVerifier, fetch }) {
    const tok = await json<{ access_token?: string; error?: string }>(
      await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
      }),
      'Google token exchange',
    );
    if (!tok.access_token) throw new OAuthError(`Google token exchange: ${tok.error ?? 'no access_token'}`);
    const info = await json<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>(
      await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }),
      'Google userinfo',
    );
    return { id: info.sub, email: info.email && info.email_verified ? info.email : null, name: info.name ?? null, avatarUrl: info.picture ?? null };
  },
};

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = { github, google };
