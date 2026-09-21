# Understanding guest memory

A visual introduction to memory in the [planned native VMM](README.md).
The architecture view starts with a small x86_64 KVM example; the walkthrough
then follows one byte through an arm64 VM with 512 MiB RAM. Example addresses
are illustrative; the final address-map diagrams show BoxLite's planned layout.

## 1. Architecture

Two mapped RAM regions provide 12 KiB of guest RAM on a host with 4 KiB pages.
Program, data and stack labels illustrate how the guest could use that RAM.
Range endpoints below are inclusive; the host column shows virtual addresses.

<details>
<summary>Show architecture diagram</summary>

```text
                  WHOLE EXAMPLE: TWO MAPPED RAM REGIONS

Guest physical addresses          KVM mapping   Host virtual addresses
                                                BoxLite-owned allocations

0x0000  +---------------------+
        | Unmapped            |
0x0FFF  +---------------------+

0x1000  +---------------------+                 +---------------------+ 0x70000000
        | Program             |     slot 0      | Program bytes       |
        | 4 KiB               |    <=======>    | 4 KiB allocation    |
0x1FFF  +---------------------+                 +---------------------+ 0x70000FFF

0x2000  +---------------------+                 +---------------------+ 0x90000000
        | Data                |     slot 1      | 8 KiB allocation    |
0x2010  | One byte: 00        |    <=======>    | Same byte: 00       | 0x90000010
        | ...                 |                 | ...                 |
        | Stack space         |                 |                     |
0x3FFF  +---------------------+                 +---------------------+ 0x90001FFF

0x4000  +---------------------+
        | Remaining address   |
        | space: unmapped     |
        +---------------------+
```

</details>

`<=======>` joins two address views of the **same backing bytes**.

- **Slot 0** maps the 4 KiB program region. **Slot 1** maps the entire 8 KiB
  data/stack region; a slot can cover several pages.
- Guest byte `0x2010` is `0x10` bytes into slot 1, so its host address is
  `0x90000000 + 0x10 = 0x90000010`. Both labels identify the same byte.
- The guest regions are adjacent even though the host allocations are far
  apart. Their host physical pages may also be scattered.

[`MemorySlots`](../../../src/hypervisor/src/kvm/memory.rs) keeps the slot
records outside guest RAM. Its vector index is the slot ID; `None` marks an
unused slot. Records change only after the KVM ioctl succeeds. BoxLite keeps
the backing allocations alive under the
[memory lifetime contract](../../../src/hypervisor/src/vm.rs).

## 2. How it works

### 2.1 Allocate backing memory in the host process

<details>
<summary>Show sequence diagram</summary>

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

</details>

### 2.2 Register the allocation as guest RAM

<details>
<summary>Show sequence diagram</summary>

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

</details>

### 2.3 Translate one guest load into a physical RAM access

<details>
<summary>Show sequence diagram</summary>

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

</details>

### 2.4 The host worker accesses the same byte through a different pointer

<details>
<summary>Show sequence diagram</summary>

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

</details>

### 2.5 A device register takes the MMIO path instead

<details>
<summary>Show sequence diagram</summary>

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

</details>

### 2.6 Interrupt-controller windows depend on who implements them

<details>
<summary>Show sequence diagram</summary>

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

</details>

### 2.7 Keep the backing alive until every user has stopped

<details>
<summary>Show sequence diagram</summary>

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

</details>

## 3. The planned arm64 address map

### 3.1 Controller and device windows below RAM

<details>
<summary>Show address map</summary>

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

</details>

### 3.2 RAM and space reserved above it

<details>
<summary>Show address map</summary>

```mermaid
flowchart LR
  subgraph guest_map["VM · guest physical addresses, low to high"]
    direction LR
    guest_ram["Example 512 MiB RAM<br/>0x8000_0000–0xA000_0000, end excluded<br/>Linux Image and device tree"]
    hotplug["Above RAM: hotplug memory window<br/>reserved for M7"]
    pci_bars["Above hotplug memory: 64-bit PCI BARs<br/>reserved for M9"]
  end
```

</details>

## BoxLite implementation reference

[MemoryRegion fields](../../../../src/hypervisor/src/memory.rs) ·
[Memory lifetime contract](README.md#hypervisor-backend-interface) ·
[Guest address layout](README.md#guest-memory-layout) ·
[Pending I/O contract](../../../../src/hypervisor/src/exit.rs) ·
[HVF walkthrough](hvf.md) · [KVM walkthrough](kvm.md) · [WHP walkthrough](whp.md) ·
[WHP host-to-guest mapping API](https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/funcs/whvmapgparange) ·
[KVM memory registration](https://docs.kernel.org/virt/kvm/api.html#kvm-set-user-memory-region)
