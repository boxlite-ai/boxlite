//! Native engine tests: the spec translation and error mapping without a
//! hypervisor, and two ignored real-kernel boots through `boxlite-shim`.

use std::{fs, io, path::PathBuf, time::Duration};

use boxlite_shared::{BoxTransport, errors::BoxliteError};

use super::engine::{
    build_cmdline, build_config, map_vmm_error, needs_vsock_bridge, unsupported_requests,
};
use crate::experimental::custom_kernel::KernelFormat;
use crate::jailer::SecurityOptions;
use crate::rootfs::guest::{GuestRootfs, Strategy};
use crate::runtime::id::BoxIDMint;
use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
use crate::runtime::options::BoxOptions;
use crate::util::{ProcessExit, ProcessMonitor, find_binary};
use crate::vmm::controller::{ShimController, VmmController};
use crate::vmm::exit_info::{ExitErrorKind, ExitInfo};
use crate::vmm::{
    BlockDevice, BlockDevices, DiskFormat, Entrypoint, FsShares, InstanceSpec, PreparedKernel, Vmm,
    VmmKind, native::Native,
};

mod guest_boot;
mod m1_initramfs;

#[test]
fn the_public_engine_type_implements_debug() {
    assert_eq!(format!("{:?}", Native), "Native");
}

const CONSOLE_CMDLINE: &str = "console=ttyS0 panic=-1 reboot=k";
const SHIM_TIMEOUT: Duration = Duration::from_secs(90);

/// A box directory under `/tmp`, short enough for the Unix socket paths.
struct TestBox {
    home: tempfile::TempDir,
    layout: BoxFilesystemLayout,
    box_id: crate::runtime::id::BoxID,
}

impl TestBox {
    fn new() -> Self {
        let home = tempfile::TempDir::new_in("/tmp").unwrap();
        let box_id = BoxIDMint::mint();
        let box_dir = home.path().join("boxes").join(box_id.as_str());
        let layout = BoxFilesystemLayout::new(box_dir, FsLayoutConfig::without_bind_mount(), false);
        layout.prepare().unwrap();
        Self {
            home,
            layout,
            box_id,
        }
    }

    /// Stages `bytes` as a kernel file and the given initramfs, the way the
    /// boot-assets task does, and returns the prepared kernel.
    fn stage_kernel(&self, kernel: &[u8], initramfs: Option<&[u8]>) -> PreparedKernel {
        let generation = self.layout.boot_dir().join("generations").join("test");
        fs::create_dir_all(&generation).unwrap();
        let kernel_path = generation.join("vmlinux");
        fs::write(&kernel_path, kernel).unwrap();
        let initramfs_path = initramfs.map(|bytes| {
            let path = generation.join("initramfs.cpio");
            fs::write(&path, bytes).unwrap();
            path
        });
        PreparedKernel::new(
            kernel_path,
            KernelFormat::Elf,
            initramfs_path,
            Some(CONSOLE_CMDLINE.to_string()),
        )
        .unwrap()
    }

    /// The spec the shim-level tests send: a serial console, no shares, no
    /// network, and `/init` from the initramfs as the guest program.
    fn spec(&self, kernel: Option<PreparedKernel>) -> InstanceSpec {
        InstanceSpec {
            engine: VmmKind::Native,
            box_id: self.box_id.to_string(),
            security: SecurityOptions::default(),
            nested_virtualization: false,
            cpus: Some(1),
            max_cpus: None,
            max_memory_mib: None,
            memory_mib: Some(256),
            kernel,
            fs_shares: FsShares::new(),
            block_devices: BlockDevices::new(),
            guest_entrypoint: Entrypoint {
                executable: "/init".to_string(),
                args: Vec::new(),
                env: Vec::new(),
            },
            transport: BoxTransport::unix(self.layout.socket_path()),
            ready_transport: BoxTransport::unix(self.layout.ready_socket_path()),
            guest_rootfs: GuestRootfs {
                path: PathBuf::new(),
                strategy: Strategy::Disk {
                    disk_path: PathBuf::new(),
                    device_path: None,
                },
                kernel: None,
                initrd: None,
                env: Vec::new(),
            },
            network_backend_spec: None,
            network_backend_endpoint: None,
            disable_network: true,
            home_dir: self.home.path().to_path_buf(),
            console_output: Some(self.layout.console_output_path()),
            exit_file: self.layout.exit_file_path(),
            detach: false,
        }
    }

