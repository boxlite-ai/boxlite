# Authenticate a cloud profile

Replace CLI_HOME with the selected BoxLite home; omit --home only for the verified default. Preserve that selector for every login, identity and deployment command.

Hosted production uses API https://api.boxlite.ai and issuer https://auth.boxlite.ai/. Confirm the selected API's /config issuer before applying this mapping. The public Native CLI client ID below is application metadata, not a secret; preserve a user/admin CLI_CLIENT_ID override.

## Device login

~~~sh
boxlite --home CLI_HOME --profile PROFILE auth login --url https://api.boxlite.ai --client-id "${CLI_CLIENT_ID:-PniqOPOrdcQ1gx2aIBljtZuvhtigCM6C}" --method device
~~~

Expect: printed verification URL/user code, then successful login after browser authorization. Use a tool session or background process with a task-private log so polling survives the wait. Present only that URL and one-time **user code**, never device_code or tokens. Stop on denial, cancellation or expiry.

## Browser alternative

Use when the user selects browser login or the device method is unavailable, after any device process has ended and when the browser can reach the host loopback callback. Do not automatically switch methods after authorization denial, cancellation or expiry:

~~~sh
boxlite --home CLI_HOME --profile PROFILE auth login --url https://api.boxlite.ai --client-id "${CLI_CLIENT_ID:-PniqOPOrdcQ1gx2aIBljtZuvhtigCM6C}" --method browser
~~~

Expect: the same environment/client/profile. The client must allow http://127.0.0.1:5555/callback. A dashboard session alone does not authenticate the CLI.

## User-controlled API key

If selected by the user, have them run this in **their own interactive terminal**, pasting their dashboard key at the hidden prompt:

~~~sh
boxlite --home CLI_HOME --profile PROFILE auth login --url https://api.boxlite.ai --method api-key
~~~

For an existing authorized private file/secret source use --api-key-stdin. Never put its value in argv/chat. Verify with auth whoami before resource creation.

Check the credential source reported by auth status: an inherited BOXLITE_API_KEY can override a named profile. Align it with the user's selected context without printing its value; the named-profile deploy helper refuses that ambiguous combination rather than routing silently.

## Other environments and errors

Additional/self-hosted environments need their own API, issuer and public Native CLI client ID. Select it explicitly with --client-id when server config advertises a dashboard app; OIDC_CLIENT_ID is a fallback and cannot override server config.

For unauthorized_client check issuer/client, then route grant setup to the administrator. Renewable sessions require Refresh Token and API offline access. Report login and actual refresh results separately; never inspect/display token values or switch methods to bypass a denial.
