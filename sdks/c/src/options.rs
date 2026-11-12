use std::os::raw::{c_char, c_int};

use boxlite::runtime::options::{
    BoxOptions, NetworkSpec, PortProtocol, PortSpec, RootfsSpec, Secret, VolumeSpec,
};

use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::util::c_str_to_string;
use crate::{CBoxliteError, CBoxliteOptions};

pub struct OptionsHandle {
    pub options: BoxOptions,
    pub name: Option<String>,
    pub(crate) checkpoint_override: bool,
    pub(crate) checkpoint_selected: bool,
}

impl OptionsHandle {
    /// Preserve setter presence until create, including explicitly set defaults.
    pub(crate) fn validate_checkpoint(&self) -> boxlite::BoxliteResult<()> {
        if self.checkpoint_selected && !matches!(self.options.rootfs, RootfsSpec::Checkpoint(_)) {
            return Err(boxlite::BoxliteError::InvalidArgument(
                "checkpoint cannot be combined with another rootfs source".into(),
            ));
        }
        let RootfsSpec::Checkpoint(key) = &self.options.rootfs else {
            return Ok(());
        };
        if key.is_empty() {
            return Err(boxlite::BoxliteError::InvalidArgument(
                "checkpoint must be nonempty valid UTF-8".into(),
            ));
        }
        if self.checkpoint_override {
            return Err(boxlite::BoxliteError::InvalidArgument(
                "a box created from a checkpoint inherits its saved settings; only name may be set"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// Record caller intent before a setter can normalize or ignore its input.
unsafe fn mark_checkpoint_override(opts: *mut CBoxliteOptions) {
    if let Some(options) = unsafe { opts.as_mut() } {
        options.checkpoint_override = true;
    }
}

#[cfg(test)]
mod required_headers_tests {
    use super::*;
    use std::{ffi::CString, ptr};

    #[test]
    fn required_headers_legacy_c_call_rejects_create() {
        let home = std::env::temp_dir().join(format!(
            "boxlite-required-c-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let rootfs = home.join("rootfs");
        std::fs::create_dir_all(&rootfs).unwrap();
        let runtime = boxlite::BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: home.join("runtime"),
            ..Default::default()
        })
        .unwrap();
        let mut handle = OptionsHandle {
            options: BoxOptions {
                rootfs: boxlite::RootfsSpec::RootfsPath(rootfs.to_string_lossy().into_owned()),
                ..Default::default()
            },
            name: None,
            checkpoint_override: false,
            checkpoint_selected: false,
        };
        let name = CString::new("x").unwrap();
        let value = CString::new("private-token").unwrap();
        let host = CString::new("api.test.com").unwrap();
        unsafe {
            boxlite_options_add_secret(
                &mut handle,
                name.as_ptr(),
                value.as_ptr(),
                ptr::null(),
                [host.as_ptr()].as_ptr(),
                1,
            );
        }
        let executor = tokio::runtime::Runtime::new().unwrap();
        let result = executor.block_on(runtime.create(handle.options, None));
        let message = result.err().map(|error| error.to_string());
        drop(runtime);
        std::fs::remove_dir_all(home).unwrap();
        assert!(
            message.as_deref().is_some_and(|message| message
                .contains("secret \"x\" has no headers; recreate the box with headers")),
            "legacy C secret accepted: {message:?}"
        );
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_new(
    image: *const c_char,
    out_opts: *mut *mut CBoxliteOptions,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    options_new(image, out_opts, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_rootfs_path(
    opts: *mut CBoxliteOptions,
    path: *const c_char,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_rootfs_path(opts, path)
}

/// Create the box from a REST-managed checkpoint instead of the image.
///
/// The box inherits the checkpoint's saved settings, so every other option
/// must stay unset; only the name may accompany it. Local runtimes fail the
/// create with an unsupported error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_checkpoint(
    opts: *mut CBoxliteOptions,
    checkpoint: *const c_char,
) {
    if let Some(options) = unsafe { opts.as_mut() } {
        options.checkpoint_selected = true;
        // The invalid selector keeps create from falling back to the image.
        options.options.rootfs =
            RootfsSpec::Checkpoint(unsafe { c_str_to_string(checkpoint) }.unwrap_or_default());
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_name(opts: *mut CBoxliteOptions, name: *const c_char) {
    options_set_name(opts, name)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_cpus(opts: *mut CBoxliteOptions, cpus: f64) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_cpus(opts, cpus)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_memory(opts: *mut CBoxliteOptions, memory_mib: c_int) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_memory(opts, memory_mib)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_disk_size_gb(
    opts: *mut CBoxliteOptions,
    disk_size_gb: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_disk_size_gb(opts, disk_size_gb)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_workdir(
    opts: *mut CBoxliteOptions,
    workdir: *const c_char,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_workdir(opts, workdir)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_user(opts: *mut CBoxliteOptions, user: *const c_char) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_user(opts, user)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_env(
    opts: *mut CBoxliteOptions,
    key: *const c_char,
    val: *const c_char,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_add_env(opts, key, val)
}

/// Bind a host directory or file into the box.
///
/// Host bind mounts are local-runtime only; a REST runtime rejects them at
/// create. Use [`boxlite_options_add_managed_volume`] against a REST runtime.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_bind_mount(
    opts: *mut CBoxliteOptions,
    host_path: *const c_char,
    guest_path: *const c_char,
    read_only: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_add_bind_mount(opts, host_path, guest_path, read_only)
}

/// Mount a managed volume, addressed by its server-assigned id **or** by its
/// name — the server resolves either.
///
/// `managed_volume` is the volume's id or name (`"my-data"`, `"vol_01K2…"`).
/// Managed volumes need a REST runtime; the local runtime has no volume backend
/// and rejects one at create.
///
/// A NULL `opts`, `managed_volume`, or `guest_path` is ignored, matching
/// [`boxlite_options_add_bind_mount`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_managed_volume(
    opts: *mut CBoxliteOptions,
    managed_volume: *const c_char,
    guest_path: *const c_char,
    read_only: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_add_managed_volume(opts, managed_volume, guest_path, read_only)
}

/// Transport protocol for a port forwarding rule.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoxlitePortProtocol {
    BoxlitePortProtocolTcp = 0,
    BoxlitePortProtocolUdp = 1,
}

/// Forward `host_port` on the host to `guest_port` inside the box.
///
/// - `host_port`: 0 = let the OS select an available host port.
/// - `guest_port`: required, 1-65535.
/// - `host_ip`: bind address; NULL or "" = all host interfaces.
///
/// Returns `InvalidArgument` if `opts` is NULL, `guest_port` is 0, or
/// `host_ip` is not valid UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_port(
    opts: *mut CBoxliteOptions,
    host_port: u16,
    guest_port: u16,
    protocol: BoxlitePortProtocol,
    host_ip: *const c_char,
) -> BoxliteErrorCode {
    unsafe { mark_checkpoint_override(opts) };
    options_add_port(opts, host_port, guest_port, protocol, host_ip)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_network_enabled(opts: *mut CBoxliteOptions) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_network_enabled(opts)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_network_disabled(opts: *mut CBoxliteOptions) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_network_disabled(opts)
}

/// Adds one entry to the outbound allowlist. Patterns: exact host,
/// "*.example.com", IPv4, or IPv4 CIDR; anything else fails at create.
///
/// A non-empty allowlist restricts both TCP and UDP egress. Hostname entries
/// are enforced by TLS SNI / HTTP Host inspection, which only TCP carries, so
/// an allowlist holding only hostnames denies all UDP egress — add the IP or
/// CIDR to keep UDP open. A host matched by a configured secret is
/// additionally reachable on port 443 without an entry of its own, so this
/// allowlist is not the only egress gate. That connection is dialed by name,
/// and under a non-empty allowlist an answer in a private, loopback or CGNAT
/// range is refused unless an IP or CIDR rule covers it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_network_allow(
    opts: *mut CBoxliteOptions,
    host: *const c_char,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_add_network_allow(opts, host)
}

/// Enables exposed services subject to each tunnel's access policy.
/// Mirrors `boxlite_options_set_network_enabled` for the inbound direction.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_network_inbound_enabled(opts: *mut CBoxliteOptions) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_network_inbound_enabled(opts)
}

/// Marks services the box exposes as unreachable from outside the box (the
/// default). Mirrors `boxlite_options_set_network_disabled` for the
/// inbound direction.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_network_inbound_disabled(opts: *mut CBoxliteOptions) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_network_inbound_disabled(opts)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_secret(
    opts: *mut CBoxliteOptions,
    name: *const c_char,
    value: *const c_char,
    placeholder: *const c_char,
    hosts: *const *const c_char,
    hosts_count: c_int,
) {
    unsafe {
        boxlite_options_add_secret_with_headers(
            opts,
            name,
            value,
            placeholder,
            hosts,
            hosts_count,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    }
}

/// Add a secret with parallel header-name and template arrays.
/// At least one entry is required at creation; zero entries and empty strings are rejected by Rust.
/// # Safety
/// Every non-null options pointer must reference a live, exclusively accessible
/// options handle for the duration of this call. Non-null string pointers must
/// reference readable NUL-terminated strings. For positive counts, each non-null
/// array must contain at least that many readable pointer entries; every non-null
/// entry must reference a readable NUL-terminated string. Header name and template
/// arrays both use `headers_count`; the hosts array uses `hosts_count`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_secret_with_headers(
    opts: *mut CBoxliteOptions,
    name: *const c_char,
    value: *const c_char,
    placeholder: *const c_char,
    hosts: *const *const c_char,
    hosts_count: c_int,
    header_names: *const *const c_char,
    header_templates: *const *const c_char,
    headers_count: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    unsafe {
        options_add_secret_with_headers(
            opts,
            name,
            value,
            placeholder,
            hosts,
            hosts_count,
            header_names,
            header_templates,
            headers_count,
        )
    }
}

/// Deprecated: use `boxlite_options_set_auto_delete_interval`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_remove(opts: *mut CBoxliteOptions, val: c_int) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_auto_remove(opts, val)
}

/// Set how long an idle box may remain paused before the runtime pauses it.
///
/// The value is expressed in seconds. `0` preserves the runtime/control-plane
/// default. A null options pointer is treated as a no-op.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_stop_interval(
    opts: *mut CBoxliteOptions,
    seconds: u32,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_auto_stop_interval(opts, seconds)
}

/// Set how long a stopped box may remain before the runtime deletes it.
///
/// The value is expressed in seconds. `0` disables automatic deletion for
/// persistent boxes. A null options pointer is treated as a no-op.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_delete_interval(
    opts: *mut CBoxliteOptions,
    seconds: u32,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_auto_delete_interval(opts, seconds)
}

/// Configure whether stopped boxes may automatically resume on demand.
///
/// Any non-zero `val` enables auto-resume; `0` disables it. A null options
/// pointer is treated as a no-op.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_resume_enabled(
    opts: *mut CBoxliteOptions,
    val: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_auto_resume_enabled(opts, val)
}

pub unsafe fn options_set_auto_stop_interval(handle: *mut OptionsHandle, seconds: u32) {
    if let Some(handle) = unsafe { handle.as_mut() } {
        handle.options.auto_stop = Some(seconds);
    }
}

pub unsafe fn options_set_auto_delete_interval(handle: *mut OptionsHandle, seconds: u32) {
    if let Some(handle) = unsafe { handle.as_mut() } {
        handle.options.auto_delete = Some(seconds);
    }
}

pub unsafe fn options_set_auto_resume_enabled(handle: *mut OptionsHandle, val: c_int) {
    if let Some(handle) = unsafe { handle.as_mut() } {
        handle.options.auto_resume = Some(val != 0);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_detach(opts: *mut CBoxliteOptions, val: c_int) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_detach(opts, val)
}

/// Apply a `CAdvancedBoxOptions` (capabilities, security, mount isolation, health check) to a
/// `CBoxliteOptions`. Clones the advanced configuration into the box options —
/// the caller retains ownership of `advanced_opts` and is responsible for
/// freeing it via `boxlite_advanced_options_free`.
///
/// Either pointer being null is a no-op. Security is reached through the
/// advanced layer, mirroring the core model (`BoxOptions.advanced.security`):
/// build the `CAdvancedBoxOptions` handle via `boxlite_advanced_options_new`,
/// toggle the sandbox with `boxlite_advanced_options_set_security_enabled`,
/// then apply it here.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_advanced(
    opts: *mut CBoxliteOptions,
    advanced_opts: *const crate::CAdvancedBoxOptions,
) {
    unsafe { mark_checkpoint_override(opts) };
    if opts.is_null() || advanced_opts.is_null() {
        return;
    }
    unsafe {
        (*opts).options.advanced = (*advanced_opts).options.clone();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_entrypoint(
    opts: *mut CBoxliteOptions,
    args: *const *const c_char,
    argc: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_entrypoint(opts, args, argc)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_cmd(
    opts: *mut CBoxliteOptions,
    args: *const *const c_char,
    argc: c_int,
) {
    unsafe { mark_checkpoint_override(opts) };
    options_set_cmd(opts, args, argc)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_free(opts: *mut CBoxliteOptions) {
    options_free(opts)
}

/// Allocate image options without counting the initial source as a checkpoint override.
pub unsafe fn options_new(
    image: *const c_char,
    out_opts: *mut *mut OptionsHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if out_opts.is_null() {
            write_error(out_error, null_pointer_error("out_opts"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let image_str = match c_str_to_string(image) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };

        let handle = Box::new(OptionsHandle {
            options: BoxOptions {
                rootfs: RootfsSpec::Image(image_str),
                ..Default::default()
            },
            name: None,
            checkpoint_override: false,
            checkpoint_selected: false,
        });

        *out_opts = Box::into_raw(handle);
        BoxliteErrorCode::Ok
    }
}

pub unsafe fn options_set_rootfs_path(handle: *mut OptionsHandle, path: *const c_char) {
    unsafe {
        if handle.is_null() || path.is_null() {
            return;
        }
        if let Ok(s) = c_str_to_string(path) {
            (*handle).options.rootfs = RootfsSpec::RootfsPath(s);
        }
    }
}

pub unsafe fn options_set_name(handle: *mut OptionsHandle, name: *const c_char) {
    unsafe {
        if handle.is_null() || name.is_null() {
            return;
        }
        if let Ok(s) = c_str_to_string(name) {
            (*handle).name = Some(s);
        }
    }
}

/// Preserve CPU input for runtime validation, including invalid/non-finite values.
pub unsafe fn options_set_cpus(handle: *mut OptionsHandle, cpus: f64) {
    unsafe {
        if let Some(handle) = handle.as_mut() {
            handle.options.cpus = Some(cpus);
        }
    }
}

pub unsafe fn options_set_memory(handle: *mut OptionsHandle, memory_mib: c_int) {
    unsafe {
        if !handle.is_null() && memory_mib > 0 {
            (*handle).options.memory_mib = Some(memory_mib as u32);
        }
    }
}

pub unsafe fn options_set_disk_size_gb(handle: *mut OptionsHandle, disk_size_gb: c_int) {
    unsafe {
        if !handle.is_null() && disk_size_gb > 0 {
            (*handle).options.disk_size_gb = Some(disk_size_gb as u64);
        }
    }
}

pub unsafe fn options_set_workdir(handle: *mut OptionsHandle, workdir: *const c_char) {
    unsafe {
        if handle.is_null() || workdir.is_null() {
            return;
        }
        if let Ok(s) = c_str_to_string(workdir) {
            (*handle).options.working_dir = Some(s);
        }
    }
}

/// Set the user the container process runs as (`<name|uid>[:<group|gid>]`).
/// `None` leaves the image's USER directive in force.
pub unsafe fn options_set_user(handle: *mut OptionsHandle, user: *const c_char) {
    unsafe {
        if handle.is_null() || user.is_null() {
            return;
        }
        if let Ok(s) = c_str_to_string(user) {
            (*handle).options.user = Some(s);
        }
    }
}

pub unsafe fn options_add_env(handle: *mut OptionsHandle, key: *const c_char, val: *const c_char) {
    unsafe {
        if handle.is_null() || key.is_null() || val.is_null() {
            return;
        }
        if let (Ok(k), Ok(v)) = (c_str_to_string(key), c_str_to_string(val)) {
            (*handle).options.env.push((k, v));
        }
    }
}

pub unsafe fn options_add_bind_mount(
    handle: *mut OptionsHandle,
    host_path: *const c_char,
    guest_path: *const c_char,
    read_only: c_int,
) {
    unsafe {
        if handle.is_null() || host_path.is_null() || guest_path.is_null() {
            return;
        }
        if let (Ok(h), Ok(g)) = (c_str_to_string(host_path), c_str_to_string(guest_path)) {
            (*handle).options.volumes.push(VolumeSpec {
                read_only: read_only != 0,
                ..VolumeSpec::bind_mount(h, g)
            });
        }
    }
}

pub unsafe fn options_add_managed_volume(
    handle: *mut OptionsHandle,
    managed_volume: *const c_char,
    guest_path: *const c_char,
    read_only: c_int,
) {
    unsafe {
        if handle.is_null() || managed_volume.is_null() || guest_path.is_null() {
            return;
        }
        if let (Ok(v), Ok(g)) = (c_str_to_string(managed_volume), c_str_to_string(guest_path)) {
            (*handle).options.volumes.push(VolumeSpec {
                read_only: read_only != 0,
                ..VolumeSpec::managed_volume(v, g)
            });
        }
    }
}

pub unsafe fn options_add_port(
    handle: *mut OptionsHandle,
    host_port: u16,
    guest_port: u16,
    protocol: BoxlitePortProtocol,
    host_ip: *const c_char,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() || guest_port == 0 {
            return BoxliteErrorCode::InvalidArgument;
        }
        let host_ip = if host_ip.is_null() {
            None
        } else {
            match c_str_to_string(host_ip) {
                Ok(ip) if ip.is_empty() => None,
                Ok(ip) => Some(ip),
                Err(_) => return BoxliteErrorCode::InvalidArgument,
            }
        };
        (*handle).options.ports.push(PortSpec {
            host_port: if host_port == 0 {
                None
            } else {
                Some(host_port)
            },
            guest_port,
            protocol: match protocol {
                BoxlitePortProtocol::BoxlitePortProtocolTcp => PortProtocol::Tcp,
                BoxlitePortProtocol::BoxlitePortProtocolUdp => PortProtocol::Udp,
            },
            host_ip,
        });
        BoxliteErrorCode::Ok
    }
}

pub unsafe fn options_set_network_enabled(handle: *mut OptionsHandle) {
    unsafe {
        if !handle.is_null() {
            (*handle).options.network = NetworkSpec::Enabled {
                allow_net: Vec::new(),
            };
        }
    }
}

pub unsafe fn options_set_network_disabled(handle: *mut OptionsHandle) {
    unsafe {
        if !handle.is_null() {
            (*handle).options.network = NetworkSpec::Disabled;
        }
    }
}

pub unsafe fn options_add_network_allow(handle: *mut OptionsHandle, host: *const c_char) {
    unsafe {
        if handle.is_null() || host.is_null() {
            return;
        }
        if let Ok(h) = c_str_to_string(host)
            && let NetworkSpec::Enabled { allow_net } = &mut (*handle).options.network
        {
            allow_net.push(h);
        }
    }
}

pub unsafe fn options_set_network_inbound_enabled(handle: *mut OptionsHandle) {
    unsafe {
        if !handle.is_null() {
            (*handle).options.inbound_network = NetworkSpec::Enabled {
                allow_net: Vec::new(),
            };
        }
    }
}

pub unsafe fn options_set_network_inbound_disabled(handle: *mut OptionsHandle) {
    unsafe {
        if !handle.is_null() {
            (*handle).options.inbound_network = NetworkSpec::Disabled;
        }
    }
}

/// # Safety
/// Every non-null options pointer must reference a live, exclusively accessible
/// options handle for the duration of this call. Non-null string pointers must
/// reference readable NUL-terminated strings. For positive counts, each non-null
/// array must contain at least that many readable pointer entries; every non-null
/// entry must reference a readable NUL-terminated string. Header name and template
/// arrays both use `headers_count`; the hosts array uses `hosts_count`.
pub unsafe fn options_add_secret_with_headers(
    handle: *mut OptionsHandle,
    name: *const c_char,
    value: *const c_char,
    placeholder: *const c_char,
    hosts: *const *const c_char,
    hosts_count: c_int,
    header_names: *const *const c_char,
    header_templates: *const *const c_char,
    headers_count: c_int,
) {
    unsafe {
        if handle.is_null() || name.is_null() || value.is_null() {
            return;
        }

        let Ok(name) = c_str_to_string(name) else {
            return;
        };
        let Ok(value) = c_str_to_string(value) else {
            return;
        };
        let placeholder = if placeholder.is_null() {
            format!("<BOXLITE_SECRET:{name}>")
        } else {
            c_str_to_string(placeholder).unwrap_or_else(|_| format!("<BOXLITE_SECRET:{name}>"))
        };

        let hosts = parse_c_string_array(hosts, hosts_count);
        let headers = if headers_count == 0 {
            None
        } else {
            let mut headers = std::collections::BTreeMap::new();
            if headers_count > 0 && !header_names.is_null() && !header_templates.is_null() {
                for index in 0..headers_count as usize {
                    let pair = (
                        c_str_to_string(*header_names.add(index)),
                        c_str_to_string(*header_templates.add(index)),
                    );
                    let (Ok(key), Ok(template)) = pair else {
                        headers.clear();
                        break;
                    };
                    if headers.insert(key, template).is_some() {
                        // Preserve an invalid configuration instead of silently
                        // collapsing duplicate C entries into a valid map.
                        headers.clear();
                        break;
                    }
                }
            }
            Some(headers)
        };
        (*handle).options.secrets.push(Secret {
            name,
            hosts,
            placeholder,
            value,
            headers,
        });
    }
}

#[allow(deprecated)]
pub unsafe fn options_set_auto_remove(handle: *mut OptionsHandle, val: c_int) {
    if let Some(handle) = unsafe { handle.as_mut() } {
        handle.options.auto_remove = val != 0;
        handle.options.auto_delete = None;
    }
}

pub unsafe fn options_set_detach(handle: *mut OptionsHandle, val: c_int) {
    unsafe {
        if !handle.is_null() {
            (*handle).options.detach = val != 0;
        }
    }
}

pub unsafe fn options_set_entrypoint(
    handle: *mut OptionsHandle,
    args: *const *const c_char,
    argc: c_int,
) {
    unsafe {
        if handle.is_null() {
            return;
        }
        let values = parse_c_string_array(args, argc);
        (*handle).options.entrypoint = if values.is_empty() {
            None
        } else {
            Some(values)
        };
    }
}

pub unsafe fn options_set_cmd(handle: *mut OptionsHandle, args: *const *const c_char, argc: c_int) {
    unsafe {
        if handle.is_null() {
            return;
        }
        let values = parse_c_string_array(args, argc);
        (*handle).options.cmd = if values.is_empty() {
            None
        } else {
            Some(values)
        };
    }
}

pub unsafe fn options_free(handle: *mut OptionsHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

fn parse_c_string_array(args: *const *const c_char, argc: c_int) -> Vec<String> {
    let mut values = Vec::new();
    if args.is_null() || argc <= 0 {
        return values;
    }

    unsafe {
        for idx in 0..argc {
            let arg_ptr = *args.add(idx as usize);
            if arg_ptr.is_null() {
                continue;
            }
            if let Ok(value) = c_str_to_string(arg_ptr) {
                values.push(value);
            }
        }
    }

    values
}

#[cfg(test)]
mod headers_map_tests {
    use super::*;
    use std::ffi::CString;
    use std::ptr;

    #[test]
    fn secret_headers_ffi_preserves_templates() {
        let name = CString::new("bot").unwrap();
        let value = CString::new("token").unwrap();
        let host = CString::new("api.example.com").unwrap();
        let hosts = [host.as_ptr()];
        let key = CString::new("Authorization").unwrap();
        let template = CString::new("Bot {value}").unwrap();
        let empty = CString::new("").unwrap();
        for (template_ptr, expected) in [(template.as_ptr(), "Bot {value}"), (empty.as_ptr(), "")] {
            let mut handle = OptionsHandle {
                options: BoxOptions::default(),
                name: None,
                checkpoint_override: false,
                checkpoint_selected: false,
            };
            unsafe {
                boxlite_options_add_secret_with_headers(
                    &mut handle,
                    name.as_ptr(),
                    value.as_ptr(),
                    ptr::null(),
                    hosts.as_ptr(),
                    1,
                    [key.as_ptr()].as_ptr(),
                    [template_ptr].as_ptr(),
                    1,
                );
            }
            let wire = serde_json::to_value(&handle.options.secrets[0]).unwrap();
            assert_eq!(wire["headers"]["Authorization"], expected);
        }
    }
}
