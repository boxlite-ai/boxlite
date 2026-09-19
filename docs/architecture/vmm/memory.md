# Guest memory (design)

How a guest physical address reaches host memory or a device in the [VMM design](README.md), on arm64; the design also lists the x86_64 layout. Planned: M1 maps guest memory and adds the PL011 and PL031, and M2 adds virtio devices.

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
