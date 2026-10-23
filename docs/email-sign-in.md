# Email code sign-in

End users of an App sign in by typing their email address and the 6-digit code mailed to it, next
to (or instead of) the OAuth providers. PRD 08 §Auth lists it ("验证码邮件的发件设置"). The mail
goes out through the App owner's own SMTP account: the platform sends no mail of its own, so there
is no platform sender to choose, verify or pay for.

## Declaring it

```toml
[auth]
providers = ["email"]            # alone, or with "github", "google", …
protect   = ["/app/*"]
```

`email` is ready once the App has a sender. Until then it behaves like an OAuth provider without
keys: `plan` warns `auth_provider_not_configured`, `app context` reports it, and the login page
leaves it out.

## The sender (per App, like the App's own OAuth keys)

| | CLI (agent) | Console (owner) | API |
|---|---|---|---|
| set | `printf %s "$PASS" \| boxlite-app app auth email set --host smtp.example.com --port 587 --username u --from "Acme <no-reply@acme.com>" --password-stdin` | Auth › Email sign-in › Set up | `PUT /v1/apps/{app}/auth/email` `{host, port, username?, password?, from}` |
| show | `boxlite-app app auth email` | the same section | `GET …/auth/email` → `{configured, host, port, username, from, password_set}` |
| try | `boxlite-app app auth email test --to me@acme.com` | Send a test email | `POST …/auth/email/test` `{to}` → `{sent, ms}` |
| remove | `boxlite-app app auth email rm --yes` | Remove | `DELETE …/auth/email` |

The password is write-only (never returned). `set` keeps the stored password when none is given.
Every change and test is in Activity. Ports 25, 465 (implicit TLS), 587 and 2525 (STARTTLS) are
allowed. The host must resolve to public addresses only: a sender pointed at the control plane's
own network (loopback, private, link-local, CGNAT) is refused, and the connection goes to the
address that was checked, so DNS cannot be switched in between. `SMTP_ALLOW_PRIVATE=1` lifts that
for a development control plane.

An SMTP failure is answered with the server's own reply and what to do (`535 authentication failed`
→ check the username and password), both by `test` and in the App's logs when a sign-in mail fails.

## The flow (app origin, `/.boxlite/auth/*`)

1. `GET /login`: with `email` ready, the page has an email field (and the OAuth buttons).
2. `POST /email/start` `email, next`: same-origin form only. Rate limits: 5 codes per address per
   hour, 100 per environment per hour. A random 6-digit code, stored hashed with its row id, valid
   10 minutes, bound to this browser by the `bxl_login` nonce cookie (as the OAuth handoff is).
   The mail: subject "Your sign-in code for <host>", body with the code and its lifetime. The
   answer is the code form; it says the same whether or not the address has signed in before.
3. `POST /email/verify` `email, code, next`: the newest unused code of that address for this
   browser; 5 wrong tries end it. Success upserts the user (`provider = email`, the lowercased
   address as id and email), opens the usual session and redirects to `next`.

Every step logs an `auth` line for the owner (code sent / mail failed with the SMTP reply / wrong
code / signed in), naming the address as OAuth sign-ins do, never the code.

## Storage

`app_email_senders(app_id, host, port, username, password, from_address, updated_at)` and
`auth_email_codes(id, env_id, email, code_hash, browser_hash, next, attempts, created_at,
expires_at, used_at)`, appended to the migrations. Codes older than a day are deleted by the
existing cleanup.

## Verification

- Unit: an in-process SMTP server receives the mail; the code from it signs in; wrong code,
  expiry, other browser, rate limits, blocked user, a private host refused.
- Live (dev): an SMTP sink on the control plane's Box with `SMTP_ALLOW_PRIVATE=1`; the e2e signs in
  through the real login page with the code the sink received.
