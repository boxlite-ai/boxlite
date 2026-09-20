# Windows Hypervisor Platform (design)

How the [VMM design](README.md) would run a box on Windows x86_64. Planned for M10: today `boxlite-hypervisor` only reserves the `whp` module.

## Components

```mermaid
flowchart TB
  subgraph shim["boxlite-shim · one jailed process per box"]
    run_thread["run() thread · poller"]
    vcpu_threads["vcpuN threads"]
    backend["boxlite-hypervisor · whp<br/>Vm · Vcpu · VcpuHandle<br/>WHvMapGpaRange"]
    devices["MMIO and port buses<br/>8250 · RTC · i8042 · virtio<br/>M10: IOAPIC · PIC · PIT"]
    workers["device workers"]
    guest_ram["guest RAM · host memory"]
    backends["host backends<br/>disks · shares<br/>gvproxy · console.log<br/>box.sock ← runtime"]
  end
  subgraph host_hv["Windows · WHP · M10"]
    hv["vCPUs and guest memory"]
    irqchip["local APIC emulation<br/>interrupts the guest"]
  end
  subgraph guest["guest VM"]
    kernel["guest kernel<br/>virtio drivers"]
    agent["boxlite-guest · PID 1<br/>zygote · containers"]
  end
  run_thread c_new@-->|"Vm::new · kick"| backend
  vcpu_threads c_run@-->|"Vcpu::run → VcpuExit"| backend
  vcpu_threads c_exits@-->|"MMIO and port exits"| devices
  backend c_hv@-->|"WHvRunVirtualProcessor"| hv
  hv c_guest@-->|"runs the guest"| kernel
  devices c_notify@-->|"queue notify"| workers
  kernel c_ram@-->|"RAM: no exit"| guest_ram
  kernel c_pid1@-->|"PID 1"| agent
  workers c_queues@-->|"virtqueues"| guest_ram
  workers c_backends@-->|"blk · fs · vsock<br/>net · console"| backends
  workers c_irq@-->|"Vm::set_irq_line · IOAPIC<br/>WHvRequestInterrupt"| irqchip
```

## Host to guest to host

```mermaid
sequenceDiagram
  participant device as device · BusDevice
  participant vcpu as vcpuN thread · host
  participant backend as whp backend
  participant host as WHP
  participant guest as guest vCPU
  %% edge:t_run
  vcpu->>backend: Vcpu::run
  %% edge:t_host_run
  backend->>host: WHvRunVirtualProcessor
  %% edge:t_enter
  host->>guest: enters the guest
  Note over host,guest: the guest runs natively · RAM stays in the guest
  %% edge:t_trap
  guest->>host: device address · MemoryAccess
  %% edge:t_exit
  host-->>backend: exit context<br/>instruction bytes, guest address
  %% edge:t_decode
  backend->>backend: whp::emulator decodes the access
  %% edge:t_vcpu_exit
  backend-->>vcpu: VcpuExit::MmioRead · guest_addr, bytes
  %% edge:t_bus
  vcpu->>device: BusDevice::read(offset, bytes)
  %% edge:t_filled
  device-->>vcpu: bytes filled
  %% edge:t_again
  vcpu->>backend: Vcpu::run again
  %% edge:t_complete
  backend->>host: writes the register, advances RIP<br/>WHvRunVirtualProcessor
  %% edge:t_resume
  host->>guest: the guest continues after its load
```

## Setup order

