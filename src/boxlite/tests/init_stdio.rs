mod common;

use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use boxlite::{BoxCommand, BoxliteRuntime};
use std::time::Duration;

#[tokio::test]
async fn init_output_larger_than_pipes_does_not_block_entrypoint() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");
    let handle = runtime
        .create(
            BoxOptions {
                entrypoint: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "dd if=/dev/zero bs=1024 count=1024; dd if=/dev/zero bs=1024 count=1024 >&2; touch /tmp/init-output-drained; exec sleep 300"
                        .to_string(),
                ]),
                ..common::alpine_opts_auto()
            },
            None,
        )
        .await
        .expect("create box");
    let box_id = handle.id().to_string();

    handle.start().await.expect("start box");

    let ready = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let execution = handle
                .exec(
                    BoxCommand::new("test")
                        .arg("-f")
                        .arg("/tmp/init-output-drained"),
                )
                .await
                .expect("start readiness check");
            let result = execution.wait().await.expect("wait for readiness check");
            if result.exit_code == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;

    let _ = handle.stop().await;
    let _ = runtime.remove(&box_id, false).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;

    ready.expect("init stdout or stderr filled its pipe before the entrypoint could continue");
}