    /// Runs `spec` in a real `boxlite-shim` and returns how it exited.
    async fn run_shim(&self, spec: &InstanceSpec) -> ProcessExit {
        let mut controller = ShimController::new(
            find_binary("boxlite-shim").unwrap(),
            VmmKind::Native,
            self.box_id.clone(),
            BoxOptions::default(),
            self.layout.clone(),
        )
        .unwrap();
        let handler = controller.start(spec).await.unwrap();
        tokio::time::timeout(
            SHIM_TIMEOUT,
            ProcessMonitor::new(handler.pid()).wait_for_exit(),
        )
        .await
        .expect("the shim exits within the timeout")
    }

    fn console(&self) -> String {
        fs::read_to_string(self.layout.console_output_path()).unwrap_or_default()
    }
}

/// A spec like the runtime's: an alpine box with SHARED, the agent's socket
/// bridge and the two disks, and no network.
fn runtime_like_spec(test_box: &TestBox, kernel: Option<PreparedKernel>) -> InstanceSpec {
    let mut spec = test_box.spec(kernel);
    spec.fs_shares
        .add("BoxLiteShared", PathBuf::from("/shared"), false);
    spec.block_devices.add(BlockDevice {
        block_id: "vda".to_string(),
        disk_path: PathBuf::from("/disks/disk.qcow2"),
        read_only: false,
        format: DiskFormat::Qcow2,
    });
    spec.block_devices.add(BlockDevice {
        block_id: "vdb".to_string(),
        disk_path: PathBuf::from("/bases/guest.ext4"),
        read_only: true,
        format: DiskFormat::Raw,
    });
    spec.guest_rootfs.strategy = Strategy::Disk {
        disk_path: PathBuf::from("/bases/guest.ext4"),
        device_path: Some("/dev/vdb".to_string()),
    };
    spec.guest_entrypoint = Entrypoint {
        executable: "/boxlite/bin/boxlite-guest".to_string(),
        args: vec![
            "--listen".to_string(),
            "unix:///tmp/bl/box.sock".to_string(),
            "--notify".to_string(),
            "unix:///tmp/bl/ready.sock".to_string(),
        ],
        env: vec![("RUST_LOG".to_string(), "info".to_string())],
    };
    spec
}

/// A stand-in kernel file: the tests below never load it.
fn fake_kernel() -> Vec<u8> {
    b"\x7fELF-stand-in".to_vec()
}

#[test]
fn a_missing_kernel_and_a_virtiofs_root_are_unsupported() {
    let test_box = TestBox::new();
    let mut spec = test_box.spec(None);
    spec.guest_rootfs.strategy = Strategy::Direct;
    spec.nested_virtualization = true;

    let requests = unsupported_requests(&spec);

    assert_eq!(
        requests,
        [
            "booting without advanced.kernel",
            "a virtio-fs root",
            "nested virtualization"
        ]
    );
    let error = Native.create(spec).err().expect("create fails");
    assert!(
        matches!(&error, BoxliteError::Unsupported(message) if message.contains("advanced.kernel")),
        "{error:?}"
    );
}

#[test]
fn a_non_elf_kernel_is_unsupported() {
    let test_box = TestBox::new();
    let generation = test_box.layout.boot_dir();
    fs::create_dir_all(&generation).unwrap();
    let path = generation.join("bzImage");
    fs::write(&path, b"MZ").unwrap();
    let kernel = PreparedKernel::new(path, KernelFormat::ImageGz, None, None).unwrap();

    let requests = unsupported_requests(&test_box.spec(Some(kernel)));

    assert_eq!(requests, ["non-ELF kernels"]);
}

