use super::*;
use crate::images::blob_source::{BlobSource, LocalBundleBlobSource};
use crate::images::manager::{ImageManifest, LayerInfo};
use std::path::Path;
use std::process::Command;

fn read_image(image: &Path, command: &str) -> Vec<u8> {
    let output = Command::new(crate::util::find_binary("debugfs").unwrap())
        .args(["-R", command])
        .arg(image)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    output.stdout
}

fn stat_field(stat: &str, name: &str) -> String {
    let fields: Vec<_> = stat.split_whitespace().collect();
    fields[fields.iter().position(|&field| field == name).unwrap() + 1].to_owned()
}

fn local_image(root: &Path) -> ImageObject {
    ImageObject::new(
        "test:permissions".into(),
        ImageManifest {
            manifest_digest: "sha256:manifest".into(),
            config_digest: "sha256:config".into(),
            diff_ids: vec![],
            layers: vec![LayerInfo {
                digest: "sha256:layer".into(),
                media_type: "application/vnd.oci.image.layer.v1.tar".into(),
                size: 0,
            }],
        },
        BlobSource::LocalBundle(LocalBundleBlobSource::new(
            root.to_path_buf(),
            root.join("layer-cache"),
        )),
    )
}

/// Exercise extraction/fallback, preparation, mke2fs, debugfs, and disk caching.
#[tokio::test]
async fn image_disk_preserves_restrictive_layer_metadata() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping: requires rootless extraction");
        return;
    }
    if crate::util::find_binary("mke2fs").is_err() || crate::util::find_binary("debugfs").is_err() {
        eprintln!("skipping: mke2fs/debugfs unavailable");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let blobs = temp.path().join("blobs/sha256");
    fs::create_dir_all(&blobs).unwrap();
    let layer = blobs.join("layer");
    let mut archive = tar::Builder::new(fs::File::create(&layer).unwrap());
    let entries = [
        ("locked", 0o0000, tar::EntryType::Directory),
        ("locked/nested", 0o3111, tar::EntryType::Directory),
        ("zero", 0o0000, tar::EntryType::Regular),
        ("execute", 0o0111, tar::EntryType::Regular),
        ("locked/nested/special", 0o7111, tar::EntryType::Regular),
        ("readonly", 0o444, tar::EntryType::Regular),
    ];
    for (path, mode, kind) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_uid(1234);
        header.set_gid(5678);
        let content: &[u8] = if kind.is_file() {
            b"original content\n"
        } else {
            b""
        };
        header.set_size(content.len() as u64);
        header.set_cksum();
        archive.append_data(&mut header, path, content).unwrap();
    }
    let mut link = tar::Header::new_gnu();
    link.set_entry_type(tar::EntryType::Link);
    link.set_mode(0o777);
    link.set_uid(1234);
    link.set_gid(5678);
    link.set_size(0);
    link.set_link_name("zero").unwrap();
    link.set_cksum();
    archive
        .append_data(&mut link, "alias", std::io::empty())
        .unwrap();
    archive.finish().unwrap();
    drop(archive);

    let image = local_image(temp.path());
    let manager = ImageDiskManager::new(temp.path().join("disks"), temp.path().to_path_buf(), 0);
    let built = manager.get_or_create(&image).await;
    // Cached source directories retain their restrictive modes; make them
    // removable after the production build, even when the regression fails.
    let cached_layer = temp.path().join("layer-cache/extracted/sha256-layer");
    use std::os::unix::fs::PermissionsExt;
    for path in ["locked", "locked/nested"] {
        fs::set_permissions(cached_layer.join(path), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let disk = built.expect("rootless image preparation must tolerate restrictive layer modes");
    for (path, mode, kind) in entries {
        let stat = String::from_utf8(read_image(disk.path(), &format!("stat /{path}"))).unwrap();
        assert_eq!(
            u32::from_str_radix(&stat_field(&stat, "Mode:"), 8).unwrap(),
            mode,
            "{path}"
        );
        assert_eq!(stat_field(&stat, "User:"), "1234", "{path}");
        assert_eq!(stat_field(&stat, "Group:"), "5678", "{path}");
        if kind.is_file() {
            assert_eq!(
                read_image(disk.path(), &format!("cat /{path}")),
                b"original content\n"
            );
        }
    }
    let stat = |path| String::from_utf8(read_image(disk.path(), &format!("stat /{path}"))).unwrap();
    assert_eq!(
        stat_field(&stat("zero"), "Inode:"),
        stat_field(&stat("alias"), "Inode:")
    );
    assert_eq!(stat_field(&stat("alias"), "Mode:"), "0000");

    // Removing the layer makes a second successful call prove disk-cache reuse.
    fs::remove_file(layer).unwrap();
    let cached = manager.get_or_create(&image).await.unwrap();
    assert_eq!(disk.path(), cached.path());
    assert_eq!(
        read_image(cached.path(), "cat /zero"),
        b"original content\n"
    );
}
