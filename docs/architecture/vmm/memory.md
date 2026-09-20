# Understanding guest memory

A visual introduction to memory in the [planned native VMM](README.md), using
an arm64 VM with 512 MiB RAM. The walkthrough follows one byte through guest
and host addresses. Pointer values and physical addresses are illustrative;
the final address-map diagrams show BoxLite's planned guest layout.

## 1. Architecture

```mermaid
flowchart TB
  subgraph guest["VM · guest address space"]
    program["Guest application"]
    guest_pt["Guest page tables"]
    guest_address["Guest physical address<br/>GPA 0x8000_1000"]
  end
  subgraph vmm["VMM · host process address space"]
    worker["Device worker"]
    host_address["Host virtual address<br/>HVA 0x1_0000_1000"]
  end
  subgraph host["Host · CPU translation and physical RAM"]
    stage2["Stage-2 tables<br/>EPT or NPT on x86"]
    host_pt["Host page tables"]
    physical_ram["Same RAM byte<br/>HPA 0x1234_1000"]
  end
  program memory_1_e1@-->|"GVA 0x0040_1000"| guest_pt
  guest_pt memory_1_e2@-->|"stage 1"| guest_address
  guest_address memory_1_e3@-->|"guest access"| stage2
  stage2 memory_1_e4@-->|"stage 2"| physical_ram
  worker memory_1_e5@-->|"host pointer"| host_address
  host_address memory_1_e6@-->|"host access"| host_pt
  host_pt memory_1_e7@-->|"host translation"| physical_ram
```

## 2. How it works

### 2.1 Allocate backing memory in the host process

```mermaid
sequenceDiagram
  box VMM · host process
    participant coordinator as VM coordinator
    participant region as MemoryRegion
  end
  box Host · memory
    participant os_memory as Host OS
  end
  %% edge:memory_2_e1
  coordinator->>os_memory: Allocate 512 MiB aligned to the host page size
  %% edge:memory_2_e2
  os_memory-->>coordinator: Example host base: 0x1_0000_0000
  %% edge:memory_2_e3
  coordinator->>region: Record host_addr = 0x1_0000_0000<br/>guest_addr = 0x8000_0000, size = 512 MiB
  Note over coordinator,os_memory: Host virtual address and guest physical address belong to different address spaces<br/>The guest cannot access the allocation until it is registered with the hypervisor
```

### 2.2 Register the allocation as guest RAM

```mermaid
sequenceDiagram
  box VMM · memory registration
    participant coordinator as VM coordinator
    participant region as MemoryRegion
  end
  box Host · hypervisor
    participant host_api as Hypervisor API
  end
  box VM · guest address space
    participant guest_ram as Guest RAM
  end
  %% edge:memory_3_e1
  coordinator->>region: Read host address, guest address and size
  %% edge:memory_3_e2
  coordinator->>host_api: Vm::map_memory(region)
  Note over coordinator,host_api: HVF: hv_vm_map · KVM: KVM_SET_USER_MEMORY_REGION<br/>WHP: WHvMapGpaRange
  %% edge:memory_3_e3
  host_api->>guest_ram: Register GPA range [0x8000_0000, 0xA000_0000)<br/>backed by the existing host allocation
  Note over region,guest_ram: The mapping covers 512 MiB, with the upper address excluded<br/>It shares the existing pages rather than copying their contents
```

### 2.3 Translate one guest load into a physical RAM access

```mermaid
sequenceDiagram
  box VM · guest software and translation state
    participant program as Application
    participant guest_pt as Guest page tables
  end
  box Host · CPU and physical memory
    participant cpu as Physical CPU
    participant stage2 as Stage-2 tables
    participant physical_ram as Physical RAM
  end
  %% edge:memory_4_e1
  program->>cpu: Load a byte at GVA 0x0040_1000
  %% edge:memory_4_e2
  cpu->>guest_pt: Walk guest page tables
  %% edge:memory_4_e3
  guest_pt-->>cpu: GPA 0x8000_1000
  %% edge:memory_4_e4
  cpu->>stage2: Translate GPA
  %% edge:memory_4_e5
  stage2-->>cpu: Example HPA<br/>0x1234_1000
  %% edge:memory_4_e6
  cpu->>physical_ram: Read that physical byte
  %% edge:memory_4_e7
  physical_ram-->>cpu: Example value: 0x41
  %% edge:memory_4_e8
  cpu-->>program: Load returns 0x41
  Note over program,physical_ram: These are hardware translations while the guest runs<br/>Mapped RAM access needs no device-emulation exit to the VMM
```

### 2.4 The host worker accesses the same byte through a different pointer

```mermaid
sequenceDiagram
  box VMM · host process
    participant worker as Device worker
    participant region as MemoryRegion
  end
  box Host · CPU and physical memory
    participant cpu as Physical CPU
    participant host_pt as Host page tables
    participant physical_ram as Physical RAM
  end
  %% edge:memory_5_e1
  worker->>region: Guest buffer address = 0x8000_1000<br/>offset = GPA - guest base = 0x1000
  %% edge:memory_5_e2
  region-->>worker: Host pointer = host base + offset<br/>HVA 0x1_0000_1000
  %% edge:memory_5_e3
  worker->>cpu: Store 0x42 through that host pointer
  %% edge:memory_5_e4
  cpu->>host_pt: Translate HVA
  %% edge:memory_5_e5
  host_pt-->>cpu: Same HPA<br/>0x1234_1000
  %% edge:memory_5_e6
  cpu->>physical_ram: Write the same physical byte
  Note over worker,physical_ram: The worker uses host translation, not guest stage 1 or stage 2<br/>Host users synchronize conflicting accesses<br/>Guest-shared fields follow protocol atomicity and ordering<br/>Raw pointers and volatile access alone do not synchronize memory
```

