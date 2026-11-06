//! Execution discovery and recovery over a real `boxlite serve` and guest.

mod common;

use common::serve::ServeChild;
use std::process::{Command, Stdio};

#[test]
fn execution_inventory_and_recovery_across_cli_processes() {
    let serve = ServeChild::start_with(&["--api-key", "execution-key"], Some("execution-key"));
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let terminal = nix::pty::openpty(None, None).expect("create CLI terminal");
    let run = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&home.path)
        .arg("--url")
        .arg(serve.url())
        .args([
            "run",
            "--detach",
            "--tty",
            "alpine:latest",
            "sh",
            "-c",
            "sleep 120",
        ])
        .env("BOXLITE_API_KEY", "execution-key")
        .stdin(Stdio::from(terminal.slave))
        .output()
        .expect("start detached tty init");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let box_id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    assert!(!box_id.is_empty());

    // A different CLI process reconstructs the guest execution from inventory.
    let top = serve.client(&["top", &box_id, "--format", "json"]);
    assert!(
        top.status.success(),
        "{}",
        String::from_utf8_lossy(&top.stderr)
    );
    let inventory: serde_json::Value = serde_json::from_slice(&top.stdout).expect("execution JSON");
    let executions = inventory.as_array().expect("top emits execution array");
    let init = executions
        .iter()
        .find(|item| item["is_main_session"] == true)
        .expect("init execution is listed");
    assert_eq!(init["tty"], true);
    let init_id = init["execution_id"].as_str().expect("canonical ID");

    let quiet = serve.client(&["top", &box_id, "-q"]);
    assert!(quiet.status.success());
    assert!(
        String::from_utf8_lossy(&quiet.stdout)
            .lines()
            .any(|id| id == init_id)
    );

    let unauthorized = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&home.path)
        .arg("--url")
        .arg(serve.url())
        .args(["top", &box_id])
        .env_remove("BOXLITE_API_KEY")
        .output()
        .expect("unauthenticated inventory request");
    assert!(
        !unauthorized.status.success(),
        "inventory must require box auth"
    );

    // A standalone control invocation can recover the execution without the
    // process that created it or the process that listed it.
    let killed = serve.client(&["kill", &box_id, init_id]);
    assert!(
        killed.status.success(),
        "{}",
        String::from_utf8_lossy(&killed.stderr)
    );
    assert!(serve.client(&["rm", "--force", &box_id]).status.success());
}

#[test]
fn top_never_boots_configured_or_stopped_boxes() {
    let serve = ServeChild::start();
    let created = serve.client(&["create", "alpine:latest"]);
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let box_id = String::from_utf8_lossy(&created.stdout).trim().to_string();
    for state in ["configured", "stopped"] {
        if state == "stopped" {
            assert!(serve.client(&["start", &box_id]).status.success());
            assert!(serve.client(&["stop", &box_id]).status.success());
        }
        let before = serve.client(&["inspect", &box_id]);
        assert!(before.status.success());
        let before: serde_json::Value = serde_json::from_slice(&before.stdout).unwrap();
        let top = serve.client(&["top", &box_id, "--format", "json"]);
        assert!(
            top.status.success(),
            "{}",
            String::from_utf8_lossy(&top.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&top.stdout).unwrap(),
            serde_json::json!([])
        );
        let after = serve.client(&["inspect", &box_id]);
        assert!(after.status.success());
        let after: serde_json::Value = serde_json::from_slice(&after.stdout).unwrap();
        assert_eq!(
            before[0]["Status"], after[0]["Status"],
            "top must not wake {state} box"
        );
    }
    assert!(serve.client(&["rm", "--force", &box_id]).status.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovered_init_attach_and_controls_are_box_scoped_and_independent() {
    let serve = ServeChild::start_with(&["--api-key", "recovery-key"], Some("recovery-key"));
    let terminal = nix::pty::openpty(None, None).expect("create CLI terminal");
    let run = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .args([
            "--url",
            &serve.url(),
            "run",
            "-d",
            "-t",
            "alpine:latest",
            "sleep",
            "120",
        ])
        .env("BOXLITE_API_KEY", "recovery-key")
        .stdin(Stdio::from(terminal.slave))
        .output()
        .expect("start detached tty init");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let box_id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    let http = reqwest::Client::new();
    let inventory: serde_json::Value = http
        .get(format!("{}/v1/boxes/{box_id}/executions", serve.url()))
        .bearer_auth("recovery-key")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let init = inventory["executions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["is_main_session"] == true)
        .unwrap();
    let init_id = init["execution_id"].as_str().unwrap();
    let path = format!("{}/v1/boxes/{box_id}/executions/{init_id}", serve.url());
    assert!(
        http.get(&path)
            .bearer_auth("recovery-key")
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let mut attach = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .args([
            "--url",
            &serve.url(),
            "attach",
            "--no-stdin",
            &box_id,
            init_id,
        ])
        .env("BOXLITE_API_KEY", "recovery-key")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("CLI reattach from another process");
    let resized = http
        .post(format!("{path}/resize"))
        .bearer_auth("recovery-key")
        .json(&serde_json::json!({"rows": 30, "cols": 100}))
        .send()
        .await
        .unwrap();
    assert!(resized.status().is_success());
    let signal = serve.client(&["signal", &box_id, init_id, "28"]);
    assert!(
        signal.status.success(),
        "{}",
        String::from_utf8_lossy(&signal.stderr)
    );
    let kill = serve.client(&["kill", &box_id, init_id]);
    assert!(
        kill.status.success(),
        "{}",
        String::from_utf8_lossy(&kill.stderr)
    );
    let _ = attach.wait().expect("attached CLI exits after kill");
    assert!(serve.client(&["rm", "--force", &box_id]).status.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn main_attach_by_name_keeps_status_addressable_by_name_and_id() {
    let serve = ServeChild::start();
    let name = "main-status-alias";
    let run = serve.client(&["run", "-d", "--name", name, "alpine:latest", "sleep", "120"]);
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let box_id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    let http = reqwest::Client::new();
    let inventory: serde_json::Value = http
        .get(format!("{}/v1/boxes/{name}/executions", serve.url()))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let execution_id = inventory["executions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["is_main_session"] == true)
        .unwrap()["execution_id"]
        .as_str()
        .unwrap();
    // Use the name on the wire: SDK clients resolve it to an ID before attach.
    let (socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}/v1/boxes/{name}/attach?stdin=false",
        serve.port()
    ))
    .await
    .expect("attach main by name");
    let mut responses = Vec::new();
    for owner in [name, box_id.as_str()] {
        let response = http
            .get(format!(
                "{}/v1/boxes/{owner}/executions/{execution_id}",
                serve.url()
            ))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: serde_json::Value = response.json().await.unwrap();
        responses.push((owner, status, body));
    }
    assert!(serve.client(&["rm", "--force", &box_id]).status.success());
    drop(socket);
    for (owner, status, body) in responses {
        assert_eq!(
            status,
            reqwest::StatusCode::OK,
            "main status via {owner}: {body}"
        );
        assert_eq!(body["execution_id"], execution_id);
        assert_eq!(body["status"], "running");
    }
}
