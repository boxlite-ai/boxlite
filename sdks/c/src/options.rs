use std::os::raw::{c_char, c_int};

use boxlite::runtime::advanced_options::SecurityOptions;
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

/// Set security options from a JSON string.
///
/// Returns `true` on success, `false` if the JSON is malformed or contains
/// unrecognised fields that prevent parsing into `SecurityOptions`.
///
/// The `preset` key is not a native `SecurityOptions` wire field; this function
/// expands it to concrete fields (matching the Go SDK's `presetDefaults()`)
/// before deserializing, so `{"preset":"maximum"}` is equivalent to passing
/// the full maximum-isolation field set.  Unknown fields other than `preset`
/// cause the function to return `false`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_options_set_security_json(
    opts: *mut CBoxliteOptions,
    security_json: *const c_char,
) -> bool {
    options_set_security_json(opts, security_json)
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

/// Expand a named preset string into concrete `SecurityOptions` fields.
///
/// Returns `true` if the preset is recognised and expanded, `false` if the
/// preset string is unknown.  Callers must treat `false` as a hard error so
/// that typos (e.g. `"maximun"`) are rejected rather than silently falling
/// through to "standard" defaults — a false security signal at the FFI boundary.
///
/// Mirrors Go SDK's `presetDefaults()` so callers using `{"preset":"maximum"}`
/// receive the same concrete isolation settings whether they use Go or C.
fn expand_security_preset(
    preset: &str,
    obj: &mut serde_json::Map<String, serde_json::Value>,
) -> bool {
    use serde_json::{Value, json};
    // Inject only the keys that are NOT already present — explicit caller fields win.
    let defaults: &[(&str, Value)] = match preset {
        "development" => &[
            ("jailer_enabled", json!(false)),
            ("seccomp_enabled", json!(false)),
            ("close_fds", json!(false)),
            ("sanitize_env", json!(false)),
            ("network_enabled", json!(true)),
        ],
        "maximum" => &[
            ("jailer_enabled", json!(true)),
            ("seccomp_enabled", json!(true)),
            ("close_fds", json!(true)),
            ("sanitize_env", json!(true)),
            ("network_enabled", json!(true)),
            (
                "resource_limits",
                json!({
                    "max_open_files": 1024_u64,
                    "max_file_size":  1_073_741_824_u64,
                    "max_processes":  100_u64
                }),
            ),
        ],
        "standard" => &[
            ("jailer_enabled", json!(true)),
            ("seccomp_enabled", json!(false)),
            ("close_fds", json!(true)),
            ("sanitize_env", json!(true)),
            ("network_enabled", json!(true)),
        ],
        // Unknown preset — reject explicitly rather than silently applying standard defaults.
        // Any unrecognised string is a caller error (e.g. a typo), not a preset.
        _ => return false,
    };
    for (key, value) in defaults {
        obj.entry(*key).or_insert_with(|| value.clone());
    }
    true
}

#[allow(clippy::collapsible_if)]
pub unsafe fn options_set_security_json(
    handle: *mut OptionsHandle,
    security_json: *const c_char,
) -> bool {
    unsafe {
        if handle.is_null() || security_json.is_null() {
            return false;
        }
        let json_str = match c_str_to_string(security_json) {
            Ok(s) => s,
            Err(_) => return false,
        };

        // Parse as a generic JSON object first so we can inspect and expand the
        // "preset" key before deserializing into SecurityOptions.  The Rust
        // SecurityOptions struct has no preset field; passing the key through
        // would be silently ignored by serde (no deny_unknown_fields), but the
        // caller would receive default isolation rather than the requested preset.
        let mut obj: serde_json::Map<String, serde_json::Value> =
            match serde_json::from_str(&json_str) {
                Ok(serde_json::Value::Object(m)) => m,
                _ => return false,
            };

        // If a preset is specified, expand it into concrete fields.
        // Explicit caller fields are preserved (they take precedence over preset defaults).
        // Unrecognised presets are rejected — returning false surfaces the caller's typo
        // rather than silently applying standard defaults (a false security signal).
        if let Some(serde_json::Value::String(preset)) = obj.remove("preset") {
            if !expand_security_preset(&preset, &mut obj) {
                return false;
            }
        }

        let expanded_value = serde_json::Value::Object(obj);
        match serde_json::from_value::<SecurityOptions>(expanded_value) {
            Ok(security) => {
                // Take the options out, call with_security (which sets security_explicit),
                // then put them back so the REST layer forwards the field.
                let owned = std::mem::take(&mut (*handle).options);
                (*handle).options = owned.with_security(security);
                true
            }
            Err(_) => false,
        }
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
mod security_json_tests {
    use super::*;
    use std::ffi::CString;

    unsafe fn make_options() -> *mut OptionsHandle {
        let image = CString::new("alpine:latest").unwrap();
        let mut opts: *mut OptionsHandle = std::ptr::null_mut();
        let mut err = crate::error::FFIError::default();
        let code = options_new(image.as_ptr(), &mut opts, &mut err);
        assert_eq!(code, BoxliteErrorCode::Ok, "options_new failed");
        opts
    }

    #[test]
    fn returns_false_for_malformed_json() {
        unsafe {
            let handle = make_options();
            let bad = CString::new("{not valid json").unwrap();
            let ok = options_set_security_json(handle, bad.as_ptr());
            assert!(!ok, "malformed JSON should return false");
            options_free(handle);
        }
    }

    #[test]
    fn returns_false_for_null_handle() {
        unsafe {
            let json = CString::new(r#"{"jailer_enabled":true}"#).unwrap();
            let ok = options_set_security_json(std::ptr::null_mut(), json.as_ptr());
            assert!(!ok, "null handle should return false");
        }
    }

    #[test]
    fn returns_false_for_null_json() {
        unsafe {
            let handle = make_options();
            let ok = options_set_security_json(handle, std::ptr::null());
            assert!(!ok, "null JSON should return false");
            options_free(handle);
        }
    }

    #[test]
    fn maximum_preset_sets_jailer_and_seccomp() {
        // {"preset":"maximum"} must expand to jailer_enabled=true, seccomp_enabled=true.
        // Before the fix, serde silently ignored the unknown "preset" field and returned
        // platform defaults — jailer_enabled depended on cfg!, seccomp_enabled was false.
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"preset":"maximum"}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(ok, "maximum preset should parse successfully");
            let security = (*handle).options.advanced.security().clone();
            assert!(security.jailer_enabled, "maximum preset must enable jailer");
            assert!(
                security.seccomp_enabled,
                "maximum preset must enable seccomp"
            );
            assert!(security.close_fds, "maximum preset must enable close_fds");
            assert!(
                security.sanitize_env,
                "maximum preset must enable sanitize_env"
            );
            assert!(
                security.resource_limits.max_open_files.is_some(),
                "maximum preset must set max_open_files"
            );
            options_free(handle);
        }
    }

    #[test]
    fn development_preset_disables_jailer_and_seccomp() {
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"preset":"development"}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(ok, "development preset should parse successfully");
            let security = (*handle).options.advanced.security().clone();
            assert!(
                !security.jailer_enabled,
                "development preset must disable jailer"
            );
            assert!(
                !security.seccomp_enabled,
                "development preset must disable seccomp"
            );
            assert!(
                !security.close_fds,
                "development preset must disable close_fds"
            );
            assert!(
                !security.sanitize_env,
                "development preset must disable sanitize_env"
            );
            options_free(handle);
        }
    }

    #[test]
    fn explicit_field_overrides_preset() {
        // When both preset and explicit field are present, explicit field wins.
        // {"preset":"maximum","jailer_enabled":false} must leave jailer_enabled=false.
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"preset":"maximum","jailer_enabled":false}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(
                ok,
                "preset with explicit override should parse successfully"
            );
            let security = (*handle).options.advanced.security().clone();
            // The explicit jailer_enabled=false takes precedence over maximum's true.
            assert!(
                !security.jailer_enabled,
                "explicit jailer_enabled=false must override preset"
            );
            // Other maximum fields are still expanded.
            assert!(
                security.seccomp_enabled,
                "seccomp_enabled comes from maximum preset"
            );
            options_free(handle);
        }
    }

    #[test]
    fn concrete_json_without_preset_still_works() {
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"jailer_enabled":true,"seccomp_enabled":false}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(
                ok,
                "concrete security JSON without preset should parse successfully"
            );
            let security = (*handle).options.advanced.security().clone();
            assert!(security.jailer_enabled);
            assert!(!security.seccomp_enabled);
            options_free(handle);
        }
    }

    #[test]
    fn security_explicit_is_set_after_successful_parse() {
        // options_set_security_json must call with_security() which sets security_explicit=true
        // so the REST layer forwards the security field in the API request.
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"preset":"standard"}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(ok);
            assert!(
                (*handle).options.security_explicit(),
                "security_explicit must be true after set_security_json succeeds"
            );
            options_free(handle);
        }
    }

    #[test]
    fn returns_false_for_camelcase_unknown_field() {
        // Regression: {"seccompEnabled": true} uses camelCase instead of snake_case.
        // Without deny_unknown_fields, serde silently drops the unknown key and returns
        // a SecurityOptions with seccomp_enabled=false — a false security signal.
        // The FFI boundary must reject unknown fields and return false.
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"seccompEnabled": true}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(
                !ok,
                "camelCase key seccompEnabled is unknown — must return false, not silently ignore it"
            );
            options_free(handle);
        }
    }

    #[test]
    fn returns_false_for_unknown_preset() {
        // Regression: {"preset": "maximun"} is a typo for "maximum".
        // Without explicit rejection, expand_security_preset falls through to the "standard"
        // arm and returns true — a false security signal (caller gets standard, not maximum).
        // The FFI boundary must reject unrecognised presets and return false.
        unsafe {
            let handle = make_options();
            let json = CString::new(r#"{"preset": "maximun"}"#).unwrap();
            let ok = options_set_security_json(handle, json.as_ptr());
            assert!(
                !ok,
                "unknown preset 'maximun' must return false, not silently apply standard"
            );
            options_free(handle);
        }
    }
}
