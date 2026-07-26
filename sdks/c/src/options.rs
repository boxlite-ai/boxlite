use std::os::raw::{c_char, c_int};

use boxlite::runtime::options::{
    BoxOptions, GuestSshCaKey, GuestSshTrustConfig, NetworkSpec, PortProtocol, PortSpec,
    RootfsSpec, Secret, VolumeSpec,
};

use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::util::c_str_to_string;
use crate::{CBoxliteError, CBoxliteOptions};

pub struct OptionsHandle {
    pub options: BoxOptions,
    pub name: Option<String>,
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
    options_set_rootfs_path(opts, path)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_name(opts: *mut CBoxliteOptions, name: *const c_char) {
    options_set_name(opts, name)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_cpus(opts: *mut CBoxliteOptions, cpus: c_int) {
    options_set_cpus(opts, cpus)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_memory(opts: *mut CBoxliteOptions, memory_mib: c_int) {
    options_set_memory(opts, memory_mib)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_disk_size_gb(
    opts: *mut CBoxliteOptions,
    disk_size_gb: c_int,
) {
    options_set_disk_size_gb(opts, disk_size_gb)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_workdir(
    opts: *mut CBoxliteOptions,
    workdir: *const c_char,
) {
    options_set_workdir(opts, workdir)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_env(
    opts: *mut CBoxliteOptions,
    key: *const c_char,
    val: *const c_char,
) {
    options_add_env(opts, key, val)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_volume(
    opts: *mut CBoxliteOptions,
    host_path: *const c_char,
    guest_path: *const c_char,
    read_only: c_int,
) {
    options_add_volume(opts, host_path, guest_path, read_only)
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
/// - `host_port`: 0 = use the same number as `guest_port`.
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
    options_add_port(opts, host_port, guest_port, protocol, host_ip)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_network_enabled(opts: *mut CBoxliteOptions) {
    options_set_network_enabled(opts)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_network_disabled(opts: *mut CBoxliteOptions) {
    options_set_network_disabled(opts)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_network_allow(
    opts: *mut CBoxliteOptions,
    host: *const c_char,
) {
    options_add_network_allow(opts, host)
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
    options_add_secret(opts, name, value, placeholder, hosts, hosts_count)
}

/// Set the create-time SSH certificate-authority trust handed to the guest.
///
/// **Private bridge symbol for the Go binding, not part of the public C API.**
/// The C SDK exposes no SSH surface, so this is kept out of
/// `include/boxlite.h` via the `[export] exclude` entry in `cbindgen.toml`;
/// the Go SDK declares it itself in `sdks/go/bridge.h`. Renaming it means
/// updating both.
///
/// Carries CA *public* keys and non-secret identifiers only — the same
/// material the guest receives on argv. No private key of any kind may be
/// passed here.
///
/// `ca_key_ids[i]` and `ca_public_keys[i]` describe the same CA, so both
/// arrays must hold `ca_key_count` entries. At least one CA key is required:
/// a trust bundle with none would start a guest listener that can accept
/// nothing, which is a silent lockout rather than a configuration error.
///
/// Returns `InvalidArgument` — leaving the options untouched — if `opts` is
/// NULL, any identity field is NULL/empty/invalid UTF-8, or the CA key arrays
/// are missing, empty, or hold a NULL/empty/invalid entry.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_go_options_set_guest_ssh_trust(
    opts: *mut CBoxliteOptions,
    listen_addr: *const c_char,
    organization_id: *const c_char,
    box_id: *const c_char,
    ca_key_ids: *const *const c_char,
    ca_public_keys: *const *const c_char,
    ca_key_count: c_int,
) -> BoxliteErrorCode {
    unsafe {
        options_set_guest_ssh_trust(
            opts,
            listen_addr,
            organization_id,
            box_id,
            ca_key_ids,
            ca_public_keys,
            ca_key_count,
        )
    }
}

/// Deprecated: use `boxlite_options_set_auto_delete_interval`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_remove(opts: *mut CBoxliteOptions, val: c_int) {
    options_set_auto_remove(opts, val)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_pause_interval(
    opts: *mut CBoxliteOptions,
    seconds: u32,
) {
    options_set_auto_pause_interval(opts, seconds)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_delete_interval(
    opts: *mut CBoxliteOptions,
    seconds: u32,
) {
    options_set_auto_delete_interval(opts, seconds)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_resume_enabled(
    opts: *mut CBoxliteOptions,
    val: c_int,
) {
    options_set_auto_resume_enabled(opts, val)
}

pub unsafe fn options_set_auto_pause_interval(handle: *mut OptionsHandle, seconds: u32) {
    if let Some(handle) = unsafe { handle.as_mut() } {
        handle.options.auto_pause = Some(seconds);
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
    options_set_detach(opts, val)
}

/// Apply a `CAdvancedBoxOptions` (security, mount isolation, health check) to a
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
    options_set_entrypoint(opts, args, argc)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_cmd(
    opts: *mut CBoxliteOptions,
    args: *const *const c_char,
    argc: c_int,
) {
    options_set_cmd(opts, args, argc)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_free(opts: *mut CBoxliteOptions) {
    options_free(opts)
}

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

pub unsafe fn options_set_cpus(handle: *mut OptionsHandle, cpus: c_int) {
    unsafe {
        if !handle.is_null() && cpus > 0 {
            (*handle).options.cpus = Some(cpus as u8);
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

pub unsafe fn options_add_volume(
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
                host_path: h,
                guest_path: g,
                read_only: read_only != 0,
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

pub unsafe fn options_add_secret(
    handle: *mut OptionsHandle,
    name: *const c_char,
    value: *const c_char,
    placeholder: *const c_char,
    hosts: *const *const c_char,
    hosts_count: c_int,
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
        (*handle).options.secrets.push(Secret {
            name,
            hosts,
            placeholder,
            value,
        });
    }
}

pub unsafe fn options_set_guest_ssh_trust(
    handle: *mut OptionsHandle,
    listen_addr: *const c_char,
    organization_id: *const c_char,
    box_id: *const c_char,
    ca_key_ids: *const *const c_char,
    ca_public_keys: *const *const c_char,
    ca_key_count: c_int,
) -> BoxliteErrorCode {
    unsafe {
        let Some(handle) = handle.as_mut() else {
            return BoxliteErrorCode::InvalidArgument;
        };
        // Validate the whole bundle before touching the options: a half-applied
        // trust set (identity without CA keys, or the reverse) would boot a
        // guest that silently accepts nothing.
        let Some(trust) = parse_guest_ssh_trust(
            listen_addr,
            organization_id,
            box_id,
            ca_key_ids,
            ca_public_keys,
            ca_key_count,
        ) else {
            return BoxliteErrorCode::InvalidArgument;
        };
        handle.options.guest_ssh_trust = Some(trust);
        BoxliteErrorCode::Ok
    }
}

/// Read a trust bundle out of the raw C input, or `None` when any part of it
/// is missing or unusable.
///
/// # Safety
/// Same contract as `boxlite_go_options_set_guest_ssh_trust`: the identity
/// pointers must be NULL or null-terminated C strings, and both CA arrays must
/// hold at least `ca_key_count` such pointers.
unsafe fn parse_guest_ssh_trust(
    listen_addr: *const c_char,
    organization_id: *const c_char,
    box_id: *const c_char,
    ca_key_ids: *const *const c_char,
    ca_public_keys: *const *const c_char,
    ca_key_count: c_int,
) -> Option<GuestSshTrustConfig> {
    unsafe {
        if ca_key_ids.is_null() || ca_public_keys.is_null() || ca_key_count <= 0 {
            return None;
        }

        let mut ca_keys = Vec::with_capacity(ca_key_count as usize);
        for index in 0..ca_key_count as usize {
            ca_keys.push(GuestSshCaKey {
                key_id: required_c_string(*ca_key_ids.add(index))?,
                public_key: required_c_string(*ca_public_keys.add(index))?,
            });
        }

        Some(GuestSshTrustConfig {
            listen_addr: required_c_string(listen_addr)?,
            organization_id: required_c_string(organization_id)?,
            box_id: required_c_string(box_id)?,
            ca_keys,
        })
    }
}

/// Owned, trimmed C string, or `None` when it is NULL, not UTF-8, or blank.
///
/// # Safety
/// `value` must be NULL or a valid null-terminated C string.
unsafe fn required_c_string(value: *const c_char) -> Option<String> {
    let text = unsafe { c_str_to_string(value) }.ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
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
