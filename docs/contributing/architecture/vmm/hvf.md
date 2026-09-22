# Understanding Hypervisor.framework

A visual introduction to HVF on Apple silicon, using BoxLite's
[planned native VMM](README.md). This design targets macOS 15+ for HVF's
interrupt controller. The native backend is still a stub; boxes currently use
libkrun.

## 1. Architecture

```mermaid
flowchart TB
  subgraph host_process["VMM: virtual machine monitor · one macOS process"]
    coordinator["VM coordinator"]
    thread0["Host thread T0"]
    thread1["Host thread T1"]
    disk["Virtual disk device"]
    worker["Disk I/O worker"]
    backing["Host allocation<br/>512 MiB"]
    hvf["HVF API<br/>Hypervisor.framework"]
  end
  subgraph guest_vm["Example Linux VM · 2 vCPUs, 512 MiB RAM"]
    program["Linux application"]
    kernel["Linux kernel"]
    vcpu0["vCPU 0"]
    vcpu1["vCPU 1"]
    guest_ram["Guest RAM<br/>512 MiB"]
  end
  subgraph macos["Provided by macOS"]
    gic["Interrupt controller<br/>HVF GIC"]
  end
  physical_cpu["Physical CPU<br/>Apple silicon"]
  disk_file[("Backing disk file")]
  coordinator entity_start0@-->|"start / stop"| thread0
  coordinator entity_start1@-->|"start / stop"| thread1
  coordinator entity_configure@-->|"configure VM"| hvf
  thread0 entity_run0@-->|"run vCPU 0"| hvf
  thread1 entity_run1@-->|"run vCPU 1"| hvf
  disk entity_queue@-->|"wake"| worker
  worker entity_storage@-->|"read / write"| disk_file
  worker entity_buffers@-->|"request / completion data"| backing
  worker entity_irq@-->|"set device IRQ"| hvf
  hvf entity_gic@-->|"interrupt control"| gic
  gic entity_deliver@-->|"guest interrupt"| kernel
  hvf entity_cpu0@-->|"guest execution"| vcpu0
  hvf entity_cpu1@-->|"guest execution"| vcpu1
  thread0 entity_schedule0@-->|"macOS schedules"| physical_cpu
  thread1 entity_schedule1@-->|"macOS schedules"| physical_cpu
  program entity_syscall@-->|"system call"| kernel
  kernel entity_exec0@-->|"executes on"| vcpu0
  kernel entity_exec1@-->|"executes on"| vcpu1
  kernel entity_access@-->|"read / write"| guest_ram
  backing entity_mapping@-->|"HVF mapping: same pages"| guest_ram
```

## 2. How it works

### 2.1 Prepare the machine

```mermaid
sequenceDiagram
  box VMM · one macOS process
    participant coordinator as VM coordinator
    participant disk as Virtual disk
    participant worker as I/O worker
  end
  box Host · macOS APIs
    participant hvf as Hypervisor.framework
    participant gic as GIC<br/>interrupt controller
  end
  box VM · guest address space
    participant guest_ram as Guest RAM<br/>512 MiB
  end
  %% edge:setup_vm
  coordinator->>hvf: hv_vm_create: create the VM
  %% edge:setup_gic
  coordinator->>hvf: hv_gic_create: before any vCPU
  %% edge:setup_gic_ready
  hvf->>gic: Create controller
  %% edge:setup_allocate
  coordinator->>coordinator: Allocate 512 MiB<br/>of host memory
  %% edge:setup_map
  coordinator->>hvf: hv_vm_map: host address → guest physical address
  %% edge:setup_ram_view
  hvf->>guest_ram: Map the same pages as guest RAM
  %% edge:setup_load
  coordinator->>guest_ram: Through the host mapping: write Linux Image and device tree
  %% edge:setup_disk
  coordinator->>disk: Configure registers<br/>and interrupt line
  %% edge:setup_worker
  disk->>worker: Start disk worker
  Note over coordinator,guest_ram: One allocation, two address spaces · guest RAM is not a second copy
```

### 2.2 Boot Linux on a vCPU

