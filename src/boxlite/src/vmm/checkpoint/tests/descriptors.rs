use super::*;
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::Read;
use std::os::unix::fs::FileExt;

#[test]
fn checkpoint_descriptors_transfer_multiple_batches_and_cloexec() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let file = tempfile::tempfile().unwrap();
    file.write_all_at(b"retained object", 0).unwrap();
    let files: Vec<OwnedFd> = (0..130).map(|_| file.try_clone().unwrap().into()).collect();
    let operation = [7; 16];
    let worker = std::thread::spawn(move || {
        send(&sender, operation, &serde_json::json!({"cut": 42}), &files)
    });
    let (metadata, files): (serde_json::Value, _) = receive(&receiver, operation).unwrap();
    assert_eq!(metadata["cut"], 42);
    assert_eq!(files.len(), 130);
    for fd in files {
        // SAFETY: fd is a live descriptor owned by this scope.
        assert_ne!(
            unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        let mut bytes = [0; 15];
        File::from(fd).read_exact_at(&mut bytes, 0).unwrap();
        assert_eq!(&bytes, b"retained object");
    }
    worker.join().unwrap().unwrap();
}

#[test]
fn checkpoint_descriptors_reject_other_operation_and_short_header() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let worker = std::thread::spawn(move || send(&sender, [1; 16], &(), &[]));
    assert!(receive::<()>(&receiver, [2; 16]).is_err());
    drop(receiver);
    assert!(worker.join().unwrap().is_err());
    let (mut sender, receiver) = UnixStream::pair().unwrap();
    sender.write_all(b"BXC2").unwrap();
    drop(sender);
    assert_eq!(
        receive::<()>(&receiver, [1; 16]).unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
}

