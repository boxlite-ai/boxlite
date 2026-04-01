//! Shared error response helpers for coordinator REST API.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

/// Wrapper matching the OpenAPI `ErrorResponse` schema.
#[derive(Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: ErrorModel,
}

/// Error detail matching the OpenAPI `ErrorModel` schema.
#[derive(Serialize, ToSchema)]
pub struct ErrorModel {
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
    pub code: u16,
}

/// Build a structured JSON error response.
pub fn error_response(
    status: StatusCode,
    message: impl Into<String>,
    error_type: &str,
) -> Response {
    (
        status,
        Json(ErrorResponse {
            error: ErrorModel {
                message: message.into(),
                error_type: error_type.to_string(),
                code: status.as_u16(),
            },
        }),
    )
        .into_response()
}

/// Convert a tonic gRPC status to an HTTP error response.
pub fn grpc_to_http_error(status: tonic::Status) -> Response {
    let http_status = match status.code() {
        tonic::Code::NotFound => StatusCode::NOT_FOUND,
        tonic::Code::AlreadyExists => StatusCode::CONFLICT,
        tonic::Code::InvalidArgument => StatusCode::BAD_REQUEST,
        tonic::Code::Unimplemented => StatusCode::NOT_IMPLEMENTED,
        tonic::Code::Unavailable => StatusCode::BAD_GATEWAY,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error_response(http_status, status.message(), "WorkerError")
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    /// Extract status + JSON body from a Response.
    async fn extract(resp: Response) -> (StatusCode, serde_json::Value) {
        let (parts, body) = resp.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (parts.status, json)
    }

    #[tokio::test]
    async fn test_error_response_body_structure() {
        let resp = error_response(StatusCode::NOT_FOUND, "box not found: abc", "NotFoundError");
        let (status, body) = extract(resp).await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["message"], "box not found: abc");
        assert_eq!(body["error"]["type"], "NotFoundError");
        assert_eq!(body["error"]["code"], 404);
    }

    #[tokio::test]
    async fn test_error_response_various_status_codes() {
        for (code, expected_num) in [
            (StatusCode::BAD_REQUEST, 400),
            (StatusCode::NOT_FOUND, 404),
            (StatusCode::CONFLICT, 409),
            (StatusCode::INTERNAL_SERVER_ERROR, 500),
            (StatusCode::NOT_IMPLEMENTED, 501),
            (StatusCode::BAD_GATEWAY, 502),
        ] {
            let resp = error_response(code, "test", "TestError");
            let (status, body) = extract(resp).await;
            assert_eq!(status, code);
            assert_eq!(body["error"]["code"], expected_num);
        }
    }

    #[tokio::test]
    async fn test_error_response_message_preserved() {
        let msg = "very specific error: with special chars <>&";
        let resp = error_response(StatusCode::INTERNAL_SERVER_ERROR, msg, "InternalError");
        let (_, body) = extract(resp).await;
        assert_eq!(body["error"]["message"].as_str().unwrap(), msg);
    }

    #[tokio::test]
    async fn test_grpc_not_found_maps_to_404() {
        let status = tonic::Status::not_found("resource missing");
        let resp = grpc_to_http_error(status);
        let (http_status, body) = extract(resp).await;
        assert_eq!(http_status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], 404);
        assert_eq!(body["error"]["message"], "resource missing");
    }

    #[tokio::test]
    async fn test_grpc_already_exists_maps_to_409() {
        let status = tonic::Status::already_exists("duplicate");
        let resp = grpc_to_http_error(status);
        let (http_status, _) = extract(resp).await;
        assert_eq!(http_status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_grpc_invalid_argument_maps_to_400() {
        let status = tonic::Status::invalid_argument("bad input");
        let resp = grpc_to_http_error(status);
        let (http_status, _) = extract(resp).await;
        assert_eq!(http_status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_grpc_unimplemented_maps_to_501() {
        let status = tonic::Status::unimplemented("not supported");
        let resp = grpc_to_http_error(status);
        let (http_status, _) = extract(resp).await;
        assert_eq!(http_status, StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn test_grpc_unavailable_maps_to_502() {
        let status = tonic::Status::unavailable("service down");
        let resp = grpc_to_http_error(status);
        let (http_status, _) = extract(resp).await;
        assert_eq!(http_status, StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn test_grpc_internal_maps_to_500() {
        let status = tonic::Status::internal("crash");
        let resp = grpc_to_http_error(status);
        let (http_status, body) = extract(resp).await;
        assert_eq!(http_status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"]["type"], "WorkerError");
    }
}
