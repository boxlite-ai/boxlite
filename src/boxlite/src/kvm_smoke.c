/*
 * KVM smoke test — verify /dev/kvm can execute guest code.
 *
 * Creates a throwaway VM with a single HLT instruction at address 0,
 * sets up minimal real-mode vCPU state (CS:IP → 0, RFLAGS bit 1),
 * and runs one instruction.
 *
 * Returns KVM_EXIT_HLT (5) on success, or the actual exit reason on failure.
 *
 * This is implemented in C because Rust's libc::ioctl() variadic FFI has
 * ABI issues with some KVM ioctls on certain platforms (observed on EC2 c8i
 * nested virtualization).
 *
 * x86_64 only — ARM uses a different KVM API (no CS/RIP registers).
 *
 * References:
 *   - LWN "Using the KVM API": https://lwn.net/Articles/658511/
 *   - dpw/kvm-hello-world: https://github.com/dpw/kvm-hello-world
 */

#ifdef __x86_64__

#include <fcntl.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <linux/kvm.h>
#include <unistd.h>

/* Run a KVM smoke test on an already-opened /dev/kvm fd.
 * Returns: 5 (KVM_EXIT_HLT) on success, -1 on setup error,
 *          or the KVM exit reason on unexpected exit. */
int boxlite_kvm_smoke_test(int kvm_fd) {
    int vm_fd = ioctl(kvm_fd, KVM_CREATE_VM, 0);
    if (vm_fd < 0)
        return -1;

    /* One page of guest memory with HLT (0xF4) at address 0 */
    void *guest_mem = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                           MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (guest_mem == MAP_FAILED) {
        close(vm_fd);
        return -1;
    }
    *(unsigned char *)guest_mem = 0xF4; /* HLT */

    struct kvm_userspace_memory_region region = {
        .slot = 0,
        .guest_phys_addr = 0,
        .memory_size = 4096,
        .userspace_addr = (unsigned long)guest_mem,
    };
    if (ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region) < 0) {
        munmap(guest_mem, 4096);
        close(vm_fd);
        return -1;
    }

    int vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, 0);
    if (vcpu_fd < 0) {
        munmap(guest_mem, 4096);
        close(vm_fd);
        return -1;
    }

    /* Set CS base=0, selector=0 so real-mode CS:IP points to address 0.
     * Default x86 state has CS base=0xFFFF0000, selector=0xF000 (reset vector)
     * which would fetch from 0xFFFFFFF0 — unmapped in our one-page VM. */
    struct kvm_sregs sregs;
    ioctl(vcpu_fd, KVM_GET_SREGS, &sregs);
    sregs.cs.base = 0;
    sregs.cs.selector = 0;
    ioctl(vcpu_fd, KVM_SET_SREGS, &sregs);

    /* Set RIP=0 (HLT location), RFLAGS=0x2 (bit 1 architecturally required) */
    struct kvm_regs regs;
    memset(&regs, 0, sizeof(regs));
    regs.rip = 0;
    regs.rflags = 0x2;
    ioctl(vcpu_fd, KVM_SET_REGS, &regs);

    /* Run the vCPU */
    int mmap_size = ioctl(kvm_fd, KVM_GET_VCPU_MMAP_SIZE, 0);
    struct kvm_run *run = mmap(NULL, mmap_size, PROT_READ | PROT_WRITE,
                               MAP_SHARED, vcpu_fd, 0);
    if (run == MAP_FAILED) {
        close(vcpu_fd);
        munmap(guest_mem, 4096);
        close(vm_fd);
        return -1;
    }

    ioctl(vcpu_fd, KVM_RUN, 0);
    int exit_reason = run->exit_reason;

    /* Cleanup */
    munmap(run, mmap_size);
    close(vcpu_fd);
    munmap(guest_mem, 4096);
    close(vm_fd);

    return exit_reason;
}

#else /* !__x86_64__ */

/* ARM/aarch64: no smoke test needed — KVM API differs and Hypervisor.framework
 * is used on macOS ARM. Return success (KVM_EXIT_HLT = 5). */
int boxlite_kvm_smoke_test(int kvm_fd) {
    (void)kvm_fd;
    return 5; /* KVM_EXIT_HLT */
}

#endif /* __x86_64__ */
