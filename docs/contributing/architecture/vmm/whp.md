# Understanding Windows Hypervisor Platform

A visual introduction to WHP, using BoxLite's [planned native VMM](README.md).
The example is a Linux x86_64 VM with 2 vCPUs, 512 MiB RAM and a virtual disk
on a Windows host. This entire backend is planned for M10; the current code
only reserves its module.

## 1. Architecture

```mermaid
flowchart TB
  subgraph vmm["VMM · one Windows process"]
    disk["Virtual disk"]
    worker["Disk worker"]
    backing["Host allocation"]
    ioapic["IOAPIC"]
    coordinator["Coordinator"]
    thread0["Thread T0"]
    thread1["Thread T1"]
  end
  subgraph host["Host · WHP and CPU"]
    lapic["Local APIC"]
    host_api["WHP API"]
    physical_cpu["Physical CPU"]
  end
  subgraph storage["Host · filesystem"]
    disk_file[("Backing disk file")]
  end
  subgraph guest["VM · Linux, 2 vCPUs and 512 MiB RAM"]
    guest_ram["Guest RAM"]
    program["Application"]
    kernel["Linux kernel"]
    vcpu0["vCPU 0"]
    vcpu1["vCPU 1"]
  end
  disk whp_2_e1@-->|"queue event"| worker
  worker whp_2_e2@-->|"read blocks"| disk_file
  worker whp_2_e3@-->|"queue data"| backing
  backing whp_2_e4@-->|"same pages"| guest_ram
  kernel whp_2_e5@-->|"buffers"| guest_ram
  worker whp_2_e6@-->|"pulse IRQ"| ioapic
  ioapic whp_2_e7@-->|"inject IRQ"| lapic
  lapic whp_2_e8@-->|"deliver IRQ"| kernel
  coordinator whp_1_e1@-->|"configure VM"| host_api
  thread0 whp_1_e2@-->|"run vCPU 0"| host_api
  thread1 whp_1_e3@-->|"run vCPU 1"| host_api
  host_api whp_1_e4@-->|"guest mode"| physical_cpu
  physical_cpu whp_1_e5@-->|"execute"| kernel
  program whp_1_e6@-->|"system call"| kernel
  kernel whp_1_e7@-->|"runs on"| vcpu0
  kernel whp_1_e8@-->|"runs on"| vcpu1
```

## 2. How it works

### 2.1 Create and configure a partition

```mermaid
sequenceDiagram
  box VMM · machine setup
    participant coordinator as VM coordinator
  end
  box Host · Windows API and virtual CPU support
    participant host_api as WHP
    participant partition as Partition
    participant lapic as Local APICs
  end
  %% edge:whp_3_e1
  coordinator->>host_api: WHvGetCapability: check required support
  %% edge:whp_3_e2
  coordinator->>host_api: WHvCreatePartition
  %% edge:whp_3_e3
  host_api-->>partition: Create empty partition
  %% edge:whp_3_e4
  coordinator->>host_api: WHvSetPartitionProperty<br/>2 processors and local-APIC emulation
  %% edge:whp_3_e5
  coordinator->>host_api: WHvSetupPartition
  %% edge:whp_3_e6
  host_api->>partition: Allocate configured<br/>partition resources
  %% edge:whp_3_e7
  host_api->>lapic: Enable local-APIC<br/>emulation
  Note over coordinator,partition: WHP calls a VM a partition and a vCPU a virtual processor (VP)
```

### 2.2 Build the userspace chipset

```mermaid
sequenceDiagram
  box VMM · emulated hardware, planned for M10
    participant coordinator as VM coordinator
    participant ioapic as IOAPIC
    participant pic as PIC
    participant pit as PIT timer
    participant disk as Virtual disk
    participant worker as I/O worker
  end
  %% edge:whp_4_e1
  coordinator->>ioapic: Create device IRQ routing
  %% edge:whp_4_e2
  coordinator->>pic: Create legacy interrupt controller
  %% edge:whp_4_e3
  coordinator->>pit: Create interval timer
  %% edge:whp_4_e4
  coordinator->>disk: Configure registers and device interrupt line
  %% edge:whp_4_e5
  disk->>worker: Start disk worker
  Note over coordinator,worker: WHP supplies local APICs, while these chipset devices run in the VMM<br/>M10 chooses the crate that implements IOAPIC, PIC and PIT
```

### 2.3 Map RAM and load Linux

```mermaid
sequenceDiagram
  box VMM · memory and boot loading
    participant coordinator as VM coordinator
    participant backing as Host allocation
  end
  box Host · Windows API
    participant host_api as WHP
  end
  box VM · guest address space
    participant guest_ram as Guest RAM
  end
  %% edge:whp_5_e1
  coordinator->>backing: Allocate 512 MiB
  %% edge:whp_5_e2
  coordinator->>host_api: WHvMapGpaRange<br/>host address, guest physical address, size, permissions
  %% edge:whp_5_e3
  host_api->>guest_ram: Map the same host pages
  %% edge:whp_5_e4
  coordinator->>backing: Write x86 Linux kernel and boot data<br/>boot_params, command line, MP table and initial page tables
  Note over backing,guest_ram: Guest RAM is a view of the host allocation<br/>Larger RAM layouts preserve the x86 device hole beginning at 3 GiB
```

