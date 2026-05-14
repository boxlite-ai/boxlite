//! `GET /v1/me` — identity for the calling credential.
//!
//! The local Axum reference server is unauthenticated, so this returns a
//! fixed "local-anonymous" principal regardless of the Bearer header. Useful
//! for exercising the CLI's `auth status` and login validation against a
//! local development target.

use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub(in crate::commands::serve) struct Principal {
    sub: &'static str,
    principal_type: &'static str,
    email: &'static str,
    display_name: &'static str,
    prefix: &'static str,
    scopes: Vec<&'static str>,
    expires_at: Option<&'static str>,
}

pub(in crate::commands::serve) async fn get_me() -> Json<Principal> {
    Json(Principal {
        sub: "local-anonymous",
        principal_type: "service_account",
        email: "local@boxlite.local",
        display_name: "Local development",
        prefix: "default",
        scopes: vec![
            "box:read",
            "box:write",
            "box:exec",
            "box:delete",
            "image:read",
            "image:write",
            "snapshot:read",
            "snapshot:write",
            "snapshot:delete",
            "me:read",
        ],
        expires_at: None,
    })
}
