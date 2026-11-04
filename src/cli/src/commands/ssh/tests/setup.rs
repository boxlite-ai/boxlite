use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn local(context: &str) -> ConnectionTarget {
    ConnectionTarget {
        context: context.into(),
        rest: None,
    }
}

#[tokio::test]
async fn setup_applies_managed_credentials_and_only_reports_success_after_configure() {
    use super::super::tests::{Server, status};

    let server = Server::start(vec![
        (
            500,
            r#"{"error":{"message":"configure failed","type":"Error","code":"internal"}}"#.into(),
        ),
        (200, status(true, "0.0.0.0:22", 1)),
    ])
    .await;
    // Exercise the selected-box operation through the existing REST recording fixture.
    let runtime =
        boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(&server.url)).unwrap();
    let sandbox = runtime.get("box-1").await.unwrap().unwrap();
    let home = tempfile::tempdir().unwrap();
    let error = configure(&sandbox, home.path(), &local("default"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("configure failed"), "{error:#}");
    let unsupported_home = home.path().join("${HOME}");
    fs::create_dir(&unsupported_home).unwrap();
    let error = configure(&sandbox, &unsupported_home, &local("default"))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("SSH command paths cannot contain"),
        "{error:#}"
    );
    assert!(
        !unsupported_home.join("boxes").exists(),
        "reject unrepresentable paths before writing credentials"
    );
    let output = configure(&sandbox, home.path(), &local("default"))
        .await
        .unwrap();
    let requests = server.bodies();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1], "retry must reuse both identities");
    let sent: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
    assert_eq!(sent["listen_address"], "0.0.0.0:22");
    assert_eq!(sent["accounts"][0]["login"], "box");
    assert!(sent["accounts"][0]["ca"].is_null());
    let directory = home.path().join("boxes/box-1/ssh");
    assert_eq!(
        sent["host_private_key"],
        fs::read_to_string(directory.join("host_key")).unwrap()
    );
    assert_eq!(
        sent["accounts"][0]["authorized_keys"][0],
        public_key(&directory.join("client_key")).unwrap()
    );
    assert!(output.contains("SSH configured for box box-1"));
    assert!(output.contains("SSH host key fingerprint: SHA256:host"));
    assert!(output.contains("CLI exit stops non-detached boxes"));
    assert!(output.contains("running detached box"));
    assert!(output.contains("  ssh "));
    assert!(!output.contains(sent["host_private_key"].as_str().unwrap()));
}

#[test]
fn keys_are_private_reused_and_invalid_state_is_not_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("ssh");
    let first = managed_config(&directory).unwrap();
    let second = managed_config(&directory).unwrap();
    assert_eq!(first.host_private_key, second.host_private_key);
    assert_eq!(
        first.accounts[0].authorized_keys,
        second.accounts[0].authorized_keys
    );
    assert_eq!(first.accounts[0].login, "box");
    assert_eq!(first.listen_address, "0.0.0.0:22");
    for (path, mode) in [
        (directory.clone(), 0o700),
        (directory.join("client_key"), 0o600),
        (directory.join("host_key"), 0o600),
    ] {
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, mode);
    }
    let client = directory.join("client_key");
    fs::write(&client, "corrupt").unwrap();
    assert!(managed_config(&directory).is_err());
    assert_eq!(fs::read_to_string(&client).unwrap(), "corrupt");
    fs::remove_file(&client).unwrap();
    symlink(directory.join("host_key"), &client).unwrap();
    assert!(managed_config(&directory).is_err());
    fs::remove_file(&client).unwrap();
    assert!(managed_config(&directory).is_err());
    assert_eq!(
        fs::read_to_string(directory.join("host_key")).unwrap(),
        first.host_private_key
    );
    let linked = temp.path().join("linked");
    symlink(&directory, &linked).unwrap();
    assert!(managed_config(&linked).is_err());
}

#[test]
fn credential_directory_inspection_errors_are_not_treated_as_missing_keys() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("not-a-directory");
    fs::write(&parent, "keep").unwrap();
    let error = managed_config(&parent.join("ssh")).unwrap_err();
    assert_eq!(error.to_string(), "inspect SSH key directory");
    assert_eq!(fs::read_to_string(&parent).unwrap(), "keep");
}

#[test]
fn generated_command_preserves_arguments_through_shell_and_openssh() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("space ' quote % dollar $() `ticks`");
    fs::create_dir(&directory).unwrap();
    let executable = directory.join("boxlite");
    fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$PROXY_RECORD\"\n",
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let key = directory.join("client_key");
    let context = "default ' % $()";
    let command =
        connection_command(&executable, &directory, "testbox", &key, &local(context)).unwrap();
    let record = temp.path().join("args");
    let output = Command::new("/bin/sh")
        .args([
            "-c",
            &command.replacen(
                "ssh ",
                "ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=2 ",
                1,
            ),
        ])
        .env("PROXY_RECORD", &record)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "recording proxy cannot complete SSH"
    );
    let args = fs::read(&record)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    let args: Vec<_> = args
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| std::str::from_utf8(arg).unwrap())
        .collect();
    assert_eq!(
        args,
        [
            "--home",
            directory.to_str().unwrap(),
            "--context",
            context,
            "ssh",
            "--proxy",
            "--",
            "testbox"
        ]
    );
    assert!(
        connection_command(
            &executable,
            &directory,
            "testbox",
            Path::new("/tmp/${HOME}/key"),
            &local(context)
        )
        .is_err()
    );
}
