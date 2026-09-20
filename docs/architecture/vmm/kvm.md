# Linux KVM (design)

How the [VMM design](README.md) runs a box on Linux x86_64 and arm64. Planned: M1 boots a test initramfs on this backend, and M2 adds virtio devices and `boxlite-guest` as PID 1.

## Components

```mermaid
flowchart TB
  subgraph shim["boxlite-shim · one jailed process per box"]
    run_thread["run() thread · poller"]
    vcpu_threads["vcpuN threads"]
    backend["boxlite-hypervisor · kvm<br/>Vm · Vcpu · VcpuHandle"]
    devices["MMIO and port buses<br/>UART · RTC · x86 i8042<br/>virtio-mmio devices"]
    workers["device workers"]
    guest_ram["guest RAM · host memory"]
    backends["host backends<br/>disks · shares<br/>gvproxy · console.log<br/>box.sock ← runtime"]
  end
  subgraph host_hv["Linux · KVM"]
    hv["vCPUs and guest memory"]
    irqchip["in-kernel irqchip<br/>GICv3, or PIC · IOAPIC<br/>local APIC · PIT"]
  end
  subgraph guest["guest VM"]
    kernel["guest kernel<br/>virtio drivers"]
    agent["boxlite-guest · PID 1<br/>zygote · containers"]
  end
  run_thread c_new@-->|"Vm::new · kick"| backend
  vcpu_threads c_run@-->|"Vcpu::run → VcpuExit"| backend
  vcpu_threads c_exits@-->|"MMIO and port exits"| devices
  backend c_hv@-->|"KVM_RUN · memory slots"| hv
  hv c_guest@-->|"runs the guest"| kernel
  devices c_notify@-->|"queue notify"| workers
  kernel c_ram@-->|"RAM: no exit"| guest_ram
  kernel c_pid1@-->|"PID 1"| agent
  workers c_queues@-->|"virtqueues"| guest_ram
  workers c_backends@-->|"blk · fs · vsock<br/>net · console"| backends
  workers c_irq@-->|"Vm::set_irq_line<br/>KVM_IRQ_LINE"| irqchip
```

## Host to guest to host

```mermaid
sequenceDiagram
  participant device as device · BusDevice
  participant vcpu as vcpuN thread · host
  participant backend as kvm backend
  participant host as KVM
  participant guest as guest vCPU
  %% edge:t_run
  vcpu->>backend: Vcpu::run
  %% edge:t_host_run
  backend->>host: KVM_RUN
  %% edge:t_enter
  host->>guest: enters the guest
  Note over host,guest: the guest runs natively · RAM stays in the guest
  %% edge:t_trap
  guest->>host: device address · KVM_EXIT_MMIO
  %% edge:t_exit
  host-->>backend: exit_reason, data in kvm_run
  %% edge:t_vcpu_exit
  backend-->>vcpu: VcpuExit::MmioRead · guest_addr, bytes
  %% edge:t_bus
  vcpu->>device: BusDevice::read(offset, bytes)
  %% edge:t_filled
  device-->>vcpu: bytes filled
  %% edge:t_again
  vcpu->>backend: Vcpu::run again
  %% edge:t_complete
  backend->>host: KVM_RUN<br/>the kernel completes the load
  %% edge:t_resume
  host->>guest: the guest continues after its load
```

## Setup order

```mermaid
sequenceDiagram
  participant caller as run() thread
  participant vm as boxlite_vmm::Vm
  participant backend as kvm backend
  participant kvm as KVM · /dev/kvm
  participant vcpu as vcpuN thread
  %% edge:s_new
  caller->>vm: Vm::new(config)
  %% edge:s_vm_create
  backend->>kvm: constructor · KVM_CREATE_VM · Intel: KVM_SET_TSS_ADDR
  %% edge:s_irqchip
  backend->>kvm: x86: KVM_CREATE_IRQCHIP, KVM_CREATE_PIT2<br/>arm64: vGICv3 device and its addresses
  %% edge:s_map
  vm->>backend: Vm::map_memory · RAM
  %% edge:s_memslot
  backend->>kvm: KVM_SET_USER_MEMORY_REGION · a slot the backend picks
  %% edge:s_load
  vm->>vm: load the kernel and its boot data
  %% edge:s_run_call
  caller->>vm: vm.run() · spawns the vCPU threads
  %% edge:s_spawn
  vm->>vcpu: spawn vcpuN, one per vCPU
  %% edge:s_create_vcpu
  vcpu->>backend: Vm::create_vcpu(N), boot registers (M1)
  %% edge:s_kvm_vcpu
  backend->>kvm: KVM_CREATE_VCPU, mmap kvm_run<br/>arm64: KVM_ARM_VCPU_INIT, secondaries powered off
  %% edge:s_regs
  backend->>kvm: arm64 boot vCPU: KVM_SET_ONE_REG PC, X0, PSTATE<br/>arm64 every vCPU: KVM_SET_ONE_REG MPIDR_EL1<br/>x86_64: KVM_SET_CPUID2, MSRS, REGS, FPU, SREGS, LINT pins
  %% edge:s_vcpu_run
  vcpu->>backend: Vcpu::run, once every vCPU exists
  %% edge:s_kvm_run
  backend->>kvm: arm64, first run only: KVM_DEV_ARM_VGIC_CTRL_INIT<br/>KVM_RUN · enters the guest
```

