# Understanding KVM

A visual introduction to Linux KVM (Kernel-based Virtual Machine), using BoxLite's
[planned native VMM](README.md). The main example is an x86_64 Linux VM with
2 vCPUs, 512 MiB RAM and a virtual disk; arm64 differences follow the walkthrough.
M1 currently provides native x86_64 VM creation and RAM registration in
[`boxlite-hypervisor`](../../../src/hypervisor/README.md); vCPU execution and
Linux boot follow. Boxes currently use libkrun.

## 1. Architecture

<details>
<summary>Show architecture diagram</summary>

```mermaid
flowchart TB
  subgraph vmm["VMM · one Linux process"]
    disk["Virtual disk"]
    worker["Disk worker"]
    backing["Host allocation"]
    coordinator["Coordinator"]
    thread0["Thread T0"]
    thread1["Thread T1"]
  end
  subgraph host["Host · KVM and CPU"]
    host_api["KVM API"]
    physical_cpu["Physical CPU"]
  end
  subgraph irqchip["Host · interrupts"]
    ioapic["IOAPIC"]
    lapic["Local APIC"]
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
  disk kvm_2_e1@-->|"queue event"| worker
  worker kvm_2_e2@-->|"read blocks"| disk_file
  worker kvm_2_e3@-->|"queue data"| backing
  backing kvm_2_e4@-->|"same pages"| guest_ram
  kernel kvm_2_e5@-->|"buffers"| guest_ram
  worker kvm_2_e6@-->|"pulse GSI"| ioapic
  ioapic kvm_2_e7@-->|"route IRQ"| lapic
  lapic kvm_2_e8@-->|"deliver IRQ"| kernel
  coordinator kvm_1_e1@-->|"configure VM"| host_api
  thread0 kvm_1_e2@-->|"run vCPU 0"| host_api
  thread1 kvm_1_e3@-->|"run vCPU 1"| host_api
  host_api kvm_1_e4@-->|"guest mode"| physical_cpu
  physical_cpu kvm_1_e5@-->|"execute"| kernel
  program kvm_1_e6@-->|"system call"| kernel
  kernel kvm_1_e7@-->|"runs on"| vcpu0
  kernel kvm_1_e8@-->|"runs on"| vcpu1
```

</details>

## 2. How it works

### 2.1 Open KVM and create an empty VM

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · process resources
    participant coordinator as VM coordinator
    participant system_fd as System fd
    participant vm_fd as VM fd
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  %% edge:kvm_3_e1
  coordinator->>host_api: open /dev/kvm
  %% edge:kvm_3_e2
  host_api-->>system_fd: Return subsystem handle
  %% edge:kvm_3_e3
  coordinator->>system_fd: Check API version and required capabilities
  %% edge:kvm_3_e4
  system_fd->>host_api: KVM_GET_API_VERSION and KVM_CHECK_EXTENSION
  %% edge:kvm_3_e5
  coordinator->>system_fd: KVM_CREATE_VM
  %% edge:kvm_3_e6
  system_fd->>host_api: Create VM
  %% edge:kvm_3_e7
  host_api-->>vm_fd: Return VM handle
  Note over coordinator,host_api: fd = file descriptor · a handle to a kernel object<br/>The new VM has no vCPUs and no guest RAM
```

</details>

### 2.2 Prepare x86 interrupt controllers

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · machine setup
    participant coordinator as VM coordinator
  end
  box Host · Linux KVM
    participant host_api as KVM
    participant pic as PIC
    participant ioapic as IOAPIC
    participant pit as PIT timer
  end
  %% edge:kvm_4_e1
  coordinator->>host_api: Intel: KVM_SET_TSS_ADDR
  %% edge:kvm_4_e2
  coordinator->>host_api: KVM_CREATE_IRQCHIP on VM fd
  %% edge:kvm_4_e3
  host_api->>pic: Create legacy PICs
  %% edge:kvm_4_e4
  host_api->>ioapic: Create device IRQ router
  Note over host_api,ioapic: KVM also gives each subsequently created vCPU a local APIC
  %% edge:kvm_4_e5
  coordinator->>host_api: KVM_CREATE_PIT2
  %% edge:kvm_4_e6
  host_api->>pit: Create interval timer
  Note over coordinator,pit: Create these before the vCPUs<br/>The arm64 setup is shown separately below
```

