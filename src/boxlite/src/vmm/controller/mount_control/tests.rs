//! Real-socket tests: the server runs on a live Unix listener against a real
//! `AggregateFs`, the client drives it over `SCM_RIGHTS`. Assertions stay at
//! the protocol level — export semantics are pinned in the VMM crate tests.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use super::{MAX_FRAME, MountControlClient, MountRequest, MountResponse, bind, serve};
use boxlite_shared::constants::mount_tags::MOUNT_CONTROL_SOCKET;
use boxlite_vmm::{AggregateFs, Share, insert_aggregate};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct BoxDir(PathBuf);

impl BoxDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "boxlite-mount-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for BoxDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Spawns the server for `tag` with a live aggregate over a fresh socket.
fn spawn_server(box_dir: &BoxDir, tag: &str) {
    let filesystem = Arc::new(
        AggregateFs::new(vec![Share {
            name: "seed".into(),
            path: box_dir.0.clone(),
            read_only: false,
        }])
        .unwrap(),
    );
    // Mirror what the device build does: publish the handle by tag.
    insert_aggregate(tag, filesystem);
    let listener = bind(&box_dir.0).unwrap();
    let tag = tag.to_string();
    thread::spawn(move || serve(listener, tag));
}

/// Fds this process holds that resolve into `dir`.
fn fds_into(dir: &std::path::Path) -> usize {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
        .filter(|target| target.starts_with(dir))
        .count()
}

fn send_raw(stream: &mut UnixStream, payload: &[u8], fd: Option<RawFd>) {
    super::send_frame(stream, payload, fd).unwrap();
}

fn read_response(stream: &mut UnixStream) -> MountResponse {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).unwrap();
    let length = u32::from_le_bytes(length);
    let mut payload = vec![0u8; length as usize];
    stream.read_exact(&mut payload).unwrap();
    serde_json::from_slice(&payload).unwrap()
}

#[test]
fn register_remove_roundtrip_over_scm_rights() {
    let box_dir = BoxDir::new();
    let tag = "ctl-roundtrip";
    let data_dir = box_dir.0.join("late");
    fs::create_dir(&data_dir).unwrap();
    spawn_server(&box_dir, tag);

    let mut client = MountControlClient::connect(&box_dir.0).unwrap();
    let delivered = File::open(&data_dir).unwrap();
    assert!(matches!(
        client.register("late".into(), delivered, false).unwrap(),
        MountResponse::Registered { .. }
    ));
    // The name is live: a second registration collides.
    let second = File::open(&data_dir).unwrap();
    assert!(matches!(
        client.register("late".into(), second, false).unwrap(),
        MountResponse::Error {
            code: libc::EEXIST,
            ..
        }
    ));
    // Removal retires the name; the entry is gone afterwards.
    assert!(matches!(
        client.remove("late").unwrap(),
        MountResponse::Removed
    ));
    assert!(matches!(
        client.remove("late").unwrap(),
        MountResponse::Error {
            code: libc::ENOENT,
            ..
        }
    ));
    // The name is free again for a fresh delivery.
    let again = File::open(&data_dir).unwrap();
    assert!(matches!(
        client.register("late".into(), again, true).unwrap(),
        MountResponse::Registered { .. }
    ));
}