## Boot on arm64: the VMM as boot loader, then the kernel and PID 1

```mermaid
sequenceDiagram
  participant vm as boxlite_vmm::Vm · boot loader, no firmware
  participant vcpu as boot vCPU · KVM
  participant kernel as guest kernel · EL1
  participant init as boxlite-guest · PID 1
  %% edge:b_load
  vm->>vm: Image at its text offset, 2 MiB aligned base<br/>device tree in the last 2 MiB: memory, CPUs,<br/>psci, GIC, timer, apb_pclk, PL011, PL031,<br/>virtio,mmio, bootargs
  %% edge:b_regs
  vm->>vcpu: KVM_SET_ONE_REG: PC = the Image's first<br/>instruction, X0 = the device tree<br/>EL1, DAIF masked, MMU off
  %% edge:b_run
  vcpu->>kernel: KVM_RUN<br/>the header's NOP, then b primary_entry
  %% edge:b_head
  kernel->>kernel: keeps X0 as the device tree · MMU on<br/>start_kernel · setup_arch reads the<br/>device tree and the command line
  %% edge:b_smp
  kernel->>vcpu: smp_init: PSCI CPU_ON per secondary<br/>KVM starts it, no exit
  %% edge:b_probe
  kernel->>vm: do_basic_setup probes each virtio,mmio node<br/>magic value, ID reads: KVM_EXIT_MMIO exits
  %% edge:b_exec
  kernel->>init: prepare_namespace mounts /dev/vdb read-only<br/>kernel_init execs /boxlite/bin/boxlite-guest
  %% edge:b_agent
  init->>init: sysctl hardening · forks the zygote<br/>before any thread
  %% edge:b_ready
  init->>vm: gRPC on vsock 2695 · connects to 2696: ready
```

## Boot on x86_64: the VMM as boot loader, then the kernel and PID 1

```mermaid
sequenceDiagram
  participant vm as boxlite_vmm::Vm · boot loader, no firmware
  participant vcpu as boot vCPU · KVM
  participant kernel as guest kernel · ring 0
  participant init as boxlite-guest · PID 1
  %% edge:b_load
  vm->>vm: bzImage at 1 MiB, or vmlinux where its ELF<br/>headers say · boot_params at 0x7000: setup<br/>header, e820 map, cmd_line_ptr → the command<br/>line at 0x2_0000 · MP table at 0x9_FC00
  %% edge:b_regs
  vm->>vcpu: KVM_SET_REGS, KVM_SET_SREGS<br/>RIP = the 64-bit entry, RSI = boot_params<br/>long mode, identity paging, GDT, IRQs off
  %% edge:b_run
  vcpu->>kernel: KVM_RUN<br/>the 64-bit entry runs natively
  %% edge:b_head
  kernel->>kernel: a bzImage decompresses itself · startup_64<br/>→ start_kernel · setup_arch reads boot_params
  %% edge:b_smp
  kernel->>vcpu: smp_init: INIT and SIPI to each MP table AP<br/>KVM's local APIC starts it
  %% edge:b_probe
  kernel->>vm: do_basic_setup probes each virtio_mmio.device=<br/>magic value, ID reads: KVM_EXIT_MMIO exits
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
  proc->>kernel: system calls: EL0 / ring 3 → EL1 / ring 0 · no exit
  %% edge:p_write
  proc->>init: writes stdout into its pipe
  %% edge:p_attach
  init->>kernel: Attach · ExecOutput · 2695
  %% edge:p_notify
  kernel->>vm: vsock notify · KVM_EXIT_MMIO
  %% edge:p_host
  vm->>host: vsock worker → box.sock
```

## vCPU lifecycle