#[test]
fn checkpoint_descriptors_reject_mismatched_rights() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let files = vec![File::open("/dev/null").unwrap().into()];
    let mut header = [0; HEADER];
    header[..4].copy_from_slice(b"BXC2");
    header[24..28].copy_from_slice(&2u32.to_le_bytes());
    header[32..36].copy_from_slice(&2u32.to_le_bytes());
    send_header(&sender, &header, &files).unwrap();
    drop(sender);
    assert!(receive::<()>(&receiver, [0; 16]).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn checkpoint_descriptors_close_every_received_fd_after_ancillary_truncation() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let mut pipe = [0; 2];
    // SAFETY: pipe initializes two owned descriptors in the writable array.
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let mut read = unsafe { File::from_raw_fd(pipe[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(pipe[1]) };
    unsafe { libc::fcntl(read.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
    let mut header = [0u8; HEADER];
    header[..4].copy_from_slice(b"BXC2");
    let mut control = [0usize; 256];
    let mut iov = libc::iovec {
        iov_base: header.as_mut_ptr().cast(),
        iov_len: HEADER,
    };
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    // 253 is Linux SCM_MAX_FD and exceeds the receiver's ancillary buffer.
    unsafe {
        message.msg_controllen = libc::CMSG_SPACE(253 * 4) as _;
        let cmsg = libc::CMSG_FIRSTHDR(&message);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(253 * 4) as _;
        for index in 0..253 {
            libc::CMSG_DATA(cmsg)
                .cast::<i32>()
                .add(index)
                .write(write.as_raw_fd());
        }
        assert_eq!(
            libc::sendmsg(sender.as_raw_fd(), &message, libc::MSG_NOSIGNAL),
            HEADER as isize
        );
    }
    drop(write);
    assert!(receive::<()>(&receiver, [0; 16]).is_err());
    assert_eq!(
        read.read(&mut [0]).unwrap(),
        0,
        "all received/truncated writer FDs must close"
    );
}

#[test]
fn checkpoint_descriptors_reject_rights_in_json_payload() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let operation = [8; 16];
    let mut header = [0u8; HEADER];
    header[..4].copy_from_slice(b"BXC2");
    header[4..20].copy_from_slice(&operation);
    header[28..32].copy_from_slice(&(HEADER as u32).to_le_bytes());
    send_header(&sender, &header, &[]).unwrap();
    send_header(
        &sender,
        &[b' '; HEADER],
        &[File::open("/dev/null").unwrap().into()],
    )
    .unwrap();
    let error = receive::<()>(&receiver, operation).unwrap_err();
    assert!(error.to_string().contains("ancillary"));
}

#[test]
fn checkpoint_descriptors_preflight_real_process_fd_limit() {
    if std::env::var_os("BOXLITE_TEST_SMALL_FD_LIMIT").is_some() {
        let limit = libc::rlimit {
            rlim_cur: 128,
            rlim_max: 128,
        };
        // SAFETY: only the isolated child process lowers its own resource limit.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
        assert!(preflight(256).unwrap_err().to_string().contains("headroom"));
        return;
    }
    let status=std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact","vmm::checkpoint::descriptors::tests::checkpoint_descriptors_preflight_real_process_fd_limit"])
        .env("BOXLITE_TEST_SMALL_FD_LIMIT","1").status().unwrap();
    assert!(status.success());
}

#[cfg(target_os = "linux")]
#[test]
fn checkpoint_descriptors_default_owner_limit_covers_live_and_transfer_sets() {
    const ENV: &str = "BOXLITE_CHECKPOINT_PEAK_FDS";
    if std::env::var_os(ENV).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "vmm::checkpoint::descriptors::tests::checkpoint_descriptors_default_owner_limit_covers_live_and_transfer_sets", "--nocapture"])
            .env(ENV, "1").status().unwrap();
        assert!(
            status.success(),
            "default owner FD limit cannot bind a valid capture"
        );
        return;
    }
    let mut options = crate::BoxOptions::default();
    options.sanitize().unwrap();
    let configured = options
        .advanced
        .security
        .resource_limits
        .max_open_files
        .unwrap();
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: output points to a correctly sized writable limit.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) },
        0
    );
    // SAFETY: getrlimit succeeded.
    let mut limit = unsafe { limit.assume_init() };
    assert!(
        configured <= limit.rlim_max,
        "host cannot honor the production default"
    );
    limit.rlim_cur = configured;
    // SAFETY: only this isolated test process changes its soft limit.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
    let original = File::open("/dev/null").unwrap();
    let live: std::io::Result<Vec<_>> = (0..2 * MAX_FDS).map(|_| original.try_clone()).collect();
    let result = preflight(MAX_FDS);
    assert!(
        live.is_ok() && result.is_ok(),
        "production default rejects live, captured and transferred descriptor sets: live={:?}, preflight={result:?}",
        live.as_ref().map(Vec::len)
    );
}

#[cfg(target_os = "linux")]
#[test]
fn checkpoint_descriptors_explicit_owner_cap_is_not_raised() {
    const ENV: &str = "BOXLITE_CHECKPOINT_EXPLICIT_FDS";
    if std::env::var_os(ENV).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "vmm::checkpoint::descriptors::tests::checkpoint_descriptors_explicit_owner_cap_is_not_raised", "--nocapture"])
            .env(ENV, "1").status().unwrap();
        assert!(status.success());
        return;
    }
    let mut options = crate::BoxOptions::default();
    options.advanced.security.resource_limits.max_open_files = Some(64);
    let serialized = serde_json::to_vec(&options).unwrap();
    let mut options: crate::BoxOptions = serde_json::from_slice(&serialized).unwrap();
    options.sanitize().unwrap();
    assert_eq!(
        options.advanced.security.resource_limits.max_open_files,
        Some(64),
        "sanitize silently raised an explicit caller cap"
    );
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: getrlimit initializes the correctly sized output.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) },
        0
    );
    // SAFETY: getrlimit succeeded.
    let mut limit = unsafe { limit.assume_init() };
    limit.rlim_cur = options
        .advanced
        .security
        .resource_limits
        .max_open_files
        .unwrap();
    // SAFETY: this subprocess changes only its own soft descriptor cap.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
    assert!(
        preflight(MAX_FDS).is_err(),
        "insufficient explicit cap must refuse before transfer"
    );
}
