//! Authorization Code + PKCE flow against a Dex / Auth0 OIDC IdP.
//!
//! Lifts the user through a real browser — we spin up an axum listener on
//! `127.0.0.1:<port>`, point the IdP's redirect_uri at it, open the
//! authorization URL, and wait for the IdP to bounce the user back with an
//! `authorization_code`. The code + the stashed PKCE verifier go to the
//! token endpoint, and we hand the resulting tokens to the caller.
//!
//! Mirrors the Go CLI's flow at `apps/cli/auth/auth.go:32-200` so users with
//! a working `apps/cli` install have the same login experience.
//!
//! Cancellation is explicit: Ctrl-C and the IdP's `expires_in` are both
//! peers of the success path in a `tokio::select!`. We never block the
//! whole process on a hung redirect.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use axum::Router;
use axum::extract::{Query, State};
use axum::response::Html;
use axum::routing::get;
use chrono::{TimeDelta, Utc};
use openidconnect::core::{CoreAuthenticationFlow, CoreClient};
use openidconnect::{
    AuthorizationCode, CsrfToken, Nonce, OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier,
    RedirectUrl, Scope, TokenResponse,
};
use secrecy::SecretString;
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::{OidcConfig, OidcTokens};

/// Default port for the local callback. Fixed (vs. ephemeral) because
/// Dex requires a literal port in its `redirectURIs` allow-list, and Auth0
/// allow-list entries are also exact-match. The port must therefore match
/// **byte-for-byte** what the IdP has registered — falling back to a
/// nearby port the IdP doesn't know about would just produce the same
/// "callback URL mismatch" error in a new disguise.
///
/// If `5555` is busy the run fails with an actionable message rather than
/// silently using another port; the operator can free `5555` or pass
/// `--callback-port` together with a matching IdP allow-list entry.
///
/// The redirect URI is always built as `http://127.0.0.1:<port>/callback`
/// — RFC 8252 §8.3 requires the loopback IP literal, NOT `localhost`,
/// because the literal cannot be hijacked via `/etc/hosts` and cannot
/// accidentally bind to a non-loopback interface. Operators register
/// exactly this form in Dex / Auth0; no `localhost` alias.
pub const DEFAULT_CALLBACK_PORT: u16 = 5555;

/// Hard ceiling on how long we'll wait for the user to complete the
/// browser flow. Three minutes is the same budget as the Go CLI.
const FLOW_TIMEOUT: Duration = Duration::from_secs(180);

/// Run the Authorization Code + PKCE flow.
///
/// Steps, in order:
///
/// 1. Bind a TCP listener on `127.0.0.1:5555..=5565` so the redirect URI
///    we hand the IdP is one we actually own.
/// 2. Build the OIDC client from `cfg` + the well-known document.
/// 3. Generate PKCE + CSRF state, build the authorization URL, open it
///    in the user's browser.
/// 4. Wait for the IdP to redirect back with `?code=...&state=...`;
///    verify state, exchange code for tokens.
///
/// Surfaces three terminal failures distinctly:
/// - **user cancellation** (`Ctrl-C`): `Err` with a message; no tokens written.
/// - **timeout** (3 min, [`FLOW_TIMEOUT`]): `Err`; the listener is dropped.
/// - **IdP error** (state mismatch, token exchange refusal): `Err` with the
///   IdP-supplied message; the listener is dropped.
pub async fn run(cfg: &OidcConfig, http: &reqwest::Client, port: u16) -> Result<OidcTokens> {
    let metadata = super::discovery::load_provider_metadata(cfg, http).await?;

    let listener = bind_callback_listener(port).await?;
    let redirect_uri = RedirectUrl::new(format!("http://127.0.0.1:{port}/callback"))
        .context("building redirect URI")?;

    let client = CoreClient::from_provider_metadata(metadata, cfg.client_id.clone(), None)
        .set_redirect_uri(redirect_uri.clone());

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let mut authorize_req = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .set_pkce_challenge(pkce_challenge);
    for scope in &cfg.scopes {
        authorize_req = authorize_req.add_scope(Scope::new(scope.clone()));
    }
    if let Some(audience) = cfg.audience.as_deref() {
        // Auth0 requires `audience`; Dex tolerates the extra query param.
        authorize_req = authorize_req.add_extra_param("audience", audience);
    }
    let (auth_url, csrf_token, _nonce) = authorize_req.url();

    let (tx, rx) = oneshot::channel::<Result<CallbackData>>();
    let server_state = CallbackState {
        tx: Arc::new(std::sync::Mutex::new(Some(tx))),
        expected_state: csrf_token.secret().clone(),
    };

    let app = Router::new()
        .route("/callback", get(callback_handler))
        .with_state(server_state);

    let server_task = tokio::spawn(async move {
        // `into_make_service` matches axum 0.8's tower-style serve API; if
        // it ever errors we surface that as a flow failure rather than a
        // panic so the outer select! can shut things down cleanly.
        let _ = axum::serve(listener, app.into_make_service()).await;
    });

    eprintln!("Opening browser for login: {}", auth_url);
    if webbrowser::open(auth_url.as_str()).is_err() {
        eprintln!(
            "Could not open a browser automatically. Open this URL manually:\n  {}",
            auth_url
        );
    }

    let callback = tokio::select! {
        result = rx => result.context("callback channel closed")??,
        _ = tokio::signal::ctrl_c() => {
            server_task.abort();
            bail!("login cancelled");
        }
        _ = tokio::time::sleep(FLOW_TIMEOUT) => {
            server_task.abort();
            bail!("timed out waiting for browser login after {}s", FLOW_TIMEOUT.as_secs());
        }
    };
    server_task.abort();

    let token_response = client
        .exchange_code(AuthorizationCode::new(callback.code))
        .context("building token exchange request")?
        .set_pkce_verifier(PkceCodeVerifier::new(pkce_verifier.secret().clone()))
        .request_async(http)
        .await
        .map_err(explain_token_error)?;

    Ok(tokens_from_response(&token_response))
}

