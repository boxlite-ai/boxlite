//! Native - VMM implementation on `boxlite-vmm`.
//!
//! `create` translates the `InstanceSpec` into a `VmConfig`; `enter` builds
//! the VM and runs it until the guest resets or powers off.

use std::{fs::File, io, path::PathBuf};

use crate::experimental::custom_kernel::KernelFormat;
use crate::rootfs::guest::Strategy;
use crate::runtime::constants::vm_defaults::{DEFAULT_CPUS, DEFAULT_MEMORY_MIB};
use crate::vmm::{
    DiskFormat, InstanceSpec, Vmm, VmmConfig, VmmInstance, VmmKind, engine::VmmInstanceImpl,
    guest_args, registry::EngineFactoryRegistration,
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_vmm::{DiskConfig, Vm, VmConfig};

/// The command line when the box brings no custom one: the 8250 console, a
/// reset on panic and on `reboot`, as the VMM's own boot tests use.
const DEFAULT_CMDLINE: &str = "console=ttyS0 panic=-1 reboot=k";

/// The native engine. Stateless: everything lives in the instance.
#[derive(Debug)]
pub struct Native;

impl Native {
    /// Create the engine; `boxlite-vmm` probes the host in `Vm::new`.
    pub fn new(_options: VmmConfig) -> BoxliteResult<Self> {
        Ok(Self)
    }
}

/// A configured native VM, ready to run on `enter`.
struct NativeVmmInstance {
    config: VmConfig,
    console: Option<PathBuf>,
}

impl VmmInstanceImpl for NativeVmmInstance {
    fn enter(self: Box<Self>) -> BoxliteResult<()> {
        let sink: Box<dyn io::Write + Send> = match &self.console {
            Some(path) => Box::new(File::create(path).map_err(|error| {
                BoxliteError::Engine(format!(
                    "cannot open console output {}: {error}",
                    path.display()
                ))
            })?),
            None => Box::new(io::sink()),
        };
        let mut vm = Vm::new(self.config, sink).map_err(map_vmm_error)?;
        let exit = vm.run().map_err(map_vmm_error)?;
        tracing::info!(?exit, "native VM ended");
        Ok(())
    }
}

/// Requests the engine cannot serve; any one fails `create` before boot.
pub(crate) fn unsupported_requests(spec: &InstanceSpec) -> Vec<&'static str> {
    let mut requests = Vec::new();
    match &spec.kernel {
        None => requests.push("booting without advanced.kernel"),
        Some(kernel) if kernel.format != KernelFormat::Elf => requests.push("non-ELF kernels"),
        Some(_) => {}
    }
    if !matches!(spec.guest_rootfs.strategy, Strategy::Disk { .. }) {
        requests.push("a virtio-fs root");
    }
    if spec.nested_virtualization {
        requests.push("nested virtualization");
    }
    requests
}

/// Requests the engine drops with a warning until their devices land. Each
/// entry goes when its device attaches: virtio-fs shares, virtio-net (the
/// device exists, but `Vm` does not attach it yet) and the vsock bridge.
pub(crate) fn transitional_unattached(spec: &InstanceSpec) -> Vec<&'static str> {
    let mut unattached = Vec::new();
    if !spec.fs_shares.shares().is_empty() {
        unattached.push("virtio-fs shares");
    }
    if spec.network_backend_endpoint.is_some() {
        unattached.push("virtio-net");
    }
    if needs_vsock_bridge(&spec.guest_entrypoint.args) {
        unattached.push("the vsock bridge for the guest agent");
    }
    unattached
}

/// Whether `guest_args` still names a Unix socket for `--listen` or `--notify`,
/// as a separate argument or inside a shell command string.
pub(crate) fn needs_vsock_bridge(guest_args: &[String]) -> bool {
    ["listen", "notify"].iter().any(|arg_name| {
        let flag = format!("--{arg_name}");
        let pattern = format!("--{arg_name} unix://");
        guest_args
            .windows(2)
            .any(|pair| pair[0] == flag && pair[1].starts_with("unix://"))
            || guest_args.iter().any(|arg| arg.contains(&pattern))
    })
}

