// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, File},
    io::{self, Read, Write},
    os::unix::fs::PermissionsExt,
};

use crate::{memory::GuestRam, snapshot::image};
use vm_memory::{Bytes, GuestAddress};

#[test]
fn container_round_trip_streams_across_chunk_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let len = (1 << 20) + 37;
    let ram = GuestRam::new(&[(GuestAddress(0), len)]).unwrap();
    let bytes: Vec<_> = (0..len).map(|n| n as u8).collect();
    ram.memory().write_slice(&bytes, GuestAddress(0)).unwrap();
    image::write(&path, 3, b"machine", &ram).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let raw = fs::read(&path).unwrap();
    assert_eq!(&raw[..8], b"BXLMEM01");
    assert_eq!(&raw[8..12], &1u32.to_le_bytes());
    assert_eq!(&raw[12..16], &3u32.to_le_bytes());
    assert_eq!(&raw[16..24], &(len as u64).to_le_bytes());
    assert_eq!(&raw[24..32], &7u64.to_le_bytes());
    let mut file = File::open(&path).unwrap();
    let header = image::Header::read(&mut file).unwrap();
    assert_eq!(
        (header.vcpus, header.machine_len, header.ram_len),
        (3, 7, len as u64)
    );
    let mut payload = Vec::new();
    file.read_to_end(&mut payload).unwrap();
    assert_eq!(&payload[..7], b"machine");
    assert_eq!(&payload[7..], bytes);
    assert_eq!(raw.len(), 32 + 7 + len);
}

#[test]
fn container_round_trip_packs_ram_across_the_mmio_hole() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let low = GuestAddress(0);
    let high = GuestAddress(4 << 30);
    let mut low_bytes = [0; 4096];
    let mut high_bytes = [0; 8192];
    low_bytes[4095] = 0x35;
    high_bytes[0] = 0xc7;
    let ranges = [(low, low_bytes.len()), (high, high_bytes.len())];
    let regions = [(low, &low_bytes[..]), (high, &high_bytes[..])];
    let ram = GuestRam::new(&ranges).unwrap();
    for (start, bytes) in regions {
        ram.memory().write_slice(bytes, start).unwrap();
    }

    image::write(&path, 1, b"", &ram).unwrap();
    let mut bytes = Vec::new();
    image::write_to(&mut bytes, 1, b"", &ram).unwrap();
    assert_eq!(bytes, fs::read(&path).unwrap());
    let mut reader = bytes.as_slice();
    let header = image::Header::read_from(&mut reader, None).unwrap();
    assert_eq!(header.ram_len, (low_bytes.len() + high_bytes.len()) as u64);

    let restored = GuestRam::new(&ranges).unwrap();
    restored.read_image(&mut reader).unwrap();
    for (start, expected) in regions {
        let mut bytes = vec![0; expected.len()];
        restored.memory().read_slice(&mut bytes, start).unwrap();
        assert_eq!(bytes, expected);
    }
    assert!(reader.is_empty());
}

#[test]
fn write_to_reports_short_writes_as_snapshot_errors() {
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    let mut bytes = [0; 8];
    let error = image::write_to(&mut bytes.as_mut_slice(), 1, b"", &ram).unwrap_err();
    assert!(matches!(error, crate::Error::Snapshot(e) if e.kind() == io::ErrorKind::WriteZero));
    assert_eq!(&bytes, b"BXLMEM01");
}

#[test]
fn new_file_writer_creates_on_first_write_and_removes_uncommitted_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let mut writer = image::NewFileWriter::new(&path);
    writer.flush().unwrap();
    assert!(!path.exists());

    writer.write_all(b"partial image").unwrap();
    assert!(path.is_file());
    drop(writer);
    assert!(!path.exists());
}

#[test]
fn partial_write_is_removed_and_existing_file_is_not_touched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    assert!(
        image::create(&path, |file| {
            file.write_all(&[42; 32]).map_err(crate::Error::Snapshot)?;
            Err(crate::Error::Snapshot(io::Error::other(
                "injected write failure",
            )))
        })
        .is_err()
    );
    assert!(!path.exists());
    fs::write(&path, b"existing").unwrap();
    assert!(image::create(&path, |_| panic!("must not overwrite")).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"existing");
    assert!(image::create(&dir.path().join("missing/image"), |_| Ok(())).is_err());
}

#[test]
fn failed_write_preserves_replacement_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let replacement = dir.path().join("replacement");
    fs::write(&replacement, b"replacement contents").unwrap();

    let error = image::create(&path, |file| {
        file.write_all(b"partial image")
            .map_err(crate::Error::Snapshot)?;
        fs::rename(&replacement, &path).map_err(crate::Error::Snapshot)?;
        Err(crate::Error::Snapshot(io::Error::other(
            "injected write failure",
        )))
    })
    .unwrap_err();

    assert!(matches!(error, crate::Error::Snapshot(ref e)
        if e.to_string() == "injected write failure"));
    assert!(fs::symlink_metadata(&path).unwrap().is_file());
    assert_eq!(fs::read(&path).unwrap(), b"replacement contents");
}