```mermaid
sequenceDiagram
  participant caller as run() thread
  participant vm as boxlite_vmm::Vm
  participant backend as whp backend
  participant whp as WHP
  participant vcpu as vcpuN thread
  %% edge:s_new
  caller->>vm: Vm::new(config)
  %% edge:s_partition
  backend->>whp: constructor · WHvCreatePartition<br/>WHvSetPartitionProperty · vCPU count, APIC mode
  %% edge:s_setup
  backend->>whp: WHvSetupPartition
  %% edge:s_map
  vm->>backend: Vm::map_memory · RAM, split around 0xC000_0000
  %% edge:s_gpa
  backend->>whp: WHvMapGpaRange
  %% edge:s_load
  vm->>vm: load the kernel and boot_params
  %% edge:s_run_call
  caller->>vm: vm.run() · spawns the vCPU threads
  loop each vCPU
  %% edge:s_spawn
  vm->>vcpu: spawn vcpuN
  %% edge:s_create_vcpu
  vcpu->>backend: Vm::create_vcpu(N), boot registers (M1)
  %% edge:s_vp
  backend->>whp: WHvCreateVirtualProcessor
  %% edge:s_regs
  backend->>whp: WHvSetVirtualProcessorRegisters<br/>registers, segments, MSRs
  end
  %% edge:s_vcpu_run
  vcpu->>backend: Vcpu::run, once every vCPU exists
  %% edge:s_whv_run
  backend->>whp: WHvRunVirtualProcessor · enters the guest
```

## Boot: the VMM as boot loader, then the kernel and PID 1

```mermaid
sequenceDiagram
  participant vm as boxlite_vmm::Vm · boot loader, no firmware
  participant vcpu as boot vCPU · WHP
  participant kernel as guest kernel · ring 0
  participant init as boxlite-guest · PID 1
  %% edge:b_load
  vm->>vm: bzImage at 1 MiB, or vmlinux where its ELF<br/>headers say · boot_params at 0x7000: setup<br/>header, e820 map, cmd_line_ptr → the command<br/>line at 0x2_0000 · MP table at 0x9_FC00
  %% edge:b_regs
  vm->>vcpu: WHvSetVirtualProcessorRegisters<br/>RIP = the 64-bit entry, RSI = boot_params<br/>long mode, identity paging, GDT, IRQs off
  %% edge:b_run
  vcpu->>kernel: WHvRunVirtualProcessor<br/>the 64-bit entry runs natively
  %% edge:b_head
  kernel->>kernel: a bzImage decompresses itself · startup_64<br/>→ start_kernel · setup_arch reads boot_params
  %% edge:b_smp
  kernel->>kernel: smp_init: INIT and SIPI to each MP table AP
  %% edge:b_probe
  kernel->>vm: do_basic_setup probes each virtio_mmio.device=<br/>magic value, ID reads: MemoryAccess exits
  %% edge:b_exec
  kernel->>init: prepare_namespace mounts /dev/vdb read-only<br/>kernel_init execs /boxlite/bin/boxlite-guest
  %% edge:b_agent
  init->>init: sysctl hardening · forks the zygote<br/>before any thread
  %% edge:b_ready
  init->>vm: gRPC on vsock 2695 · connects to 2696: ready
```

## A process in the guest

```mermaid
sequenceDiagram
  participant host as host · box.sock
  participant vm as boxlite-vmm
  participant kernel as guest kernel
  participant init as boxlite-guest · PID 1
  participant zygote as zygote
  participant proc as container process
  %% edge:p_guest_init
  host->>init: Guest.Init over vsock 2695 · mounts, network
  %% edge:p_container_init
  host->>init: Container.Init · rootfs, OCI bundle
  %% edge:p_build_init
  init->>zygote: build_init
  %% edge:p_clone
  zygote->>proc: clone3: main →<br/>intermediate → init
  %% edge:p_start
  host->>init: Container.Start
  %% edge:p_entry
  init->>proc: init execs the entrypoint
  %% edge:p_exec
  host->>init: Execution.Exec
  %% edge:p_build
  init->>zygote: build · pipes by SCM_RIGHTS
  %% edge:p_tenant
  zygote->>proc: a tenant · PID 1 reaps it
  %% edge:p_syscall
  proc->>kernel: system calls: ring 3 → ring 0 · no exit
  %% edge:p_write
  proc->>init: writes stdout into its pipe
  %% edge:p_attach
  init->>kernel: Attach · ExecOutput · 2695
  %% edge:p_notify
  kernel->>vm: vsock notify · MemoryAccess
  %% edge:p_host
  vm->>host: vsock worker → box.sock
```

## vCPU lifecycle

