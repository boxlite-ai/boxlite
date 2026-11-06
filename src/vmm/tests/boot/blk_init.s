# BoxLite virtio-blk experiment init (x86_64, Linux syscalls, no libc).
# Steps are numbered in r13 so a failure prints which one broke.
        .text
        .globl _start
_start:
        sub     $1024, %rsp             # rbx = a 512-byte sector buffer on the stack
        mov     %rsp, %rbx
        mov     $1, %r13d
        mov     $83, %eax               # mkdir("/dev", 0755)
        lea     dev(%rip), %rdi
        mov     $0x1ed, %esi
        syscall
        mov     $165, %eax              # mount("devtmpfs", "/dev", "devtmpfs", 0, 0)
        lea     devtmpfs(%rip), %rdi
        lea     dev(%rip), %rsi
        lea     devtmpfs(%rip), %rdx
        xor     %r10d, %r10d
        xor     %r8d, %r8d
        syscall
        test    %rax, %rax
        jnz     fail
        mov     $2, %r13d
        mov     $83, %eax               # mkdir("/sys", 0755)
        lea     sys(%rip), %rdi
        mov     $0x1ed, %esi
        syscall
        mov     $165, %eax              # mount("sysfs", "/sys", "sysfs", 0, 0)
        lea     sysfs(%rip), %rdi
        lea     sys(%rip), %rsi
        lea     sysfs(%rip), %rdx
        xor     %r10d, %r10d
        xor     %r8d, %r8d
        syscall
        test    %rax, %rax
        jnz     fail
# Phase A: read sector 0, check the magic, write sector 1, fsync.
        mov     $3, %r13d
        mov     $2, %eax                # open("/dev/vda", O_RDWR)
        lea     vda(%rip), %rdi
        mov     $2, %esi
        xor     %edx, %edx
        syscall
        test    %rax, %rax
        js      fail
        mov     %rax, %r12
        mov     $4, %r13d
        xor     %eax, %eax              # read(fd, buf, 512)
        mov     %r12, %rdi
        mov     %rbx, %rsi
        mov     $512, %edx
        syscall
        cmp     $512, %rax
        jne     fail
        mov     $5, %r13d
        mov     magic(%rip), %rax       # buf[0..8] == "BLKEXP01"
        cmp     %rax, (%rbx)
        jne     fail
        mov     %rbx, %rdi              # buf = 512 bytes of 0x5a
        mov     $0x5a, %al
        mov     $512, %ecx
        rep stosb
        mov     $6, %r13d
        mov     $1, %eax                # write(fd, buf, 512): sector 1
        mov     %r12, %rdi
        mov     %rbx, %rsi
        mov     $512, %edx
        syscall
        cmp     $512, %rax
        jne     fail
        mov     $7, %r13d
        mov     $74, %eax               # fsync(fd)
        mov     %r12, %rdi
        syscall
        test    %rax, %rax
        jnz     fail
        mov     $3, %eax                # close(fd)
        mov     %r12, %rdi
        syscall
# Phase B: unbind and bind the driver: Status=0 reset, then a fresh DRIVER_OK.
        mov     $8, %r13d
        lea     unbind(%rip), %rdi
        call    write_virtio0
        mov     $9, %r13d
        lea     bind(%rip), %rdi
        call    write_virtio0
# Phase C: read sector 1 back through the re-activated device.
        mov     $10, %r13d
        mov     $2, %eax                # open("/dev/vda", O_RDONLY)
        lea     vda(%rip), %rdi
        xor     %esi, %esi
        xor     %edx, %edx
        syscall
        test    %rax, %rax
        js      fail
        mov     %rax, %r12
        mov     $11, %r13d
        mov     $8, %eax                # lseek(fd, 512, SEEK_SET)
        mov     %r12, %rdi
        mov     $512, %esi
        xor     %edx, %edx
        syscall
        cmp     $512, %rax
        jne     fail
        mov     $12, %r13d
        xor     %eax, %eax              # read(fd, buf, 512)
        mov     %r12, %rdi
        mov     %rbx, %rsi
        mov     $512, %edx
        syscall
        cmp     $512, %rax
        jne     fail
        mov     $13, %r13d
        movabs  $0x5a5a5a5a5a5a5a5a, %rax
        cmp     %rax, (%rbx)
        jne     fail
        lea     ok_msg(%rip), %rsi
        mov     $ok_len, %edx
        jmp     print
fail:
        lea     fail_msg(%rip), %rsi
        mov     $fail_len, %edx
        mov     $1, %eax                # write(1, "BOXLITE_BLK_FAIL ", len)
        mov     $1, %edi
        syscall
        lea     0x30(%r13), %eax        # then the step as "<digit>\n" (10..13 print as ':'..'=')
        mov     %al, (%rbx)
        movb    $10, 1(%rbx)
        mov     %rbx, %rsi
        mov     $2, %edx
print:
        mov     $1, %eax                # write(1, msg, len)
        mov     $1, %edi
        syscall
        mov     $16, %eax               # ioctl(1, TCSBRK, 1): drain the tty
        mov     $1, %edi
        mov     $0x5409, %esi
        mov     $1, %edx
        syscall
        mov     $169, %eax              # reboot(LINUX_REBOOT_CMD_RESTART)
        mov     $0xfee1dead, %edi
        mov     $0x28121969, %esi
        mov     $0x01234567, %edx
        xor     %r10d, %r10d
        syscall
        mov     $231, %eax              # exit_group(1)
        mov     $1, %edi
        syscall
# write_virtio0(rdi = sysfs attribute path): open O_WRONLY, write "virtio0", close.
write_virtio0:
        mov     $2, %eax
        mov     $1, %esi
        xor     %edx, %edx
        syscall
        test    %rax, %rax
        js      fail
        mov     %rax, %r12
        mov     $1, %eax
        mov     %r12, %rdi
        lea     virtio0(%rip), %rsi
        mov     $7, %edx
        syscall
        cmp     $7, %rax
        jne     fail
        mov     $3, %eax
        mov     %r12, %rdi
        syscall
        ret
dev:      .asciz "/dev"
devtmpfs: .asciz "devtmpfs"
sys:      .asciz "/sys"
sysfs:    .asciz "sysfs"
vda:      .asciz "/dev/vda"
unbind:   .asciz "/sys/bus/virtio/drivers/virtio_blk/unbind"
bind:     .asciz "/sys/bus/virtio/drivers/virtio_blk/bind"
virtio0:  .ascii "virtio0"
magic:    .ascii "BLKEXP01"
ok_msg:   .ascii "BOXLITE_BLK_OK\n"
        .set ok_len, . - ok_msg
fail_msg: .ascii "BOXLITE_BLK_FAIL "
        .set fail_len, . - fail_msg
