//! Native directory delivery through vmm.sock and the guest RPC bridge.

#![cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]

mod common;

use boxlite::runtime::options::{BoxliteOptions, NetworkSpec};
use boxlite::vmm::controller::mount_control::MountControlClient;
use boxlite::{BoxCommand, LiteBox};
use boxlite_shared::{ContainerClient, ContainerDetachRequest, ContainerMountRequest};
use futures::StreamExt;
use hyper_util::rt::TokioIo;
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
    time::Duration,
};
use tonic::transport::{Channel, Endpoint};

async fn control<T: Send + 'static>(
    socket: &Path,
    operation: impl FnOnce(&MountControlClient) -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    let socket = socket.to_owned();
    tokio::task::spawn_blocking(move || operation(&MountControlClient::new(socket)))
        .await
        .expect("control task")
}

async fn run(bx: &LiteBox, script: &str) -> (i32, String) {
    let mut execution = bx
        .exec(BoxCommand::new("sh").args(["-c", script]))
        .await
        .unwrap();
    let mut output = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            output.push_str(&chunk);
        }
    }
    (execution.wait().await.unwrap().exit_code, output)
}

async fn guest(socket: PathBuf) -> ContainerClient<Channel> {
    let channel = Endpoint::from_static("http://[::]:50051")
        .connect_timeout(Duration::from_secs(10))
        .connect_with_connector(tower::service_fn(move |_| {
            let socket = socket.clone();
            async move {
                tokio::net::UnixStream::connect(socket)
                    .await
                    .map(TokioIo::new)
            }
        }))
        .await
        .unwrap();
    ContainerClient::new(channel)
}

async fn mounted(
    client: &mut ContainerClient<Channel>,
    container: &str,
    export: &str,
    read_only: bool,
) {
    client
        .mount(ContainerMountRequest {
            container_id: container.into(),
            source: String::new(),
            destination: "/workspace".into(),
            export_key: export.into(),
            device_tag: boxlite_shared::constants::mount_tags::AGGREGATE.into(),
            read_only,
        })
        .await
        .unwrap();
}

async fn detached(client: &mut ContainerClient<Channel>, container: &str, export: &str) {
    client
        .detach(ContainerDetachRequest {
            container_id: container.into(),
            destination: "/workspace".into(),
            export_key: export.into(),
        })
        .await
        .unwrap();
}

async fn retire(socket: &Path, export: &str) {
    let export = export.to_owned();
    control(socket, move |client| client.remove(&export))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL; make test:integration:vmm:mount-delivery"]
async fn descriptor_delivery_mounts_and_detaches_in_an_existing_container() {
    assert_eq!(
        std::env::var("BOXLITE_TEST_ENGINE").as_deref(),
        Ok("native")
    );
    let home = common::home::PerTestBoxHome::new();
    let runtime = common::TestRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let source = tempfile::tempdir_in("/tmp").unwrap();
    std::fs::write(source.path().join("value"), "host").unwrap();
    let mut options = common::alpine_opts();
    options.network = NetworkSpec::Disabled;
    options.cmd = Some(vec!["sleep".into(), "300".into()]);
    assert!(options.volumes.is_empty());
    let bx = runtime.create(options, None).await.unwrap();
    bx.start().await.unwrap();
    let container = bx
        .executions()
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|execution| execution.is_main_session)
        .expect("running main session")
        .execution_id;
    let sockets = home
        .path
        .join("boxes")
        .join(bx.id().as_str())
        .join("sockets");
    let socket = sockets.join("vmm.sock");
    let mut rpc = guest(sockets.join("box.sock")).await;

    let path = source.path().to_owned();
    let mount = control(&socket, move |client| {
        client.register(
            path.to_str().unwrap().into(),
            "/workspace".into(),
            File::open(&path)?,
            false,
            uuid::Uuid::new_v4().into_bytes(),
        )
    })
    .await
    .unwrap();
    assert_eq!(
        control(&socket, |client| client.list()).await.unwrap(),
        vec![mount.clone()]
    );
    mounted(&mut rpc, &container, &mount.export, false).await;
    assert_eq!(run(&bx, "cat /workspace/value").await, (0, "host".into()));
    assert_eq!(run(&bx, "printf guest > /workspace/from-guest").await.0, 0);
    assert_eq!(
        std::fs::read_to_string(source.path().join("from-guest")).unwrap(),
        "guest"
    );

    detached(&mut rpc, &container, &mount.export).await;
    retire(&socket, &mount.export).await;
    assert_eq!(run(&bx, "test ! -e /workspace/value").await.0, 0);
    assert!(
        control(&socket, |client| client.list())
            .await
            .unwrap()
            .is_empty()
    );
    bx.stop().await.unwrap();
    runtime.remove(bx.id().as_str(), true).await.unwrap();
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL; make test:integration:vmm:mount-delivery"]
async fn mount_administrative_containers_keep_privileges_and_reject_runtime_delivery() {
    use boxlite::runtime::advanced_options::ContainerCapabilities;
    assert_eq!(
        std::env::var("BOXLITE_TEST_ENGINE").as_deref(),
        Ok("native")
    );
    for privileged in [false, true] {
        let home = common::home::PerTestBoxHome::new();
        let runtime = common::TestRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
            ..Default::default()
        })
        .unwrap();
        let mut options = common::alpine_opts();
        options.network = NetworkSpec::Disabled;
        options.cmd = Some(vec!["sleep".into(), "300".into()]);
        if privileged {
            options.advanced.privileged = true;
        } else {
            options
                .advanced
                .set_capabilities(Some(ContainerCapabilities {
                    add: vec!["SYS_ADMIN".into()],
                    drop: vec![],
                }))
                .unwrap();
        }
        let bx = runtime.create(options, None).await.unwrap();
        bx.start().await.unwrap();
        let container = bx
            .executions()
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|execution| execution.is_main_session)
            .unwrap()
            .execution_id;
        let socket = home
            .path
            .join("boxes")
            .join(bx.id().as_str())
            .join("sockets/box.sock");
        let mut rpc = guest(socket).await;
        let error = rpc
            .mount(ContainerMountRequest {
                container_id: container.clone(),
                source: String::new(),
                destination: "/workspace".into(),
                export_key: "not-published".into(),
                device_tag: "boxlite".into(),
                read_only: false,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::Unimplemented);
        assert!(error.message().contains("CAP_SYS_ADMIN"));
        let error = rpc
            .detach(ContainerDetachRequest {
                container_id: container,
                destination: "/workspace".into(),
                export_key: "not-published".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::Unimplemented);
        assert!(error.message().contains("CAP_SYS_ADMIN"));
        assert_eq!(run(&bx, "test ! -e /workspace").await.0, 0);
        let (exit, bounding) = run(&bx, "awk '/^CapBnd:/ {print $2}' /proc/self/status").await;
        assert_eq!(exit, 0);
        let bounding = u64::from_str_radix(bounding.trim(), 16).unwrap();
        assert_ne!(
            bounding & (1 << 21),
            0,
            "configured CAP_SYS_ADMIN must remain granted"
        );
        bx.stop().await.unwrap();
        runtime.remove(bx.id().as_str(), true).await.unwrap();
    }
}
