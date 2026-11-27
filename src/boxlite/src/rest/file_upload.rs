use std::time::Duration;

use boxlite_shared::{
    BoxByteStream,
    errors::{BoxliteError, BoxliteResult},
};
use futures::{SinkExt, StreamExt, stream::SplitStream};
use reqwest::StatusCode;
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message;

use super::{
    client::{ApiClient, WsStream},
    error::map_http_body,
};

const PROTOCOL: &str = "boxlite-file-upload.v1";
const MESSAGE_SIZE: usize = 256 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(120);
const RESULT_TIMEOUT: Duration = Duration::from_secs(310);

#[derive(Deserialize)]
struct Receipt {
    #[serde(rename = "type")]
    kind: String,
    status: u16,
    error: Option<serde_json::Value>,
}

pub(super) async fn upload(
    client: &ApiClient,
    path: &str,
    mut stream: BoxByteStream,
) -> BoxliteResult<()> {
    let (socket, response) = client.connect_ws_upgrade(path, Some(PROTOCOL)).await?;
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        != Some(PROTOCOL)
    {
        return Err(BoxliteError::Network(
            "file upload WebSocket protocol was not negotiated".into(),
        ));
    }

    let (mut writer, mut reader) = socket.split();
    let send_tar = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| BoxliteError::Storage(error.to_string()))?;
            for message in chunk.chunks(MESSAGE_SIZE) {
                tokio::time::timeout(SEND_TIMEOUT, writer.send(Message::Binary(message.to_vec())))
                    .await
                    .map_err(|_| BoxliteError::Network("file upload stalled while sending".into()))?
                    .map_err(|error| {
                        BoxliteError::Network(format!("file upload send failed: {error}"))
                    })?;
            }
        }
        Ok::<_, BoxliteError>(())
    };

    tokio::select! {
        biased;
        receipt = receive_receipt(&mut reader) => return apply_receipt(receipt?, false),
        send = send_tar => send?,
    }

    let outcome_unknown = || {
        BoxliteError::Network("file upload result was lost after finish; outcome unknown".into())
    };
    // Read while sending finish as well, so a Runner refusal can still win a blocked write.
    let mut finish_started = false;
    let receipt = tokio::time::timeout(RESULT_TIMEOUT, async {
        tokio::select! {
            biased;
            receipt = receive_receipt(&mut reader) => receipt,
            sent = async {
                finish_started = true;
                writer.send(Message::Text("finish".into())).await
            } => {
                sent.map_err(|_| outcome_unknown())?;
                receive_receipt(&mut reader).await
            }
        }
    })
    .await
    .map_err(|_| outcome_unknown())?;

    let receipt = if finish_started {
        receipt.map_err(|_| outcome_unknown())?
    } else {
        receipt?
    };
    apply_receipt(receipt, finish_started)
}

async fn receive_receipt(reader: &mut SplitStream<WsStream>) -> BoxliteResult<Receipt> {
    while let Some(Ok(message)) = reader.next().await {
        match message {
            Message::Text(text) => {
                return serde_json::from_str(&text)
                    .map_err(|_| BoxliteError::Network("invalid file upload result".into()));
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => break,
        }
    }
    Err(BoxliteError::Network(
        "file upload connection closed before a result arrived".into(),
    ))
}

fn apply_receipt(receipt: Receipt, finished: bool) -> BoxliteResult<()> {
    match (receipt.kind.as_str(), StatusCode::from_u16(receipt.status)) {
        ("result", Ok(StatusCode::NO_CONTENT)) if finished && receipt.error.is_none() => Ok(()),
        ("result", Ok(status)) if status.is_client_error() || status.is_server_error() => {
            let body = receipt
                .error
                .map(|error| serde_json::json!({"error": error}).to_string());
            Err(map_http_body(status, body.as_deref().unwrap_or_default()))
        }
        _ => Err(BoxliteError::Network(
            "unexpected file upload result".into(),
        )),
    }
}
