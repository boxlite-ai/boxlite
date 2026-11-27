#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

mod common;

use std::path::Path;
use std::time::Duration;

use boxlite::experimental::{ExperimentalFeatures, RuntimeBuilder, custom_kernel, native_vmm};
use boxlite::{BoxOptions, BoxliteOptions, NetworkSpec, RootfsSpec};
use boxlite_test_utils::home::PerTestBoxHome;
use common::serve::ServeChild;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::time::timeout;

const FEATURES: &str = "native-vmm,custom-kernel";
const TARGET: &str = "/mnt/runtime + mount & \u{fffd}";

async fn run(home: &Path, url: Option<&str>, args: &[&str]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_boxlite"));
    command
        .env("BOXLITE_EXPERIMENTAL", FEATURES)
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_REST_PATH_PREFIX")
        .arg("--home")
        .arg(home)
        .kill_on_drop(true);
    if let Some(url) = url {
        command.args(["--url", url]);
    } else {
        command.args(["--context", "embedded"]);
    }
    timeout(Duration::from_secs(60), command.args(args).output())
        .await
        .unwrap_or_else(|_| panic!("{args:?}: CLI process did not exit"))
        .unwrap()
}

async fn output(home: &Path, url: Option<&str>, args: &[&str]) -> Vec<u8> {
    let result = run(home, url, args).await;
    assert!(
        result.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

async fn assert_mounts(home: &Path, url: Option<&str>, id: &str, source: &Path, state: &str) {
    let expected = json!({
        "source": source,
        "target": TARGET,
        "read_only": true,
        "state": state,
    });
    let inspected: Value = serde_json::from_slice(
        &output(
            home,
            url,
            &[
                "mount",
                "inspect",
                id,
                "--box-path",
                TARGET,
                "--format",
                "json",
            ],
        )
        .await,
    )
    .unwrap();
    assert_eq!(inspected, expected);
    let listed: Value =
        serde_json::from_slice(&output(home, url, &["mount", "ls", id, "--format", "json"]).await)
            .unwrap();
    assert_eq!(listed, json!([expected]));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn runtime_mounts_round_trip_across_cli_processes() {
    let home = PerTestBoxHome::new();
    let id = {
        let runtime = RuntimeBuilder::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: boxlite_test_utils::test_registries(),
            ..Default::default()
        })
        .with_features(ExperimentalFeatures::parse(FEATURES).unwrap())
        .build()
        .unwrap();
        let mut options = BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            network: NetworkSpec::Disabled,
            detach: true,
            auto_delete: Some(0),
            cmd: Some(vec!["sleep".into(), "300".into()]),
            ..Default::default()
        };
        native_vmm::configure(&mut options);
        custom_kernel::configure(
            &mut options,
            custom_kernel::KernelOptions::new(std::env::var_os("VMM_KERNEL").expect("VMM_KERNEL"))
                .with_format(custom_kernel::KernelFormat::Elf),
        );
        runtime
            .create(options, None)
            .await
            .unwrap()
            .id()
            .to_string()
    };
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().canonicalize().unwrap().join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("value"), "from host\n").unwrap();
    let add = [
        "mount",
        "add",
        &id,
        "--source",
        source.to_str().unwrap(),
        "--box-path",
        TARGET,
        "--read-only",
    ];
    let remove = ["mount", "rm", &id, "--box-path", TARGET];
    let inspect = [
        "mount",
        "inspect",
        &id,
        "--box-path",
        TARGET,
        "--format",
        "json",
    ];

    // Each invocation reopens the local runtime without starting the box.
    let added = output(&home.path, None, &add).await;
    assert!(String::from_utf8(added).unwrap().contains("configured"));
    assert_mounts(&home.path, None, &id, &source, "configured").await;
    output(&home.path, None, &remove).await;
    assert_eq!(output(&home.path, None, &inspect).await, b"null\n");

    let home_path = home.path.clone();
    let mut serve = ServeChild::start_with_home(home, &[], None, Some(FEATURES));
    let url = serve.url();
    let remote = Some(url.as_str());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let endpoint = format!("{url}/v1/boxes/{id}");
    let lifecycle = async || -> Value {
        let info: Value = client
            .get(&endpoint)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        json!([info["status"], info["pid"]])
    };
    let idle = lifecycle().await;
    assert_eq!(idle, json!(["configured", null]));

    output(&home_path, remote, &add).await;
    assert_mounts(&home_path, remote, &id, &source, "configured").await;
    assert_eq!(lifecycle().await, idle);
    serve.restart();
    assert_mounts(&home_path, remote, &id, &source, "configured").await;
    assert_eq!(lifecycle().await, idle);

    output(&home_path, remote, &["start", &id]).await;
    assert_mounts(&home_path, remote, &id, &source, "mounted").await;
    let file = format!("{TARGET}/value");
    assert_eq!(
        output(&home_path, remote, &["exec", &id, "--", "cat", &file]).await,
        b"from host\n"
    );
    output(&home_path, remote, &remove).await;
    assert_eq!(output(&home_path, remote, &inspect).await, b"null\n");

    // Add through the same CLI while the VM is already running.
    let added = output(&home_path, remote, &add).await;
    assert!(String::from_utf8(added).unwrap().contains("mounted"));
    assert_mounts(&home_path, remote, &id, &source, "mounted").await;
    assert_eq!(
        output(&home_path, remote, &["exec", &id, "--", "cat", &file]).await,
        b"from host\n"
    );
    output(&home_path, remote, &remove).await;
    assert_eq!(output(&home_path, remote, &inspect).await, b"null\n");
    let listed: Value = serde_json::from_slice(
        &output(
            &home_path,
            remote,
            &["mount", "ls", &id, "--format", "json"],
        )
        .await,
    )
    .unwrap();
    assert_eq!(listed, json!([]));
    assert!(!run(&home_path, remote, &remove).await.status.success());
    output(&home_path, remote, &["rm", "--force", &id]).await;
}