/// Turn an `openidconnect::RequestTokenError` into a focused, debuggable
/// error message.
///
/// The most painful case is `Parse`: openidconnect's `Display` impl reduces
/// it to a bland `"Failed to parse server response"`, hiding the actual
/// HTTP body — which is exactly what we need to know when an IdP returns
/// something the crate didn't expect (Auth0 redirects to an HTML error
/// page, sends an unexpected `token_type` casing, omits a required field,
/// etc.). The body bytes are carried in the variant; we pull them out and
/// include them, truncated to the first 4 KiB so a giant HTML error page
/// can't blow up the terminal.
fn explain_token_error<RE, T>(err: openidconnect::RequestTokenError<RE, T>) -> anyhow::Error
where
    RE: std::error::Error + 'static,
    T: openidconnect::ErrorResponse + 'static,
{
    use openidconnect::RequestTokenError as E;
    match err {
        E::Parse(parse_err, body) => {
            let preview = String::from_utf8_lossy(&body);
            let preview = if preview.len() > 4096 {
                format!(
                    "{}… (truncated, {} bytes total)",
                    &preview[..4096],
                    body.len()
                )
            } else {
                preview.into_owned()
            };
            anyhow!(
                "token endpoint returned a body openidconnect could not parse: {parse_err}\n\
                 --- response body ({} bytes) ---\n{preview}\n--- end ---",
                body.len()
            )
        }
        E::ServerResponse(srv) => anyhow!("token endpoint rejected the request: {srv}"),
        E::Request(re) => anyhow!("token endpoint request failed: {re}"),
        E::Other(s) => anyhow!("token exchange: {s}"),
    }
}

#[derive(Clone)]
struct CallbackState {
    tx: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<CallbackData>>>>>,
    expected_state: String,
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

struct CallbackData {
    code: String,
}

/// Receives the IdP's redirect. The handler reports either the
/// `code` (on success) or the IdP-supplied `error` description (on
/// rejection) through the `oneshot` channel, then returns a self-contained
/// HTML page so the user knows it's safe to close the tab.
async fn callback_handler(
    State(state): State<CallbackState>,
    Query(query): Query<CallbackQuery>,
) -> Html<&'static str> {
    let outcome: Result<CallbackData> = match query {
        CallbackQuery {
            error: Some(error),
            error_description: desc,
            ..
        } => {
            let detail = desc.unwrap_or_default();
            Err(anyhow!("IdP returned error `{error}`: {detail}"))
        }
        CallbackQuery {
            code: Some(code),
            state: Some(received_state),
            ..
        } if received_state == state.expected_state => Ok(CallbackData { code }),
        CallbackQuery { state: Some(_), .. } => Err(anyhow!(
            "callback state did not match — possible CSRF; refusing the response"
        )),
        _ => Err(anyhow!("callback missing `code` or `state`")),
    };

