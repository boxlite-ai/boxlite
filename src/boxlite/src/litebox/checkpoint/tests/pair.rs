use super::*;
use std::io::Write;
use std::os::unix::fs::FileExt;

// Envelope fixtures exercise the host parser, not CPU/device restore. Their
// QCOW2 comes through the production copier; placeholder CPU state cannot boot.
pub(crate) fn fixture() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let raw = source.path().join("base.ext4");
    std::fs::write(&raw, vec![19; 1 << 20]).unwrap();
    let overlay = source.path().join("disk.qcow2");
    crate::disk::Qcow2Helper::create_cow_child_disk(
        &raw,
        crate::disk::BackingFormat::Raw,
        &overlay,
        1 << 20,
    )
    .unwrap()
    .leak();
    crate::disk::Qcow2Helper::flatten(&overlay, &directory.path().join(DISK)).unwrap();
    let metadata = serde_json::json!({"compatibility":{},"cpus":[{}],"vm":{},"regions":[{"gpa":0,"len":4096,"attributes":0}],
        "disks":[{"read_only":false,"disk_bytes":1048576},{"read_only":true,"disk_bytes":4096}],
        "nic":null,"rng":null,"balloon":null,"vsock":null,"console":null,"legacy":null,"fs":null,
        "application_schema":1,"application":{"local_paths":{"version":2}},"disk_dependencies":["container_qcow2",{"external_readonly_boot":{"length":4096,"sha256":vec![0u8;32]}}]});
    seal(directory.path(), &metadata);
    directory
}
fn seal(directory: &Path, metadata: &serde_json::Value) {
    let metadata = serde_json::to_vec(metadata).unwrap();
    let payload = vec![0u8; 4096];
    let disk = File::open(directory.join(DISK)).unwrap();
    let disk_bytes = disk.metadata().unwrap().len();
    let mut header = [0u8; 160];
    header[..8].copy_from_slice(b"KRUNVM\0\0");
    header[8..12].copy_from_slice(&9u32.to_le_bytes());
    header[12..16].copy_from_slice(&160u32.to_le_bytes());
    for (offset, value) in [
        (16, 160 + metadata.len() as u64 + payload.len() as u64),
        (24, metadata.len() as u64),
        (32, payload.len() as u64),
        (40, disk_bytes),
    ] {
        header[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    header[48..80].copy_from_slice(&Sha256::digest(&metadata));
    header[80..112].copy_from_slice(&Sha256::digest(&payload));
    header[112..144].copy_from_slice(&digest(&disk, 0, disk_bytes).unwrap());
    let mut file = File::create(directory.join(MEMORY)).unwrap();
    file.write_all(&header).unwrap();
    file.write_all(&metadata).unwrap();
    file.write_all(&payload).unwrap();
}

#[test]
fn checkpoint_transport_roundtrip_no_overwrite_and_cleanup() {
    use crate::checkpoint_transport::{pack, unpack};
    let source = fixture();
    let home = tempfile::tempdir().unwrap();
    let destination = home.path().join("pair");
    unpack(pack(source.path()).unwrap(), &destination).unwrap();
    open(&destination).unwrap().verify_disk().unwrap();
    assert_eq!(
        std::fs::read(destination.join(MEMORY)).unwrap(),
        std::fs::read(source.path().join(MEMORY)).unwrap()
    );
    assert!(unpack(pack(source.path()).unwrap(), &destination).is_err());
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 2);
}

fn transport_archive(source: &Path, names: &[&str]) -> File {
    let output = tempfile::tempfile().unwrap();
    let encoder = zstd::stream::write::Encoder::new(output, 1).unwrap();
    let mut archive = tar::Builder::new(encoder);
    for name in names {
        let file = File::open(source.join(if *name == DISK { DISK } else { MEMORY })).unwrap();
        let mut header = tar::Header::new_ustar();
        header.set_mode(0o600);
        header.set_size(file.metadata().unwrap().len());
        header.set_cksum();
        archive.append_data(&mut header, name, file).unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap()
}

#[test]
fn checkpoint_transport_rejects_missing_duplicate_extra_corrupt_and_incomplete() {
    use crate::checkpoint_transport::{pack, unpack};
    let source = fixture();
    let home = tempfile::tempdir().unwrap();
    let destination = home.path().join("pair");
    for names in [
        vec![MEMORY],
        vec![MEMORY, MEMORY],
        vec![MEMORY, DISK, "extra"],
    ] {
        assert!(unpack(transport_archive(source.path(), &names), &destination).is_err());
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    }
    let file = pack(source.path()).unwrap();
    file.set_len(file.metadata().unwrap().len() - 3).unwrap();
    assert!(unpack(file, &destination).is_err());
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    OpenOptions::new()
        .write(true)
        .open(source.path().join(DISK))
        .unwrap()
        .write_all_at(b"bad", 104)
        .unwrap();
    assert!(
        unpack(
            transport_archive(source.path(), &[MEMORY, DISK]),
            &destination
        )
        .is_err()
    );
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn checkpoint_transport_requires_v2_but_local_inspection_keeps_v1() {
    let source = fixture();
    let pair = open(source.path()).unwrap();
    let mut memory = pair.memory;
    memory.seek(SeekFrom::Start(24)).unwrap();
    let mut length = [0; 8];
    memory.read_exact(&mut length).unwrap();
    let mut bytes = vec![0; u64::from_le_bytes(length) as usize];
    memory.seek(SeekFrom::Start(160)).unwrap();
    memory.read_exact(&mut bytes).unwrap();
    let mut metadata: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    metadata["application"]["local_paths"]["version"] = 1.into();
    seal(source.path(), &metadata);
    open(source.path()).unwrap().verify_disk().unwrap();
    let error = crate::checkpoint_transport::pack(source.path()).unwrap_err();
    assert!(
        matches!(error, BoxliteError::Unsupported(_)) && error.to_string().contains("re-export")
    );
    let target = tempfile::tempdir().unwrap();
    assert!(matches!(
        crate::checkpoint_transport::unpack(
            transport_archive(source.path(), &[MEMORY, DISK]),
            &target.path().join("pair")
        ),
        Err(BoxliteError::Unsupported(_))
    ));
    assert_eq!(std::fs::read_dir(target.path()).unwrap().count(), 0);
}

#[test]
fn checkpoint_pair_checks_the_disk_and_memory_without_mutating_inputs() {
    let directory = fixture();
    let pair = open(directory.path()).unwrap();
    pair.verify_disk().unwrap();
    let memory_before = std::fs::read(directory.path().join(MEMORY)).unwrap();
    OpenOptions::new()
        .write(true)
        .open(directory.path().join(DISK))
        .unwrap()
        .write_all_at(b"bad", 104)
        .unwrap();
    assert!(
        pair.verify_disk()
            .unwrap_err()
            .to_string()
            .contains("checksum")
    );
    assert_eq!(
        std::fs::read(directory.path().join(MEMORY)).unwrap(),
        memory_before
    );
    let directory = fixture();
    let file = OpenOptions::new()
        .write(true)
        .open(directory.path().join(MEMORY))
        .unwrap();
    let length = file.metadata().unwrap().len();
    file.write_all_at(b"!", length - 1).unwrap();
    assert!(
        open(directory.path())
            .err()
            .unwrap()
            .to_string()
            .contains("checksum")
    );
}

#[test]
fn checkpoint_pair_rejects_old_versions_extra_children_and_symlinks() {
    for version in [7u32, 8] {
        let directory = fixture();
        OpenOptions::new()
            .write(true)
            .open(directory.path().join(MEMORY))
            .unwrap()
            .write_all_at(&version.to_le_bytes(), 8)
            .unwrap();
        assert!(
            open(directory.path())
                .err()
                .unwrap()
                .to_string()
                .contains("version 9")
        );
    }
    let directory = fixture();
    std::fs::write(directory.path().join("bindings.json"), b"{}").unwrap();
    assert!(
        open(directory.path())
            .err()
            .unwrap()
            .to_string()
            .contains("exactly")
    );
    std::fs::remove_file(directory.path().join("bindings.json")).unwrap();
    let saved = tempfile::tempdir().unwrap();
    let moved = saved.path().join("saved-memory");
    std::fs::rename(directory.path().join(MEMORY), &moved).unwrap();
    std::os::unix::fs::symlink(&moved, directory.path().join(MEMORY)).unwrap();
    assert!(open(directory.path()).is_err());
}

#[test]
fn checkpoint_pair_rejects_unaccounted_payload_and_unknown_sections() {
    let directory = fixture();
    let memory = std::fs::read(directory.path().join(MEMORY)).unwrap();
    let length = u64::from_le_bytes(memory[24..32].try_into().unwrap()) as usize;
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&memory[160..160 + length]).unwrap();
    metadata["regions"][0]["len"] = 8192.into();
    seal(directory.path(), &metadata);
    assert!(
        open(directory.path())
            .err()
            .unwrap()
            .to_string()
            .contains("extents")
    );
    metadata["regions"][0]["len"] = 4096.into();
    metadata["unknown_required"] = true.into();
    seal(directory.path(), &metadata);
    assert!(
        open(directory.path())
            .err()
            .unwrap()
            .to_string()
            .contains("required metadata")
    );
}

#[test]
fn checkpoint_pair_rejects_each_incomplete_member_and_truncation() {
    for missing in [MEMORY, DISK] {
        let directory = fixture();
        std::fs::remove_file(directory.path().join(missing)).unwrap();
        assert!(
            open(directory.path()).is_err(),
            "missing {missing} accepted"
        );
    }
    for member in [MEMORY, DISK] {
        let directory = fixture();
        let file = OpenOptions::new()
            .write(true)
            .open(directory.path().join(member))
            .unwrap();
        file.set_len(file.metadata().unwrap().len() - 1).unwrap();
        let result = open(directory.path()).and_then(|pair| pair.verify_disk());
        assert!(result.is_err(), "truncated {member} accepted");
    }
}
