//! OAuth2 token endpoint (local passthrough).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};

use super::super::types::{TokenForm, TokenResponse};
use super::super::{ERROR_AUTH, error_response};

pub(in crate::commands::serve) async fn oauth_token(Form(form): Form<TokenForm>) -> Response {
    if form.grant_type != "client_credentials" {
        return error_response(
            StatusCode::BAD_REQUEST,
            "unsupported grant_type",
            ERROR_AUTH,
        );
    }

    (
        StatusCode::OK,
        Json(TokenResponse {
            access_token: "boxlite-local-token".to_string(),
            token_type: "bearer".to_string(),
            expires_in: 86400,
        }),
    )
        .into_response()
}
