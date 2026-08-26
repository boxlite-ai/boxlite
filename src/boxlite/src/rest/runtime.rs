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
    BoxResponse, CreateBoxRequest, CreateVolumeRequest, ListBoxesResponse, ListVolumesResponse,
    RuntimeMetricsResponse, VolumeResponse,
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
}

fn validate_remote_box_options(options: &BoxOptions) -> BoxliteResult<()> {
    if options.ports.is_empty() {
        return Ok(());
    }

    Err(BoxliteError::Unsupported(
        "Host port publication (-p/ports) is local-only for remote runtimes. \
         Use box.network.tunnel(port) or `boxlite network tunnel BOX PORT` instead."
            .to_string(),
    ))
}

#[async_trait::async_trait]
impl AuthBackend for RestRuntime {
    async fn whoami(&self) -> BoxliteResult<Principal> {
        self.client.get_me().await
    }
}

#[async_trait::async_trait]
impl VolumeBackend for RestRuntime {
    async fn create_volume(&self, name: Option<&str>) -> BoxliteResult<VolumeInfo> {
        let request = CreateVolumeRequest {
            name: name.map(str::to_string),
        };
        let resp: VolumeResponse = self.client.post("/volumes", &request).await?;
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

/// Host-only RC options a REST server never accepts from a client: they
/// configure the server's own hardware, not the box the caller asked for.
fn reject_remote_experimental_options(options: &BoxOptions) -> BoxliteResult<()> {
    if options.advanced.kernel.is_some() {
        return Err(BoxliteError::Unsupported(
            "custom kernels are only supported by the local runtime".to_string(),
        ));
    }

    if options.advanced.nested_virtualization {
        return Err(BoxliteError::Unsupported(
            "nested virtualization is only supported by the local runtime".to_string(),
        ));
    }

    Ok(())
}

/// Check the mounts a REST runtime was asked for.
///
/// Two things happen here, and neither happens anywhere else on this path:
/// `BoxOptions::sanitize` is local-only, so `VolumeSpec::validate` — the
/// "exactly one origin" invariant that C and Go callers can violate by setting
/// the fields directly — has no other chance to run before the request goes out.
///
/// A host bind then has no meaning against a REST runtime: the path names the
/// *server's* filesystem, not the caller's. The rejected path is deliberately
/// not quoted back — the caller already knows what they asked for, and echoing
/// a server-side path into a client error is a leak, not a diagnostic.
fn validate_remote_volumes(options: &BoxOptions) -> BoxliteResult<()> {
    for volume in &options.volumes {
        volume.validate()?;
    }

    if options
        .volumes
        .iter()
        .any(|volume| volume.managed_volume.is_none())
    {
        return Err(BoxliteError::Unsupported(
            "host bind mounts are only supported by the local runtime; mount a managed volume \
             by id or name instead"
                .to_string(),
        ));
    }

    // The server rejects `read_only: true` on a managed mount. Refusing here
    // says so plainly instead of surfacing a field-level 400, and — more to the
    // point — never lets a caller believe a writable mount is protected.
    if let Some(volume) = options
        .volumes
        .iter()
        .find(|volume| volume.read_only)
        .and_then(|volume| volume.managed_volume.as_deref())
    {
        return Err(BoxliteError::Unsupported(format!(
            "read-only managed volumes are not supported yet; mount {volume:?} read-write"
        )));
    }

    Ok(())
}

#[async_trait::async_trait]
impl RuntimeBackend for RestRuntime {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox> {
        validate_remote_box_options(&options)?;
        reject_remote_experimental_options(&options)?;
        validate_remote_volumes(&options)?;

        // Validate only the caller's requested policy. An unset auto_stop means
        // "no auto-stop", so it must not borrow the server's default here —
        // otherwise a plain remove-on-stop box (`--rm` → auto_delete=1) is
        // wrongly rejected by the ordering check before the request is even sent.
        crate::runtime::types::BoxLifecyclePolicy {
            auto_stop: options.auto_stop.unwrap_or(0),
            auto_delete: options.auto_delete.unwrap_or(0),
            auto_resume: options.auto_resume.unwrap_or(true),
        }
        .validate()?;

        // A server that does not advertise the capability policy would accept
        // the request and drop the field, silently granting default privileges.
        // `Some` alone is the trigger, even an explicitly empty policy: the
        // caller configured something, and a server that can't represent the
        // concept at all can't be trusted to preserve that from a no-op value.
        if options.advanced.capabilities().is_some() {
            self.client.require_linux_capabilities_enabled().await?;
        }

        let req = CreateBoxRequest::from_options(&options, name);
        let resp: BoxResponse = self.client.post("/boxes", &req).await?;
        let info = resp.to_box_info()?;
        let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
        Ok(litebox_from_rest(rest_box))
    }

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        validate_remote_box_options(&options)?;
        reject_remote_experimental_options(&options)?;
        validate_remote_volumes(&options)?;

        // Try to get existing box by name first
        if let Some(ref box_name) = name
            && let Some(litebox) = self.get(box_name).await?
        {
            return Ok((litebox, false));
        }
        // Create new box
        let litebox = self.create(options, name).await?;
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
    use crate::runtime::options::{PortProtocol, PortSpec};

    #[test]
    fn remote_runtime_rejects_host_port_publication_with_tunnel_guidance() {
        let options = BoxOptions {
            ports: vec![PortSpec {
                host_port: None,
                guest_port: 3000,
                protocol: PortProtocol::Tcp,
                host_ip: None,
            }],
            ..Default::default()
        };

        let err = validate_remote_box_options(&options).unwrap_err();
        assert!(err.to_string().contains("-p/ports"));
        assert!(err.to_string().contains("network.tunnel"));
        assert!(err.to_string().contains("boxlite network tunnel"));
    }

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const BOX_RESPONSE: &str = r#"{"box_id":"01HJK4TNRPQSXYZ8WM6NCVT9R5","name":"named","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":2,"memory_mib":512,"labels":{}}"#;

    fn capability_options() -> BoxOptions {
        let mut advanced = crate::AdvancedBoxOptions::default();
        advanced
            .set_capabilities(Some(crate::ContainerCapabilities {
                drop: vec!["NET_RAW".into()],
                ..Default::default()
            }))
            .unwrap();
        BoxOptions {
            advanced,
            ..Default::default()
        }
    }

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
    async fn create_allows_remove_on_stop_without_autostop() {
        // `run --rm` maps to auto_delete=1 with no auto_stop. The client must
        // validate only the caller's requested policy — not the server's auto_stop
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
                .contains("auto_delete must be greater than auto_stop"),
            "remove-on-stop without auto_stop must pass client validation; got: {err}"
        );
    }

    #[tokio::test]
    async fn custom_capabilities_require_server_advertisement_before_create() {
        // A server that does not advertise the feature would accept the create
        // request and drop `advanced`, silently granting default privileges.
        let (port, server) = json_server(vec![r#"{"capabilities":{}}"#]).await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();

        let error = match RuntimeBackend::create(&runtime, capability_options(), None).await {
            Err(error) => error,
            Ok(_) => panic!("an old server must not silently ignore a capability policy"),
        };

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert_eq!(server.await.unwrap(), ["GET /v1/config HTTP/1.1"]);
    }

    /// An explicitly empty policy is still explicit — the caller configured
    /// something, even if it happens to be a no-op value. A server that
    /// can't advertise the capability feature at all can't be trusted to
    /// honor that distinction either, so this must still be probed for.
    #[tokio::test]
    async fn explicit_empty_capabilities_still_require_server_advertisement() {
        let (port, server) = json_server(vec![r#"{"capabilities":{}}"#]).await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();

        let mut advanced = crate::AdvancedBoxOptions::default();
        advanced
            .set_capabilities(Some(crate::ContainerCapabilities::default()))
            .unwrap();
        let opts = BoxOptions {
            advanced,
            ..Default::default()
        };

        let error = match RuntimeBackend::create(&runtime, opts, None).await {
            Err(error) => error,
            Ok(_) => panic!("an explicit, even empty, capability policy must still be probed for"),
        };

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert_eq!(server.await.unwrap(), ["GET /v1/config HTTP/1.1"]);
    }

    #[tokio::test]
    async fn advertised_capability_support_creates_on_the_shared_route() {
        let (port, server) = json_server(vec![
            r#"{"capabilities":{"linux_capabilities_enabled":true}}"#,
            BOX_RESPONSE,
        ])
        .await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();

        RuntimeBackend::create(&runtime, capability_options(), None)
            .await
            .expect("create with a capability policy");

        assert_eq!(
            server.await.unwrap(),
            ["GET /v1/config HTTP/1.1", "POST /v1/boxes HTTP/1.1"]
        );
    }

    #[tokio::test]
    async fn ordinary_create_does_not_probe_server_capabilities() {
        let (port, server) = json_server(vec![BOX_RESPONSE]).await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();

        RuntimeBackend::create(&runtime, BoxOptions::default(), None)
            .await
            .expect("create without a capability policy");

        assert_eq!(server.await.unwrap(), ["POST /v1/boxes HTTP/1.1"]);
    }

    /// Inspection reads the shared routes. Addressing a versioned variant here
    /// would 404, and `get` maps NotFound to `Ok(None)` — so an existing box
    /// would silently report as missing rather than failing loudly.
    #[tokio::test]
    async fn inspection_uses_the_shared_box_routes() {
        let (port, server) = json_server(vec![BOX_RESPONSE, BOX_RESPONSE]).await;
        let runtime =
            RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();

        let found = RuntimeBackend::get(&runtime, "named").await.expect("get");
        let info = RuntimeBackend::get_info(&runtime, "named")
            .await
            .expect("get_info");

        assert!(found.is_some(), "an existing box must not read as missing");
        assert!(info.is_some(), "an existing box must expose its info");
        assert_eq!(
            server.await.unwrap(),
            [
                "GET /v1/boxes/named HTTP/1.1",
                "GET /v1/boxes/named HTTP/1.1"
            ]
        );
    }

    #[tokio::test]
    async fn create_rejects_custom_kernel_for_rest_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let kernel = temp.path().join("vmlinux");
        std::fs::write(&kernel, b"custom kernel").unwrap();
        let options = BoxliteRestOptions::new("http://localhost:1");
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
        let mut advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        advanced.kernel = Some(crate::experimental::custom_kernel::KernelOptions::new(
            kernel,
        ));
        let opts = BoxOptions {
            advanced,
            ..Default::default()
        };

        let error = RuntimeBackend::create(&runtime, opts, None)
            .await
            .err()
            .expect("REST runtime must reject a host-local custom kernel path");

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert!(error.to_string().contains("local runtime"));
    }

    #[tokio::test]
    async fn create_rejects_nested_virtualization_in_rest_mode() {
        let options = BoxliteRestOptions::new("http://localhost:1");
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
        let mut advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        advanced.nested_virtualization = true;
        let box_options = BoxOptions {
            advanced,
            ..Default::default()
        };

        let error = RuntimeBackend::create(&runtime, box_options, None)
            .await
            .err()
            .expect("REST nested virtualization must be rejected before network I/O");

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert!(error.to_string().contains("local runtime"));
    }

    /// A host path has no meaning against a REST runtime — the server's
    /// filesystem is not the caller's. The path must not leave the client at
    /// all: it is the caller's own business, and a server-side "not found"
    /// naming it would leak it into logs on the way back.
    #[tokio::test]
    async fn create_rejects_host_bind_mount_in_rest_mode() {
        use crate::runtime::options::VolumeSpec;

        let options = BoxliteRestOptions::new("http://localhost:1");
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
        let box_options = BoxOptions {
            volumes: vec![VolumeSpec::host_path("/tmp/secrets", "/mnt/ro")],
            ..Default::default()
        };

        let error = RuntimeBackend::create(&runtime, box_options, None)
            .await
            .err()
            .expect("REST host bind mounts must be rejected before network I/O");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("host bind mounts"));
        assert!(
            !error.to_string().contains("/tmp/secrets"),
            "the rejected host path must not be echoed back: {error}"
        );
    }

    /// The server rejects `read_only: true` on a managed mount. Refusing it
    /// here keeps a caller from believing a writable mount is protected — the
    /// failure mode that matters is the silent downgrade, not the 400.
    #[tokio::test]
    async fn create_rejects_read_only_managed_volume() {
        use crate::runtime::options::VolumeSpec;

        let options = BoxliteRestOptions::new("http://localhost:1");
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
        let box_options = BoxOptions {
            volumes: vec![VolumeSpec {
                read_only: true,
                ..VolumeSpec::managed_volume("my-data", "/data")
            }],
            ..Default::default()
        };

        let error = RuntimeBackend::create(&runtime, box_options, None)
            .await
            .err()
            .expect("read-only managed volumes must be rejected before network I/O");

        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        assert!(error.to_string().contains("read-only"), "{error}");
    }

    /// The guard is about host paths, not about mounts: a managed volume gets
    /// past it and on to the request, addressed by id or by name alike.
    #[tokio::test]
    async fn create_accepts_managed_volume_by_id_or_name() {
        use crate::runtime::options::VolumeSpec;

        for reference in ["vol_01K2EXAMPLE", "my-data"] {
            let options = BoxliteRestOptions::new("http://localhost:1");
            let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
            let box_options = BoxOptions {
                volumes: vec![VolumeSpec::managed_volume(reference, "/data")],
                ..Default::default()
            };

            // localhost:1 refuses the connection, so reaching *any* transport
            // error is the proof that the mount cleared client-side validation.
            let error = RuntimeBackend::create(&runtime, box_options, None)
                .await
                .err()
                .expect("no server is listening on localhost:1");

            assert!(
                !matches!(error, BoxliteError::Unsupported(_)),
                "managed volume {reference:?} must not be refused client-side: {error:?}"
            );
        }
    }

    #[tokio::test]
    async fn get_or_create_rejects_custom_kernel_for_rest_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let kernel = temp.path().join("vmlinux");
        std::fs::write(&kernel, b"custom kernel").unwrap();
        let options = BoxliteRestOptions::new("http://localhost:1");
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
        let mut advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        advanced.kernel = Some(crate::experimental::custom_kernel::KernelOptions::new(
            kernel,
        ));
        let opts = BoxOptions {
            advanced,
            ..Default::default()
        };

        let error = RuntimeBackend::get_or_create(&runtime, opts, Some("custom".to_string()))
            .await
            .err()
            .expect("REST runtime must reject a custom kernel before lookup");

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert!(error.to_string().contains("local runtime"));
    }

    #[tokio::test]
    async fn get_or_create_rejects_nested_virtualization_in_rest_mode() {
        let options = BoxliteRestOptions::new("http://localhost:1");
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");
        let mut advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        advanced.nested_virtualization = true;
        let box_options = BoxOptions {
            advanced,
            ..Default::default()
        };

        let error =
            RuntimeBackend::get_or_create(&runtime, box_options, Some("nested".to_string()))
                .await
                .err()
                .expect("REST nested virtualization must be rejected before network I/O");

        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert!(error.to_string().contains("local runtime"));
    }
}