```mermaid
flowchart TB
  created(["spawned by run()<br/>KVM_CREATE_VCPU<br/>its kvm_run mapped"])
  waiting["waits until<br/>every vCPU exists"]
  check["stop requested?"]
  in_guest["in the guest · KVM_RUN<br/>WFI, HLT and powered-off<br/>arm64 secondaries wait"]
  dispatching["exit dispatched to a bus<br/>next KVM_RUN completes it"]
  interrupted["Interrupted"]
  ended(["thread returns<br/>joined by run()"])
  created l_regs@-->|"boot registers · arm64<br/>entry point: boot vCPU only"| waiting
  waiting l_start@-->|"all created"| check
  check l_enter@-->|"no"| in_guest
  in_guest l_exit@-->|"MMIO · port exit"| dispatching
  dispatching l_again@-->|"again"| check
  in_guest l_kick@-->|"EINTR"| interrupted
  interrupted l_continue@-->|"continue"| check
  in_guest l_terminal@-->|"Shutdown · Reset · error"| ended
  check l_stop@-->|"yes · pending I/O finished<br/>VmExit::StopRequested"| ended
```

## Exits

```mermaid
flowchart LR
  subgraph kvm_host["Linux KVM"]
    kvm_run["KVM_RUN returns<br/>exit_reason in kvm_run"]
    in_kernel["stays in the kernel<br/>WFI · HLT · PSCI CPU_ON"]
  end
  subgraph kvm_backend["boxlite-hypervisor · kvm"]
    r_eintr["EINTR<br/>immediate_exit + signal"]
    r_mmio["KVM_EXIT_MMIO"]
    r_io["KVM_EXIT_IO · x86_64"]
    r_event["KVM_EXIT_SYSTEM_EVENT"]
    r_triple["KVM_EXIT_SHUTDOWN"]
    r_hlt["KVM_EXIT_HLT"]
  end
  subgraph vcpu_side["VcpuExit to the vcpuN thread"]
    x_interrupted["Interrupted"]
    x_mmio["MmioRead · MmioWrite<br/>MMIO bus → BusDevice"]
    x_io["IoIn · IoOut<br/>8250 · CMOS RTC · i8042"]
    x_shutdown["Shutdown"]
    x_reset["Reset"]
    x_halted["Halted"]
    x_unhandled["Error::UnhandledExit<br/>also any other exit_reason"]
  end
  kvm_run e_eintr@-->|"returns"| r_eintr
  kvm_run e_mmio@-->|"exit_reason"| r_mmio
  kvm_run e_io@-->|"exit_reason"| r_io
  kvm_run e_event@-->|"exit_reason"| r_event
  kvm_run e_triple@-->|"exit_reason"| r_triple
  kvm_run e_hlt@-->|"exit_reason"| r_hlt
  r_eintr e_interrupted@-->|"kick"| x_interrupted
  r_mmio e_to_mmio@-->|"next KVM_RUN completes it"| x_mmio
  r_io e_to_io@-->|"next KVM_RUN completes it"| x_io
  r_event e_off@-->|"power off"| x_shutdown
  r_event e_event_reset@-->|"reset"| x_reset
  r_triple e_triple_reset@-->|"triple fault"| x_reset
  r_hlt e_halted@-->|"no irqchip"| x_halted
  r_io e_string@-->|"string port I/O"| x_unhandled
```

## I/O, interrupts and stop

```mermaid
sequenceDiagram
  participant vcpu as vcpuN thread
  participant worker as device worker
  participant backend as kvm backend
  participant kvm as KVM · irqchip
  participant runner as run() thread
  participant shim as SIGTERM path
  %% edge:i_notify
  vcpu->>worker: queue notify · wakes the worker
  %% edge:i_set_line
  worker->>backend: done · Vm::set_irq_line(line, high)
  %% edge:i_irq_line
  backend->>kvm: KVM_IRQ_LINE · GIC SPI or GSI
  %% edge:i_wake
  kvm-->>vcpu: irqchip wakes the waiting vCPU
  Note over vcpu,kvm: WFI and HLT wait in the kernel: no Halted exit
  %% edge:i_stop
  shim->>runner: stop.stop()
  %% edge:i_flag
  runner->>runner: set the stop flag
  %% edge:i_kick
  runner->>backend: VcpuHandle::kick and unpark, every vCPU
  %% edge:i_immediate
  backend->>vcpu: immediate_exit + signal the thread
  %% edge:i_eintr
  kvm-->>vcpu: KVM_RUN returns EINTR → Interrupted
  %% edge:i_join
  vcpu-->>runner: thread ends · joined
  %% edge:i_workers
  runner->>worker: stop and join
  %% edge:i_return
  runner->>runner: returns VmExit::StopRequested
```
