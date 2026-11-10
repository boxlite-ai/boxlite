//! Real Box checks for the M3 many-directory-volume startup requirement.

mod common;

use boxlite::runtime::options::{BoxliteOptions, VolumeSpec};
use boxlite::{BoxCommand, BoxliteResult};
use futures::StreamExt;
use tempfile::TempDir;

async fn verify_directory_volumes(count: usize) {
    let home = common::home::PerTestBoxHome::new();
    let host = TempDir::new_in("/tmp").expect("create volume roots");
    let runtime = common::TestRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("create selected-engine runtime");

    let mut options = common::alpine_opts();
    for index in 0..count {
        let directory = host.path().join(index.to_string());
        std::fs::create_dir(&directory).expect("create host directory");
        std::fs::write(directory.join("from-host"), index.to_string()).expect("write host input");
        options.volumes.push(VolumeSpec {
            managed_volume: None,
            host_path: directory.to_str().unwrap().to_owned(),
            guest_path: format!("/mnt/volume-{index}"),
            read_only: false,
        });
    }
    let bx = runtime.create(options, None).await.expect("create Box");
    eprintln!(
        "directory volumes={count}, engine={:?}, box={}",
        std::env::var("BOXLITE_TEST_ENGINE"),
        bx.id()
    );

    let probe: BoxliteResult<(i32, String)> = async {
        bx.start().await?;
        let last = (count - 1).to_string();
        let mut execution = bx
            .exec(BoxCommand::new("sh").args([
                "-eu",
                "-c",
                r#"for i in $(seq 0 "$1"); do
    test "$(cat "/mnt/volume-$i/from-host")" = "$i"
    printf '%s' "$i" > "/mnt/volume-$i/from-guest"
done"#,
                "volume-probe",
                last.as_str(),
            ]))
            .await?;
        let mut stderr = String::new();
        if let Some(mut stream) = execution.stderr() {
            while let Some(chunk) = stream.next().await {
                stderr.push_str(&chunk);
            }
        }
        Ok((execution.wait().await?.exit_code, stderr))
    }
    .await;

    if probe.is_err() {
        let console = home
            .path
            .join("boxes")
            .join(bx.id().as_str())
            .join("logs/console.log");
        eprintln!(
            "startup/exec error: {probe:?}; console: {:?}",
            std::fs::read_to_string(console)
        );
    }
    let stopped = bx.stop().await;
    let removed = runtime.remove(bx.id().as_str(), true).await;
    let (exit_code, stderr) = probe.expect("start and access every directory volume");
    assert_eq!(exit_code, 0, "volume probe stderr: {stderr}");
    for index in 0..count {
        let output = host.path().join(index.to_string()).join("from-guest");
        assert_eq!(std::fs::read_to_string(output).unwrap(), index.to_string());
    }
    stopped.expect("stop Box");
    removed.expect("remove Box");
}

#[tokio::test]
#[ignore = "requires a real VM runtime; run through the explicit-engine matrix"]
async fn two_directory_volumes_round_trip() {
    verify_directory_volumes(2).await;
}

#[tokio::test]
#[ignore = "requires a real VM runtime; run through the explicit-engine matrix"]
async fn three_directory_volumes_round_trip() {
    verify_directory_volumes(3).await;
}

#[tokio::test]
#[ignore = "requires a real VM runtime; run through the explicit-engine matrix"]
async fn eight_directory_volumes_round_trip() {
    verify_directory_volumes(8).await;
}

#[tokio::test]
#[ignore = "requires a real VM runtime; run through the explicit-engine matrix"]
async fn thirty_two_directory_volumes_round_trip() {
    verify_directory_volumes(32).await;
}
