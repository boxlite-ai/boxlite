use super::*;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/outbound/bootstrap-v1.json"
    )))
    .unwrap()
}

#[test]
fn outbound_bootstrap_shim_extracts_identity_and_retains_provisioning_policy() {
    let wire = fixture();
    let (spec, revision) = parse_config(&wire.to_string()).unwrap();
    assert_eq!(
        revision.unwrap().as_str(),
        wire["outbound_revision"].as_str().unwrap()
    );
    let network = spec.network_backend_spec.unwrap();
    assert!(network.outbound_disabled);
    assert!(network.allow_net.is_empty());
    assert_eq!(spec.box_id, "outbound-bootstrap");
}

#[test]
fn outbound_bootstrap_shim_wraps_complete_policy_away_from_old_readers() {
    let mut config = fixture();
    config.as_object_mut().unwrap().remove("outbound_revision");
    let wire = serde_json::json!({
        "config":config,
        "outbound_v1": {
            "snapshot": {
                "policy": {"mode":"disabled","allow_net":[],"deny_net":["192.0.2.0/24:443"]},
                "revision":"rev-complete",
                "admission":"extended_ipv4",
            },
            "requirements": {"admission":true,"deny":true,"port":true,"capacity":false}
        }
    });
    assert!(parse_config(&wire.to_string()).is_err());
    let launch = parse_complete_launch(wire).unwrap();
    assert_eq!(
        launch.outbound_v1.snapshot.revision.as_str(),
        "rev-complete"
    );
    assert_eq!(
        launch.outbound_v1.snapshot.policy.deny_net,
        ["192.0.2.0/24:443"]
    );
    assert!(launch.config.network_backend_spec.is_some());
}

#[test]
fn outbound_bootstrap_shim_accepts_legacy_messages_and_rejects_bad_metadata() {
    let mut wire = fixture();
    wire.as_object_mut().unwrap().remove("outbound_revision");
    assert!(parse_config(&wire.to_string()).unwrap().1.is_none());
    wire["outbound_revision"] = serde_json::Value::Null;
    assert!(parse_config(&wire.to_string()).unwrap().1.is_none());
    for token in [
        serde_json::json!(""),
        serde_json::json!("bad token"),
        serde_json::json!("a".repeat(129)),
        serde_json::json!(7),
        serde_json::json!({"revision":"rev-a"}),
    ] {
        wire["outbound_revision"] = token;
        assert!(
            parse_config(&wire.to_string())
                .unwrap_err()
                .to_string()
                .contains("Invalid outbound bootstrap revision")
        );
    }
}

#[test]
fn outbound_bootstrap_shim_requires_matching_status_before_vmm_handoff() {
    let revision = "inventory-1";
    let digest = "ab".repeat(32);
    for complete in [false, true] {
        for (response, should_handoff) in [
            (None, false),
            (Some((503, revision, digest.as_str())), false),
            (Some((200, "stale-inventory", digest.as_str())), false),
            (Some((200, revision, "stale-digest")), false),
            (Some((200, revision, digest.as_str())), true),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let data_socket = directory.path().join("net.sock");
            let mut config = fixture();
            config["network_backend_spec"]["socket_path"] = serde_json::json!(data_socket);
            config["network_backend_spec"]["outbound_disabled"] = serde_json::json!(false);
            let guard = serde_json::json!({
                "inventory_directory": directory.path(),
                "shim_socket": directory.path().join("host.sock"),
                "box": "outbound-bootstrap",
                "instance": "test-instance",
                "revision": revision,
                "digest": digest,
            });
            let wire = if complete {
                config.as_object_mut().unwrap().remove("outbound_revision");
                serde_json::json!({
                    "config": config,
                    "outbound_v1": {
                        "snapshot": {
                            "policy": {"mode":"enabled","allow_net":[],"deny_net":[]},
                            "revision":"rev-complete","admission":"legacy"
                        },
                        "requirements": {"admission":false,"deny":false,"port":false,"capacity":false}
                    },
                    "cloud_guard": guard
                })
            } else {
                config["cloud_guard"] = guard;
                config
            };
            let launch = parse_launch(&wire.to_string(), wire).unwrap();
            assert_eq!(launch.outbound.is_some(), complete);
            let mut network_called = false;
            let mut server = None;
            let mut handed_off = false;
            let result = run_shim(
                launch,
                |spec, _| {
                    network_called = true;
                    if let Some((status, revision, digest)) = response {
                        server = Some(serve_gvproxy_confirmation(
                            &spec.socket_path.with_file_name("gvproxy-ctl.sock"),
                            status,
                            serde_json::json!({"active":true,"revision":revision,"digest":digest}),
                        ));
                    }
                    Ok((
                        (),
                        NetworkBackendEndpoint::UnixSocket {
                            path: spec.socket_path.clone(),
                            connection_type: boxlite::net::ConnectionType::UnixStream,
                            mac_address: [0x02, 0, 0, 0, 0, 1],
                        },
                    ))
                },
                |config| {
                    handed_off = true;
                    let Some(NetworkBackendEndpoint::UnixSocket { path, .. }) =
                        config.network_backend_endpoint
                    else {
                        panic!("VMM did not receive a Unix endpoint");
                    };
                    assert_eq!(path, data_socket);
                    Ok(())
                },
                &|_| {},
            );
            assert!(network_called);
            assert_eq!(
                handed_off, should_handoff,
                "complete={complete}, response={response:?}"
            );
            if should_handoff {
                result.unwrap();
            } else {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("Cloud platform guard"), "{error}");
            }
            if let Some(server) = server {
                server.join().unwrap();
            }
        }
    }
}

fn serve_gvproxy_confirmation(
    path: &Path,
    status: u16,
    body: serde_json::Value,
) -> thread::JoinHandle<()> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    let listener = UnixListener::bind(path).unwrap();
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(3);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("waiting for the private status request: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "GET /network/platform-guard/status HTTP/1.1\r\n");
        while line != "\r\n" {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
        }
        let body = body.to_string();
        write!(
            stream,
            "HTTP/1.1 {status} status\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    })
}