#[test]
fn shares_network_and_the_agent_bridge_reach_the_vm_config() {
    let test_box = TestBox::new();
    let kernel = test_box.stage_kernel(&fake_kernel(), None);
    let mut spec = runtime_like_spec(&test_box, Some(kernel));
    spec.fs_shares
        .add("readonly", PathBuf::from("/read-only"), true);
    spec.network_backend_endpoint = Some(crate::net::NetworkBackendEndpoint::UnixSocket {
        path: PathBuf::from("/sockets/net.sock"),
        connection_type: crate::net::ConnectionType::UnixStream,
        mac_address: [0x02, 0, 0, 0, 0, 1],
    });

    assert!(unsupported_requests(&spec).is_empty());
    let config = build_config(&spec).unwrap();
    let filesystem = config.filesystem.unwrap();
    assert_eq!(
        filesystem.tag,
        boxlite_shared::constants::mount_tags::AGGREGATE
    );
    assert_eq!(
        filesystem.shares,
        [
            boxlite_vmm::FsShareConfig {
                name: "BoxLiteShared".into(),
                path: "/shared".into(),
                read_only: false
            },
            boxlite_vmm::FsShareConfig {
                name: "readonly".into(),
                path: "/read-only".into(),
                read_only: true
            },
        ]
    );
    let vsock = config.vsock.unwrap();
    assert_eq!(vsock.cid, 3);
    assert_eq!(vsock.listen, [(2695, test_box.layout.socket_path())]);
    assert_eq!(vsock.connect, [(2696, test_box.layout.ready_socket_path())]);
    let network = config.network.unwrap();
    assert_eq!(network.mac, [0x02, 0, 0, 0, 0, 1]);
    assert_eq!(network.path, PathBuf::from("/sockets/net.sock"));
    assert!(config.virtio_console);

    spec.network_backend_endpoint = Some(crate::net::NetworkBackendEndpoint::UnixSocket {
        path: PathBuf::from("/sockets/net.sock"),
        connection_type: crate::net::ConnectionType::UnixDgram,
        mac_address: [0x02, 0, 0, 0, 0, 1],
    });
    assert_eq!(unsupported_requests(&spec), ["datagram network backends"]);
}

#[test]
fn optional_devices_stay_absent_and_non_unix_agent_bridges_are_rejected() {
    let test_box = TestBox::new();
    let kernel = test_box.stage_kernel(&fake_kernel(), None);
    let config = build_config(&test_box.spec(Some(kernel.clone()))).unwrap();
    assert!(config.filesystem.is_none());
    assert!(config.vsock.is_none());
    assert!(config.network.is_none());
    let mut spec = runtime_like_spec(&test_box, Some(kernel));
    spec.ready_transport = BoxTransport::Vsock { port: 2696 };
    assert!(
        matches!(build_config(&spec), Err(BoxliteError::Unsupported(message)) if message.contains("non-Unix host bridges"))
    );
}

#[test]
fn unix_socket_arguments_need_the_vsock_bridge() {
    let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(needs_vsock_bridge(&args(&["--notify", "unix:///r.sock"])));
    assert!(needs_vsock_bridge(&args(&[
        "-c",
        "x --listen unix:///l.sock"
    ])));
    assert!(!needs_vsock_bridge(&args(&["--listen", "vsock://2695"])));
    assert!(!needs_vsock_bridge(&args(&[])));
}

#[test]
fn the_command_line_names_the_root_disk_the_agent_and_its_vsock_ports() {
    let test_box = TestBox::new();
    let spec = runtime_like_spec(&test_box, None);

    assert_eq!(
        build_cmdline(&spec, None),
        "console=hvc0 panic=-1 reboot=k root=/dev/vdb rootfstype=ext4 ro \
         init=/boxlite/bin/boxlite-guest \"RUST_LOG=info\" \
         -- --listen vsock://2695 --notify vsock://2696"
    );
    assert_eq!(
        build_cmdline(&test_box.spec(None), Some("earlycon panic=-1")),
        "earlycon panic=-1 init=/init"
    );
}

#[test]
fn each_environment_entry_stays_one_kernel_parameter() {
    let test_box = TestBox::new();
    let mut spec = runtime_like_spec(&test_box, None);
    spec.guest_entrypoint.env = vec![
        ("FOO".to_string(), "hello root=/dev/vda".to_string()),
        ("BAD".to_string(), "a\"b".to_string()),
    ];

    let cmdline = build_cmdline(&spec, None);

    // Unquoted, the space would split `root=/dev/vda` into a kernel
    // parameter of its own and mount the wrong root disk.
    assert!(
        !cmdline.contains(" root=/dev/vda "),
        "a value leaked a kernel parameter: {cmdline}"
    );
    // The kernel cannot quote a `"`, so that entry is dropped.
    assert!(!cmdline.contains("BAD="), "{cmdline}");
    assert_eq!(
        cmdline,
        "console=hvc0 panic=-1 reboot=k root=/dev/vdb rootfstype=ext4 ro \
         init=/boxlite/bin/boxlite-guest \"FOO=hello root=/dev/vda\" \
         -- --listen vsock://2695 --notify vsock://2696"
    );
}

