use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn fixture() -> (String, Arc<AggregateFs>, Registry) {
    let tag = format!(
        "control-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let fs = Arc::new(AggregateFs::new(vec![]).unwrap());
    boxlite_vmm::insert_aggregate(&tag, fs.clone());
    (tag, fs, Registry::default())
}

fn register(registry: &mut Registry, tag: &str, target: &str) -> io::Result<ControlMount> {
    match registry.request(
        tag,
        Request::Register {
            source: "/".into(),
            target: target.into(),
            read_only: true,
        },
        vec![File::open("/").unwrap()],
    )? {
        Response::Registered(mount) => Ok(mount),
        response => panic!("unexpected {response:?}"),
    }
}

#[test]
fn registration_reserves_normalized_target_and_publishes_preparing() {
    let (tag, _fs, mut registry) = fixture();
    let first = register(&mut registry, &tag, "/data//./files/").unwrap();
    assert_eq!(first.target, "/data/files");
    assert_eq!(first.state, MountState::Preparing);
    assert_eq!(
        register(&mut registry, &tag, "/data/files")
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EBUSY)
    );
    match registry.request(&tag, Request::List, vec![]).unwrap() {
        Response::List(mounts) => assert_eq!(mounts, vec![first]),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn detaching_is_terminal_and_old_incarnation_cannot_retire_replacement() {
    let (tag, _fs, mut registry) = fixture();
    let old = register(&mut registry, &tag, "/data").unwrap();
    assert_eq!(
        registry
            .request(
                &tag,
                Request::Remove {
                    export: old.export.clone()
                },
                vec![]
            )
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EBUSY)
    );
    registry
        .request(
            &tag,
            Request::SetState {
                export: old.export.clone(),
                state: MountState::Detaching,
            },
            vec![],
        )
        .unwrap();
    assert_eq!(
        registry
            .request(
                &tag,
                Request::SetState {
                    export: old.export.clone(),
                    state: MountState::Mounted
                },
                vec![]
            )
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EINVAL)
    );
    registry
        .request(
            &tag,
            Request::Remove {
                export: old.export.clone(),
            },
            vec![],
        )
        .unwrap();
    let new = register(&mut registry, &tag, "/data").unwrap();
    assert_ne!(old.export, new.export);
    assert_eq!(
        registry
            .request(&tag, Request::Remove { export: old.export }, vec![])
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ENOENT)
    );
    assert_eq!(registry.mounts, vec![new]);
}

#[test]
fn replacement_device_rejects_old_server_mutations() {
    let (tag, _original, mut registry) = fixture();
    register(&mut registry, &tag, "/old").unwrap();
    let replacement = Arc::new(AggregateFs::new(vec![]).unwrap());
    boxlite_vmm::insert_aggregate(&tag, replacement.clone());
    assert_eq!(
        register(&mut registry, &tag, "/new")
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ENODEV)
    );
    assert_eq!(
        replacement.remove("mount-2").unwrap_err().raw_os_error(),
        Some(libc::ENOENT)
    );
}

#[test]
fn metadata_budget_accounts_for_escaping_and_all_state_sizes() {
    let (tag, _fs, mut registry) = fixture();
    let mut admitted = 0;
    loop {
        let target = format!("/{}{}", admitted, "\"".repeat(2000));
        let result = registry.request(
            &tag,
            Request::Register {
                source: "\\".repeat(2000),
                target,
                read_only: true,
            },
            vec![File::open("/").unwrap()],
        );
        match result {
            Ok(_) => admitted += 1,
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
                break;
            }
        }
    }
    assert!(admitted > 0);
    let response = registry.request(&tag, Request::List, vec![]).unwrap();
    assert!(serde_json::to_vec(&response).unwrap().len() <= MAX_FRAME);
    assert_eq!(registry.mounts.len(), admitted);
}

#[test]
fn failed_descriptor_validation_does_not_publish_or_reserve_target() {
    let (tag, _fs, mut registry) = fixture();
    let result = registry.request(
        &tag,
        Request::Register {
            source: "/dev/null".into(),
            target: "/data".into(),
            read_only: true,
        },
        vec![File::open("/dev/null").unwrap()],
    );
    assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::ENOTDIR));
    assert!(registry.mounts.is_empty());
    register(&mut registry, &tag, "/data").unwrap();
}

fn wire_client(
    sender: &std::sync::mpsc::SyncSender<UnixStream>,
) -> super::super::MountControlClient {
    let (client, server) = UnixStream::pair().unwrap();
    sender.send(server).unwrap();
    transport::send_bytes(&client, MOUNT_CONTROL_PREFACE, None, transport::deadline()).unwrap();
    let mut ack = [0; 3];
    transport::receive_exact(&client, &mut ack, &mut vec![], transport::deadline()).unwrap();
    assert_eq!(&ack, ACK);
    super::super::MountControlClient {
        stream: Some(client),
    }
}