### 2.4 Create virtual processors and boot Linux

```mermaid
sequenceDiagram
  box VMM · one thread per vCPU
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · Windows API
    participant host_api as WHP
  end
  box VM · guest software
    participant kernel as Linux kernel
  end
  %% edge:whp_6_e1
  coordinator->>thread0: Start T0
  %% edge:whp_6_e2
  coordinator->>thread1: Start T1
  %% edge:whp_6_e3
  thread0->>host_api: WHvCreateVirtualProcessor: VP 0
  %% edge:whp_6_e4
  thread1->>host_api: WHvCreateVirtualProcessor: VP 1
  Note over thread0,host_api: WHvSetVirtualProcessorRegisters supplies the full x86 startup state<br/>Boot CPU: RIP = 64-bit entry, RSI = boot_params, paging on, interrupts masked
  %% edge:whp_6_e5
  thread0->>host_api: Set boot CPU registers
  %% edge:whp_6_e6
  thread1->>host_api: Set secondary CPU startup state
  Note over thread0,host_api: Both VPs exist before guest execution begins
  %% edge:whp_6_e7
  thread0->>host_api: WHvRunVirtualProcessor: VP 0
  %% edge:whp_6_e8
  thread1->>host_api: WHvRunVirtualProcessor: VP 1
  %% edge:whp_6_e9
  host_api->>kernel: Physical CPU<br/>executes Linux
  Note over host_api,kernel: Linux boots and starts secondary CPUs<br/>using INIT/SIPI, then starts userspace<br/>and the example application
```

### 2.5 A file read reaches a device register

```mermaid
sequenceDiagram
  box VM · guest software and memory
    participant program as Application
    participant kernel as Linux kernel<br/>and disk driver
    participant guest_ram as Guest RAM
  end
  box Host · Windows API
    participant host_api as WHP
  end
  box VMM · vCPU 0 thread
    participant thread0 as Thread T0
  end
  Note over program,thread0: Example: Linux has booted, a 4 KiB file read misses the cache and succeeds<br/>Follow its disk request on vCPU 0
  %% edge:whp_7_e1
  program->>kernel: read(fd, buf, 4096)
  %% edge:whp_7_e2
  kernel->>guest_ram: Write request and<br/>buffer addresses<br/>into the virtqueue
  Note over program,guest_ram: System calls and mapped RAM accesses stay in the guest<br/>A virtqueue holds requests and completions in guest RAM
  %% edge:whp_7_e3
  kernel->>host_api: Write the disk's queue-notify register<br/>MMIO = a device register at a guest memory address
  %% edge:whp_7_e4
  host_api-->>thread0: Run call returns<br/>MemoryAccess exit
  %% edge:whp_7_e5
  thread0->>thread0: WHP emulator decodes<br/>instruction bytes and<br/>guest address<br/>into MmioWrite
```

### 2.6 Resume Linux while the worker reads the disk

```mermaid
sequenceDiagram
  box VMM · device emulation and host I/O
    participant thread0 as Thread T0
    participant disk as Virtual disk
    participant worker as I/O worker
  end
  box Host · Windows API and storage
    participant host_api as WHP
    participant disk_file as Backing disk file
  end
  box VM · guest memory
    participant guest_ram as Guest RAM
  end
  %% edge:whp_8_e1
  thread0->>disk: Bus dispatches<br/>MmioWrite
  %% edge:whp_8_e2
  disk->>worker: Signal queue event
  par Guest execution
  %% edge:whp_8_e3
    thread0->>thread0: WHP emulator completes<br/>the write and advances RIP
  %% edge:whp_8_e4
    thread0->>host_api: WHvRunVirtualProcessor: Linux continues
  and Device worker
  %% edge:whp_8_e5
    worker->>guest_ram: Read request through the host mapping
  %% edge:whp_8_e6
    worker->>disk_file: Read requested disk blocks
  %% edge:whp_8_e7
    disk_file-->>worker: Return bytes
  %% edge:whp_8_e8
    worker->>guest_ram: Write bytes to guest buffers, then publish completion
  end
  Note over thread0,guest_ram: Re-entry and host I/O proceed independently<br/>Linux can run other work while this read waits
```

### 2.7 Route the disk interrupt through the userspace IOAPIC

