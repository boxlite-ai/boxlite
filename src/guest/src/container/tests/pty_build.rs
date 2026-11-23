#[test]
fn pty_build_request_preserves_terminal_config_over_ipc() {
    use crate::service::exec::exec_handle::{PtyConfig, PtyMode};
    let (sender, receiver) = socketpair(
        AddressFamily::Unix,
        SockType::SeqPacket,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .unwrap();
    let mut spec = sample_spec();
    spec.pty_config = Some(PtyConfig {
        rows: 43,
        cols: 137,
        x_pixels: 640,
        y_pixels: 480,
        modes: vec![
            PtyMode {
                opcode: 53,
                value: 0,
            },
            PtyMode {
                opcode: 1,
                value: 7,
            },
        ],
    });
    send_request(
        sender.as_raw_fd(),
        &ZygoteRequest::Build(spec.clone()),
        None,
    )
    .unwrap();
    let (request, fds) = recv_request(receiver.as_raw_fd()).unwrap();
    let ZygoteRequest::Build(received) = request else {
        panic!("expected tenant build")
    };
    assert_eq!(received, spec);
    assert!(fds.is_none());
}

#[test]
fn tenant_build_missing_state_closes_fds_for_both_executors() {
    for ssh_workload in [None, Some(crate::service::ssh::SshWorkload::Shell)] {
        let state_root = tempfile::tempdir().unwrap();
        assert_build_failure_closes_fds(|fds| {
            let mut spec = tenant_spec_named("missing-container");
            spec.state_root = state_root.path().into();
            spec.ssh_workload = ssh_workload;
            let result = do_build(spec, Some(fds));
            assert!(
                matches!(&result, BuildResult::Failed { error } if error == "build failed: container state directory does not exist"),
                "{result:?}"
            );
            result
        });
    }
}
