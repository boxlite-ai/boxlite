# Guest memory (design)

What turns a guest access into host memory or a device access in the [VMM design](README.md), and where each guest physical address goes on arm64; the design also lists the x86_64 layout. Planned: M1 maps guest memory and adds the PL011 and PL031, and M2 adds virtio devices.

## Components

```mermaid
flowchart TB
  subgraph guest_side["guest"]
    guest_code["processes and the kernel<br/>its page tables · stage 1"]
  end
  subgraph gpa_space["guest physical addresses"]
    gpa_ram["RAM · kernel<br/>boot data · virtqueues"]
    gpa_windows["device windows<br/>virtio-mmio · UART · RTC"]
    gpa_irq["interrupt controller windows"]
  end
  subgraph host_hv["host hypervisor"]
    stage2["stage-2 translation<br/>EPT or NPT on x86_64"]
    mmio_exit["MMIO exit"]
    in_kernel["in-kernel GIC<br/>or local APIC"]
  end
  subgraph shim_side["boxlite-shim"]
    region["MemoryRegion<br/>guest_addr · host_addr · size"]
    backing["host memory<br/>the RAM backing"]
    bus["MMIO and port buses"]
    workers["device workers"]
  end
  guest_code m_ram@-->|"guest physical"| gpa_ram
  guest_code m_window@-->|"guest physical"| gpa_windows
  guest_code m_irq@-->|"guest physical"| gpa_irq
  gpa_ram m_mapped@-->|"mapped RAM"| stage2
  region m_region@-->|"Vm::map_memory"| stage2
  stage2 m_host@-->|"host memory · no exit"| backing
  gpa_windows m_exit@-->|"no region covers it"| mmio_exit
  gpa_irq m_in_kernel@-->|"handled in the host"| in_kernel
  mmio_exit m_bus@-->|"MmioRead · MmioWrite"| bus
  bus m_notify@-->|"queue notify"| workers
  backing m_queues@-->|"virtqueues"| workers
```

## arm64 address map

```mermaid
flowchart TB
  subgraph guest_physical["guest physical address space · arm64 · low to high"]
    gpa_gic["GICv3<br/>below 0x4000_0000"]
    gpa_devices["PL031 · PL011 · virtio-mmio<br/>0x4000_1000 – 0x7000_0000"]
    gpa_ecam["PCI ECAM · M9<br/>0x7000_0000 – 0x8000_0000"]
    gpa_ram["RAM · from 0x8000_0000<br/>kernel · device tree"]
    gpa_hotplug["hotplug memory · M7<br/>then PCI BARs · M9"]
  end
  subgraph host_hypervisor["host hypervisor · HVF or KVM"]
    in_kernel_gic["in-kernel GICv3"]
    mmio_exit["MMIO exit<br/>HVF data abort or KVM_EXIT_MMIO"]
    guest_mapping["guest RAM mapping<br/>made by Vm::map_memory"]
  end
  subgraph shim_process["boxlite-shim process"]
    vmm_bus["MMIO bus · BusDevice"]
    platform_devices["PL011 · PL031"]
    device_code["virtio devices · virtqueues"]
    ram_backing["guest RAM backing<br/>host memory"]
  end
  gpa_gic e_gic@-->|"handled in-kernel"| in_kernel_gic
  gpa_devices e_device_access@-->|"load or store"| mmio_exit
  mmio_exit e_dispatch@-->|"MmioRead · MmioWrite<br/>vcpuN dispatches"| vmm_bus
  vmm_bus e_bus_platform@-->|"read · write"| platform_devices
  vmm_bus e_bus_device@-->|"read · write"| device_code
  device_code e_raw_access@-->|"raw or volatile access"| ram_backing
  gpa_ram e_ram@-->|"mapped by"| guest_mapping
  guest_mapping e_host_addr@-->|"MemoryRegion · host_addr"| ram_backing
```
