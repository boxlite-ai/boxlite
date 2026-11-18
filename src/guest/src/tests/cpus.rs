// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! `Cpus` against a fake sysfs tree whose `online` files record the writes.

use std::{fs, io};

use super::{parse_cpu_list, Cpus};

/// A sysfs root listing `present`, with `online` per CPU; CPU 0 has no
/// `online` file, as on x86.
fn fake(present: &str, online: &[bool]) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("present"), format!("{present}\n")).unwrap();
    for (cpu, &state) in online.iter().enumerate().skip(1) {
        let dir = root.path().join(format!("cpu{cpu}"));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("online"), if state { "1\n" } else { "0\n" }).unwrap();
    }
    root
}

fn state(root: &tempfile::TempDir, cpu: u32) -> String {
    fs::read_to_string(root.path().join(format!("cpu{cpu}/online"))).unwrap()
}

#[test]
fn onlines_the_lowest_cpus_and_offlines_the_rest() {
    let root = fake("0-3", &[true, false, false, true]);
    let cpus = Cpus::new(root.path());

    assert_eq!(cpus.set_online_count(3).unwrap(), [0, 1, 2]);
    assert_eq!(
        [state(&root, 1), state(&root, 2), state(&root, 3)],
        ["1", "1", "0"]
    );
    assert_eq!(cpus.set_online_count(1).unwrap(), [0]);
    assert_eq!(cpus.set_online_count(4).unwrap(), [0, 1, 2, 3]);
}

#[test]
fn leaves_cpus_already_in_place_untouched() {
    let root = fake("0-2", &[true, true, false]);
    // A trailing newline marks files the agent did not rewrite.
    assert_eq!(Cpus::new(root.path()).set_online_count(2).unwrap(), [0, 1]);
    assert_eq!([state(&root, 1), state(&root, 2)], ["1\n", "0\n"]);
}

#[test]
fn refuses_counts_outside_one_to_present() {
    let root = fake("0-1", &[true, false]);
    let cpus = Cpus::new(root.path());
    for count in [0, 3] {
        let error = cpus.set_online_count(count).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{count}");
    }
    assert_eq!(state(&root, 1), "0\n", "a refused count writes nothing");
}

#[test]
fn a_failed_write_names_its_cpu() {
    let root = fake("0-1", &[true, false]);
    // A directory where the file should be makes the write fail.
    let file = root.path().join("cpu1/online");
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    let error = Cpus::new(root.path()).set_online_count(2).unwrap_err();
    assert!(error.to_string().contains("cpu1/online"), "{error}");
}

#[test]
fn parses_sysfs_cpu_lists() {
    assert_eq!(parse_cpu_list("0\n").unwrap(), [0]);
    assert_eq!(parse_cpu_list("0-2,5,7-8").unwrap(), [0, 1, 2, 5, 7, 8]);
    for bad in ["3-1", "a", "0-"] {
        assert_eq!(
            parse_cpu_list(bad).unwrap_err().kind(),
            io::ErrorKind::InvalidData,
            "{bad}"
        );
    }
}