```mermaid
flowchart TB
  created(["spawned by run()<br/>WHvCreateVirtualProcessor"])
  waiting["waits until<br/>every vCPU exists"]
  check["stop requested?"]
  in_guest["in the guest<br/>WHvRunVirtualProcessor<br/>HLT waits here"]
  dispatching["exit dispatched to a bus<br/>next run: register, RIP<br/>an i8042 write ends the VM"]
  interrupted["Interrupted"]
  ended(["thread returns<br/>joined by run()"])
  created l_regs@-->|"boot registers"| waiting
  waiting l_start@-->|"all created"| check
  check l_enter@-->|"no"| in_guest
  in_guest l_exit@-->|"MMIO · port exit"| dispatching
  dispatching l_again@-->|"again"| check
  in_guest l_kick@-->|"Canceled"| interrupted
  interrupted l_continue@-->|"continue"| check
  in_guest l_terminal@-->|"error"| ended
  check l_stop@-->|"yes · pending I/O finished<br/>VmExit::StopRequested"| ended
```

## Exits

```mermaid
flowchart LR
  subgraph whp_host["Windows Hypervisor Platform"]
    whv_run["WHvRunVirtualProcessor<br/>fills the exit context"]
    in_whp["stays inside the call<br/>HLT"]
  end
  subgraph whp_backend["boxlite-hypervisor · whp"]
    r_canceled["Canceled"]
    r_memory["MemoryAccess<br/>whp::emulator decodes it"]
    r_io["X64IoPortAccess<br/>port · size · RAX"]
    r_eoi["X64ApicEoi · vector"]
  end
  subgraph vcpu_side["VcpuExit to the vcpuN thread"]
    x_interrupted["Interrupted"]
    x_mmio["MmioRead · MmioWrite<br/>MMIO bus → BusDevice"]
    x_io["IoIn · IoOut<br/>8250 · CMOS RTC · i8042<br/>userspace PIC, PIT (M10)"]
    x_unhandled["Error::UnhandledExit"]
  end
  irqchip["userspace IOAPIC<br/>M10 picks the crate"]
  whv_run e_canceled@-->|"ExitReason"| r_canceled
  whv_run e_memory@-->|"ExitReason"| r_memory
  whv_run e_io@-->|"ExitReason"| r_io
  whv_run e_eoi@-->|"ExitReason"| r_eoi
  whv_run e_other@-->|"any other exit"| x_unhandled
  r_canceled e_interrupted@-->|"kick"| x_interrupted
  r_memory e_to_mmio@-->|"next run: register, RIP"| x_mmio
  r_io e_to_io@-->|"next run: RAX, RIP"| x_io
  r_eoi e_to_irqchip@-->|"level-triggered EOI"| irqchip
  r_io e_string@-->|"string port I/O"| x_unhandled
```

## I/O, interrupts and stop

```mermaid
sequenceDiagram
  participant vcpu as vcpuN thread
  participant worker as device worker
  participant irqchip as userspace IOAPIC
  participant backend as whp backend
  participant whp as WHP
  participant runner as run() thread
  participant shim as SIGTERM path
  %% edge:i_notify
  vcpu->>worker: queue notify
  %% edge:i_set_line
  worker->>irqchip: Vm::set_irq_line(GSI, high)
  %% edge:i_request
  irqchip->>whp: WHvRequestInterrupt
  %% edge:i_wake
  whp-->>vcpu: local APIC wakes the vCPU in HLT
  %% edge:i_stop
  shim->>runner: stop.stop()
  %% edge:i_flag
  runner->>runner: set the stop flag
  %% edge:i_kick
  runner->>backend: VcpuHandle::kick and unpark, every vCPU
  %% edge:i_cancel
  backend->>whp: cancel · WHvCancelRun<br/>VirtualProcessor
  %% edge:i_canceled
  whp-->>vcpu: Canceled → Interrupted
  %% edge:i_join
  vcpu-->>runner: thread ends · joined
  %% edge:i_workers
  runner->>worker: stop and join
  %% edge:i_return
  runner->>runner: returns VmExit::StopRequested
```