#[test]
fn reader_checks_magic_version_and_length_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    image::write(&path, 1, b"", &ram).unwrap();
    let original = fs::read(&path).unwrap();
    for (offset, byte) in [(0, b'?'), (8, 2)] {
        let mut bytes = original.clone();
        bytes[offset] = byte;
        fs::write(&path, bytes).unwrap();
        assert!(image::Header::read(&mut File::open(&path).unwrap()).is_err());
    }
    for offset in [16, 24] {
        let mut bytes = original.clone();
        bytes[offset..offset + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(image::Header::read_from(&mut bytes.as_slice(), None).is_err());
        fs::write(&path, bytes).unwrap();
        assert!(image::Header::read(&mut File::open(&path).unwrap()).is_err());
    }
    let truncated = &original[..original.len() - 1];
    let mut reader = truncated;
    assert!(image::Header::read_from(&mut reader, None).is_ok());
    fs::write(&path, truncated).unwrap();
    assert!(image::Header::read(&mut File::open(&path).unwrap()).is_err());
    let mut bytes = original;
    bytes.push(9); // Trailing bytes are not a compatibility/admission check.
    fs::write(&path, bytes).unwrap();
    assert!(image::Header::read(&mut File::open(&path).unwrap()).is_ok());
}

#[test]
fn header_rejects_out_of_range_vcpu_counts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    for count in [0, 65, u32::MAX] {
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
        image::write(&path, count, b"machine", &ram).unwrap();
        let mut file = File::open(&path).unwrap();
        let error =
            image::Header::read(&mut file).expect_err("header admitted an out-of-range vCPU count");
        assert!(matches!(error, crate::Error::Snapshot(ref e)
            if e.kind() == io::ErrorKind::InvalidInput
                && e.to_string() == "vCPU count must be in 1..=64"));
        assert_eq!(std::io::Seek::stream_position(&mut file).unwrap(), 32);
    }
}

#[test]
fn machine_state_length_limit_is_checked_in_the_header() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    image::write(&path, 1, b"", &ram).unwrap();
    let mut header = fs::read(&path).unwrap()[..32].to_vec();
    let limit = u64::from(crate::config::MAX_VCPUS) * (512 << 10) + (64 << 10);
    for machine_len in [limit - 1, limit, limit + 1] {
        header[24..32].copy_from_slice(&machine_len.to_le_bytes());
        fs::write(&path, &header).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(32 + machine_len + 4096)
            .unwrap();
        let result = image::Header::read(&mut File::open(&path).unwrap());
        if machine_len <= limit {
            assert!(result.is_ok(), "length at the limit must be admitted");
        } else {
            let error = result.expect_err("oversized machine state admitted by header");
            assert!(matches!(error, crate::Error::Snapshot(ref e)
                if e.kind() == io::ErrorKind::InvalidInput
                    && e.to_string() == "machine state exceeds length limit"));
        }
    }
}

#[test]
fn final_buffer_flush_failure_removes_partial_target() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    assert!(
        image::create(&path, |file| {
            file.write_all(b"partial header")
                .map_err(crate::Error::Snapshot)?;
            // Force the production final flush to fail on a read-only descriptor.
            let mut writer = io::BufWriter::with_capacity(
                8192,
                File::open(&path).map_err(crate::Error::Snapshot)?,
            );
            let result = image::write_to(&mut writer, 1, b"machine", &ram);
            drop(writer.into_parts());
            result
        })
        .is_err()
    );
    assert!(!path.exists());
}

#[test]
fn large_ram_length_must_fit_in_the_image_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let ram = GuestRam::new(&[(GuestAddress(0), 4096)]).unwrap();
    image::write(&path, 1, b"machine", &ram).unwrap();
    let mut bytes = fs::read(&path).unwrap();
    let ram_len = (4u64 << 30) + 4096;
    bytes[16..24].copy_from_slice(&ram_len.to_le_bytes());
    fs::write(&path, bytes).unwrap();

    let file = File::options().write(true).open(&path).unwrap();
    let image_len = 32 + 7 + ram_len;
    // Extend the file sparsely to exercise header validation without allocating guest RAM.
    file.set_len(image_len).unwrap();
    let header = image::Header::read(&mut File::open(&path).unwrap()).unwrap();
    assert_eq!(header.ram_len, ram_len);

    file.set_len(image_len - 1).unwrap();
    let error = image::Header::read(&mut File::open(&path).unwrap())
        .expect_err("accepted an image with a truncated RAM payload");
    assert!(matches!(error, crate::Error::Snapshot(ref e)
        if e.kind() == io::ErrorKind::InvalidInput
            && e.to_string() == "image lengths exceed file bounds"));
}

#[test]
fn failed_write_preserves_replacement_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let error = image::create(&path, |_| {
        fs::rename(&path, dir.path().join("original")).map_err(crate::Error::Snapshot)?;
        fs::create_dir(&path).map_err(crate::Error::Snapshot)?;
        Err(crate::Error::Snapshot(io::Error::other(
            "injected write failure",
        )))
    })
    .unwrap_err();
    assert!(matches!(error, crate::Error::Snapshot(ref e)
        if e.to_string() == "injected write failure"));
    assert!(path.is_dir());
}
