// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Bringing guest CPUs online and offline through sysfs, so the guest uses
//! exactly the vCPUs the host has granted.
//!
//! The host grants vCPUs before the agent onlines them and revokes them only
//! after the agent offlined them. Onlining a CPU the host has not granted
//! blocks in the kernel for about 10 seconds and then fails with `EIO`.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Where Linux lists CPUs.
pub(crate) const SYSFS_CPUS: &str = "/sys/devices/system/cpu";

/// The CPUs under one sysfs root.
pub(crate) struct Cpus {
    root: PathBuf,
}

impl Cpus {
    pub(crate) fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Onlines the lowest `count` present CPUs and offlines the rest, the
    /// highest first, then returns the online CPUs. Fails with
    /// [`io::ErrorKind::InvalidInput`] unless `1 <= count <= present`.
    pub(crate) fn set_online_count(&self, count: usize) -> io::Result<Vec<u32>> {
        let present = parse_cpu_list(&fs::read_to_string(self.root.join("present"))?)?;
        if count == 0 || count > present.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{count} online CPUs requested, {} present", present.len()),
            ));
        }
        let (wanted, extra) = present.split_at(count);
        for &cpu in wanted {
            if !self.is_online(cpu)? {
                self.write_online(cpu, true)?;
            }
        }
        for &cpu in extra.iter().rev() {
            if self.is_online(cpu)? {
                self.write_online(cpu, false)?;
            }
        }
        present
            .into_iter()
            .filter_map(|cpu| match self.is_online(cpu) {
                Ok(true) => Some(Ok(cpu)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            })
            .collect()
    }

    fn online_file(&self, cpu: u32) -> PathBuf {
        self.root.join(format!("cpu{cpu}")).join("online")
    }

    /// A CPU without an `online` file, such as the boot CPU, is always online.
    fn is_online(&self, cpu: u32) -> io::Result<bool> {
        let path = self.online_file(cpu);
        match fs::read_to_string(&path) {
            Ok(state) => Ok(state.trim() == "1"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(named(&path, error)),
        }
    }

    fn write_online(&self, cpu: u32, online: bool) -> io::Result<()> {
        let path = self.online_file(cpu);
        fs::write(&path, if online { "1" } else { "0" }).map_err(|error| named(&path, error))
    }
}

/// `error`, keeping its kind, with the file it concerns.
fn named(path: &Path, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{}: {error}", path.display()))
}

/// Parses a sysfs CPU list such as `0-3,5`.
fn parse_cpu_list(text: &str) -> io::Result<Vec<u32>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, format!("bad CPU list {text:?}"));
    let mut cpus = Vec::new();
    for part in text.trim().split(',').filter(|part| !part.is_empty()) {
        let (first, last) = part.split_once('-').unwrap_or((part, part));
        let first: u32 = first.parse().map_err(|_| invalid())?;
        let last: u32 = last.parse().map_err(|_| invalid())?;
        if first > last {
            return Err(invalid());
        }
        cpus.extend(first..=last);
    }
    Ok(cpus)
}

#[cfg(test)]
#[path = "tests/cpus.rs"]
mod tests;
