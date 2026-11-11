//! Fractional allocations across real HTTP, serve restarts and the Linux VM.
#![cfg(target_os = "linux")]
mod common;

use boxlite::{BoxCommand, BoxOptions, BoxliteRestOptions, BoxliteRuntime, RootfsSpec};
use common::serve::ServeChild;
use futures::StreamExt;
use std::path::PathBuf;

async fn assert_quota(runtime: &BoxliteRuntime, id: &str, cpus: f64) {
    let bx = runtime.get(id).await.unwrap().unwrap();
    let mut execution = bx.exec(BoxCommand::new("nproc")).await.unwrap();
    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    assert_eq!(execution.wait().await.unwrap().exit_code, 0);
    assert_eq!(stdout.trim().parse::<u16>().unwrap(), cpus.ceil() as u16);
    let info = runtime.get_info(id).await.unwrap().unwrap();
    assert_eq!(info.cpus, cpus);
    let pid = info.pid.expect("running VM pid");
    let membership = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    let relative = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .unwrap();
    let group = PathBuf::from("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
    let quota = std::fs::read_to_string(group.join("cpu.max")).unwrap();
    if cpus.fract() == 0.0 {
        assert!(quota.starts_with("max "));
    } else {
        assert_eq!(
            quota.trim(),
            format!("{} 100000", (cpus * 100_000.0) as u64)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fractional_cpus_over_serve_survive_restart() {
    let mut serve = ServeChild::start();
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(serve.url())).unwrap();
    for cpus in [
        boxlite::runtime::cpu_limits::MIN_CPUS - 0.001,
        boxlite::runtime::cpu_limits::MIN_CPUS + 0.0001,
    ] {
        let response = reqwest::Client::new()
            .post(format!("{}/v1/boxes", serve.url()))
            .json(&serde_json::json!({"image": "alpine:latest", "cpus": cpus}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        assert!(runtime.list_info().await.unwrap().is_empty());
    }
    for cpus in [boxlite::runtime::cpu_limits::MIN_CPUS, 0.5, 1.5, 2.0] {
        let bx = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    cpus: Some(cpus),
                    auto_delete: Some(0),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        let id = bx.id().to_string();
        bx.start().await.unwrap();
        assert_quota(&runtime, &id, cpus).await;
        assert_eq!(
            runtime
                .list_info()
                .await
                .unwrap()
                .iter()
                .find(|info| info.id.as_str() == id)
                .unwrap()
                .cpus,
            cpus
        );
        bx.stop().await.unwrap();
        serve.restart();
        assert_eq!(runtime.get_info(&id).await.unwrap().unwrap().cpus, cpus);
        let reopened = runtime.get(&id).await.unwrap().unwrap();
        reopened.start().await.unwrap();
        assert_quota(&runtime, &id, cpus).await;
        runtime.remove(&id, true).await.unwrap();
    }
}
