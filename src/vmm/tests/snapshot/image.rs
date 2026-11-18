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
fn multi_region_and_nonzero_base_are_rejected_before_creation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    for ranges in [
        vec![(GuestAddress(0), 4096), (GuestAddress(8192), 4096)],
        vec![(GuestAddress(4096), 4096)],
    ] {
        let ram = GuestRam::new(&ranges).unwrap();
        assert!(image::write(&path, 1, b"", &ram).is_err());
        assert!(!path.exists());
    }
}

#[test]
fn partial_write_is_removed_and_existing_file_is_not_touched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    assert!(
        image::create(&path, |writer| {
            writer.write_all(&vec![42; 16384])?;
            Err(io::Error::other("injected write failure"))
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
        fs::write(&path, bytes).unwrap();
        assert!(image::Header::read(&mut File::open(&path).unwrap()).is_err());
    }
    fs::write(&path, &original[..original.len() - 1]).unwrap();
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
    assert!(
        image::create(&path, |writer| {
            writer.write_all(b"partial header")?;
            writer.flush()?;
            // Force the production final flush to fail on a read-only descriptor.
            *writer = io::BufWriter::new(File::open(&path)?);
            writer.write_all(b"buffered payload")
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
fn failed_cleanup_reports_both_write_and_removal_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("image");
    let error = image::create(&path, |_| {
        // Replace the new target with a directory so remove_file fails,
        // independently of host permissions (including when running as root).
        fs::remove_file(&path)?;
        fs::create_dir(&path)?;
        Err(io::Error::other("injected write failure"))
    })
    .unwrap_err();
    assert!(matches!(error, crate::Error::Snapshot(ref e)
        if e.to_string().contains("injected write failure; removing incomplete image:")));
    assert!(path.is_dir());
}