    let success = outcome.is_ok();
    if let Some(tx) = state.tx.lock().unwrap().take() {
        let _ = tx.send(outcome);
    }

    if success {
        Html(SUCCESS_HTML)
    } else {
        Html(FAILURE_HTML)
    }
}

/// Bind the callback listener on exactly `port`. Fails loudly if the port
/// is in use — silently falling back to another port would produce a
/// redirect URI the IdP doesn't have in its allow-list, surfacing as the
/// same "callback URL mismatch" error one level deeper.
async fn bind_callback_listener(port: u16) -> Result<TcpListener> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpListener::bind(addr).await.map_err(|e| {
        anyhow!(
            "binding callback listener on 127.0.0.1:{port}: {e}\n\
             Free the port (e.g. `lsof -i :{port}`) or pass `--callback-port <PORT>` and add the \
             matching `http://127.0.0.1:<PORT>/callback` to the IdP's allow-list."
        )
    })
}

/// Map `openidconnect::CoreTokenResponse` into our small [`OidcTokens`]
/// type. The `expires_at` falls back to "5 minutes from now" if the IdP
/// omits `expires_in`; better to refresh too eagerly than to hold a token
/// past its real lifetime.
fn tokens_from_response(resp: &openidconnect::core::CoreTokenResponse) -> OidcTokens {
    let expires_in = resp
        .expires_in()
        .and_then(|d| TimeDelta::from_std(d).ok())
        .unwrap_or(TimeDelta::minutes(5));
    OidcTokens {
        access_token: SecretString::from(resp.access_token().secret().clone()),
        refresh_token: resp
            .refresh_token()
            .map(|t| SecretString::from(t.secret().clone())),
        id_token: resp.id_token().map(|t| SecretString::from(t.to_string())),
        expires_at: Utc::now() + expires_in,
    }
}

// Two embedded HTML pages: one for success, one for the rare hit-this-then-
// something-failed case. Keeping them inline (vs. include_str!) means
// reviewers see the full surface in one file.
const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>BoxLite — Login complete</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
    .card{background:#1e293b;padding:2.5rem 3rem;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);text-align:center;max-width:32rem}
    h1{margin:0 0 .75rem;font-size:1.5rem;font-weight:600}
    p{margin:0;color:#94a3b8}
  </style>
</head>
<body>
  <div class="card">
    <h1>Login complete</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>"#;

const FAILURE_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>BoxLite — Login failed</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#fecaca}
    .card{background:#1e293b;padding:2.5rem 3rem;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);text-align:center;max-width:32rem}
    h1{margin:0 0 .75rem;font-size:1.5rem;font-weight:600;color:#f87171}
    p{margin:0;color:#cbd5e1}
  </style>
</head>
<body>
  <div class="card">
    <h1>Login failed</h1>
    <p>Return to your terminal — the CLI has the details.</p>
  </div>
</body>
</html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// The chosen port must round-trip into the redirect URI we hand the
    /// IdP — a mismatch here is what causes Dex to silently reject the
    /// callback (most painful failure mode of this whole flow). Use an
    /// OS-assigned ephemeral port (`:0`) for the test so we don't conflict
    /// with whatever is running on 5555 on the developer's machine.
    #[tokio::test]
    async fn binds_loopback_and_redirect_url_round_trips() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind ephemeral");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let listener = bind_callback_listener(port)
            .await
            .expect("rebind exact port");
        assert_eq!(listener.local_addr().unwrap().port(), port);
        let url = format!("http://127.0.0.1:{port}/callback");
        RedirectUrl::new(url).expect("valid redirect URL");
    }

    /// Binding the same port twice must surface as a focused, actionable
    /// error — not a silent fallback that produces an allow-list mismatch
    /// downstream.
    #[tokio::test]
    async fn second_bind_on_same_port_errors_with_actionable_message() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind ephemeral");
        let port = listener.local_addr().expect("addr").port();
        let err = bind_callback_listener(port)
            .await
            .expect_err("second bind should fail");
        let msg = err.to_string();
        assert!(
            msg.contains("--callback-port"),
            "actionable hint missing: {msg}"
        );
    }

    /// Default port matches what we tell Auth0 / Dex admins to register —
    /// a literal here protects the contract from drifting silently.
    #[test]
    fn default_callback_port_is_stable() {
        assert_eq!(DEFAULT_CALLBACK_PORT, 5555);
    }
}
