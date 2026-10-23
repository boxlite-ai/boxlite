/**
 * OAuth providers for end-user sign-in. Adding one means adding an entry here; the callback URL is
 * `${PUBLIC_URL}/auth/callback/<name>`. GitHub and Google can also use BoxLite's own OAuth app
 * (`<NAME>_CLIENT_ID` / `<NAME>_CLIENT_SECRET` in the CP's env); the rest only an App's own.
 */
import { sign } from 'node:crypto';

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
  /** Only an App's own OAuth app can sign users in; BoxLite runs none for this provider. */
  ownKeysOnly?: true;
  /** The provider POSTs its callback cross-site (Apple), so the verifier cookie must be SameSite=None. */
  formPost?: true;
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

/** The claims of an ID token fetched straight from the provider's token endpoint over TLS (so not re-verified). */
function idTokenClaims(idToken: string | undefined, what: string): Record<string, unknown> {
  const payload = idToken?.split('.')[1];
  if (!payload) throw new OAuthError(`${what}: no id_token`);
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new OAuthError(`${what}: unreadable id_token`);
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The tenant of personal Microsoft accounts (outlook.com, hotmail.com, …). */
const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const microsoft: OAuthProvider = {
  name: 'microsoft',
  label: 'Microsoft',
  ownKeysOnly: true,
  authorizeUrl({ creds, redirectUri, state, codeChallenge }) {
    const u = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
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
    const tok = await json<{ id_token?: string; error_description?: string }>(
      await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier, scope: 'openid email profile' }).toString(),
      }),
      'Microsoft token exchange',
    );
    const c = idTokenClaims(tok.id_token, 'Microsoft token exchange');
    if (!str(c.sub)) throw new OAuthError('Microsoft token exchange: id_token has no subject');
    // Any tenant's admin can set a work account's `email`, so it counts only when Microsoft vouches
    // for it: a personal account (Microsoft verifies those), or xms_edov (email domain verified).
    const verified = c.tid === MICROSOFT_CONSUMER_TENANT || c.xms_edov === true || c.xms_edov === 'true' || c.xms_edov === 1;
    return { id: str(c.sub)!, email: verified ? str(c.email) : null, name: str(c.name), avatarUrl: null };
  },
};

/** Apple's client secret is a short-lived ES256 JWT signed with the App's .p8 key. */
export interface AppleKey {
  teamId: string;
  keyId: string;
  privateKey: string;
}

/** Apple keeps three values where others keep one secret; they are stored together, as JSON. */
export const appleKeyOf = (clientSecret: string): AppleKey | null => {
  try {
    const k = JSON.parse(clientSecret) as Partial<AppleKey>;
    return k.teamId && k.keyId && k.privateKey ? (k as AppleKey) : null;
  } catch {
    return null;
  }
};

function appleClientSecret(clientId: string, key: AppleKey): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'ES256', kid: key.keyId })}.${b64({ iss: key.teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: clientId })}`;
  try {
    return `${data}.${sign('sha256', Buffer.from(data), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  } catch {
    throw new OAuthError('Apple: the private key (.p8) could not sign; paste the whole file, BEGIN and END lines included');
  }
}

const apple: OAuthProvider = {
  name: 'apple',
  label: 'Apple',
  ownKeysOnly: true,
  formPost: true,
  // Apple has no PKCE; the verifier cookie still binds the callback to the browser that began it.
  authorizeUrl({ creds, redirectUri, state }) {
    const u = new URL('https://appleid.apple.com/auth/authorize');
    u.search = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', response_mode: 'form_post', scope: 'name email', state }).toString();
    return u.toString();
  },
  async signIn({ creds, redirectUri, code, fetch }) {
    const key = appleKeyOf(creds.clientSecret);
    if (!key) throw new OAuthError('Apple: the Team ID, Key ID and private key are not all set');
    const tok = await json<{ id_token?: string }>(
      await fetch('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: creds.clientId, client_secret: appleClientSecret(creds.clientId, key), code, redirect_uri: redirectUri }).toString(),
      }),
      'Apple token exchange',
    );
    const c = idTokenClaims(tok.id_token, 'Apple token exchange');
    if (!str(c.sub)) throw new OAuthError('Apple token exchange: id_token has no subject');
    const verified = c.email_verified === true || c.email_verified === 'true';
    return { id: str(c.sub)!, email: verified ? str(c.email) : null, name: null, avatarUrl: null };
  },
};

const x: OAuthProvider = {
  name: 'x',
  label: 'X',
  ownKeysOnly: true,
  authorizeUrl({ creds, redirectUri, state, codeChallenge }) {
    const u = new URL('https://x.com/i/oauth2/authorize');
    u.search = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'users.read tweet.read', state, code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
    return u.toString();
  },
  async signIn({ creds, redirectUri, code, codeVerifier, fetch }) {
    const tok = await json<{ access_token?: string; error_description?: string }>(
      await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: creds.clientId, code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
      }),
      'X token exchange',
    );
    if (!tok.access_token) throw new OAuthError(`X token exchange: ${tok.error_description ?? 'no access_token'}`);
    const me = await json<{ data?: { id: string; name?: string; username?: string; profile_image_url?: string } }>(
      await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url', { headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': UA } }),
      'X /2/users/me',
    );
    if (!me.data?.id) throw new OAuthError('X /2/users/me: no user');
    // X shares no email address with this scope.
    return { id: me.data.id, email: null, name: me.data.name ?? me.data.username ?? null, avatarUrl: me.data.profile_image_url ?? null, login: me.data.username };
  },
};

/** Meta's sign-in is Facebook Login. */
const facebook: OAuthProvider = {
  name: 'facebook',
  label: 'Facebook',
  ownKeysOnly: true,
  authorizeUrl({ creds, redirectUri, state, codeChallenge }) {
    const u = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    u.search = new URLSearchParams({ client_id: creds.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'email,public_profile', state, code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
    return u.toString();
  },
  async signIn({ creds, redirectUri, code, codeVerifier, fetch }) {
    const q = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code, code_verifier: codeVerifier });
    const tok = await json<{ access_token?: string }>(await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?${q}`), 'Facebook token exchange');
    if (!tok.access_token) throw new OAuthError('Facebook token exchange: no access_token');
    const me = await json<{ id: string; name?: string; email?: string; picture?: { data?: { url?: string } } }>(
      await fetch(`https://graph.facebook.com/v21.0/me?${new URLSearchParams({ fields: 'id,name,email,picture.type(large)', access_token: tok.access_token })}`),
      'Facebook /me',
    );
    // Facebook returns only a confirmed email address, and none if the person declined to share it.
    return { id: me.id, email: me.email ?? null, name: me.name ?? null, avatarUrl: me.picture?.data?.url ?? null };
  },
};

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = { github, google, microsoft, apple, x, facebook };
