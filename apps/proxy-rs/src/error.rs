// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Typed request errors and their JSON wire form.
//!
//! Handlers return `Result<Response, ProxyError>` and the server renders the
//! error once, at the edge, so no handler can half-write a response.

use http::{Method, Response, StatusCode};
use serde::Serialize;

use crate::body::{self, Body};

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("unauthorized: {0}")]
    Unauthorized(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("internal server error: {0}")]
    Internal(String),

    /// An error the BoxLite API reported in its own error envelope.
    #[error("{message}")]
    Upstream {
        status: StatusCode,
        message: String,
        code: String,
    },
}

impl ProxyError {
    pub fn bad_request(err: impl std::fmt::Display) -> Self {
        Self::BadRequest(err.to_string())
    }

    pub fn unauthorized(err: impl std::fmt::Display) -> Self {
        Self::Unauthorized(err.to_string())
    }

    pub fn not_found(err: impl std::fmt::Display) -> Self {
        Self::NotFound(err.to_string())
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self::Internal(err.to_string())
    }

    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Upstream { status, .. } => *status,
        }
    }

    pub fn code(&self) -> &str {
        match self {
            Self::BadRequest(_) => "BAD_REQUEST",
            Self::Unauthorized(_) => "UNAUTHORIZED",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Internal(_) => "INTERNAL_SERVER_ERROR",
            Self::Upstream { code, .. } => code,
        }
    }

    /// Only gateway-class API failures are worth another attempt. Anything that
    /// never reached the API (connect, timeout, decode) is assumed transient.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Upstream { status, .. } => matches!(
                *status,
                StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT
            ),
            _ => true,
        }
    }

    /// Names the operation that failed while keeping the status and code, so a
    /// retry-exhausted error still renders as the failure the client caused.
    pub fn with_operation(self, operation: &str, attempts: u32) -> Self {
        let described = format!("failed to {operation} after {attempts} attempts: {self}");
        match self {
            Self::BadRequest(_) => Self::BadRequest(described),
            Self::Unauthorized(_) => Self::Unauthorized(described),
            Self::NotFound(_) => Self::NotFound(described),
            Self::Internal(_) => Self::Internal(described),
            Self::Upstream { status, code, .. } => Self::Upstream {
                status,
                message: described,
                code,
            },
        }
    }

    pub fn into_response(self, path: &str, method: &Method) -> Response<Body> {
        let status = self.status();
        let payload = ErrorResponse {
            status_code: status.as_u16(),
            message: self.to_string(),
            code: self.code().to_string(),
            timestamp: chrono::Utc::now(),
            path: path.to_string(),
            method: method.to_string(),
        };

        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(path, %method, message = %payload.message, "internal server error");
        } else {
            tracing::warn!(path, %method, status = status.as_u16(), message = %payload.message, "request error");
        }

        let encoded = serde_json::to_vec(&payload)
            .unwrap_or_else(|_| br#"{"message":"error serialization failed"}"#.to_vec());

        Response::builder()
            .status(status)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(body::full(encoded))
            .expect("a status and one header always build a valid response")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    status_code: u16,
    message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    code: String,
    timestamp: chrono::DateTime<chrono::Utc>,
    path: String,
    method: String,
}

pub type Result<T> = std::result::Result<T, ProxyError>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::body_to_string;

    #[tokio::test]
    async fn renders_typed_error_as_json_envelope() {
        let response =
            ProxyError::bad_request("target port is required").into_response("/x", &Method::GET);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let parsed: serde_json::Value =
            serde_json::from_str(&body_to_string(response.into_body()).await).expect("valid json");
        assert_eq!(parsed["statusCode"], 400);
        assert_eq!(parsed["code"], "BAD_REQUEST");
        assert_eq!(parsed["message"], "bad request: target port is required");
        assert_eq!(parsed["path"], "/x");
        assert_eq!(parsed["method"], "GET");
    }

    #[test]
    fn only_gateway_failures_from_the_api_are_retried() {
        let bad_gateway = ProxyError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            message: "upstream down".into(),
            code: "BAD_GATEWAY".into(),
        };
        let forbidden = ProxyError::Upstream {
            status: StatusCode::FORBIDDEN,
            message: "nope".into(),
            code: "FORBIDDEN".into(),
        };

        assert!(bad_gateway.is_retryable());
        assert!(!forbidden.is_retryable());
        assert!(ProxyError::internal("socket closed").is_retryable());
    }

    #[test]
    fn operation_context_keeps_the_original_status() {
        let described = ProxyError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            message: "upstream down".into(),
            code: "BAD_GATEWAY".into(),
        }
        .with_operation("get box public", 3);

        assert_eq!(described.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            described.to_string(),
            "failed to get box public after 3 attempts: upstream down"
        );
    }
}
