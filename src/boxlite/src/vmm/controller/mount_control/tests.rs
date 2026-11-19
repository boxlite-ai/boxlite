use super::*;
use std::io::Write;
use std::os::fd::AsRawFd;

#[test]
fn fragmented_header_and_body_preserve_delivered_descriptor() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let file = File::open("/").unwrap();
    let worker = std::thread::spawn(move || {
        let end = transport::deadline();
        transport::send_bytes(&sender, &[3], None, end).unwrap();
        transport::send_bytes(&sender, &[0, 0, 0], None, end).unwrap();
        transport::send_bytes(&sender, b"abc", Some(file.as_raw_fd()), end).unwrap();
    });
    let (payload, descriptors) =
        transport::receive_frame(&receiver, transport::deadline()).unwrap();
    assert_eq!(payload, b"abc");
    assert_eq!(descriptors.len(), 1);
    assert!(descriptors[0].metadata().unwrap().is_dir());
    let flags = unsafe { libc::fcntl(descriptors[0].as_raw_fd(), libc::F_GETFD) };
    assert_ne!(flags & libc::FD_CLOEXEC, 0);
    worker.join().unwrap();
}

#[test]
fn ancillary_on_body_is_counted_with_header_descriptor() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let file = File::open("/").unwrap();
    transport::send_bytes(
        &sender,
        &[1, 0, 0, 0],
        Some(file.as_raw_fd()),
        transport::deadline(),
    )
    .unwrap();
    transport::send_bytes(&sender, b"x", Some(file.as_raw_fd()), transport::deadline()).unwrap();
    assert_eq!(
        transport::receive_frame(&receiver, transport::deadline())
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}

#[test]
fn oversized_frame_rejected_before_body_allocation() {
    let (mut sender, receiver) = UnixStream::pair().unwrap();
    sender
        .write_all(&((MAX_FRAME + 1) as u32).to_le_bytes())
        .unwrap();
    assert_eq!(
        transport::receive_frame(&receiver, transport::deadline())
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EMSGSIZE)
    );
}

#[test]
fn malformed_response_poisons_client() {
    let (client, server) = UnixStream::pair().unwrap();
    let worker = std::thread::spawn(move || {
        transport::receive_frame(&server, transport::deadline()).unwrap();
        transport::send_frame(&server, b"invalid", None, transport::deadline()).unwrap();
    });
    let mut client = MountControlClient {
        stream: Some(client),
    };
    assert!(client.list().is_err());
    assert_eq!(
        client.list().unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    worker.join().unwrap();
}

#[test]
fn frame_deadline_is_overall() {
    let (_sender, receiver) = UnixStream::pair().unwrap();
    let error = transport::receive_frame(&receiver, std::time::Instant::now()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
}

#[test]
fn closed_receiver_does_not_raise_sigpipe() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    drop(receiver);
    assert!(transport::send_frame(&sender, b"x", None, transport::deadline()).is_err());
}

#[test]
fn large_frame_over_small_send_buffer_delivers_one_descriptor() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let capacity: libc::c_int = 1024;
    assert_eq!(
        unsafe {
            libc::setsockopt(
                sender.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                (&capacity as *const libc::c_int).cast(),
                std::mem::size_of_val(&capacity) as _,
            )
        },
        0
    );
    let worker = std::thread::spawn(move || {
        let file = File::open("/").unwrap();
        transport::send_frame(
            &sender,
            &vec![b'x'; MAX_FRAME],
            Some(file.as_raw_fd()),
            transport::deadline(),
        )
        .unwrap();
    });
    let (payload, descriptors) =
        transport::receive_frame(&receiver, transport::deadline()).unwrap();
    assert_eq!(payload, vec![b'x'; MAX_FRAME]);
    assert_eq!(descriptors.len(), 1);
    assert!(descriptors[0].metadata().unwrap().is_dir());
    worker.join().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn connect_at_bounds_saturated_accept_backlog() {
    use std::os::unix::net::UnixListener;
    use std::time::{Duration, Instant};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("control.sock");
    let listener = UnixListener::bind(&path).unwrap();
    assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
    // Linux permits one queued connection with backlog zero.
    let queued = UnixStream::connect(&path).unwrap();
    let (started, ready) = std::sync::mpsc::sync_channel(0);
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        let start = Instant::now();
        (MountControlClient::connect_at(path), start.elapsed())
    });
    ready.recv().unwrap();
    std::thread::sleep(Duration::from_secs(6));
    // Release the backlog even with the old blocking connect, then service its
    // handshake so full-revert defect proof always joins the worker.
    drop(listener.accept().unwrap());
    drop(queued);
    listener.set_nonblocking(true).unwrap();
    let release_end = Instant::now() + Duration::from_secs(2);
    while Instant::now() < release_end && !worker.is_finished() {
        match listener.accept() {
            Ok((stream, _)) => {
                let mut preface = vec![0; MOUNT_CONTROL_PREFACE.len()];
                transport::receive_exact(&stream, &mut preface, &mut vec![], transport::deadline())
                    .unwrap();
                assert_eq!(preface, MOUNT_CONTROL_PREFACE);
                transport::send_bytes(&stream, ACK, None, transport::deadline()).unwrap();
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("accept: {error}"),
        }
    }
    drop(listener);
    let (result, elapsed) = worker.join().unwrap();
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("connect exceeded budget and completed after backlog release"),
    };
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(
        elapsed < Duration::from_millis(5750),
        "elapsed: {elapsed:?}"
    );
}
