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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_add_port(
    opts: *mut CBoxliteOptions,
    guest_port: c_int,
    host_port: c_int,
) {
    options_add_port(opts, guest_port, host_port)
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_auto_remove(opts: *mut CBoxliteOptions, val: c_int) {
    options_set_auto_remove(opts, val)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_detach(opts: *mut CBoxliteOptions, val: c_int) {
    options_set_detach(opts, val)
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

pub unsafe fn options_add_port(handle: *mut OptionsHandle, guest_port: c_int, host_port: c_int) {
    unsafe {
        if handle.is_null() {
            return;
        }
        (*handle).options.ports.push(PortSpec {
            guest_port: guest_port as u16,
            host_port: if host_port > 0 {
                Some(host_port as u16)
            } else {
                None
            },
            protocol: PortProtocol::Tcp,
            host_ip: None,
        });
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

pub unsafe fn options_set_auto_remove(handle: *mut OptionsHandle, val: c_int) {
    unsafe {
        if !handle.is_null() {
            (*handle).options.auto_remove = val != 0;
        }
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
