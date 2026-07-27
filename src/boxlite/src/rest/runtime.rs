//! RestRuntime — implements RuntimeBackend for the REST API.

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::metrics::RuntimeMetrics;
use crate::runtime::backend::RuntimeBackend;
use crate::runtime::options::{BoxArchive, BoxOptions};
use crate::{BoxInfo, LiteBox};

use super::client::ApiClient;
use super::litebox::RestBox;
use super::options::BoxliteRestOptions;
use super::types::{
    BoxResponse, CreateBoxRequest, CreateVolumeRequest, GetOrCreateBoxResponse, ListBoxesResponse,
    ListVolumesResponse, RuntimeMetricsResponse, VolumeResponse,
};
use crate::runtime::auth::{AuthBackend, Principal};
use crate::runtime::volumes::VolumeBackend;
use crate::volumes::VolumeInfo;

pub(crate) struct RestRuntime {
    client: ApiClient,
}

impl RestRuntime {
    pub fn new(config: &BoxliteRestOptions) -> BoxliteResult<Self> {
        let client = ApiClient::new(config)?;
        Ok(Self { client })
    }

    async fn create_with_contract(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        // Validate only the caller's requested policy. An unset auto_pause means
        // "no auto-pause", so it must not borrow the server's default here.
        crate::runtime::types::BoxLifecyclePolicy {
            auto_pause: options.auto_pause.unwrap_or(0),
            auto_delete: options.auto_delete.unwrap_or(0),
            auto_resume: options.auto_resume.unwrap_or(true),
        }
        .validate()?;

        let has_capability_policy = !options.advanced.capabilities.is_empty();
        if has_capability_policy {
            self.client.require_linux_capabilities_enabled().await?;
        }

        let req = CreateBoxRequest::from_options(&options, name);
        // The strict route was introduced with capability policy support. An
        // older API instance returns 404 rather than accepting security-sensitive
        // fields it does not understand.
        let uses_strict_contract = has_capability_policy;
        let create_path = if uses_strict_contract {
            "/boxes/strict"
        } else {
            "/boxes"
        };
        let resp: BoxResponse = self.client.post(create_path, &req).await?;
        let info = resp.to_box_info()?;
        let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
        Ok(litebox_from_rest(rest_box))
    }
}

#[async_trait::async_trait]
impl AuthBackend for RestRuntime {
    async fn whoami(&self) -> BoxliteResult<Principal> {
        self.client.get_me().await
    }
}

#[async_trait::async_trait]
impl VolumeBackend for RestRuntime {
    async fn create_volume(&self) -> BoxliteResult<VolumeInfo> {
        let resp: VolumeResponse = self
            .client
            .post("/volumes", &CreateVolumeRequest {})
            .await?;
        Ok(resp.to_volume_info())
    }

    async fn list_volumes(&self) -> BoxliteResult<Vec<VolumeInfo>> {
        let resp: ListVolumesResponse = self.client.get("/volumes").await?;
        Ok(resp.volumes.iter().map(|v| v.to_volume_info()).collect())
    }

    async fn get_volume(&self, id: &str) -> BoxliteResult<VolumeInfo> {
        let path = format!("/volumes/{}", id);
        let resp: VolumeResponse = self.client.get(&path).await?;
        Ok(resp.to_volume_info())
    }

    async fn remove_volume(&self, id: &str, force: bool) -> BoxliteResult<()> {
        let path = format!("/volumes/{}", id);
        if force {
            self.client
                .delete_with_query(&path, &[("force", "true")])
                .await
        } else {
            self.client.delete(&path).await
        }
    }
}

fn litebox_from_rest(rest_box: Arc<RestBox>) -> LiteBox {
    let box_backend: Arc<dyn crate::runtime::backend::BoxBackend> = rest_box.clone();
    let network_backend: Arc<dyn crate::runtime::backend::BoxNetworkBackend> = rest_box.clone();
    let snapshot_backend: Arc<dyn crate::runtime::backend::SnapshotBackend> = rest_box;
    LiteBox::new(box_backend, network_backend, snapshot_backend)
}

#[async_trait::async_trait]
impl RuntimeBackend for RestRuntime {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox> {
        self.create_with_contract(options, name).await
    }

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        if name.is_some() {
            crate::runtime::types::BoxLifecyclePolicy {
                auto_pause: options.auto_pause.unwrap_or(0),
                auto_delete: options.auto_delete.unwrap_or(0),
                auto_resume: options.auto_resume.unwrap_or(true),
            }
            .validate()?;

            if !options.advanced.capabilities.is_empty() {
                self.client.require_linux_capabilities_enabled().await?;
            }

            let request = CreateBoxRequest::from_options(&options, name);
            let response: GetOrCreateBoxResponse = self
                .client
                .post("/boxes/get-or-create/strict", &request)
                .await?;
            let info = response.box_info.to_box_info()?;
            let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
            return Ok((litebox_from_rest(rest_box), response.created));
        }

