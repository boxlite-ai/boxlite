use super::*;

#[test]
fn extract_locked_file_preserves_ownership() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping: requires rootless extraction");
        return;
    }
    for mode in [0o0000, 0o0111, 0o0444, 0o7111] {
        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(6);
        header.set_uid(1234);
        header.set_gid(5678);
        header.set_mode(mode);
        header.set_cksum();
        archive
            .append_data(&mut header, "locked", &b"secret"[..])
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut extractor = LayerExtractor::new(temp.path());
        extractor
            .extract_reader(std::io::Cursor::new(archive.into_inner().unwrap()))
            .unwrap();
        extractor.finalize().unwrap();
        let file = temp.path().join("locked");
        let restored = fs::metadata(&file).unwrap().permissions().mode() & 0o7777;
        fs::set_permissions(&file, Permissions::from_mode(0o600)).unwrap();
        assert_eq!(restored, mode);
        assert_eq!(
            OverrideStat::read_xattr(&file).unwrap(),
            Some(OverrideStat::new(1234, 5678, mode, OverrideFileType::File)),
            "ownership must be saved before restrictive permissions are finalized"
        );
        assert_eq!(fs::read(file).unwrap(), b"secret");
    }
}
