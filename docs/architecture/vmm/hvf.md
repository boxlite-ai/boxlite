# macOS Hypervisor.framework (design)

How the [VMM design](README.md) runs a box on macOS 15+ on Apple silicon. Planned: M1 boots a test initramfs on this backend, and M2 adds virtio devices and `boxlite-guest` as PID 1.

```mermaid
flowchart TB
  subgraph shim_process["boxlite-shim process · one per box"]
    subgraph vmm_crate["boxlite-vmm"]
      run_thread["run() thread · poller"]
      device_worker["device workers"]
      vcpu_thread["vcpuN thread per vCPU"]
    end
    subgraph hvf_backend["boxlite-hypervisor · hvf backend"]
      hvf_vm["Vm (HVF)"]
      hvf_vcpu["Vcpu (HVF) · bound to its thread"]
    end
  end
  subgraph macos["macOS 15+"]
    hvf_api["Hypervisor.framework"]
    gic["in-kernel GICv3"]
  end
  subgraph guest_vm["guest VM"]
    guest_kernel["pinned LTS kernel"]
    guest_init["boxlite-guest · PID 1"]
  end
  vcpu_thread e_vcpu_run@-->|"Vcpu::run → VcpuExit"| hvf_vcpu
  hvf_vcpu e_hv_vcpu_run@-->|"hv_vcpu_run"| hvf_api
  hvf_api e_enter_guest@-->|"enters the guest"| guest_kernel
  run_thread e_kick@-->|"VcpuHandle::kick · hv_vcpus_exit"| hvf_vcpu
  run_thread e_map_memory@-->|"Vm::map_memory"| hvf_vm
  hvf_vm e_hv_vm_map@-->|"hv_vm_map"| hvf_api
  device_worker e_set_irq_line@-->|"Vm::set_irq_line"| hvf_vm
  hvf_vm e_gic_set_spi@-->|"hv_gic_set_spi"| gic
  gic e_guest_irq@-->|"SPI interrupts"| guest_kernel
  guest_kernel e_pid1@-->|"PID 1"| guest_init
```
