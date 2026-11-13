//! Bring pre-created CPUs online through Linux's CPU hotplug interface.

use std::path::Path;

use boxlite_shared::OnlineCpusResponse;
use tonic::Status;

/// Zero queries the current count. Changes only write `1`; CPUs are never
/// offlined. Return the observed count even after a partially completed grow.
pub(super) fn online_cpus(root: &Path, count: u32) -> Result<OnlineCpusResponse, Box<Status>> {
    let mut cpus = Vec::new();
    for entry in std::fs::read_dir(root).map_err(io_status)? {
        let entry = entry.map_err(io_status)?;
        let name = entry.file_name();
        if let Some(id) = name
            .to_str()
            .and_then(|s| s.strip_prefix("cpu"))
            .and_then(|s| s.parse::<u32>().ok())
        {
            cpus.push(id);
        }
    }
    cpus.sort_unstable();
    if cpus.is_empty() || cpus.len() > usize::from(u8::MAX) {
        return Err(Status::failed_precondition("unsupported guest CPU topology").into());
    }
    if count as usize > cpus.len() {
        return Err(Status::invalid_argument("CPU target exceeds present CPUs").into());
    }
    let mut online = Vec::with_capacity(cpus.len());
    for id in &cpus {
        let path = root.join(format!("cpu{id}/online"));
        let enabled = match std::fs::read_to_string(&path) {
            Ok(value) if value.trim() == "1" => true,
            Ok(value) if value.trim() == "0" => false,
            Err(error) if *id == 0 && error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(io_status(error)),
            Ok(_) => return Err(Status::internal("invalid CPU online state").into()),
        };
        online.push(enabled);
    }
    let mut failure = String::new();
    for (index, id) in cpus.iter().take(count as usize).enumerate() {
        if online[index] {
            continue;
        }
        let path = root.join(format!("cpu{id}/online"));
        if let Err(error) = std::fs::write(&path, b"1") {
            failure = format!("online CPU {id}: {error}");
            break;
        }
        // A successful sysfs write has synchronously onlined the CPU. Preserve
        // that allocation even if the diagnostic readback fails afterward.
        online[index] = true;
        match std::fs::read_to_string(path) {
            Ok(value) if value.trim() == "1" => {}
            result => {
                failure = format!("CPU {id} did not become online: {result:?}");
                break;
            }
        }
    }
    Ok(OnlineCpusResponse {
        online: online.into_iter().filter(|enabled| *enabled).count() as u32,
        error: failure,
    })
}

fn io_status(error: std::io::Error) -> Box<Status> {
    Box::new(Status::internal(format!("guest CPU hotplug: {error}")))
}

// Fault injection stays at the filesystem boundary. Production writes still
// update the fixture before its readback fails; the hotplug algorithm is unchanged.
#[cfg(test)]
mod std {
    pub use ::std::{io, path};
    pub mod fs {
        pub use ::std::fs::{create_dir, read_dir, write};
        use ::std::{
            cell::RefCell,
            io,
            path::{Path, PathBuf},
        };
        thread_local! { pub static FAIL_READBACK: RefCell<Option<PathBuf>> = const { RefCell::new(None) }; }
        pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
            let path = path.as_ref();
            let value = ::std::fs::read_to_string(path)?;
            if value.trim() == "1"
                && FAIL_READBACK.with(|fail| fail.borrow().as_deref() == Some(path))
            {
                return Err(io::Error::other("injected CPU readback failure"));
            }
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topology() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for id in 0..3 {
            std::fs::create_dir(dir.path().join(format!("cpu{id}"))).unwrap();
            if id > 0 {
                std::fs::write(dir.path().join(format!("cpu{id}/online")), "0").unwrap();
            }
        }
        dir
    }

    #[test]
    fn grow_onlines_only_the_requested_cpus_and_is_idempotent() {
        let dir = topology();
        let response = online_cpus(dir.path(), 2).unwrap();
        assert_eq!(response.online, 2);
        assert!(response.error.is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cpu1/online")).unwrap(),
            "1"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cpu2/online")).unwrap(),
            "0"
        );
        assert_eq!(online_cpus(dir.path(), 2).unwrap().online, 2);
        assert_eq!(online_cpus(dir.path(), 0).unwrap().online, 2);
    }

    #[test]
    fn an_oversized_target_does_not_online_any_cpu() {
        let dir = topology();
        assert_eq!(
            online_cpus(dir.path(), 4).unwrap_err().code(),
            tonic::Code::InvalidArgument
        );
        assert_eq!(online_cpus(dir.path(), 0).unwrap().online, 1);
    }

    #[test]
    fn a_smaller_request_never_offlines_a_cpu() {
        let dir = topology();
        online_cpus(dir.path(), 3).unwrap();
        assert_eq!(online_cpus(dir.path(), 1).unwrap().online, 3);
    }

    #[test]
    fn successful_online_write_is_counted_when_readback_fails() {
        let dir = topology();
        let path = dir.path().join("cpu1/online");
        std::fs::FAIL_READBACK.with(|fail| *fail.borrow_mut() = Some(path.clone()));
        let response = online_cpus(dir.path(), 2).unwrap();
        std::fs::FAIL_READBACK.with(|fail| *fail.borrow_mut() = None);
        assert_eq!(::std::fs::read_to_string(path).unwrap(), "1");
        assert_eq!(
            response.online, 2,
            "successful synchronous writes must survive a failed readback"
        );
        assert!(response.error.contains("injected CPU readback failure"));
    }
}