#[test]
fn cross_client_publication_and_idle_shutdown() {
    let (tag, _fs, _) = fixture();
    let (sender, receiver) = std::sync::mpsc::sync_channel(8);
    let server = std::thread::spawn(move || serve(receiver, tag));
    let mut first = wire_client(&sender);
    let mut second = wire_client(&sender);
    let mount = first
        .register("/".into(), "/data".into(), File::open("/").unwrap(), true)
        .unwrap();
    assert_eq!(second.list().unwrap(), vec![mount.clone()]);
    assert_eq!(
        second
            .register("/".into(), "/data".into(), File::open("/").unwrap(), true)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EBUSY)
    );
    second
        .set_state(&mount.export, MountState::Detaching)
        .unwrap();
    assert_eq!(
        first
            .set_state(&mount.export, MountState::Mounted)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EINVAL)
    );
    drop(sender);
    server.join().unwrap();
    assert!(first.list().is_err());
}

#[test]
fn non_register_rejects_descriptor_attached_to_body() {
    let (tag, _fs, _) = fixture();
    let registry = Mutex::new(Registry::default());
    let (client, server) = UnixStream::pair().unwrap();
    let worker = std::thread::spawn(move || connection(server, &tag, &registry));
    transport::send_bytes(&client, MOUNT_CONTROL_PREFACE, None, transport::deadline()).unwrap();
    transport::receive_exact(&client, &mut [0; 3], &mut vec![], transport::deadline()).unwrap();
    let payload = serde_json::to_vec(&Request::List).unwrap();
    transport::send_bytes(
        &client,
        &(payload.len() as u32).to_le_bytes(),
        None,
        transport::deadline(),
    )
    .unwrap();
    let file = File::open("/").unwrap();
    transport::send_bytes(
        &client,
        &payload,
        Some(file.as_raw_fd()),
        transport::deadline(),
    )
    .unwrap();
    let (response, files) = transport::receive_frame(&client, transport::deadline()).unwrap();
    assert!(files.is_empty());
    match serde_json::from_slice::<Response>(&response).unwrap() {
        Response::Error { errno, .. } => assert_eq!(errno, libc::EINVAL),
        other => panic!("unexpected {other:?}"),
    }
    drop(client);
    assert!(worker.join().unwrap().is_err());
}

#[test]
fn lost_registration_response_remains_observable() {
    let (tag, _fs, _) = fixture();
    let (sender, receiver) = std::sync::mpsc::sync_channel(8);
    let server = std::thread::spawn(move || serve(receiver, tag));
    let mut first = wire_client(&sender);
    let stream = first.stream.take().unwrap();
    let file = File::open("/").unwrap();
    let request = serde_json::to_vec(&Request::Register {
        source: "/".into(),
        target: "/lost".into(),
        read_only: true,
    })
    .unwrap();
    transport::send_frame(
        &stream,
        &request,
        Some(file.as_raw_fd()),
        transport::deadline(),
    )
    .unwrap();
    // One response byte establishes server publication without receiving the
    // registration identity. A new client must be able to recover that identity.
    transport::receive_exact(&stream, &mut [0; 1], &mut vec![], transport::deadline()).unwrap();
    drop(stream);
    let mut second = wire_client(&sender);
    let records = second.list().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].target, "/lost");
    assert_eq!(records[0].state, MountState::Preparing);
    drop(sender);
    server.join().unwrap();
}

#[test]
fn checked_incarnation_counter_never_wraps() {
    let (tag, _fs, mut registry) = fixture();
    registry.next = u64::MAX;
    assert_eq!(
        register(&mut registry, &tag, "/data")
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EOVERFLOW)
    );
    assert!(registry.mounts.is_empty());
}

#[test]
fn descriptor_is_required_and_path_traversal_refused() {
    let (tag, _fs, mut registry) = fixture();
    assert_eq!(
        registry
            .request(
                &tag,
                Request::Register {
                    source: "/".into(),
                    target: "/data".into(),
                    read_only: true
                },
                vec![]
            )
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EINVAL)
    );
    assert_eq!(
        register(&mut registry, &tag, "/data/../other")
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EINVAL)
    );
    assert!(registry.mounts.is_empty());
}

#[test]
fn nonblocking_handoff_survives_fragmented_preface_and_idle_request_gap() {
    let (tag, _fs, _) = fixture();
    let (sender, receiver) = std::sync::mpsc::sync_channel(8);
    let worker = std::thread::spawn(move || serve(receiver, tag));
    let (client, server) = UnixStream::pair().unwrap();
    // Backend::drive hands off this mode after peeking at the first byte.
    server.set_nonblocking(true).unwrap();
    transport::send_bytes(
        &client,
        &MOUNT_CONTROL_PREFACE[..1],
        None,
        transport::deadline(),
    )
    .unwrap();
    sender.send(server).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(100));
    let result = (|| -> io::Result<()> {
        transport::send_bytes(
            &client,
            &MOUNT_CONTROL_PREFACE[1..],
            None,
            transport::deadline(),
        )?;
        let mut ack = [0; 3];
        transport::receive_exact(&client, &mut ack, &mut vec![], transport::deadline())?;
        assert_eq!(&ack, ACK);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let mut client = super::super::MountControlClient {
            stream: Some(client),
        };
        assert!(client.list()?.is_empty());
        Ok(())
    })();
    drop(sender);
    worker.join().unwrap();
    result.expect("nonblocking handoff must survive both input gaps");
}
