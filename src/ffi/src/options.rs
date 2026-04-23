use std::os::raw::{c_char, c_int};

use boxlite::runtime::options::{
    BoxOptions, NetworkSpec, PortProtocol, PortSpec, RootfsSpec, VolumeSpec,
};

use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::string::c_str_to_string;

pub struct OptionsHandle {
    pub options: BoxOptions,
    pub name: Option<String>,
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

pub unsafe fn options_set_disk(handle: *mut OptionsHandle, disk_gb: i64) {
    unsafe {
        if !handle.is_null() && disk_gb > 0 {
            (*handle).options.disk_size_gb = Some(disk_gb as u64);
        }
    }
}

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
        if let Ok(h) = c_str_to_string(host) {
            if let NetworkSpec::Enabled { allow_net } = &mut (*handle).options.network {
                allow_net.push(h);
            }
        }
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
        let mut ep = Vec::new();
        if !args.is_null() {
            for i in 0..argc {
                let arg_ptr = *args.offset(i as isize);
                if arg_ptr.is_null() {
                    break;
                }
                if let Ok(s) = c_str_to_string(arg_ptr) {
                    ep.push(s);
                }
            }
        }
        (*handle).options.entrypoint = if ep.is_empty() { None } else { Some(ep) };
    }
}

pub unsafe fn options_set_cmd(handle: *mut OptionsHandle, args: *const *const c_char, argc: c_int) {
    unsafe {
        if handle.is_null() {
            return;
        }
        let mut cmd = Vec::new();
        if !args.is_null() {
            for i in 0..argc {
                let arg_ptr = *args.offset(i as isize);
                if arg_ptr.is_null() {
                    break;
                }
                if let Ok(s) = c_str_to_string(arg_ptr) {
                    cmd.push(s);
                }
            }
        }
        (*handle).options.cmd = if cmd.is_empty() { None } else { Some(cmd) };
    }
}

pub unsafe fn options_free(handle: *mut OptionsHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}
