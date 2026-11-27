use super::tests::{read_request_head, rest_box_for};
use boxlite_shared::errors::BoxliteError;
use futures::{SinkExt, StreamExt, stream};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpListener};
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{Request, Response},
};

const SELECT_PROTOCOL: &str = "boxlite-file-upload.v1";

async fn reply_to_config(listener: &TcpListener, response: &str) {
    let (mut connection, _) = listener.accept().await.unwrap();
    let head = read_request_head(&mut connection).await;
    assert!(head.starts_with(b"GET /v1/config "));
    connection.write_all(response.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn html_413_upload_error_keeps_the_status_and_omits_the_page() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bx = rest_box_for(listener.local_addr().unwrap().port(), "box1");
    let server = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut head = read_request_head(&mut connection).await;
        if head.starts_with(b"GET /v1/config ") {
            connection
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            (connection, _) = listener.accept().await.unwrap();
            head = read_request_head(&mut connection).await;
        }
        assert!(head.starts_with(b"PUT /v1/boxes/box1/files?"));
        connection.write_all(b"HTTP/1.1 413 Payload Too Large\r\nContent-Type: text/html\r\nContent-Length: 22\r\nConnection: close\r\n\r\n<html>too large</html>").await.unwrap();
    });
    let error = bx
        .upload_stream(Box::pin(stream::empty()), "/tmp/upload")
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("413") && !error.contains("<html>"),
        "{error}"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn websocket_file_upload_completion_and_early_refusal() {
    for receipt in [Some(204), Some(400), None] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bx = rest_box_for(listener.local_addr().unwrap().port(), "box1");
        let server = tokio::spawn(async move {
            let config = r#"{"capabilities":{"file_upload_ws_enabled":true}}"#;
            reply_to_config(
                &listener,
                &format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{config}",
                    config.len()
                ),
            )
            .await;
            let (connection, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                connection,
                |request: &Request, mut response: Response| {
                    assert_eq!(
                        request.uri().path_and_query().unwrap().as_str(),
                        "/v1/boxes/box1/files/ws?path=%2Ftmp%2Fwith%20space"
                    );
                    assert_eq!(request.headers()["Sec-WebSocket-Protocol"], SELECT_PROTOCOL);
                    response
                        .headers_mut()
                        .insert("Sec-WebSocket-Protocol", SELECT_PROTOCOL.parse().unwrap());
                    Ok(response)
                },
            )
            .await
            .unwrap();
            if receipt == Some(400) {
                let refusal = r#"{"type":"result","status":400,"error":{"code":"unsupported","message":"cannot upload here"}}"#;
                ws.send(Message::Text(refusal.into())).await.unwrap();
                return;
            }
            for size in [256 * 1024, 3] {
                assert_eq!(
                    ws.next().await.unwrap().unwrap(),
                    Message::Binary(vec![42; size])
                );
            }
            assert_eq!(
                ws.next().await.unwrap().unwrap(),
                Message::Text("finish".into())
            );
            if receipt == Some(204) {
                ws.send(Message::Text(r#"{"type":"result","status":204}"#.into()))
                    .await
                    .unwrap();
            }
        });
        let stream = if receipt == Some(400) {
            // Receiving the refusal must interrupt even a source waiting for its first chunk.
            Box::pin(stream::pending()) as boxlite_shared::BoxByteStream
        } else {
            Box::pin(stream::iter([Ok(vec![42; 256 * 1024 + 3])]))
        };
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            bx.upload_stream(stream, "/tmp/with space"),
        )
        .await
        .expect("upload stalled");
        match receipt {
            Some(204) => result.unwrap(),
            Some(400) => assert!(
                matches!(result, Err(BoxliteError::Unsupported(message)) if message == "cannot upload here")
            ),
            _ => assert!(
                matches!(result, Err(BoxliteError::Network(message)) if message.contains("outcome unknown"))
            ),
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn absent_or_disabled_file_upload_capability_falls_back_to_http() {
    for config in [
        r#"{}"#,
        r#"{"capabilities":{"file_upload_ws_enabled":false}}"#,
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bx = rest_box_for(listener.local_addr().unwrap().port(), "box1");
        let server = tokio::spawn(async move {
            reply_to_config(
                &listener,
                &format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{config}",
                    config.len()
                ),
            )
            .await;
            let (mut connection, _) = listener.accept().await.unwrap();
            let head = read_request_head(&mut connection).await;
            assert!(head.starts_with(b"PUT /v1/boxes/box1/files?path=%2Ftmp%2Fout "));
            connection
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        bx.upload_stream(Box::pin(stream::empty()), "/tmp/out")
            .await
            .unwrap();
        server.await.unwrap();
    }
}
