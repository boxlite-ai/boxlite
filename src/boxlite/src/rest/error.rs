//! HTTP error → BoxliteError mapping.

use boxlite_shared::errors::BoxliteError;
use reqwest::StatusCode;

use super::types::ErrorModel;

/// Map an HTTP error response to a BoxliteError.
pub(crate) fn map_http_error(status: StatusCode, body: &ErrorModel) -> BoxliteError {
    match (status.as_u16(), body.error_type.as_str()) {
        (404, _) => BoxliteError::NotFound(body.message.clone()),
        (409, "AlreadyExistsError") => BoxliteError::AlreadyExists(body.message.clone()),
        (409, "InvalidStateError") => BoxliteError::InvalidState(body.message.clone()),
        (409, "StoppedError") => BoxliteError::Stopped(body.message.clone()),
        (400, _) => BoxliteError::InvalidArgument(body.message.clone()),
        (422, "ImageError") => BoxliteError::Image(body.message.clone()),
        (422, _) => BoxliteError::InvalidArgument(body.message.clone()),
        (401 | 403, _) => BoxliteError::Config(format!("auth: {}", body.message)),
        _ => BoxliteError::Internal(format!("HTTP {}: {}", status, body.message)),
    }
}

/// Map an HTTP error when we can't parse the body.
pub(crate) fn map_http_status(status: StatusCode, text: &str) -> BoxliteError {
    match status.as_u16() {
        404 => BoxliteError::NotFound(text.to_string()),
        401 | 403 => BoxliteError::Config(format!("auth: {}", text)),
        _ => BoxliteError::Internal(format!("HTTP {}: {}", status, text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_model(msg: &str, error_type: &str, code: u16) -> ErrorModel {
        ErrorModel {
            message: msg.to_string(),
            error_type: error_type.to_string(),
            code,
        }
    }

    #[test]
    fn test_404_maps_to_not_found() {
        let err = map_http_error(
            StatusCode::NOT_FOUND,
            &error_model("box xyz not found", "NotFoundError", 404),
        );
        assert!(matches!(err, BoxliteError::NotFound(_)));
    }

    #[test]
    fn test_409_already_exists() {
        let err = map_http_error(
            StatusCode::CONFLICT,
            &error_model("box already exists", "AlreadyExistsError", 409),
        );
        assert!(matches!(err, BoxliteError::AlreadyExists(_)));
    }

    #[test]
    fn test_409_invalid_state() {
        let err = map_http_error(
            StatusCode::CONFLICT,
            &error_model("box is stopped", "InvalidStateError", 409),
        );
        assert!(matches!(err, BoxliteError::InvalidState(_)));
    }

    #[test]
    fn test_409_stopped() {
        let err = map_http_error(
            StatusCode::CONFLICT,
            &error_model("box is stopped", "StoppedError", 409),
        );
        assert!(matches!(err, BoxliteError::Stopped(_)));
    }

    #[test]
    fn test_400_invalid_argument() {
        let err = map_http_error(
            StatusCode::BAD_REQUEST,
            &error_model("invalid cpus", "ValidationError", 400),
        );
        assert!(matches!(err, BoxliteError::InvalidArgument(_)));
    }

    #[test]
    fn test_422_image_error() {
        let err = map_http_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            &error_model("image not found", "ImageError", 422),
        );
        assert!(matches!(err, BoxliteError::Image(_)));
    }

    #[test]
    fn test_401_auth_error() {
        let err = map_http_error(
            StatusCode::UNAUTHORIZED,
            &error_model("invalid token", "AuthError", 401),
        );
        assert!(matches!(err, BoxliteError::Config(_)));
    }

    #[test]
    fn test_500_internal_error() {
        let err = map_http_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &error_model("server error", "InternalError", 500),
        );
        assert!(matches!(err, BoxliteError::Internal(_)));
    }

    #[test]
    fn test_map_status_fallback() {
        let err = map_http_status(StatusCode::NOT_FOUND, "not found");
        assert!(matches!(err, BoxliteError::NotFound(_)));

        let err = map_http_status(StatusCode::FORBIDDEN, "forbidden");
        assert!(matches!(err, BoxliteError::Config(_)));

        let err = map_http_status(StatusCode::INTERNAL_SERVER_ERROR, "oops");
        assert!(matches!(err, BoxliteError::Internal(_)));
    }
}
