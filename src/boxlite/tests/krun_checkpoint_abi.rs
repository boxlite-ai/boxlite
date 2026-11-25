#![cfg(feature = "krun")]

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use boxlite::vmm::krun::context::KrunContext;
use tempfile::tempdir;

#[cfg(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
))]
#[test]
fn krun_checkpoint_abi_unstarted_contract() {
    let dir = tempdir().expect("create temp dir");
    let save_path = dir.path().join("unstarted.ckpt");
    let restore_path = dir.path().join("missing-restore.ckpt");

    let ctx = unsafe { KrunContext::create() }.expect("create unstarted KrunContext");

    let pause_err = ctx
        .pause()
        .expect_err("pause on unstarted context must fail");
    assert_eq!(pause_err.raw_os_error(), Some(libc::EAGAIN));

    let resume_err = ctx
        .resume()
        .expect_err("resume on unstarted context must fail");
    assert_eq!(resume_err.raw_os_error(), Some(libc::EAGAIN));

    let save_err = ctx
        .save_checkpoint(&save_path)
        .expect_err("save_checkpoint on unstarted context must fail");
    assert_eq!(save_err.raw_os_error(), Some(libc::EAGAIN));
    assert!(
        !save_path.exists(),
        "failed save_checkpoint must not create {}",
        save_path.display()
    );

    ctx.build_from_checkpoint(&restore_path)
        .expect("build_from_checkpoint defers opening the file until launch");
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
#[test]
fn krun_checkpoint_abi_enotsup_on_linux_arm64() {
    let dir = tempdir().expect("create temp dir");
    let save_path = dir.path().join("unsupported.ckpt");
    let restore_path = dir.path().join("missing-restore.ckpt");

    let ctx = unsafe { KrunContext::create() }.expect("create unstarted KrunContext");

    assert_eq!(ctx.pause().unwrap_err().raw_os_error(), Some(libc::ENOTSUP));
    assert_eq!(
        ctx.resume().unwrap_err().raw_os_error(),
        Some(libc::ENOTSUP)
    );
    assert_eq!(
        ctx.save_checkpoint(&save_path).unwrap_err().raw_os_error(),
        Some(libc::ENOTSUP)
    );
    assert!(!save_path.exists());
    assert_eq!(
        ctx.build_from_checkpoint(&restore_path)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ENOTSUP)
    );
}

#[test]
fn krun_checkpoint_abi_rejects_interior_nul_paths() {
    let ctx = unsafe { KrunContext::create() }.expect("create unstarted KrunContext");
    let bad_path = Path::new(OsStr::from_bytes(b"bad\0checkpoint.ckpt"));

    let save_err = ctx
        .save_checkpoint(bad_path)
        .expect_err("interior NUL in save path must be rejected");
    assert_eq!(save_err.kind(), ErrorKind::InvalidInput);
    assert_eq!(save_err.raw_os_error(), None);

    let restore_err = ctx
        .build_from_checkpoint(bad_path)
        .expect_err("interior NUL in restore path must be rejected");
    assert_eq!(restore_err.kind(), ErrorKind::InvalidInput);
    assert_eq!(restore_err.raw_os_error(), None);
}