        let litebox = self.create_with_contract(options, name).await?;
        Ok((litebox, true))
    }

    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>> {
        let path = format!("/boxes/{id_or_name}");
        match self.client.get::<BoxResponse>(&path).await {
            Ok(resp) => {
                let info = resp.to_box_info()?;
                let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
                Ok(Some(litebox_from_rest(rest_box)))
            }
            Err(BoxliteError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>> {
        let path = format!("/boxes/{id_or_name}");
        match self.client.get::<BoxResponse>(&path).await {
            Ok(resp) => Ok(Some(resp.to_box_info()?)),
            Err(BoxliteError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>> {
        let resp: ListBoxesResponse = self.client.get("/boxes").await?;
        resp.boxes.iter().map(BoxResponse::to_box_info).collect()
    }

    async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool> {
        let path = format!("/boxes/{}", id_or_name);
        self.client.head_exists(&path).await
    }

    async fn metrics(&self) -> BoxliteResult<RuntimeMetrics> {
        let resp: RuntimeMetricsResponse = self.client.get("/metrics").await?;
        Ok(runtime_metrics_from_response(&resp))
    }

    async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        let path = format!("/boxes/{}", id_or_name);
        if force {
            self.client
                .delete_with_query(&path, &[("force", "true")])
                .await
        } else {
            self.client.delete(&path).await
        }
    }

    async fn shutdown(&self, _timeout: Option<i32>) -> BoxliteResult<()> {
        // REST client doesn't own the server — shutdown is a no-op.
        // The server manages its own lifecycle.
        Ok(())
    }

    async fn import_box(
        &self,
        archive: BoxArchive,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.client.require_import_enabled().await?;

        let archive_bytes = std::fs::read(archive.path()).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read archive {}: {}",
                archive.path().display(),
                e
            ))
        })?;

        let query: Vec<(&str, &str)> = name
            .as_deref()
            .map(|n| vec![("name", n)])
            .unwrap_or_default();

        let resp: BoxResponse = self
            .client
            .post_bytes_for_json("/boxes/import", archive_bytes, &query)
            .await?;

        let info = resp.to_box_info()?;
        let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
        Ok(litebox_from_rest(rest_box))
    }
}

