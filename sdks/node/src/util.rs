use boxlite_shared::errors::BoxliteError;
use napi::Error as NapiError;

/// Map BoxliteError to napi Error
/// This is the single source of truth for error conversion (DRY principle)
pub(crate) fn map_err(err: BoxliteError) -> NapiError {
    NapiError::from_reason(format!("{}", err))
}

pub(crate) fn map_outbound_error(error: boxlite::net::OutboundPolicyError) -> NapiError {
    use boxlite::net::OutboundPolicyError;
    match error {
        OutboundPolicyError::Runtime(error) => map_err(error),
        OutboundPolicyError::Request {
            effect,
            status,
            code,
            box_id,
            message,
        } => {
            let details = serde_json::json!({"effect": effect, "status": status, "code": code, "box_id": box_id, "message": message});
            NapiError::from_reason(format!("outbound_policy: {details}"))
        }
    }
}