#[test]
fn register_without_descriptor_is_rejected() {
    let box_dir = BoxDir::new();
    spawn_server(&box_dir, "ctl-nofd");
    let mut client = MountControlClient::connect(&box_dir.0).unwrap();

    send_raw(
        &mut client.stream,
        serde_json::to_vec(&MountRequest::Register {
            name: "sneaky".into(),
            read_only: false,
        })
        .unwrap()
        .as_slice(),
        None,
    );
    match read_response(&mut client.stream) {
        MountResponse::Error { code, message } => {
            assert_eq!(code, libc::EINVAL);
            assert!(message.contains("descriptor"), "{message}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn descriptor_on_remove_is_rejected_and_closed() {
    let box_dir = BoxDir::new();
    let data_dir = box_dir.0.join("payload");
    fs::create_dir(&data_dir).unwrap();
    spawn_server(&box_dir, "ctl-removefd");

    let mut client = MountControlClient::connect(&box_dir.0).unwrap();
    let before = fds_into(&data_dir);
    // The descriptor must stay open on our side until the send completes.
    let handle = File::open(&data_dir).unwrap();
    send_raw(
        &mut client.stream,
        serde_json::to_vec(&MountRequest::Remove {
            name: "seed".into(),
        })
        .unwrap()
        .as_slice(),
        Some(handle.as_raw_fd()),
    );
    drop(handle);
    match read_response(&mut client.stream) {
        MountResponse::Error { code, message } => {
            assert_eq!(code, libc::EINVAL);
            assert!(message.contains("descriptor"), "{message}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
    // The response implies the handler returned: the server closed the
    // rejected descriptor instead of leaving it dangling.
    assert_eq!(fds_into(&data_dir), before, "server leaked the descriptor");
}

#[test]
fn malformed_frames_are_answered_and_survive() {
    let box_dir = BoxDir::new();
    spawn_server(&box_dir, "ctl-malformed");
    let mut client = MountControlClient::connect(&box_dir.0).unwrap();

    // Garbage JSON in a well-formed frame still yields EBADMSG.
    send_raw(&mut client.stream, b"{not json", None);
    match read_response(&mut client.stream) {
        MountResponse::Error { code, .. } => assert_eq!(code, libc::EBADMSG),
        other => panic!("expected Error, got {other:?}"),
    }

    // The connection continues to serve well-formed requests afterwards.
    send_raw(
        &mut client.stream,
        serde_json::to_vec(&MountRequest::Remove {
            name: "missing".into(),
        })
        .unwrap()
        .as_slice(),
        None,
    );
    match read_response(&mut client.stream) {
        MountResponse::Error { code, .. } => assert_eq!(code, libc::ENOENT),
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn oversized_frames_cut_the_connection() {
    let box_dir = BoxDir::new();
    spawn_server(&box_dir, "ctl-oversize");
    let mut client = MountControlClient::connect(&box_dir.0).unwrap();

    // Announce a frame over the protocol limit: the server cuts the link.
    client
        .stream
        .write_all(&(MAX_FRAME + 1).to_le_bytes())
        .unwrap();
    let mut leftover = Vec::new();
    match client.stream.read_to_end(&mut leftover) {
        Ok(0) => {}
        Ok(_) => panic!("server sent a reply to an oversized frame"),
        Err(error) => assert_eq!(error.kind(), io::ErrorKind::ConnectionReset),
    }
}

// Keep the socket name import honest: the Box layout and the client derive
// the same path from this constant.
const _: &str = MOUNT_CONTROL_SOCKET;

#[test]
fn truncated_descriptor_delivery_closes_every_received_descriptor() {
    let data = BoxDir::new();
    let descriptors: Vec<File> = (0..8).map(|_| File::open(&data.0).unwrap()).collect();
    let before = fds_into(&data.0);
    let (sender, mut receiver) = UnixStream::pair().unwrap();
    let payload = 1u32.to_le_bytes();
    let mut iov = libc::iovec {
        iov_base: payload.as_ptr().cast_mut().cast(),
        iov_len: payload.len(),
    };
    let mut control = vec![0usize; 16];
    // SAFETY: msghdr is initialized below with live buffers and descriptors.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen =
        unsafe { libc::CMSG_SPACE((8 * std::mem::size_of::<RawFd>()) as u32) } as _;
    // SAFETY: the aligned buffer holds the header and all eight descriptors.
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN((8 * std::mem::size_of::<RawFd>()) as u32) as _;
        for (index, descriptor) in descriptors.iter().enumerate() {
            libc::CMSG_DATA(header)
                .cast::<RawFd>()
                .add(index)
                .write(descriptor.as_raw_fd());
        }
        assert_eq!(
            libc::sendmsg(sender.as_raw_fd(), &message, libc::MSG_NOSIGNAL),
            4
        );
    }
    let error = super::receive_frame(&mut receiver).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EPROTO));
    assert_eq!(
        fds_into(&data.0),
        before,
        "rejected ancillary data leaked descriptors"
    );
}