/// Convert REST metrics response to core RuntimeMetrics.
fn runtime_metrics_from_response(resp: &RuntimeMetricsResponse) -> RuntimeMetrics {
    use crate::metrics::RuntimeMetricsStorage;
    use std::sync::atomic::Ordering;

    let storage = RuntimeMetricsStorage::new();
    storage
        .boxes_created
        .store(resp.boxes_created_total, Ordering::Relaxed);
    storage
        .boxes_failed
        .store(resp.boxes_failed_total, Ordering::Relaxed);
    storage
        .boxes_stopped
        .store(resp.boxes_stopped_total, Ordering::Relaxed);
    storage
        .total_commands
        .store(resp.total_commands_executed, Ordering::Relaxed);
    storage
        .total_exec_errors
        .store(resp.total_exec_errors, Ordering::Relaxed);

    RuntimeMetrics::new(storage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn json_server(bodies: Vec<&'static str>) -> (u16, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for body in bodies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
                let request = String::from_utf8(headers).unwrap();
                requests.push(request.lines().next().unwrap().to_string());
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            requests
        });
        (port, server)
    }

    #[tokio::test]
    async fn test_import_box_requires_capability() {
        // Without a running server, import_box should fail with a connection error
        // (it tries to check capabilities first). This verifies the code path is wired up.
        let options = BoxliteRestOptions::new("http://localhost:1"); // unreachable port
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");

        let result = RuntimeBackend::import_box(
            &runtime,
            BoxArchive::new("/tmp/ignored.boxlite"),
            Some("x".to_string()),
        )
        .await;

        // Should fail trying to reach the server for capability check
        assert!(result.is_err(), "Expected error when server is unreachable");
    }

    #[tokio::test]
    async fn create_allows_remove_on_stop_without_autopause() {
        // `run --rm` maps to auto_delete=1 with no auto_pause. The client must
        // validate only the caller's requested policy — not the server's auto_pause
        // default — so a remove-on-stop box is not rejected before the request is
        // sent. With the server unreachable, a passing validation surfaces as a
        // connection error, never the lifecycle-ordering error.
        let options = BoxliteRestOptions::new("http://localhost:1"); // unreachable port
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");

        let opts = BoxOptions {
            auto_delete: Some(1),
            ..Default::default()
        };
        let err = RuntimeBackend::create(&runtime, opts, None)
            .await
            .err()
            .expect("unreachable server must yield an error");

        assert!(
            !err.to_string()
                .contains("auto_delete must be greater than auto_pause"),
            "remove-on-stop without auto_pause must pass client validation; got: {err}"
        );
    }

    #[tokio::test]
    async fn custom_capabilities_require_server_advertisement_before_create() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(socket.read_u8().await.unwrap());
            }
            let request = String::from_utf8(headers).unwrap();
            let body = r#"{"capabilities":{}}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request.lines().next().unwrap().to_string()
        });

        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        let result = RuntimeBackend::create(
            &runtime,
            BoxOptions {
                advanced: crate::AdvancedBoxOptions {
                    capabilities: crate::ContainerCapabilities {
                        drop: vec!["NET_RAW".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            None,
        )
        .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("an old server must not silently ignore a capability policy"),
        };

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert_eq!(server.await.unwrap(), "GET /v1/config HTTP/1.1");
    }

    #[tokio::test]
    async fn custom_capabilities_use_strict_create_route() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for body in [
                r#"{"capabilities":{"linux_capabilities_enabled":true}}"#,
                r#"{"box_id":"01HJK4TNRPQSXYZ8WM6NCVT9R5","name":null,"status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":2,"memory_mib":512,"labels":{}}"#,
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
                let request = String::from_utf8(headers).unwrap();
                requests.push(request.lines().next().unwrap().to_string());
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            requests
        });

        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        RuntimeBackend::create(
            &runtime,
            BoxOptions {
                advanced: crate::AdvancedBoxOptions {
                    capabilities: crate::ContainerCapabilities {
                        add: vec!["SYS_ADMIN".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            server.await.unwrap(),
            ["GET /v1/config HTTP/1.1", "POST /v1/boxes/strict HTTP/1.1"]
        );
    }

    #[tokio::test]
    async fn strict_create_does_not_recheck_server_options() {
        let (port, server) = json_server(vec![
            r#"{"capabilities":{"linux_capabilities_enabled":true}}"#,
            r#"{"box_id":"01HJK4TNRPQSXYZ8WM6NCVT9R5","name":null,"status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":2,"memory_mib":512,"labels":{}}"#,
        ])
        .await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        RuntimeBackend::create(
            &runtime,
            BoxOptions {
                advanced: crate::AdvancedBoxOptions {
                    capabilities: crate::ContainerCapabilities {
                        add: vec!["NET_ADMIN".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            server.await.unwrap(),
            ["GET /v1/config HTTP/1.1", "POST /v1/boxes/strict HTTP/1.1"]
        );
    }

    #[tokio::test]
    async fn strict_create_accepts_response_without_capability_policy() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for body in [
                r#"{"capabilities":{"linux_capabilities_enabled":true}}"#,
                r#"{"box_id":"01HJK4TNRPQSXYZ8WM6NCVT9R5","name":null,"status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":2,"memory_mib":512,"labels":{}}"#,
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        RuntimeBackend::create(
            &runtime,
            BoxOptions {
                advanced: crate::AdvancedBoxOptions {
                    capabilities: crate::ContainerCapabilities {
                        drop: vec!["NET_RAW".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn get_or_create_accepts_response_without_capability_policy() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(socket.read_u8().await.unwrap());
            }
            let request = String::from_utf8(headers).unwrap();
            let body = r#"{"box_info":{"box_id":"01HJK4TNRPQSXYZ8WM6NCVT9R5","name":"named","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":2,"memory_mib":512,"labels":{}},"created":false}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request.lines().next().unwrap().to_string()
        });

        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        let (_, created) =
            RuntimeBackend::get_or_create(&runtime, BoxOptions::default(), Some("named".into()))
                .await
                .unwrap();

        assert!(!created);
        assert_eq!(
            server.await.unwrap(),
            "POST /v1/boxes/get-or-create/strict HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn get_or_create_does_not_recheck_server_options() {
        let (port, server) = json_server(vec![
            r#"{"box_info":{"box_id":"01HJK4TNRPQSXYZ8WM6NCVT9R5","name":"named","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":2,"memory_mib":512,"labels":{}},"created":false}"#,
        ])
        .await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        let (_, created) = RuntimeBackend::get_or_create(
            &runtime,
            BoxOptions::default(),
            Some("named".to_string()),
        )
        .await
        .unwrap();

        assert!(!created);
        assert_eq!(
            server.await.unwrap(),
            ["POST /v1/boxes/get-or-create/strict HTTP/1.1"]
        );
    }
}