</details>

### 2.3 Map RAM and load Linux

See the [side-by-side view of guest ranges, KVM slots and host allocations](memory.md#1-architecture).

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · memory and boot loading
    participant coordinator as VM coordinator
    participant backing as Host allocation
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  box VM · guest address space
    participant guest_ram as Guest RAM
  end
  %% edge:kvm_5_e1
  coordinator->>backing: Allocate 512 MiB
  %% edge:kvm_5_e2
  coordinator->>host_api: KVM_SET_USER_MEMORY_REGION on VM fd<br/>slot ID, guest address, host address, size
  %% edge:kvm_5_e3
  host_api->>guest_ram: Register the host pages as guest RAM
  %% edge:kvm_5_e4
  coordinator->>backing: Write x86 Linux kernel and boot data<br/>boot_params, command line, MP table and initial page tables
  Note over backing,guest_ram: Guest RAM and the host allocation name the same pages<br/>A memory slot records a mapping, not another allocation
```

</details>

### 2.4 Create two vCPUs and their run buffers

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · vCPU owners and communication buffers
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
    participant run0 as kvm_run 0
    participant run1 as kvm_run 1
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  %% edge:kvm_6_e1
  coordinator->>host_api: KVM_GET_VCPU_MMAP_SIZE on system fd
  %% edge:kvm_6_e2
  coordinator->>thread0: Start T0
  %% edge:kvm_6_e3
  coordinator->>thread1: Start T1
  %% edge:kvm_6_e4
  thread0->>host_api: KVM_CREATE_VCPU on VM fd → vCPU fd 0
  %% edge:kvm_6_e5
  thread1->>host_api: KVM_CREATE_VCPU on VM fd → vCPU fd 1
  %% edge:kvm_6_e6
  thread0->>run0: mmap vCPU fd 0 using the queried size
  %% edge:kvm_6_e7
  thread1->>run1: mmap vCPU fd 1 using the queried size
  Note over thread0,host_api: Each kvm_run buffer is shared between the VMM and KVM<br/>It carries exit information and I/O data, not guest RAM
```

</details>

### 2.5 Boot the x86 Linux guest

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · one thread per vCPU
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  box VM · guest software
    participant kernel as Linux kernel
  end
  Note over thread0,host_api: Configure both CPUs with CPUID, MSRs, registers, FPU and local-APIC state<br/>Boot CPU: 64-bit entry, boot_params pointer, long mode, paging and interrupts masked
  %% edge:kvm_7_e1
  thread0->>host_api: Set vCPU 0 boot state<br/>RIP = kernel entry, RSI = boot_params
  %% edge:kvm_7_e2
  thread1->>host_api: Configure vCPU 1<br/>waiting for INIT/SIPI
  Note over thread0,host_api: BoxLite waits until both vCPUs exist before either enters the guest
  par vCPU 0
  %% edge:kvm_7_e3
    thread0->>host_api: KVM_RUN on vCPU fd 0
  and vCPU 1
  %% edge:kvm_7_e4
    thread1->>host_api: KVM_RUN on vCPU fd 1<br/>wait for startup inside KVM
  end
  %% edge:kvm_7_e5
  host_api->>kernel: Physical CPU<br/>executes Linux
  %% edge:kvm_7_e6
  kernel->>host_api: INIT/SIPI starts the secondary through its local APIC
  Note over thread0,kernel: Linux boots, starts its userspace, then the example application runs
```

</details>

### 2.6 A file read reaches a device register

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VM · guest software and memory
    participant program as Application
    participant kernel as Linux kernel<br/>and disk driver
    participant guest_ram as Guest RAM
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  box VMM · vCPU 0 thread
    participant thread0 as Thread T0
  end
  Note over program,thread0: Example: Linux has booted, a 4 KiB file read misses the cache and succeeds<br/>Follow its disk request on vCPU 0
  %% edge:kvm_8_e1
  program->>kernel: read(fd, buf, 4096)
  %% edge:kvm_8_e2
  kernel->>guest_ram: Write request and<br/>buffer addresses<br/>into the virtqueue
  Note over program,guest_ram: System calls and mapped RAM accesses stay in the guest<br/>A virtqueue holds requests and completions in guest RAM
  %% edge:kvm_8_e3
  kernel->>host_api: Write the disk's queue-notify register<br/>MMIO = a device register at a guest memory address
  %% edge:kvm_8_e4
  host_api-->>thread0: KVM_RUN returns<br/>KVM_EXIT_MMIO
  %% edge:kvm_8_e5
  thread0->>thread0: KVM backend reads<br/>kvm_run.mmio fields<br/>into MmioWrite
```

</details>

### 2.7 Resume Linux while the worker reads the disk

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · device emulation and host I/O
    participant thread0 as Thread T0
    participant disk as Virtual disk
    participant worker as I/O worker
  end
  box Host · Linux kernel and storage
    participant host_api as KVM
    participant disk_file as Backing disk file
  end
  box VM · guest memory
    participant guest_ram as Guest RAM
  end
  %% edge:kvm_9_e1
  thread0->>disk: Bus dispatches<br/>MmioWrite
  %% edge:kvm_9_e2
  disk->>worker: Signal queue event
  par Guest execution
  %% edge:kvm_9_e3
    thread0->>host_api: KVM_RUN completes the MMIO instruction, then Linux continues
  and Device worker
  %% edge:kvm_9_e4
    worker->>guest_ram: Read request through the host mapping
  %% edge:kvm_9_e5
    worker->>disk_file: Read requested disk blocks
  %% edge:kvm_9_e6
    disk_file-->>worker: Return bytes
  %% edge:kvm_9_e7
    worker->>guest_ram: Write bytes to guest buffers, then publish completion
  end
  Note over thread0,guest_ram: Re-entry and host I/O proceed independently<br/>Linux can run other work while this read waits
```

</details>

### 2.8 KVM delivers the disk interrupt

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · device completion
    participant worker as I/O worker
  end
  box Host · KVM interrupt controllers
    participant host_api as KVM
    participant ioapic as IOAPIC
    participant lapic as Local APIC
  end
  box VM · guest interrupt handler
    participant kernel as Linux kernel
  end
  Note over worker,host_api: Continue once the worker publishes completion (2.7)<br/>Guest re-entry may still be pending
  %% edge:kvm_10_e1
  worker->>host_api: KVM_IRQ_LINE: assert, then clear the device GSI
  %% edge:kvm_10_e2
  host_api->>ioapic: Pulse edge-triggered<br/>disk interrupt
  %% edge:kvm_10_e3
  ioapic->>lapic: Route vector<br/>to target vCPU
  %% edge:kvm_10_e4
  lapic->>kernel: Deliver IRQ<br/>when accepted
  Note over host_api,kernel: With KVM's in-kernel irqchip, HLT waits inside KVM_RUN<br/>A pending interrupt can wake that kernel wait
```

</details>

### 2.9 Linux completes the file read

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VM · guest execution on vCPU 0
    participant kernel as Linux kernel<br/>and disk driver
    participant guest_ram as Guest RAM
    participant program as Application
  end
  Note over kernel,program: The host worker has filled the shared buffers<br/>Linux now completes the read inside the guest
  %% edge:kvm_11_e1
  kernel->>guest_ram: Read completion<br/>and file bytes
  %% edge:kvm_11_e2
  kernel-->>program: read() returns 4096 bytes
```

</details>

### 2.10 Stop the vCPU threads

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · lifecycle and vCPU owners
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  %% edge:kvm_12_e1
  coordinator->>coordinator: Set shared stop flag
  %% edge:kvm_12_e2
  coordinator->>thread0: Set immediate_exit and signal T0
  %% edge:kvm_12_e3
  coordinator->>thread1: Set immediate_exit and signal T1
  %% edge:kvm_12_e4
  host_api-->>thread0: KVM_RUN returns EINTR
  %% edge:kvm_12_e5
  host_api-->>thread1: KVM_RUN returns EINTR
  Note over thread0,host_api: Finish any pending device access with KVM_RUN and immediate_exit set<br/>KVM completes that access without executing another guest instruction
  %% edge:kvm_12_e6
  thread0-->>coordinator: Exit loop, join T0
  %% edge:kvm_12_e7
  thread1-->>coordinator: Exit loop, join T1
```

</details>

### 2.11 Release the mappings and descriptors

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · lifecycle and remaining resources
    participant coordinator as VM coordinator
    participant worker as I/O worker
    participant backing as Host allocation
  end
  box Host · Linux kernel
    participant host_api as KVM
  end
  Note over coordinator,host_api: Both vCPU threads have ended
  %% edge:kvm_13_e1
  coordinator->>worker: Stop and join
  %% edge:kvm_13_e2
  worker-->>coordinator: No more guest-memory accesses
  %% edge:kvm_13_e3
  coordinator->>coordinator: Unmap each kvm_run buffer<br/>and close each vCPU fd
  %% edge:kvm_13_e4
  coordinator->>host_api: Remove each memory slot<br/>KVM_SET_USER_MEMORY_REGION with size = 0
  %% edge:kvm_13_e5
  coordinator->>backing: Unmap host backing after slot removal succeeds
  %% edge:kvm_13_e6
  coordinator->>host_api: Close remaining VM, device and system fds
  Note over coordinator,host_api: Closing only the VM fd is not enough while other references keep it alive
```

</details>

## 3. What changes on arm64

### 3.1 Configure the GIC and initialize it after the vCPUs exist

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · machine setup and vCPU owners
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · Linux KVM
    participant host_api as KVM
    participant gic as VGICv3
  end
  %% edge:kvm_14_e1
  coordinator->>host_api: KVM_CREATE_DEVICE: VGICv3
  %% edge:kvm_14_e2
  host_api->>gic: Create interrupt<br/>controller
  %% edge:kvm_14_e3
  coordinator->>gic: Set distributor and redistributor addresses
  %% edge:kvm_14_e4
  thread0->>host_api: KVM_CREATE_VCPU and KVM_ARM_VCPU_INIT<br/>boot CPU enabled
  %% edge:kvm_14_e5
  thread1->>host_api: KVM_CREATE_VCPU and KVM_ARM_VCPU_INIT<br/>secondary starts powered off
  Note over thread0,gic: Every vCPU must exist before VGIC initialization
  %% edge:kvm_14_e6
  thread0->>gic: First run path, once: KVM_DEV_ARM_VGIC_CTRL_INIT
  Note over coordinator,gic: The x86 PIC, IOAPIC and PIT setup is replaced by this GIC path
```

</details>

### 3.2 Use the arm64 boot protocol and let KVM start secondaries

<details>
<summary>Show sequence diagram</summary>

```mermaid
sequenceDiagram
  box VMM · boot loading and vCPU owners
    participant coordinator as VM coordinator
    participant thread0 as Thread T0
    participant thread1 as Thread T1
  end
  box Host · Linux KVM
    participant host_api as KVM
  end
  box VM · guest software and memory
    participant guest_ram as Guest RAM
    participant kernel as Linux kernel
  end
  %% edge:kvm_15_e1
  coordinator->>guest_ram: Load Image and device tree<br/>RAM starts at 0x8000_0000
  %% edge:kvm_15_e2
  thread0->>host_api: KVM_SET_ONE_REG: boot state and MPIDR affinity<br/>PC = Image, X0 = device tree, X1–X3 = 0<br/>EL1, DAIF masked, MMU off
  %% edge:kvm_15_e3
  thread1->>host_api: Set initial CPU state and MPIDR affinity
  %% edge:kvm_15_e4
  thread0->>host_api: KVM_RUN: boot CPU
  %% edge:kvm_15_e5
  thread1->>host_api: KVM_RUN: wait powered off inside KVM
  %% edge:kvm_15_e6
  host_api->>kernel: Execute Linux
  %% edge:kvm_15_e7
  kernel->>host_api: PSCI CPU_ON<br/>starts vCPU 1 in-kernel
  Note over host_api,kernel: Device IRQs use GIC SPI numbers with KVM_IRQ_LINE<br/>WFI waits inside KVM, not on a userspace parked-thread path
```

</details>

## BoxLite implementation reference

[Crate responsibilities](README.md#architecture) ·
[Backend API contract](README.md#hypervisor-backend-interface) ·
[Exit decoding](README.md#exit-contract) ·
[Memory layout](memory.md) ·
[Boot registers and boot data](README.md#boot-path) ·
[Threads and lifecycle](README.md#threads) ·
[KVM API](https://docs.kernel.org/virt/kvm/api.html) ·
[VGICv3 initialization](https://docs.kernel.org/virt/kvm/devices/arm-vgic-v3.html) ·
[Firecracker x86 vCPU setup](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/src/vmm/src/arch/x86_64/vcpu.rs#L222-L301)