/// The VM the spec asks for: resources, disks in attach order, the staged
/// kernel and the command line.
pub(crate) fn build_config(spec: &InstanceSpec) -> BoxliteResult<VmConfig> {
    let kernel = spec
        .kernel
        .as_ref()
        .ok_or_else(|| unsupported(&["booting without advanced.kernel"]))?;
    let disks = spec
        .block_devices
        .devices()
        .iter()
        .map(|device| DiskConfig {
            path: device.disk_path.clone(),
            format: match device.format {
                DiskFormat::Raw => boxlite_vmm::DiskFormat::Raw,
                DiskFormat::Qcow2 => boxlite_vmm::DiskFormat::Qcow2,
            },
            read_only: device.read_only,
        })
        .collect();
    Ok(VmConfig {
        vcpu_count: spec.cpus.unwrap_or(DEFAULT_CPUS),
        memory_mib: spec.memory_mib.unwrap_or(DEFAULT_MEMORY_MIB),
        kernel: kernel.path.clone(),
        cmdline: build_cmdline(spec, kernel.command_line.as_deref()),
        initramfs: kernel.initramfs.clone(),
        disks,
    })
}

/// The kernel command line: the custom or default base, the root disk, the
/// agent as `init`, its environment as quoted `"KEY=value"` parameters, and
/// its arguments after `--` with the Unix socket URIs rewritten to the guest's
/// vsock ports.
pub(crate) fn build_cmdline(spec: &InstanceSpec, custom: Option<&str>) -> String {
    let mut parts = vec![custom.unwrap_or(DEFAULT_CMDLINE).to_string()];
    if let Strategy::Disk {
        device_path: Some(device),
        ..
    } = &spec.guest_rootfs.strategy
    {
        parts.push(format!("root={device} rootfstype=ext4 ro"));
    }
    parts.push(format!("init={}", spec.guest_entrypoint.executable));
    // Each entry is one quoted parameter, as libkrun writes it, so a space in
    // a value cannot split off a kernel parameter such as `root=`. The kernel
    // has no escape for `"`, so an entry holding one is dropped.
    parts.extend(spec.guest_entrypoint.env.iter().filter_map(|(key, value)| {
        if key.contains('"') || value.contains('"') {
            tracing::warn!(
                env_key = %key,
                "Skipping env var: the kernel command line cannot quote '\"'"
            );
            return None;
        }
        Some(format!("\"{key}={value}\""))
    }));
    let args = guest_args::transform_guest_args(spec.guest_entrypoint.args.clone());
    if !args.is_empty() {
        parts.push("--".to_string());
        parts.extend(args);
    }
    parts.join(" ")
}

/// `Unsupported` or `PermissionDenied` host causes become `Unsupported`, the
/// configuration bounds `InvalidArgument`, everything else `Engine`; the
/// message keeps the cause chain.
pub(crate) fn map_vmm_error(error: boxlite_vmm::Error) -> BoxliteError {
    use boxlite_vmm::Error;

    let message = error_chain(&error);
    if matches!(
        error,
        Error::InvalidVcpuCount(_)
            | Error::InvalidMemorySize(_)
            | Error::InvalidCommandLine(_)
            | Error::InvalidDiskCount(_)
    ) {
        return BoxliteError::InvalidArgument(message);
    }
    if host_cause(&error).is_some_and(|kind| {
        matches!(
            kind,
            io::ErrorKind::Unsupported | io::ErrorKind::PermissionDenied
        )
    }) {
        return BoxliteError::Unsupported(message);
    }
    BoxliteError::Engine(message)
}

fn unsupported(requests: &[&str]) -> BoxliteError {
    BoxliteError::Unsupported(format!(
        "native engine does not support: {}",
        requests.join(", ")
    ))
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

fn host_cause(error: &dyn std::error::Error) -> Option<io::ErrorKind> {
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(io_error) = cause.downcast_ref::<io::Error>() {
            return Some(io_error.kind());
        }
        source = cause.source();
    }
    None
}

impl Vmm for Native {
    fn create(&mut self, config: InstanceSpec) -> BoxliteResult<VmmInstance> {
        let requests = unsupported_requests(&config);
        if !requests.is_empty() {
            return Err(unsupported(&requests));
        }
        let unattached = transitional_unattached(&config);
        if !unattached.is_empty() {
            tracing::warn!(
                unattached = %unattached.join(", "),
                "native engine boots without these requested devices until they land"
            );
        }
        let vm_config = build_config(&config)?;
        tracing::info!(
            vcpus = vm_config.vcpu_count,
            memory_mib = vm_config.memory_mib,
            disks = vm_config.disks.len(),
            kernel = %vm_config.kernel.display(),
            "native VM configured"
        );
        Ok(VmmInstance::new(Box::new(NativeVmmInstance {
            config: vm_config,
            console: config.console_output,
        })))
    }
}

// Register the engine at compile time; the shim looks it up by `VmmKind`.
inventory::submit! {
    EngineFactoryRegistration {
        kind: VmmKind::Native,
        factory: |options| Ok(Box::new(Native::new(options)?)),
    }
}
