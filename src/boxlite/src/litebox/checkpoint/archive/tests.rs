use super::*;
use crate::litebox::checkpoint::test_support::{
    DISKS, SHARE_PAYLOADS, image_for, layout_for, write_checkpoint,
};
use crate::runtime::options::VolumeSpec;
use std::path::PathBuf;
use tempfile::TempDir;

fn guest() -> GuestIdentity {
    GuestIdentity {
        boot_id: "boot-1".into(),
        container_id: "c".repeat(64),
        init_pid: 42,
    }
}

fn options() -> BoxOptions {
    let mut options = BoxOptions {
        volumes: vec![VolumeSpec::bind_mount("/srv/data", "/data")],
        ..Default::default()
    };
    options.advanced.checkpoint_enabled = true;
    options
}

/// A valid checkpoint at `dir/box.ckpt`.
fn valid(dir: &TempDir) -> (PathBuf, Manifest, Vec<u8>) {
    let path = dir.path().join("box.ckpt");
    let image = image_for(&layout_for(&options()));
    let manifest = write_checkpoint(&path, &options(), guest(), &image);
    (path, manifest, image)
}

fn rejection(archive: &Path, dir: &TempDir) -> String {
    let staged = dir.path().join(format!("staged-{}", uuid::Uuid::new_v4()));
    match read(archive, &staged) {
        Ok(_) => panic!("checkpoint {} was accepted", archive.display()),
        Err(error) => error.to_string(),
    }
}

/// An archive member: name, type and contents.
type Member<'a> = (&'a str, tar::EntryType, &'a [u8]);

/// A manifest change, and what its rejection must say.
type ManifestCase<'a> = (&'a str, Box<dyn Fn(&mut Manifest)>, &'a str);

/// A tar of `members`, in order.
fn tar_of(path: &Path, members: &[Member]) {
    let mut builder = tar::Builder::new(File::create(path).unwrap());
    for (name, kind, bytes) in members {
        let mut header = member_header(bytes.len() as u64);
        header.set_entry_type(*kind);
        builder.append_data(&mut header, name, *bytes).unwrap();
    }
    builder.finish().unwrap();
}

fn manifest_bytes(manifest: &Manifest) -> Vec<u8> {
    serde_json::to_vec(manifest).unwrap()
}

#[test]
fn checkpoint_archive_round_trips_the_manifest_and_the_exact_image() {
    let dir = TempDir::new().unwrap();
    let (path, manifest, image) = valid(&dir);
    let staged = dir.path().join("staged");
    let (read_back, share_payloads) = read(&path, &staged).unwrap();
    assert_eq!(std::fs::read(&staged).unwrap(), image);
    assert_eq!(share_payloads, SHARE_PAYLOADS);
    assert_eq!(read_back.guest, manifest.guest);
    assert_eq!(read_back.image, manifest.image);
    assert_eq!(read_back.layout, layout_for(&options()));
    assert_eq!(read_back.layout.disks[0].bytes, DISKS[0]);
    read_back.layout.check_for(&options()).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&staged).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn checkpoint_archive_refuses_corrupt_truncated_and_foreign_contents() {
    let dir = TempDir::new().unwrap();
    let (path, manifest, image) = valid(&dir);
    let bytes = std::fs::read(&path).unwrap();
    let variant = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    };

    // One flipped bit in the image.
    let mut flipped = bytes.clone();
    let at = bytes.len() - 2048;
    flipped[at] ^= 1;
    let error = rejection(&variant("flipped", &flipped), &dir);
    assert!(error.contains("SHA-256"), "{error}");

    // Cut inside the image member.
    let error = rejection(&variant("truncated", &bytes[..bytes.len() / 2]), &dir);
    assert!(error.contains("VM image"), "{error}");

    // Not a tar at all.
    let error = rejection(&variant("garbage", b"not a checkpoint"), &dir);
    assert!(error.contains("invalid checkpoint"), "{error}");

    let cases: Vec<ManifestCase> = vec![
        ("version", Box::new(|m| m.version = 2), "manifest version 2"),
        ("format", Box::new(|m| m.format = "other".into()), "format"),
        (
            "krunvm",
            Box::new(|m| m.image.krunvm_version = 7),
            "VM image version 7",
        ),
        (
            "length",
            Box::new(|m| m.image.length += 1),
            "length differs",
        ),
        (
            "layout",
            Box::new(|m| {
                m.layout.disks.push(DiskLayout {
                    read_only: false,
                    bytes: 0,
                })
            }),
            "differ from the manifest",
        ),
    ];
    for (name, change, expected) in cases {
        let mut changed = manifest.clone();
        change(&mut changed);
        let path = dir.path().join(name);
        tar_of(
            &path,
            &[
                (
                    MANIFEST_MEMBER,
                    tar::EntryType::Regular,
                    &manifest_bytes(&changed),
                ),
                (IMAGE_MEMBER, tar::EntryType::Regular, &image),
            ],
        );
        let error = rejection(&path, &dir);
        assert!(error.contains(expected), "{name}: {error}");
    }

    // A v7 image whose manifest matches it byte for byte is still refused.
    let mut old = image.clone();
    old[8..12].copy_from_slice(&7u32.to_le_bytes());
    let raw = dir.path().join("old.raw");
    std::fs::write(&raw, &old).unwrap();
    let mut v7 = manifest.clone();
    (v7.image.length, v7.image.sha256) = digest(&raw).unwrap();
    let path = dir.path().join("v7");
    tar_of(
        &path,
        &[
            (
                MANIFEST_MEMBER,
                tar::EntryType::Regular,
                &manifest_bytes(&v7),
            ),
            (IMAGE_MEMBER, tar::EntryType::Regular, &old),
        ],
    );
    assert!(rejection(&path, &dir).contains("VM image version 7"));
}

