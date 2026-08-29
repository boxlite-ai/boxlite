//! Manual verification for issue #1072 / PR #1079 — exercises all three
//! behavior-change rows of the truth table in
//! docs/architecture/jailer-network-permissions.md:
//!
//! 1. `enabled / networkEnabled=false / jailer=true` → create is rejected.
//! 2. `enabled / networkEnabled=false / jailer=false` → create is rejected.
//! 3. `disabled / networkEnabled=false / jailer=true` (the #1072 crash row)
//!    → a real box boots and executes a command, guest offline.
//!
//! Run with:
//! ```sh
//! cargo run -p boxlite --features krun,gvproxy --example issue_1072_boot
//! ```

use boxlite::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};
use boxlite::runtime::options::{BoxOptions, NetworkSpec, RootfsSpec};
use boxlite::{BoxCommand, BoxliteRuntime};
use futures::StreamExt;

fn options(network: NetworkSpec, network_enabled: bool, jailer_enabled: bool) -> BoxOptions {
    let mut advanced = AdvancedBoxOptions::default();
    advanced.security = SecurityOptions {
        jailer_enabled,
        network_enabled,
        ..SecurityOptions::default()
    };
    BoxOptions {
        network,
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        advanced,
        ..Default::default()
    }
}

async fn boot_and_exec(runtime: &BoxliteRuntime) {
    let mut opts = options(NetworkSpec::Disabled, false, true);
    opts.cmd = Some(vec!["sleep".into(), "60".into()]);

    let bx = runtime.create(opts, None).await.expect("create box");
    bx.start().await.expect("box should boot (issue #1072 fix)");

    let mut execution = bx
        .exec(BoxCommand::new("echo").arg("hello-from-guest"))
        .await
        .expect("exec failed");
    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
        }
    }
    let result = execution.wait().await.expect("wait failed");
    println!("exit_code={}", result.exit_code);
    println!("stdout={stdout}");
    assert_eq!(result.exit_code, 0);
    assert!(stdout.contains("hello-from-guest"));

    bx.stop().await.expect("stop box");
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let runtime = BoxliteRuntime::new(Default::default()).expect("create runtime");

    for (jailer_enabled, row) in [(true, 1), (false, 2)] {
        let err = match runtime
            .create(
                options(
                    NetworkSpec::Enabled { allow_net: vec![] },
                    false,
                    jailer_enabled,
                ),
                None,
            )
            .await
        {
            Err(err) => err,
            Ok(_) => panic!("row {row}: contradictory config must be rejected at create"),
        };
        println!("row {row} rejected as expected: {err}");
    }

    println!("row 3: booting the #1072 crash combination...");
    boot_and_exec(&runtime).await;
    println!("row 3 booted and executed successfully");

    let _ = runtime.shutdown(None).await;
}
