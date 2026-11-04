use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

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
    let command = connection_command(&executable, &directory, "testbox", &key, context).unwrap();
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
            "proxy",
            "testbox"
        ]
    );
    assert!(
        connection_command(
            &executable,
            &directory,
            "testbox",
            Path::new("/tmp/${HOME}/key"),
            context
        )
        .is_err()
    );
}
