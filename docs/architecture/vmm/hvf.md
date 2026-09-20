# macOS Hypervisor.framework (design)

How the [VMM design](README.md) runs a box on macOS 15+ on Apple silicon. Planned: M1 boots a test initramfs on this backend, and M2 adds virtio devices and `boxlite-guest` as PID 1.

## Components

```mermaid
flowchart TB
  subgraph shim["boxlite-shim · one jailed process per box"]
    run_thread["run() thread · poller"]
    vcpu_threads["vcpuN threads"]
    backend["boxlite-hypervisor · hvf<br/>Vm · Vcpu · VcpuHandle"]
    devices["MMIO bus<br/>PL011 · PL031<br/>virtio-mmio devices"]
    workers["device workers"]
    guest_ram["guest RAM · host memory"]
    backends["host backends<br/>disks · shares<br/>gvproxy · console.log<br/>box.sock ← runtime"]
  end
  subgraph host_hv["macOS 15+ · Hypervisor.framework"]
    hv["vCPUs and guest memory"]
    irqchip["in-kernel GICv3 · vtimer<br/>interrupts the guest"]
  end
  subgraph guest["guest VM"]
    kernel["guest kernel<br/>virtio drivers"]
    agent["boxlite-guest · PID 1<br/>zygote · containers"]
  end
  run_thread c_new@-->|"Vm::new · kick"| backend
  vcpu_threads c_run@-->|"Vcpu::run → VcpuExit"| backend
  vcpu_threads c_exits@-->|"MMIO exits"| devices
  backend c_hv@-->|"hv_vcpu_run · hv_vm_map"| hv
  hv c_guest@-->|"runs the guest"| kernel
  devices c_notify@-->|"queue notify"| workers
  kernel c_ram@-->|"RAM: no exit"| guest_ram
  kernel c_pid1@-->|"PID 1"| agent
  workers c_queues@-->|"virtqueues"| guest_ram
  workers c_backends@-->|"blk · fs · vsock<br/>net · console"| backends
  workers c_irq@-->|"Vm::set_irq_line<br/>hv_gic_set_spi"| irqchip
```

## Host to guest to host

```mermaid
sequenceDiagram
  participant device as device · BusDevice
  participant vcpu as vcpuN thread · host
  participant backend as hvf backend
  participant host as Hypervisor.framework
  participant guest as guest vCPU
  %% edge:t_run
  vcpu->>backend: Vcpu::run
  %% edge:t_host_run
  backend->>host: hv_vcpu_run
  %% edge:t_enter
  host->>guest: enters the guest
  Note over host,guest: the guest runs natively · RAM stays in the guest
  %% edge:t_trap
  guest->>host: device address · data abort
  %% edge:t_exit
  host-->>backend: EXCEPTION<br/>syndrome, guest address
  %% edge:t_decode
  backend->>backend: hvf::syndrome decodes SAS, WnR, SRT
  %% edge:t_vcpu_exit
  backend-->>vcpu: VcpuExit::MmioRead · guest_addr, bytes
  %% edge:t_bus
  vcpu->>device: BusDevice::read(offset, bytes)
  %% edge:t_filled
  device-->>vcpu: bytes filled
  %% edge:t_again
  vcpu->>backend: Vcpu::run again
  %% edge:t_complete
  backend->>host: writes Xt, PC + 4<br/>hv_vcpu_run
  %% edge:t_resume
  host->>guest: the guest continues after its load
```

## Setup order

