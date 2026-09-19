# Linux KVM (design)

How the [VMM design](README.md) runs a box on Linux x86_64 and arm64. Planned: M1 boots a test initramfs on this backend, and M2 adds virtio devices and `boxlite-guest` as PID 1.

```mermaid
flowchart TB
  subgraph shim_process["boxlite-shim process · one per box"]
    subgraph vmm_crate["boxlite-vmm"]
      run_thread["run() thread · poller"]
      device_worker["device workers"]
      vcpu_thread["vcpuN thread per vCPU"]
    end
    subgraph kvm_backend["boxlite-hypervisor · kvm backend"]
      kvm_vm["Vm (KVM)"]
      kvm_vcpu["Vcpu (KVM)"]
    end
  end
  subgraph linux_kernel["Linux kernel"]
    kvm_module["KVM"]
    irqchip["in-kernel irqchip"]
  end
  subgraph guest_vm["guest VM"]
    guest_kernel["pinned LTS kernel"]
    guest_init["boxlite-guest · PID 1"]
  end
  vcpu_thread e_vcpu_run@-->|"Vcpu::run → VcpuExit"| kvm_vcpu
  kvm_vcpu e_kvm_run@-->|"KVM_RUN"| kvm_module
  kvm_module e_enter_guest@-->|"enters the guest"| guest_kernel
  run_thread e_kick@-->|"VcpuHandle::kick · immediate_exit + signal"| kvm_vcpu
  run_thread e_map_memory@-->|"Vm::map_memory"| kvm_vm
  kvm_vm e_set_memslot@-->|"KVM_SET_USER_<br/>MEMORY_REGION"| kvm_module
  device_worker e_set_irq_line@-->|"Vm::set_irq_line"| kvm_vm
  kvm_vm e_irq_line@-->|"KVM_IRQ_LINE"| irqchip
  irqchip e_guest_irq@-->|"SPI or GSI interrupts"| guest_kernel
  guest_kernel e_pid1@-->|"PID 1"| guest_init
```
