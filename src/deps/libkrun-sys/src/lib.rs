//! Low-level FFI bindings to libkrun
//!
//! This crate provides raw, unsafe bindings to the libkrun C library.
//! For a safe, idiomatic Rust API, use the higher-level wrapper in the boxlite crate.

use std::os::raw::c_char;

// Log constants from libkrun.h
pub const KRUN_LOG_TARGET_DEFAULT: i32 = 0;
pub const KRUN_LOG_TARGET_STDOUT: i32 = 1;
pub const KRUN_LOG_TARGET_STDERR: i32 = 2;

pub const KRUN_LOG_LEVEL_OFF: u32 = 0;
pub const KRUN_LOG_LEVEL_ERROR: u32 = 1;
pub const KRUN_LOG_LEVEL_WARN: u32 = 2;
pub const KRUN_LOG_LEVEL_INFO: u32 = 3;
pub const KRUN_LOG_LEVEL_DEBUG: u32 = 4;
pub const KRUN_LOG_LEVEL_TRACE: u32 = 5;

pub const KRUN_LOG_STYLE_AUTO: u32 = 0;
pub const KRUN_LOG_STYLE_ALWAYS: u32 = 1;
pub const KRUN_LOG_STYLE_NEVER: u32 = 2;

// Disk format constants from libkrun.h
pub const KRUN_DISK_FORMAT_RAW: u32 = 0;
pub const KRUN_DISK_FORMAT_QCOW2: u32 = 1;

// External kernel format constants from libkrun.h
pub const KRUN_KERNEL_FORMAT_RAW: u32 = 0;
pub const KRUN_KERNEL_FORMAT_ELF: u32 = 1;
pub const KRUN_KERNEL_FORMAT_PE_GZ: u32 = 2;
pub const KRUN_KERNEL_FORMAT_IMAGE_BZ2: u32 = 3;
pub const KRUN_KERNEL_FORMAT_IMAGE_GZ: u32 = 4;
pub const KRUN_KERNEL_FORMAT_IMAGE_ZSTD: u32 = 5;

// Checkpointing constants from libkrun.h (Linux x86_64 KVM only; elsewhere
// every krun_snapshot_* call returns -ENOTSUP).
pub const KRUN_SNAPSHOT_PAUSE_HOST_WRITERS_STOPPED: u32 = 1 << 0;
pub const KRUN_SNAPSHOT_CAP_MEMORY_V9: u64 = 1 << 0;
pub const KRUN_SNAPSHOT_CAP_CAPTURE_RESERVATION: u64 = 1 << 1;
pub const KRUN_SNAPSHOT_CAP_EXTERNAL_FDS: u64 = 1 << 2;
pub const KRUN_SNAPSHOT_CAPTURE_CHECKPOINT: u32 = 0;
pub const KRUN_SNAPSHOT_CAPTURE_DISK: u32 = 1;
pub const KRUN_SNAPSHOT_CAPTURE_COMPLETE: u32 = 0;
pub const KRUN_SNAPSHOT_CAPTURE_CANCEL: u32 = 1;

pub const KRUN_SNAPSHOT_STATE_CONFIGURED: u32 = 0;
pub const KRUN_SNAPSHOT_STATE_STARTING: u32 = 1;
pub const KRUN_SNAPSHOT_STATE_RUNNING: u32 = 2;
pub const KRUN_SNAPSHOT_STATE_PAUSED: u32 = 3;
pub const KRUN_SNAPSHOT_STATE_EXITED: u32 = 4;
pub const KRUN_SNAPSHOT_STATE_FAILED: u32 = 5;
pub const KRUN_SNAPSHOT_STATE_STOPPED: u32 = 6;