```mermaid
sequenceDiagram
  box VMM · device completion and IRQ routing
    participant worker as I/O worker
    participant ioapic as IOAPIC
  end
  box Host · Windows API and per-vCPU interrupts
    participant host_api as WHP
    participant lapic as Local APIC
  end
  box VM · guest interrupt handler
    participant kernel as Linux kernel
  end
  Note over worker,host_api: Continue once the worker publishes completion (2.6)<br/>Guest re-entry may still be pending
  %% edge:whp_9_e1
  worker->>ioapic: Pulse the disk's<br/>edge-triggered line
  %% edge:whp_9_e2
  ioapic->>host_api: WHvRequestInterrupt<br/>vector and destination
  %% edge:whp_9_e3
  host_api->>lapic: Set pending<br/>interrupt
  %% edge:whp_9_e4
  lapic->>kernel: Deliver IRQ<br/>when accepted
  Note over host_api,kernel: With local-APIC emulation enabled, HLT waits inside the run call<br/>An interrupt can wake that waiting virtual processor
```

### 2.8 Linux completes the file read

```mermaid
sequenceDiagram
  box VM · guest execution on vCPU 0
    participant kernel as Linux kernel<br/>and disk driver
    participant guest_ram as Guest RAM
    participant program as Application
  end
  Note over kernel,program: The host worker has filled the shared buffers<br/>Linux now completes the read inside the guest
  %% edge:whp_10_e1
  kernel->>guest_ram: Read completion<br/>and file bytes
  %% edge:whp_10_e2
  kernel-->>program: read() returns 4096 bytes
```

### 2.9 A level-triggered device also needs EOI feedback

```mermaid
sequenceDiagram
  box VM · guest interrupt handler
    participant kernel as Linux kernel
  end
  box Host · Windows API
    participant host_api as WHP
  end
  box VMM · host process, on thread T0
    participant backend as WHP backend
    participant ioapic as IOAPIC
  end
  Note over kernel,ioapic: This is the level-triggered case, separate from the edge-triggered disk example<br/>EOI means end of interrupt
  %% edge:whp_11_e1
  kernel->>host_api: Acknowledge completion in local APIC
  %% edge:whp_11_e2
  host_api-->>backend: X64ApicEoi exit<br/>includes vector
  %% edge:whp_11_e3
  backend->>ioapic: Forward EOI vector<br/>through controller callback
  %% edge:whp_11_e4
  ioapic->>ioapic: Update in-service state<br/>and reevaluate the line
  %% edge:whp_11_e5
  backend->>host_api: Resume virtual processor
  Note over backend,ioapic: M10 wires this inside Vcpu::run<br/>EOI does not return to the VMM loop as a VcpuExit
```

### 2.10 Stop the vCPU threads

```mermaid
sequenceDiagram
  box VMM · lifecycle and vCPU owners
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · Windows API
    participant host_api as WHP
  end
  %% edge:whp_12_e1
  coordinator->>coordinator: Set shared stop flag
  %% edge:whp_12_e2
  coordinator->>host_api: WHvCancelRunVirtualProcessor for each running VP
  %% edge:whp_12_e3
  host_api-->>thread0: Run returns Canceled
  %% edge:whp_12_e4
  host_api-->>thread1: Run returns Canceled
  Note over thread0,host_api: Check stop before any re-entry, including when already outside the run call<br/>Complete pending emulation without executing another guest instruction
  %% edge:whp_12_e5
  thread0-->>coordinator: Exit loop, join T0
  %% edge:whp_12_e6
  thread1-->>coordinator: Exit loop, join T1
```

### 2.11 Release the remaining resources

```mermaid
sequenceDiagram
  box VMM · lifecycle and remaining resources
    participant coordinator as VM coordinator
    participant worker as I/O worker
    participant backing as Host allocation
  end
  box Host · Windows API
    participant host_api as WHP
  end
  Note over coordinator,host_api: Both vCPU threads have ended
  %% edge:whp_13_e1
  coordinator->>worker: Stop and join
  %% edge:whp_13_e2
  worker-->>coordinator: No more guest-memory accesses
  %% edge:whp_13_e3
  coordinator->>host_api: WHvDeleteVirtualProcessor for each VP
  %% edge:whp_13_e4
  coordinator->>host_api: WHvUnmapGpaRange for each RAM mapping
  %% edge:whp_13_e5
  coordinator->>host_api: WHvDeletePartition
  %% edge:whp_13_e6
  coordinator->>backing: Free the host allocation after unmapping
  %% edge:whp_13_e7
  coordinator->>coordinator: Release userspace chipset<br/>and device resources
```

## BoxLite implementation reference

[Crate responsibilities](README.md#architecture) ·
[Backend API contract](README.md#hypervisor-backend-interface) ·
[Exit decoding](README.md#exit-contract) ·
[Memory layout](memory.md) ·
[Boot registers and boot data](README.md#boot-path) ·
[Threads and lifecycle](README.md#threads) ·
[Windows M10 scope](README.md#room-for-later-milestones) ·
[WHP API](https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform) ·
[QEMU WHP exit handling](https://github.com/qemu/qemu/blob/f8aef8a9aed7438083c400da10acabdec485dc9b/target/i386/whpx/whpx-all.c#L2332-L2342)