```mermaid
sequenceDiagram
  participant caller as run() thread
  participant vm as boxlite_vmm::Vm
  participant backend as hvf backend
  participant hvf as Hypervisor.framework
  participant vcpu as vcpuN thread
  %% edge:s_new
  caller->>vm: Vm::new(config)
  %% edge:s_vm_create
  backend->>hvf: constructor · hv_vm_create, one VM per process
  %% edge:s_gic_create
  backend->>hvf: hv_gic_create · before any vCPU<br/>GICD 0x3FFF_0000, GICRs below it
  %% edge:s_map
  vm->>backend: Vm::map_memory · RAM at 0x8000_0000
  %% edge:s_vm_map
  backend->>hvf: hv_vm_map · 16 KiB aligned
  %% edge:s_load
  vm->>vm: load the kernel Image and device tree
  %% edge:s_run_call
  caller->>vm: vm.run() · spawns the vCPU threads
  loop each vCPU
  %% edge:s_spawn
  vm->>vcpu: spawn vcpuN
  %% edge:s_create_vcpu
  vcpu->>backend: Vm::create_vcpu(N), boot registers (M1)
  %% edge:s_vcpu_create
  backend->>hvf: hv_vcpu_create · binds this thread
  %% edge:s_hv_regs
  backend->>hvf: boot vCPU: hv_vcpu_set_reg PC, X0, PSTATE<br/>every vCPU: hv_vcpu_set_sys_reg MPIDR_EL1
  end
  %% edge:s_vcpu_run
  vcpu->>backend: Vcpu::run · the boot vCPU now, secondaries after CPU_ON
  %% edge:s_hv_run
  backend->>hvf: hv_vcpu_run · enters the guest
```

## Boot: the VMM as boot loader, then the kernel and PID 1

```mermaid
sequenceDiagram
  participant vm as boxlite_vmm::Vm · boot loader, no firmware
  participant vcpu as boot vCPU · Hypervisor.framework
  participant kernel as guest kernel · EL1
  participant init as boxlite-guest · PID 1
  %% edge:b_load
  vm->>vm: Image at its text offset, 2 MiB aligned base<br/>device tree in the last 2 MiB: memory, CPUs,<br/>psci, GIC, timer, apb_pclk, PL011, PL031,<br/>virtio,mmio, bootargs
  %% edge:b_regs
  vm->>vcpu: hv_vcpu_set_reg: PC = the Image's first<br/>instruction, X0 = the device tree<br/>EL1, DAIF masked, MMU off
  %% edge:b_run
  vcpu->>kernel: hv_vcpu_run<br/>the header's NOP, then b primary_entry
  %% edge:b_head
  kernel->>kernel: keeps X0 as the device tree · MMU on<br/>start_kernel · setup_arch reads the<br/>device tree and the command line
  %% edge:b_smp
  kernel->>vm: smp_init: PSCI CPU_ON per secondary · an exit (M1) starts it
  %% edge:b_probe
  kernel->>vm: do_basic_setup probes each virtio,mmio node<br/>magic value, ID reads: data abort exits
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
  proc->>kernel: system calls: EL0 → EL1 · no exit
  %% edge:p_write
  proc->>init: writes stdout into its pipe
  %% edge:p_attach
  init->>kernel: Attach · ExecOutput · 2695
  %% edge:p_notify
  kernel->>vm: vsock notify · data abort
  %% edge:p_host
  vm->>host: vsock worker → box.sock
```

## vCPU lifecycle

```mermaid
flowchart TB
  created(["spawned by run()<br/>hv_vcpu_create<br/>bound to this thread"])
  waiting["waits until<br/>every vCPU exists"]
  check["stop requested?"]
  in_guest["in the guest<br/>hv_vcpu_run"]
  dispatching["exit dispatched to a bus<br/>next run completes it"]
  interrupted["Interrupted"]
  ended(["thread returns<br/>joined by run()"])
  powered_off["secondary vCPU, parked<br/>powered off until CPU_ON"]
  parked["parked on Halted<br/>timer, interrupt or stop"]
  created l_regs@-->|"every vCPU: MPIDR_EL1<br/>boot vCPU: PC, X0, PSTATE"| waiting
  waiting l_start@-->|"boot vCPU"| check
  waiting l_secondary@-->|"secondary"| powered_off
  powered_off l_cpu_on@-->|"CPU_ON, or a stop<br/>unparks it"| check
  check l_enter@-->|"no"| in_guest
  in_guest l_exit@-->|"MMIO exit"| dispatching
  dispatching l_again@-->|"again"| check
  in_guest l_kick@-->|"CANCELED"| interrupted
  interrupted l_continue@-->|"continue"| check
  in_guest l_wfi@-->|"WFI"| parked
  parked l_unpark@-->|"unparked"| check
  in_guest l_terminal@-->|"Shutdown · Reset · error"| ended
  check l_stop@-->|"yes · pending I/O finished<br/>VmExit::StopRequested"| ended
```