extern "C" {
    pub fn krun_init_log(target: i32, level: u32, style: u32, flags: u32) -> i32;
    pub fn krun_set_log_level(level: u32) -> i32;
    pub fn krun_create_ctx() -> i32;
    pub fn krun_free_ctx(ctx_id: u32) -> i32;
    pub fn krun_set_vm_config(ctx_id: u32, num_vcpus: u8, ram_mib: u32) -> i32;
    pub fn krun_set_root(ctx_id: u32, root_path: *const c_char) -> i32;
    pub fn krun_add_virtiofs(
        ctx_id: u32,
        mount_tag: *const c_char,
        host_path: *const c_char,
    ) -> i32;
    pub fn krun_add_virtiofs3(
        ctx_id: u32,
        mount_tag: *const c_char,
        host_path: *const c_char,
        shm_size: u64,
        read_only: bool,
    ) -> i32;
    pub fn krun_set_kernel(
        ctx_id: u32,
        kernel_path: *const c_char,
        kernel_format: u32,
        initramfs: *const c_char,
        cmdline: *const c_char,
    ) -> i32;
    pub fn krun_set_exec(
        ctx_id: u32,
        exec_path: *const c_char,
        argv: *const *const c_char,
        envp: *const *const c_char,
    ) -> i32;
    pub fn krun_set_env(ctx_id: u32, envp: *const *const c_char) -> i32;
    pub fn krun_set_workdir(ctx_id: u32, workdir_path: *const c_char) -> i32;
    pub fn krun_split_irqchip(ctx_id: u32, enable: bool) -> i32;
    pub fn krun_set_nested_virt(ctx_id: u32, enabled: bool) -> i32;
    pub fn krun_check_nested_virt() -> i32;
    pub fn krun_set_gpu_options(ctx_id: u32, virgl_flags: u32) -> i32;
    pub fn krun_set_rlimits(ctx_id: u32, rlimits: *const *const c_char) -> i32;
    pub fn krun_set_port_map(ctx_id: u32, port_map: *const *const c_char) -> i32;
    pub fn krun_add_vsock_port2(
        ctx_id: u32,
        port: u32,
        filepath: *const c_char,
        listen: bool,
    ) -> i32;
    pub fn krun_add_disk(
        ctx_id: u32,
        block_id: *const c_char,
        disk_path: *const c_char,
        read_only: bool,
    ) -> i32;
    pub fn krun_add_disk2(
        ctx_id: u32,
        block_id: *const c_char,
        disk_path: *const c_char,
        disk_format: u32,
        read_only: bool,
    ) -> i32;
    pub fn krun_add_net_unixstream(
        ctx_id: u32,
        c_path: *const c_char,
        fd: i32,
        c_mac: *const u8,
        features: u32,
        flags: u32,
    ) -> i32;
    pub fn krun_add_net_unixgram(
        ctx_id: u32,
        c_path: *const c_char,
        fd: i32,
        c_mac: *const u8,
        features: u32,
        flags: u32,
    ) -> i32;
    pub fn krun_disable_implicit_vsock(ctx_id: u32) -> i32;
    pub fn krun_add_vsock(ctx_id: u32, tsi_features: u32) -> i32;
    pub fn krun_start_enter(ctx_id: u32) -> i32;

    /// Set a file path to redirect the console output to.
    ///
    /// Must be called before `krun_start_enter`.
    pub fn krun_set_console_output(ctx_id: u32, filepath: *const c_char) -> i32;

    /// Set the uid before starting the microVM.
    /// This allows virtiofsd to run with CAP_SETUID for proper ownership handling.
    pub fn krun_setuid(ctx_id: u32, uid: libc::uid_t) -> i32;

    /// Set the gid before starting the microVM.
    pub fn krun_setgid(ctx_id: u32, gid: libc::gid_t) -> i32;

    /// Configure a root filesystem backed by a block device with automatic remount.
    ///
    /// This allows booting from a disk image without needing to copy the init binary
    /// into the disk. Libkrun creates a dummy virtiofs root, executes init from it,
    /// and then switches to the disk-based root.
    ///
    /// Arguments:
    /// - `ctx_id`: Configuration context ID
    /// - `device`: Block device path (e.g., "/dev/vda", must be a previously configured block device)
    /// - `fstype`: Filesystem type (e.g., "ext4", can be "auto" or NULL)
    /// - `options`: Comma-separated mount options (can be NULL)
    pub fn krun_set_root_disk_remount(
        ctx_id: u32,
        device: *const c_char,
        fstype: *const c_char,
        options: *const c_char,
    ) -> i32;

    /// Version-9 memory, owner reservation and external-descriptor capability bits.
    pub fn krun_snapshot_capabilities() -> u64;
    pub fn krun_snapshot_inspect_fd(memory_fd: i32, json: *mut u8, length: *mut usize) -> i32;
    pub fn krun_snapshot_begin_capture(
        ctx_id: u32,
        kind: u32,
        session_fd: i32,
        token: *mut u64,
    ) -> i32;
    pub fn krun_snapshot_end_capture(ctx_id: u32, token: u64, outcome: u32) -> i32;
    pub fn krun_snapshot_prepare_capture(
        ctx_id: u32,
        token: u64,
        json: *mut u8,
        length: *mut usize,
        fds: *mut i32,
        fd_count: *mut usize,
    ) -> i32;
    pub fn krun_snapshot_export_fd(
        ctx_id: u32,
        token: u64,
        memory_fd: i32,
        qcow2_fd: i32,
        json: *const u8,
        length: usize,
    ) -> i32;
    pub fn krun_snapshot_import_fd(
        ctx_id: u32,
        memory_fd: i32,
        json: *const u8,
        length: usize,
        fds: *const i32,
        fd_count: usize,
    ) -> i32;

    /// Put the context in checkpointing mode. Must precede every
    /// `krun_add_net_*` call; `flags` must be 0.
    pub fn krun_snapshot_enable(ctx_id: u32, flags: u32) -> i32;

    /// Legacy path/archive integration: returns -ENOTSUP; use import_fd.
    pub fn krun_snapshot_import(
        ctx_id: u32,
        image_path: *const c_char,
        disk_dir: *const c_char,
        fs_dir: *const c_char,
    ) -> i32;

    /// RUNNING -> PAUSED. Blocks until the owner finished.
    pub fn krun_snapshot_pause(ctx_id: u32, flags: u32) -> i32;

    /// PAUSED -> RUNNING. Blocks until the owner finished.
    pub fn krun_snapshot_resume(ctx_id: u32) -> i32;

    /// Legacy path/archive integration: returns -ENOTSUP; use export_fd.
    pub fn krun_snapshot_export(ctx_id: u32, path: *const c_char) -> i32;

    /// End execution; invalidates an in-flight reservation and aborts copying.
    pub fn krun_snapshot_stop(ctx_id: u32) -> i32;

    /// Non-blocking read of the last published state; `exit_code` is valid
    /// when the state is `KRUN_SNAPSHOT_STATE_EXITED`. Either pointer may be NULL.
    pub fn krun_snapshot_get_state(ctx_id: u32, state: *mut u32, exit_code: *mut i32) -> i32;

    /// Externally bound root of restored share `tag`, NUL-terminated into `path`.
    /// Returns the length without NUL, `-ERANGE` if `path_len` is too small.
    pub fn krun_snapshot_get_restored_share(
        ctx_id: u32,
        tag: *const c_char,
        path: *mut c_char,
        path_len: usize,
    ) -> i32;
}
