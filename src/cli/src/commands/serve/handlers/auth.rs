//! OAuth 2.0 device-flow stub for the local Axum reference server.
//!
//! Auto-completes — every `device_code` request succeeds immediately on the
//! next `token` poll. Lets the CLI flow be exercised end-to-end without
//! standing up the real NestJS gateway.
//!
//! Spec: `openapi/rest-sandbox-open-api.yaml` §`/v1/oauth/*`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use serde::{Deserialize, Serialize};

use super::super::{ERROR_AUTH, error_response};

const LOCAL_USER_CODE: &str = "LOCAL-DEV";
const LOCAL_ACCESS_TOKEN: &str = "blo_local_dev_access_token";
const LOCAL_REFRESH_TOKEN: &str = "blr_local_dev_refresh_token";

#[derive(Debug, Deserialize)]
pub(in crate::commands::serve) struct DeviceCodeForm {
    #[allow(dead_code)]
    client_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    scope: Option<String>,
}

#[derive(Debug, Serialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
pub(in crate::commands::serve) struct TokenForm {
    grant_type: String,
    #[serde(default)]
    device_code: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    client_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: u64,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub(in crate::commands::serve) struct RevokeForm {
    #[allow(dead_code)]
    token: String,
    #[serde(default)]
    #[allow(dead_code)]
    token_type_hint: Option<String>,
}

pub(in crate::commands::serve) async fn device_code(Form(_form): Form<DeviceCodeForm>) -> Response {
    (
        StatusCode::OK,
        Json(DeviceCodeResponse {
            device_code: "local-device-code".to_string(),
            user_code: LOCAL_USER_CODE.to_string(),
            verification_uri: "http://localhost:8080/activate".to_string(),
            verification_uri_complete: format!(
                "http://localhost:8080/activate?user_code={LOCAL_USER_CODE}"
            ),
            expires_in: 600,
            interval: 1,
        }),
    )
        .into_response()
}

pub(in crate::commands::serve) async fn token(Form(form): Form<TokenForm>) -> Response {
    match form.grant_type.as_str() {
        "urn:ietf:params:oauth:grant-type:device_code" => {
            if form.device_code.is_none() {
                return error_response(StatusCode::BAD_REQUEST, "missing device_code", ERROR_AUTH);
            }
            (StatusCode::OK, Json(local_token_response())).into_response()
        }
        "refresh_token" => {
            if form.refresh_token.is_none() {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "missing refresh_token",
                    ERROR_AUTH,
                );
            }
            (StatusCode::OK, Json(local_token_response())).into_response()
        }
        other => {
            let msg = format!("unsupported grant_type: {other}");
            error_response(StatusCode::BAD_REQUEST, &msg, ERROR_AUTH)
        }
    }
}

pub(in crate::commands::serve) async fn revoke(Form(_form): Form<RevokeForm>) -> Response {
    // RFC 7009 §2.2 — always 200.
    StatusCode::OK.into_response()
}

fn local_token_response() -> TokenResponse {
    TokenResponse {
        access_token: LOCAL_ACCESS_TOKEN.to_string(),
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: LOCAL_REFRESH_TOKEN.to_string(),
    }
}