## Exits

```mermaid
flowchart LR
  subgraph hvf_host["Hypervisor.framework"]
    hv_run["hv_vcpu_run returns<br/>reason in hv_vcpu_exit_t"]
    in_framework["stays in the framework<br/>GIC · virtual timer"]
  end
  subgraph hvf_backend["boxlite-hypervisor · hvf"]
    r_canceled["CANCELED<br/>after hv_vcpus_exit"]
    r_exception["EXCEPTION<br/>syndrome · guest address"]
    c_abort["data abort<br/>SAS · WnR · SRT"]
    c_wfi["WFx trap · WFE: PC + 4"]
    c_psci["PSCI call · the rest<br/>answered in X0"]
    c_sysreg["system register trap<br/>ID registers read as 0<br/>OS lock emulated"]
  end
  subgraph vcpu_side["VcpuExit to the vcpuN thread"]
    x_interrupted["Interrupted"]
    x_mmio["MmioRead · MmioWrite<br/>MMIO bus → BusDevice"]
    x_halted["Halted"]
    x_shutdown["Shutdown"]
    x_reset["Reset"]
    x_cpu_on["CPU_ON exit · M1"]
    x_unhandled["Error::UnhandledExit"]
  end
  hv_run e_canceled@-->|"reason"| r_canceled
  hv_run e_exception@-->|"reason"| r_exception
  hv_run e_other@-->|"any other exit"| x_unhandled
  r_canceled e_interrupted@-->|"kick"| x_interrupted
  r_exception e_abort@-->|"syndrome"| c_abort
  r_exception e_wfi@-->|"syndrome"| c_wfi
  r_exception e_psci@-->|"syndrome"| c_psci
  r_exception e_sysreg@-->|"syndrome"| c_sysreg
  c_abort e_mmio@-->|"next run: Xt on a read<br/>PC + 4"| x_mmio
  c_wfi e_halted@-->|"WFI"| x_halted
  r_exception e_other_syndrome@-->|"any other syndrome"| x_unhandled
  c_psci e_off@-->|"SYSTEM_OFF"| x_shutdown
  c_psci e_reset@-->|"SYSTEM_RESET"| x_reset
  c_psci e_cpu_on@-->|"CPU_ON"| x_cpu_on
```

## I/O, interrupts and stop

```mermaid
sequenceDiagram
  participant vcpu as vcpuN thread
  participant worker as device worker
  participant backend as hvf backend
  participant hvf as Hypervisor.framework
  participant runner as run() thread
  participant shim as SIGTERM path
  %% edge:i_notify
  vcpu->>worker: queue notify · wakes the worker
  %% edge:i_set_line
  worker->>backend: done · Vm::set_irq_line(SPI, high)
  %% edge:i_spi
  backend->>hvf: hv_gic_set_spi(intid, level)
  %% edge:i_unpark
  worker->>vcpu: unpark halted vCPUs (WFI)
  %% edge:i_run
  vcpu->>hvf: hv_vcpu_run · guest takes the SPI
  %% edge:i_stop
  shim->>runner: stop.stop()
  %% edge:i_flag
  runner->>runner: set the stop flag
  %% edge:i_kick
  runner->>backend: VcpuHandle::kick and unpark, every vCPU
  %% edge:i_vcpus_exit
  backend->>hvf: hv_vcpus_exit
  %% edge:i_canceled
  hvf-->>vcpu: CANCELED → Interrupted
  %% edge:i_join
  vcpu-->>runner: thread ends · joined
  %% edge:i_workers
  runner->>worker: stop and join
  %% edge:i_return
  runner->>runner: returns VmExit::StopRequested
```