### 2.5 A device register takes the MMIO path instead

```mermaid
sequenceDiagram
  box VM · guest software
    participant kernel as Linux disk driver
  end
  box Host · CPU and virtualization service
    participant cpu as Physical CPU
    participant host_api as Hypervisor
  end
  box VMM · host process
    participant thread0 as vCPU thread
    participant disk as Virtual disk
  end
  Note over kernel,disk: Example disk window at GPA 0x4000_3000<br/>The accessed register lies outside the RAM mapping
  %% edge:memory_6_e1
  kernel->>cpu: Write a disk register<br/>after guest address translation
  %% edge:memory_6_e2
  cpu->>host_api: Trap on the device window<br/>no RAM mapping covers it
  %% edge:memory_6_e3
  host_api-->>thread0: Return a device-access exit
  %% edge:memory_6_e4
  thread0->>disk: Decode and dispatch MMIO write
  %% edge:memory_6_e5
  disk-->>thread0: Register write handled
  %% edge:memory_6_e6
  thread0->>host_api: Complete the access and re-enter
  %% edge:memory_6_e7
  host_api->>kernel: Continue guest execution
  Note over kernel,disk: This is the device path used to notify the disk worker<br/>Request descriptors and file buffers still live in ordinary guest RAM
```

### 2.6 Interrupt-controller windows depend on who implements them

```mermaid
sequenceDiagram
  box VM · guest software
    participant kernel as Linux kernel
  end
  box Host · virtualization service
    participant controller as Host controller
    participant host_api as Hypervisor
  end
  box VMM · userspace device emulation
    participant thread0 as vCPU thread
    participant ioapic as WHP IOAPIC
  end
  alt Host-provided controller
  %% edge:memory_7_e1
    kernel->>controller: Access GIC on HVF/KVM or host-provided x86 APIC
    Note over kernel,controller: The host handles its controller's window<br/>without VMM device emulation
  else WHP userspace IOAPIC
  %% edge:memory_7_e2
    kernel->>host_api: Access the IOAPIC MMIO window
  %% edge:memory_7_e3
    host_api-->>thread0: MemoryAccess exit
  %% edge:memory_7_e4
    thread0->>ioapic: Emulate the register access
  end
  Note over kernel,ioapic: An unmapped address is not automatically a userspace device<br/>Host-owned controller windows are handled by the host
```

### 2.7 Keep the backing alive until every user has stopped

```mermaid
sequenceDiagram
  box VMM · lifecycle and memory ownership
    participant coordinator as VM coordinator
    participant vcpus as vCPU threads
    participant worker as Device worker
    participant backing as Host allocation
  end
  box Host · hypervisor
    participant host_api as Hypervisor
  end
  %% edge:memory_8_e1
  coordinator->>vcpus: Stop execution and finish pending I/O
  %% edge:memory_8_e2
  vcpus-->>coordinator: All vCPU threads joined
  %% edge:memory_8_e3
  coordinator->>worker: Stop and join
  %% edge:memory_8_e4
  worker-->>coordinator: No more accesses to the allocation<br/>Host I/O completed or canceled
  %% edge:memory_8_e5
  coordinator->>host_api: Unmap every guest RAM region
  %% edge:memory_8_e6
  host_api-->>coordinator: Successful unmap
  %% edge:memory_8_e7
  coordinator->>backing: Release host allocation
  Note over coordinator,host_api: A failed unmap may leave the mapping live: retain its backing<br/>Alternatively, destroy the VM and all vCPUs<br/>In either case, every host user must finish before releasing memory
```

## 3. The planned arm64 address map

### 3.1 Controller and device windows below RAM

```mermaid
flowchart LR
  subgraph guest_map["VM · guest physical addresses, low to high"]
    direction LR
    redistributors["GIC redistributors<br/>below 0x3FFF_0000 · 128 KiB per vCPU"]
    distributor["GIC distributor<br/>0x3FFF_0000 · 64 KiB"]
    rtc["PL031 real-time clock<br/>0x4000_1000 · SPI 33"]
    uart["PL011 serial port<br/>0x4000_2000 · SPI 32"]
    virtio["Virtio MMIO windows<br/>0x4000_3000–0x7000_0000<br/>4 KiB each · SPIs from 34"]
    ecam["PCI ECAM window<br/>0x7000_0000–0x8000_0000<br/>reserved for M9"]
  end
```

### 3.2 RAM and space reserved above it

```mermaid
flowchart LR
  subgraph guest_map["VM · guest physical addresses, low to high"]
    direction LR
    guest_ram["Example 512 MiB RAM<br/>0x8000_0000–0xA000_0000, end excluded<br/>Linux Image and device tree"]
    hotplug["Above RAM: hotplug memory window<br/>reserved for M7"]
    pci_bars["Above hotplug memory: 64-bit PCI BARs<br/>reserved for M9"]
  end
```

## BoxLite implementation reference

[MemoryRegion fields](../../../src/hypervisor/src/memory.rs) ·
[Memory lifetime contract](README.md#hypervisor-backend-interface) ·
[Guest address layout](README.md#guest-memory-layout) ·
[Pending I/O contract](../../../src/hypervisor/src/exit.rs) ·
[HVF walkthrough](hvf.md) · [KVM walkthrough](kvm.md) · [WHP walkthrough](whp.md) ·
[WHP host-to-guest mapping API](https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/funcs/whvmapgparange) ·
[KVM memory registration](https://docs.kernel.org/virt/kvm/api.html#kvm-set-user-memory-region)