#[test]
fn the_vm_config_keeps_the_disks_in_attach_order() {
    let test_box = TestBox::new();
    let kernel = test_box.stage_kernel(&fake_kernel(), Some(b"070701"));
    let spec = runtime_like_spec(&test_box, Some(kernel.clone()));

    let config = build_config(&spec).unwrap();

    assert_eq!(config.vcpu_count, 1);
    assert_eq!(config.memory_mib, 256);
    assert_eq!(config.kernel, kernel.path);
    assert_eq!(config.initramfs, kernel.initramfs);
    let disks: Vec<_> = config
        .disks
        .iter()
        .map(|disk| (disk.path.clone(), disk.format, disk.read_only))
        .collect();
    assert_eq!(
        disks,
        [
            (
                PathBuf::from("/disks/disk.qcow2"),
                boxlite_vmm::DiskFormat::Qcow2,
                false
            ),
            (
                PathBuf::from("/bases/guest.ext4"),
                boxlite_vmm::DiskFormat::Raw,
                true
            ),
        ]
    );
    assert!(config.cmdline.starts_with(CONSOLE_CMDLINE));
}

#[test]
fn host_causes_and_configuration_bounds_map_to_typed_errors() {
    let unsupported_host = boxlite_vmm::Error::from(boxlite_hypervisor::Error::CreateVm(
        io::Error::from(io::ErrorKind::Unsupported),
    ));
    assert!(matches!(
        map_vmm_error(unsupported_host),
        BoxliteError::Unsupported(_)
    ));

    let denied_host = boxlite_vmm::Error::from(boxlite_hypervisor::Error::CreateVm(
        io::Error::from(io::ErrorKind::PermissionDenied),
    ));
    assert!(matches!(
        map_vmm_error(denied_host),
        BoxliteError::Unsupported(_)
    ));

    assert!(matches!(
        map_vmm_error(boxlite_vmm::Error::InvalidVcpuCount(0)),
        BoxliteError::InvalidArgument(_)
    ));

    let other_host = boxlite_vmm::Error::from(boxlite_hypervisor::Error::CreateVm(
        io::Error::from(io::ErrorKind::Other),
    ));
    let error = map_vmm_error(other_host);
    assert!(
        matches!(&error, BoxliteError::Engine(message) if message.contains(": ")),
        "the cause chain is kept: {error:?}"
    );
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a boxlite-shim built with native"]
async fn boots_the_m1_initramfs_through_the_shim() {
    let test_box = TestBox::new();
    let kernel = fs::read(std::env::var_os("VMM_KERNEL").expect("set VMM_KERNEL")).unwrap();
    let prepared = test_box.stage_kernel(&kernel, Some(&m1_initramfs::m1_archive()));
    let spec = test_box.spec(Some(prepared));

    let exit = test_box.run_shim(&spec).await;

    let console = test_box.console();
    assert_eq!(exit, ProcessExit::Code(0), "console:\n{console}");
    assert!(
        console
            .lines()
            .any(|line| line.trim() == m1_initramfs::M1_MARKER),
        "console:\n{console}"
    );
    assert!(
        ExitInfo::from_file(&test_box.layout.exit_file_path()).is_none(),
        "the shim wrote an exit record: {:?}",
        fs::read_to_string(test_box.layout.exit_file_path())
    );
}

#[tokio::test]
#[ignore = "requires Linux x86_64 with /dev/kvm, VMM_KERNEL and a boxlite-shim built with native"]
async fn reports_a_missing_kernel_through_the_exit_file() {
    let test_box = TestBox::new();
    let spec = runtime_like_spec(&test_box, None);

    let exit = test_box.run_shim(&spec).await;

    assert_ne!(exit, ProcessExit::Code(0));
    match ExitInfo::from_file(&test_box.layout.exit_file_path()) {
        Some(ExitInfo::Error {
            message,
            error_kind,
            ..
        }) => {
            assert_eq!(error_kind, ExitErrorKind::Unsupported);
            assert!(message.contains("advanced.kernel"), "{message}");
        }
        other => panic!("expected an Unsupported exit record, got {other:?}"),
    }
}