```mermaid
sequenceDiagram
  box VMM · one thread per vCPU
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · macOS API
    participant hvf as Hypervisor.framework
  end
  box VM · guest software
    participant kernel as Linux kernel
  end
  %% edge:setup_thread0
  coordinator->>thread0: Start T0
  %% edge:setup_thread1
  coordinator->>thread1: Start T1
  %% edge:setup_vcpu0
  thread0->>hvf: hv_vcpu_create: vCPU 0
  %% edge:setup_vcpu1
  thread1->>hvf: hv_vcpu_create:<br/>vCPU 1
  Note over thread0,hvf: Both vCPUs must exist before either enters the guest
  %% edge:setup_registers
  thread0->>hvf: Initialize boot state and CPU affinity<br/>PC points to Linux, X0 points to the device tree
  %% edge:setup_secondary_state
  thread1->>hvf: Initialize CPU state<br/>and affinity
  Note over thread1,hvf: T1 waits for Linux's CPU_ON request<br/>before setting its entry and running vCPU 1
  %% edge:boot_enter
  thread0->>hvf: hv_vcpu_run: enter vCPU 0
  %% edge:boot_linux
  hvf->>kernel: Physical CPU<br/>executes Linux
  Note over thread0,kernel: T0 is inside hv_vcpu_run while the guest executes<br/>The call returns when vCPU 0 exits the guest
```

### 2.3 A file read reaches a device register

```mermaid
sequenceDiagram
  box VM · guest software and memory
    participant program as Application
    participant kernel as Linux kernel<br/>and disk driver
    participant guest_ram as Guest RAM
  end
  box Host · macOS API
    participant hvf as Hypervisor.framework
  end
  box VMM · vCPU 0 thread
    participant thread0 as Thread T0
  end
  Note over program,thread0: Example: Linux has booted, a 4 KiB file read misses the cache and succeeds<br/>Follow its disk request on vCPU 0
  %% edge:read_syscall
  program->>kernel: read(fd, buf, 4096)
  %% edge:read_queue
  kernel->>guest_ram: Write request and<br/>buffer addresses<br/>into the virtqueue
  Note over program,guest_ram: System calls and mapped RAM accesses stay in the guest<br/>A virtqueue holds requests and completions in guest RAM
  %% edge:read_notify
  kernel->>hvf: Write the disk's queue-notify register<br/>MMIO = a device register at a guest memory address
  %% edge:read_exit
  hvf-->>thread0: hv_vcpu_run returns<br/>a data-abort exception
  %% edge:read_decode
  thread0->>thread0: HVF backend decodes<br/>address, size and value<br/>into MmioWrite
```

### 2.4 The VMM resumes Linux while the worker reads the disk

```mermaid
sequenceDiagram
  box VMM · device emulation and host I/O
    participant thread0 as Thread T0
    participant disk as Virtual disk
    participant worker as I/O worker
  end
  box Host · macOS API and storage
    participant hvf as Hypervisor.framework
    participant disk_file as Backing disk file
  end
  box VM · guest memory
    participant guest_ram as Guest RAM
  end
  %% edge:read_dispatch
  thread0->>disk: Bus dispatches<br/>MmioWrite
  %% edge:read_wake
  disk->>worker: Signal queue event
  par Guest execution
    %% edge:io_advance
    thread0->>hvf: Complete the MMIO write: advance PC by 4
    %% edge:io_resume
    thread0->>hvf: hv_vcpu_run: Linux continues
  and Device worker
    %% edge:io_dequeue
    worker->>guest_ram: Read request through the host mapping
    %% edge:io_read
    worker->>disk_file: Read requested disk blocks
    %% edge:io_data
    disk_file-->>worker: Return bytes
    %% edge:io_complete
    worker->>guest_ram: Write bytes to guest buffers, then publish completion
  end
  Note over thread0,guest_ram: Re-entry and host I/O proceed independently<br/>Linux can run other work while this read waits
```

### 2.5 The host delivers the disk interrupt

