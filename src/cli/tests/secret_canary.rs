//! A secret value must never come back out of BoxLite (POL-1024).
//!
//! A box gets a fresh canary as a secret and uses it for a real HTTPS request
//! through the MITM proxy. Then every channel a user or operator can read is
//! scanned for the canary: each REST response, the guest's environment and
//! every process environment, serve's own `debug` output, and the files under
//! serve's home. The database and disk images are skipped: the database holds
//! the value by design (values at rest are R5), and images never see it.
//!
//! An absence check passes trivially on an empty stream, so each channel is
//! shown to carry content first, and the file scan must find a planted copy.

mod common;

use common::serve::ServeChild;
use std::path::{Path, PathBuf};
use std::process::Command;

const IMAGE: &str = "curlimages/curl:8.10.1";
const HOST: &str = "example.com";

/// One REST call against serve, bypassing any proxy in the environment.
fn rest(serve: &ServeChild, method: &str, path: &str, body: Option<&str>) -> String {
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "--noproxy", "*", "-X", method])
        .arg(format!("{}{path}", serve.url()));
    if let Some(body) = body {
        cmd.args(["-H", "content-type: application/json", "-d", body]);
    }
    let out = cmd.output().expect("curl");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Files under `root` a person could read, minus the database and disk
/// images.
fn readable_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if !matches!(name.as_str(), "db" | "images" | "disks") {
                readable_files(&path, out);
            }
        } else if kind.is_file() && !name.ends_with(".qcow2") && !name.ends_with(".img") {
            out.push(path);
        }
    }
}

fn holding(files: &[PathBuf], needle: &str) -> Vec<PathBuf> {
    files
        .iter()
        .filter(|path| {
            std::fs::read(path)
                .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

#[test]
fn a_secret_value_never_comes_back_out() {
    // Unique per run, so a hit cannot come from an earlier run's leftovers.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let canary = format!("canary-not-a-real-key-{nanos:x}-{:x}", std::process::id());
    let scratch = tempfile::tempdir().expect("scratch dir");
    let serve_log = scratch.path().join("serve.log");
    let serve = ServeChild::start_logged(&serve_log);
    let client_home = boxlite_test_utils::home::PerTestBoxHome::new();
    let mut responses = Vec::new();

    let create = format!(
        r#"{{"image":"{IMAGE}","entrypoint":["sleep"],"cmd":["600"],"secrets":[{{"name":"canary","value":"{canary}","hosts":["{HOST}"]}}]}}"#
    );
    let created = rest(&serve, "POST", "/v1/boxes", Some(&create));
    let box_id = serde_json::from_str::<serde_json::Value>(&created)
        .ok()
        .and_then(|v| v["box_id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| panic!("create failed: {created}"));
    responses.push(created);
    responses.push(rest(
        &serve,
        "POST",
        &format!("/v1/boxes/{box_id}/start"),
        None,
    ));

    // The guest prints its environment and every process environment, then
    // sends the placeholder to the secret's host. `unset CURL_CA_BUNDLE`: the
    // image pins curl to its own bundle, which lacks the box's MITM CA.
    let script = format!(
        "env; cat /proc/[0-9]*/environ | tr '\\0' '\\n'; unset CURL_CA_BUNDLE; \
         curl -sS -o /dev/null -w 'status=%{{http_code}}\\n' \
         -H \"Authorization: Bearer $BOXLITE_SECRET_CANARY\" https://{HOST}/"
    );
    let exec = Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(&client_home.path)
        .args([
            "--url",
            &serve.url(),
            "exec",
            &box_id,
            "--",
            "sh",
            "-c",
            &script,
        ])
        .output()
        .expect("boxlite exec");
    let guest = format!(
        "{}{}",
        String::from_utf8_lossy(&exec.stdout),
        String::from_utf8_lossy(&exec.stderr)
    );
    assert!(
        guest.contains("BOXLITE_SECRET_CANARY=<BOXLITE_SECRET:canary>"),
        "the guest dump must hold the placeholder, or its absence check proves nothing: {guest}"
    );
    assert!(
        guest.contains("status=200"),
        "the request through the MITM proxy must succeed, so substitution ran: {guest}"
    );

    responses.push(rest(&serve, "GET", &format!("/v1/boxes/{box_id}"), None));
    responses.push(rest(&serve, "GET", "/v1/boxes", None));
    responses.push(rest(
        &serve,
        "POST",
        &format!("/v1/boxes/{box_id}/stop"),
        None,
    ));
    assert!(
        responses.iter().all(|r| !r.is_empty()),
        "every REST call must answer: {responses:?}"
    );

    // Positive control for the file scan: a planted copy under the logs must
    // be found, or an empty walk would pass.
    let planted = serve.home().join("logs").join("planted-canary.txt");
    std::fs::create_dir_all(planted.parent().unwrap()).unwrap();
    std::fs::write(&planted, &canary).unwrap();
    let mut files = Vec::new();
    readable_files(serve.home(), &mut files);
    let mut found = holding(&files, &canary);
    assert!(
        found.contains(&planted),
        "the scan must reach serve's logs; scanned {files:?}"
    );
    found.retain(|path| path != &planted);

    rest(
        &serve,
        "DELETE",
        &format!("/v1/boxes/{box_id}?force=true"),
        None,
    );

    let serve_output = std::fs::read_to_string(&serve_log).unwrap_or_default();
    assert!(!serve_output.is_empty(), "serve must have logged at debug");
    assert!(!guest.contains(&canary), "the guest saw the value: {guest}");
    for response in &responses {
        assert!(
            !response.contains(&canary),
            "a REST response holds the value: {response}"
        );
    }
    assert!(
        !serve_output.contains(&canary),
        "serve's output holds the value: {serve_log:?}"
    );
    assert!(
        found.is_empty(),
        "files under serve's home hold the value: {found:?}"
    );
}
