# When the user requests application login

BoxLite/Auth0 developer credentials authorize cloud operations; application users use the app's own identity provider/sessions. Never give the app developer cloud tokens.

Register the tunnel before setting public origin/callback. Google login uses a separate Web OAuth client, exact HTTPS callback and required consent/test users. Configure private client secrets in backend environment. Do not modify the platform Auth0 connection.

Use the application's maintained OAuth library for state/nonce, signature, issuer/audience and session checks. Use secure cookies and backend authorization. Verify browser login with the user and a protected feature; mock sessions do not prove real login.

Reuse Box/port and retrieve its registered URL from the CLI. A changed Box, port or proxy environment can require updated callbacks.