```mermaid
sequenceDiagram
  box VMM · completion and wake-up
    participant worker as I/O worker
    participant thread0 as Thread T0
  end
  box Host · macOS API and interrupt controller
    participant hvf as Hypervisor.framework
    participant gic as GIC
  end
  box VM · interrupt handler
    participant kernel as Linux kernel<br/>and disk driver
  end
  Note over worker,hvf: Continue after the worker publishes completion (2.4)<br/>Guest re-entry may still be pending
  %% edge:io_signal
  worker->>hvf: VMM interrupt path calls hv_gic_set_spi
  %% edge:io_pending
  hvf->>gic: Set disk IRQ<br/>pending
  %% edge:io_unpark
  worker->>thread0: VMM also unparks<br/>halted vCPU threads
  opt vCPU 0 had parked after WFI: wait for interrupt
    %% edge:io_reenter_parked
    thread0->>hvf: Wake and re-enter<br/>hv_vcpu_run
  end
  Note over thread0,kernel: Here Linux routes this interrupt to vCPU 0<br/>Setting the IRQ line alone does not wake a parked host thread
  %% edge:io_interrupt
  gic->>kernel: Deliver IRQ<br/>when accepted
```

### 2.6 Linux completes the file read

```mermaid
sequenceDiagram
  box VM · guest execution on vCPU 0
    participant kernel as Linux kernel<br/>and disk driver
    participant guest_ram as Guest RAM
    participant program as Application
  end
  Note over kernel,program: The host worker has filled the shared buffers<br/>Linux now completes the read inside the guest
  %% edge:io_consume
  kernel->>guest_ram: Read completion<br/>and file bytes
  %% edge:io_return
  kernel-->>program: read() returns 4096 bytes
```

### 2.7 Stop the vCPU threads

```mermaid
sequenceDiagram
  box VMM · lifecycle and vCPU owners
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · macOS API
    participant hvf as Hypervisor.framework
  end
  %% edge:stop_flag
  coordinator->>coordinator: Receive stop request<br/>and set stop flag
  %% edge:stop_kick
  coordinator->>hvf: hv_vcpus_exit: kick both vCPUs out of guest execution
  %% edge:stop_unpark0
  coordinator->>thread0: Unpark if waiting
  %% edge:stop_unpark1
  coordinator->>thread1: Unpark if waiting
  Note over thread0,hvf: Each owner completes any pending device access before destruction<br/>without executing another guest instruction
  %% edge:stop_destroy0
  thread0->>hvf: hv_vcpu_destroy on T0
  %% edge:stop_done0
  thread0-->>coordinator: T0 ends, join completes
  %% edge:stop_destroy1
  thread1->>hvf: hv_vcpu_destroy<br/>on T1
  %% edge:stop_done1
  thread1-->>coordinator: T1 ends, join completes
```

### 2.8 Release the remaining resources

```mermaid
sequenceDiagram
  box VMM · lifecycle and device work
    participant coordinator as VM coordinator
    participant worker as I/O worker
  end
  box Host · macOS API
    participant hvf as Hypervisor.framework
  end
  box VM · guest address space
    participant guest_ram as Guest RAM
  end
  Note over coordinator,guest_ram: Both vCPU threads have ended · the guest can no longer execute
  %% edge:stop_worker
  coordinator->>worker: Stop and join worker
  %% edge:stop_worker_done
  worker-->>coordinator: Worker ended<br/>no more RAM accesses
  %% edge:stop_unmap
  coordinator->>hvf: hv_vm_unmap
  %% edge:stop_ram_view
  hvf->>guest_ram: Remove guest mapping
  %% edge:stop_destroy_vm
  coordinator->>hvf: hv_vm_destroy
  %% edge:stop_free
  coordinator->>coordinator: Free host allocation<br/>and device resources
```

## BoxLite implementation reference

[Crate responsibilities](README.md#architecture) ·
[HVF API contract](README.md#hypervisor-backend-interface) ·
[Exit decoding](README.md#exit-contract) ·
[Memory layout](memory.md) ·
[Boot registers and device tree](README.md#boot-path) ·
[Threading and remaining M1 work](README.md#threads) ·
[Real HVF run loop in libkrun](https://github.com/libkrun/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/hvf/src/lib.rs#L553-L650) ·
[Apple's HVF overview](https://developer.apple.com/documentation/hypervisor)