#[test]
fn checkpoint_archive_accepts_exactly_its_two_regular_members_in_order() {
    let dir = TempDir::new().unwrap();
    let (_, manifest, image) = valid(&dir);
    let encoded = manifest_bytes(&manifest);
    let cases: Vec<(&str, Vec<Member>, &str)> = vec![
        (
            "extra",
            vec![
                (MANIFEST_MEMBER, tar::EntryType::Regular, &encoded),
                (IMAGE_MEMBER, tar::EntryType::Regular, &image),
                ("extra", tar::EntryType::Regular, b"x"),
            ],
            // Refused by the framing check before the member is read.
            "end right after the VM image",
        ),
        (
            "reordered",
            vec![
                (IMAGE_MEMBER, tar::EntryType::Regular, &image),
                (MANIFEST_MEMBER, tar::EntryType::Regular, &encoded),
            ],
            "expected member checkpoint.json",
        ),
        (
            "renamed",
            vec![
                (MANIFEST_MEMBER, tar::EntryType::Regular, &encoded),
                ("data/vm.krunvm", tar::EntryType::Regular, &image),
            ],
            "expected member vm.krunvm",
        ),
        (
            "missing",
            vec![(MANIFEST_MEMBER, tar::EntryType::Regular, &encoded)],
            "member vm.krunvm is missing",
        ),
        (
            "link",
            vec![
                (MANIFEST_MEMBER, tar::EntryType::Regular, &encoded),
                (IMAGE_MEMBER, tar::EntryType::Symlink, b""),
            ],
            "not a regular file",
        ),
    ];
    for (name, members, expected) in cases {
        let path = dir.path().join(name);
        tar_of(&path, &members);
        let error = rejection(&path, &dir);
        assert!(error.contains(expected), "{name}: {error}");
    }
}

#[test]
fn checkpoint_layout_must_be_the_one_the_box_boots() {
    let base = layout_for(&options());
    base.check_for(&options()).unwrap();
    let mismatch = |change: &dyn Fn(&mut DeviceLayout)| {
        let mut layout = base.clone();
        change(&mut layout);
        layout.check_for(&options()).unwrap_err().to_string()
    };
    assert!(mismatch(&|l| l.vcpus += 1).contains("vCPUs"));
    assert!(mismatch(&|l| l.disks.swap(0, 1)).contains("disks"));
    assert!(mismatch(&|l| l.shares[1].tag = "uservol9".into()).contains("shares"));
    assert!(mismatch(&|l| l.shares[1].read_only = true).contains("shares"));
    assert!(mismatch(&|l| l.vm_owned_shares = 0).contains("shares"));
    // Every kept share has the checkpoint DAX window.
    assert!(mismatch(&|l| l.shares[0].dax_bytes = 0).contains("shares"));
    assert!(mismatch(&|l| l.shares[1].dax_bytes /= 2).contains("shares"));
    assert!(mismatch(&|l| l.nic_mac = None).contains("NIC"));
    assert!(mismatch(&|l| l.nic_mac = Some([0; 6])).contains("NIC"));
    assert!(mismatch(&|l| l.vsock_ports.pop().map(drop).unwrap_or(())).contains("vsock"));

    // The window is read from the image's own metadata.
    let mut no_dax = base.clone();
    no_dax
        .shares
        .iter_mut()
        .for_each(|share| share.dax_bytes = 0);
    let dir = TempDir::new().unwrap();
    let raw = dir.path().join("vm.krunvm");
    std::fs::write(&raw, image_for(&no_dax)).unwrap();
    let (read_back, _) = read_image_layout(&raw).unwrap();
    assert_eq!(read_back.shares, no_dax.shares);
    assert!(
        read_back
            .check_for(&options())
            .unwrap_err()
            .to_string()
            .contains("shares")
    );

    let mut offline = options();
    offline.network = NetworkSpec::Disabled;
    assert!(
        base.check_for(&offline)
            .unwrap_err()
            .to_string()
            .contains("NIC")
    );
}

/// The file ends with its two members and the tar end marker: anything
/// appended (another archive included) or a short or missing end marker is
/// refused, as the tar reader alone would accept them.
#[test]
fn checkpoint_archive_refuses_trailing_data_and_a_missing_end_marker() {
    let dir = TempDir::new().unwrap();
    let (path, _, _) = valid(&dir);
    let bytes = std::fs::read(&path).unwrap();
    let mut appended = bytes.clone();
    appended.extend_from_slice(b"trailing");
    let mut concatenated = bytes.clone();
    concatenated.extend_from_slice(&bytes);
    let mut marker_not_zero = bytes.clone();
    *marker_not_zero.last_mut().unwrap() = 1;
    let cases: [(&str, &[u8]); 5] = [
        ("appended", &appended),
        ("concatenated", &concatenated),
        ("no-end-marker", &bytes[..bytes.len() - 1024]),
        ("half-end-marker", &bytes[..bytes.len() - 512]),
        ("marker-not-zero", &marker_not_zero),
    ];
    for (name, contents) in cases {
        let variant = dir.path().join(name);
        std::fs::write(&variant, contents).unwrap();
        let error = rejection(&variant, &dir);
        assert!(error.contains("end"), "{name}: {error}");
    }
}
