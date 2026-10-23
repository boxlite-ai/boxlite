use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, Response, StatusCode};
use axum::routing::any;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

#[tokio::test]
async fn private_tunnel_cli_prints_token_before_listening_or_bind_failure() {
    for occupied in [false, true] {
        let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", api_listener.local_addr().unwrap());
        let posts = Arc::new(AtomicUsize::new(0));
        let connects = Arc::new(AtomicUsize::new(0));
        let deletes = Arc::new(AtomicUsize::new(0));
        let tunnel_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tunnel_url = format!("http://{}", tunnel_listener.local_addr().unwrap());
        let tunnel_connects = connects.clone();
        let tunnel_server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = tunnel_listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(socket.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap().to_lowercase();
                assert!(head.starts_with("connect "));
                assert!(head.contains("x-boxlite-authorization: bearer owner-key"));
                tunnel_connects.fetch_add(1, Ordering::SeqCst);
                socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
            }
        });
        let app = axum::Router::new().fallback(any({
            let api_url = tunnel_url.clone(); let posts = posts.clone(); let deletes = deletes.clone();
            move |request: Request<Body>| {
                let api_url = api_url.clone(); let posts = posts.clone(); let deletes = deletes.clone();
                async move {
                    assert_eq!(request.headers()["authorization"], "Bearer owner-key");
                    match *request.method() {
                        Method::GET if request.uri().path() == "/v1/config" => Response::builder().header("Content-Type", "application/json")
                            .body(Body::from(r#"{"capabilities":{"private_tunnels_enabled":true}}"#)).unwrap(),
                        Method::POST => {
                            let body = to_bytes(request.into_body(), 4096).await.unwrap();
                            assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["isPublic"], false);
                            let first = posts.fetch_add(1, Ordering::SeqCst) == 0;
                            let descriptor = serde_json::json!({"uri":api_url,"isPublic":false,"token":if first {"blt_created_secret"} else {"blt_****cret"}});
                            Response::builder().header("Content-Type", "application/json").body(Body::from(descriptor.to_string())).unwrap()
                        }
                        Method::DELETE => { deletes.fetch_add(1, Ordering::SeqCst); Response::builder().status(204).body(Body::empty()).unwrap() }
                        Method::GET => Response::builder().header("Content-Type", "application/json").body(Body::from(serde_json::json!({
                            "box_id":"mybox", "name":"mybox", "status":"running", "created_at":"2026-10-23T00:00:00Z",
                            "updated_at":"2026-10-23T00:00:00Z", "image":"alpine", "cpus":1,"memory_mib":128,
                        }).to_string())).unwrap(),
                        _ => Response::builder().status(StatusCode::NOT_FOUND).body(Body::empty()).unwrap(),
                    }
                }
            }
        }));
        let server = tokio::spawn(async move { axum::serve(api_listener, app).await.unwrap() });
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("credentials.toml"),
            format!("[profiles.cloud]\nurl = \"{api_url}\"\napi_key = \"owner-key\"\n"),
        )
        .unwrap();
        let bound = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listen = if occupied {
            bound.local_addr().unwrap().to_string()
        } else {
            "127.0.0.1:0".to_string()
        };
        let mut child = Command::new(env!("CARGO_BIN_EXE_boxlite"))
            .env("RUST_LOG", "warn")
            .env("BOXLITE_HOME", home.path())
            .env_remove("BOXLITE_API_KEY")
            .env_remove("BOXLITE_REST_URL")
            .args([
                "--profile",
                "cloud",
                "network",
                "tunnel",
                "mybox",
                "3000",
                "--private",
                "--listen",
                &listen,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .expect("descriptor before listen");
        let descriptor: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            descriptor,
            serde_json::json!({"uri":tunnel_url,"isPublic":false,"token":"blt_created_secret"})
        );
        if occupied {
            assert!(
                !tokio::time::timeout(Duration::from_secs(10), child.wait())
                    .await
                    .unwrap()
                    .unwrap()
                    .success()
            );
            assert!(stdout.next_line().await.unwrap().is_none());
        } else {
            let address = tokio::time::timeout(Duration::from_secs(10), stdout.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let socket_address: std::net::SocketAddr =
                address.strip_prefix("tcp://").unwrap().parse().unwrap();
            for _ in 0..2 {
                let mut client = TcpStream::connect(socket_address).await.unwrap();
                let mut byte = [0];
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(5), client.read(&mut byte))
                        .await
                        .unwrap()
                        .unwrap(),
                    0
                );
            }
            if connects.load(Ordering::SeqCst) != 2 {
                child.kill().await.unwrap();
                let output = child.wait_with_output().await.unwrap();
                panic!(
                    "expected two CONNECTs through {address} to {tunnel_url}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            assert!(
                Command::new("/bin/kill")
                    .args(["-INT", &child.id().unwrap().to_string()])
                    .status()
                    .await
                    .unwrap()
                    .success()
            );
            assert!(
                tokio::time::timeout(Duration::from_secs(10), child.wait())
                    .await
                    .unwrap()
                    .unwrap()
                    .success()
            );
            assert!(TcpStream::connect(socket_address).await.is_err());
        }
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        assert_eq!(deletes.load(Ordering::SeqCst), 0);
        server.abort();
        tunnel_server.abort();
    }
}
