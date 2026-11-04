use super::*;
use crate::images::{OverrideFileType, OverrideStat};

#[test]
fn copy_readonly_file_preserves_ownership() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping: requires rootless copy");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let destination = temp.path().join("destination");
    fs::create_dir(&source).unwrap();
    let file = source.join("readonly");
    fs::write(&file, b"secret").unwrap();
    let original = OverrideStat::new(1234, 5678, 0o444, OverrideFileType::File);
    original.write_xattr(&file).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();
    copy_based_mount(&source, &destination, CopyMountOptions::default()).unwrap();
    let copied = destination.join("readonly");
    assert_eq!(
        fs::metadata(&copied).unwrap().permissions().mode() & 0o7777,
        0o444
    );
    assert_eq!(
        OverrideStat::read_xattr(&copied).unwrap(),
        Some(original),
        "copy must preserve ownership before finalizing readonly permissions"
    );
    assert_eq!(fs::read(copied).unwrap(), b"secret");
}
