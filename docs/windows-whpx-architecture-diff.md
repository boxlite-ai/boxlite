# Windows WHPX vs macOS/Linux libkrun 架构差异审计

> **日期**: 2026-04-27
> **分支**: `feat/windows-whpx-support`
> **审计范围**: `vendor/libkrun/src/vmm/src/windows/` vs `vendor/libkrun/src/vmm/src/` + `vendor/libkrun/src/devices/src/virtio/`

## 概述

Windows WHPX 后端是一套独立的 VMM 实现（`windows/` 模块），不复用上游 Firecracker/libkrun 的 Unix VMM 基础设施。本文档全面列出两套实现在架构设计上的差异，以及这些差异对用户场景的功能影响。

---

## 1. I/O 线程模型（核心差异）

| 维度 | macOS/Linux (upstream) | Windows WHPX |
|------|----------------------|--------------|
| **整体架构** | 多线程 EventManager (epoll/kqueue) | 单线程 vCPU 循环 |
| **vCPU** | 每个 vCPU 独立线程 (`start_threaded()`) | 单线程 `run_vcpu_loop()` |
| **设备事件** | EventManager 异步分发 (Subscriber trait) | `tick_and_poll()` 在 vCPU 循环顶部同步调用 |
| **中断控制器** | IOAPIC (Linux) / GIC (ARM) / IrqChip trait | 自定义 8259 PIC（仅支持 15 个 IRQ） |

**关键代码对比**:

- macOS/Linux: `lib.rs` → `Vmm` 实现 `Subscriber` trait，注册到 `EventManager`；每个设备独立 EventFd 触发
- Windows: `runner.rs` → `run_vcpu_loop()` 在每次 `vcpu.run()` 前调用 `devices.tick_and_poll()`，同步处理所有设备

**影响**: 所有 virtio 设备共享 vCPU 时间片。重 I/O 操作会饿死其他设备。已验证：ext4 顺序读 >10MB 即饿死 vsock/gRPC 通道。

---

## 2. virtio-blk 块设备（性能关键差异）

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **I/O 模型** | **独立 worker 线程** + epoll 事件驱动 | **同步 I/O** 在 vCPU 主循环内 |
| **代码路径** | `BlockWorker::run()` → `thread::spawn("block worker")` | `VirtioBlock::queue_notify()` → `disk.read_at()` / `write_at()` |
| **并发** | queue_evt (EventFd) 唤醒 worker，不阻塞 vCPU | 每个扇区读写阻塞整个 vCPU 循环 |
| **磁盘格式** | `imago` 库: raw, qcow2, vmdk | 自定义 `DiskBackend` trait: raw + qcow2 |
| **文件数量** | `block/device.rs` + `block/worker.rs` + 测试 | `block.rs`（单文件） |

**关键代码**:

```
// macOS/Linux — 独立线程
// devices/src/virtio/block/worker.rs
pub fn run(self) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name("block worker".into())
        .spawn(|| self.work())   // 独立线程处理 I/O
        .unwrap()
}

// Windows — 同步 I/O
// vmm/src/windows/devices/virtio/block.rs
fn queue_notify(&mut self, _queue_idx: u32, queue: &mut Virtqueue, mem: &dyn GuestMemoryAccessor) -> bool {
    while let Ok(Some(head)) = queue.pop_avail(mem) {
        let status = self.process_request(&chain, mem);  // 阻塞当前线程
        ...
    }
}
```

**影响**: 这是「磁盘 I/O 饿死 vsock」的直接根因。Linux/macOS 的 block worker 独立线程处理 I/O，vCPU 继续执行 vsock 等其他 virtio 中断。Windows 的同步 I/O 占住了唯一的执行线程，所有其他设备被阻塞。

---

## 3. vsock 实现（架构差异大）

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **传输层** | VsockMuxer + Unix domain socket | TCP bridge (127.0.0.1) |
| **线程模型** | 独立 `muxer_thread`（epoll 驱动） | 无独立线程，在 `tick_and_poll()` 中同步 poll |
| **协议实现** | 完整 VSock 协议栈 | 简化 TCP 桥接 |
| **连接管理** | proxy, reaper, timesync, dgram/stream | connection + packet |
| **文件数量** | **13 文件** | **3 文件** |

**上游 vsock 文件列表** (13 files):
```
device.rs, event_handler.rs, mod.rs, muxer.rs, muxer_thread.rs,
muxer_rxq.rs, packet.rs, proxy.rs, reaper.rs, timesync.rs,
tsi_dgram.rs, tsi_stream.rs, unix.rs
```

**Windows vsock 文件列表** (3 files):
```
mod.rs, connection.rs, packet.rs
```

**影响**:
- TCP bridge 增加延迟（需经过 OS TCP 栈，非直接内存映射）
- 没有独立 muxer 线程，vsock 数据只在 `tick_and_poll()` 被调用时才处理
- 缺少 timesync（guest 时钟同步）、dgram 支持

---

## 4. 缺失的 virtio 设备

上游 Linux/macOS 实现包含 10 种 virtio 设备类型，Windows WHPX 仅实现了 4 种（+ 9p 替代 virtiofs）。

| 设备 | Linux/macOS | Windows | 功能影响 |
|------|:-----------:|:-------:|---------|
| **virtio-blk** | 有（worker 线程） | 有（同步） | 性能差异，见第 2 节 |
| **virtio-vsock** | 有（muxer 线程） | 有（TCP bridge） | 架构差异，见第 3 节 |
| **virtio-net** | 有（TAP 设备） | 有（TCP/Unix stream） | 无 TAP 设备，通过 gvproxy 用户态代理 |
| **virtio-9p** | 无 | 有 | Windows 独有，替代 virtiofs |
| **virtio-balloon** | 有 | **缺失** | 无法动态调整 guest 内存。host 无法回收 guest 未使用的内存。影响长时间运行的 VM 内存效率。 |
| **virtiofs** (FUSE) | 有 | **缺失**（用 9p 替代） | virtiofs 性能远优于 9p（FUSE passthrough 直接转发 syscall）。大文件操作和高频小文件操作性能差距可达 5-10 倍。 |
| **virtio-console** | 有 | **缺失**（用 Serial COM1） | Serial 16550 限制：无流控、低吞吐（115200 baud 等效）。console 输出量大时可能丢数据。 |
| **virtio-rng** | 有 | **缺失** | guest 随机数只能依赖 CPU 时间戳等低质量熵源。影响 SSH keygen 等需高质量随机数的场景（可能很慢）。 |
| **virtio-gpu** | 有 | **缺失** | 无 GPU 虚拟化，无桌面场景支持 |
| **virtio-snd** | 有 | **缺失** | 无音频支持 |
| **virtio-input** | 有 | **缺失** | 无输入设备虚拟化 |

---

## 5. 中断系统差异

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **中断控制器** | IOAPIC (x86) / GIC (ARM) | 8259 PIC（双级联） |
| **IRQ 数量** | 24+（IOAPIC） | 15（PIC, IRQ2 级联占用） |
| **MSI/MSI-X** | 支持 | 不支持 |
| **中断注入** | KVM/HVF 内核态直接注入 | WHPX API `WHvRequestInterrupt` + `interrupt_window` 轮询 |
| **中断递送** | 异步，内核态处理 | 同步，在 vCPU 循环中轮询 `pic.has_pending()` |

**影响**:
- 15 个 IRQ 限制可挂载的设备数量（当前 5 个 MMIO slot 已占用 5 个 IRQ）
- 无 MSI-X 意味着所有设备共享 edge-triggered PIC 中断，增加中断冲突概率
- 同步中断注入增加延迟（需等待 interrupt window）

**注**: PIC 的优先级模型已修复（`pending_irq()` 实现正确的 8259A 优先级屏蔽），clear_halt 机制防止 HLT 丢失唤醒。

---

## 6. 文件系统共享：9p vs virtiofs

| 维度 | Linux/macOS (virtiofs) | Windows WHPX (9p) |
|------|----------------------|------------------|
| **协议** | FUSE passthrough | 9P2000.L |
| **性能** | 接近原生（FUSE passthrough 直接转发 syscall） | 每次操作需 9p 请求/响应序列化 |
| **缓存** | DAX（直接访问映射） | 无 DAX |
| **元数据** | 高效（passthrough 直接 stat） | 每次 stat 需完整 9p getattr 往返 |
| **适用场景** | volume mount 高性能 | volume mount 基本可用 |

**影响**: volume mount (`-v /host/dir:/guest/dir`) 性能：virtiofs 接近原生，9p 在高频小文件操作时可能慢 5-10 倍。

---

## 7. 多 vCPU 支持

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **vCPU 线程** | 每 vCPU 一个 OS 线程 | 仅 1 个 vCPU |
| **SMP 支持** | 完整（config `num_vcpus`） | 仅单核 |
| **代码** | `start_threaded()` per vCPU | `WhpxVcpu::new(&partition, 0)` 仅创建 vCPU 0 |

**注**: 虽然 `partition.set_processor_count(ctx.num_vcpus)` 被调用，但 `run_vcpu_loop()` 只创建 1 个 vCPU（index 0）。WHPX API 本身支持多 vCPU，但需要重新设计 runner 为多线程。

**影响**: guest 只能看到 1 个 CPU 核心。多线程 guest 应用无法利用多核。用户配置 `cpus=2` 或更高无实际效果。

---

## 8. 其他设计差异

### 8.1 定时器

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **PIT 实现** | 内核态 KVM PIT / HVF 原生 | 自定义用户态 PIT (`pit.rs`) + 1ms timer 线程 |
| **精度** | 硬件级 | 1ms 软件定时（受 OS 调度影响） |

### 8.2 RTC/CMOS

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **时钟** | 内核态 RTC / 设备透传 | 自定义 CMOS 寄存器模拟（启动时快照 UTC） |
| **BCD 编码** | 由硬件/内核处理 | 手工 BCD 编码（`to_bcd()`） |

### 8.3 ACPI 关机

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **机制** | 完整 ACPI 表 + 内核态处理 | 自定义 ACPI DSDT/FACP + PM1a_CNT 端口监听 |
| **S5 检测** | 内核事件 | `handle_io_out(PM1A_CNT_BLK)` 检测 SLP_TYP=5 |

### 8.4 网络

| 维度 | macOS/Linux | Windows WHPX |
|------|------------|--------------|
| **后端** | gvproxy + Unix socket | gvproxy DLL + TCP 或 Unix socket |
| **连接方式** | `UnixStream::connect()` | `TcpStream::connect()` (Windows) |
| **性能** | Unix socket（零拷贝路径） | TCP socket（需经过 TCP 栈） |

---

## 9. 用户场景影响矩阵

| 用户场景 | 可用性 | 原因 |
|---------|:------:|------|
| 基本 exec（echo, ls, 轻量命令） | **正常** | 不触发重 I/O |
| 网络访问（curl, wget, apt） | **正常** | gvproxy DLL 已可用 |
| 大文件操作 + 并发 gRPC | **受限** | 磁盘 I/O 饿死 vsock（单线程 + 同步 blk） |
| 浏览器自动化（Playwright/Chromium） | **不可用** | Chrome 二进制 362MB ext4 读直接杀死 gRPC |
| 动态内存调整 | **不可用** | 缺少 virtio-balloon |
| 高性能 host↔guest 文件共享 | **受限** | 9p 远慢于 virtiofs |
| 多核 guest 应用 | **不可用** | 仅 1 vCPU |
| 大量 console 输出 | **受限** | Serial COM1 吞吐低 |
| SSH keygen / 强随机数 | **可能慢** | 缺少 virtio-rng |
| GPU / 桌面 / 音频 | **不可用** | 缺少对应 virtio 设备 |

---

## 10. 改进优先级建议

### P0 — 解决核心功能缺陷

1. **virtio-blk 独立 worker 线程**: 将 `VirtioBlock::queue_notify()` 改为异步模型，在独立线程做 disk I/O，通过事件通知 vCPU 循环注入中断。这是解决「磁盘 I/O 饿死 vsock」的根本方案，解除浏览器自动化等重 I/O 场景的限制。

### P1 — 提升能力上限

2. **多 vCPU 支持**: 为每个 vCPU 创建独立线程 + 同步机制。WHPX API 已支持多 vCPU，需重新设计 runner loop 为多线程模型。
3. **virtio-balloon**: 实现动态内存回收，对长时间运行的 VM 重要。

### P2 — 性能优化

4. **virtiofs 替代 9p**: 实现 FUSE 协议处理，工作量较大但 volume mount 性能收益显著。
5. **virtio-console 替代 Serial**: 提升 console 吞吐。

### P3 — 完善度

6. **virtio-rng**: 为 guest 提供高质量随机数源。
7. **IOAPIC 替代 PIC**: 突破 15 IRQ 限制，支持 MSI-X。

---

## 附录：代码路径对照

| 功能 | macOS/Linux 代码路径 | Windows WHPX 代码路径 |
|------|--------------------|--------------------|
| VMM 主循环 | `vmm/src/lib.rs` → `Vmm` + EventManager | `vmm/src/windows/runner.rs` → `run_vcpu_loop()` |
| 设备管理 | `vmm/src/device_manager/` | `vmm/src/windows/devices/manager.rs` |
| virtio-blk | `devices/src/virtio/block/` (4 files + worker) | `vmm/src/windows/devices/virtio/block.rs` (1 file) |
| virtio-vsock | `devices/src/virtio/vsock/` (13 files) | `vmm/src/windows/devices/virtio/vsock/` (3 files) |
| virtio-net | `devices/src/virtio/net/` | `vmm/src/windows/devices/virtio/net.rs` |
| 中断控制 | `devices/src/legacy/` (IOAPIC/GIC) | `vmm/src/windows/devices/pic.rs` (8259 PIC) |
| 定时器 | KVM PIT / HVF 原生 | `vmm/src/windows/devices/pit.rs` + timer thread |
| 串口 | `devices/src/legacy/serial.rs` | `vmm/src/windows/devices/serial.rs` |
| 内存管理 | `vm-memory` crate (GuestMemoryMmap) | `vmm/src/windows/memory.rs` (GuestMemory) |
| WHPX 绑定 | N/A | `vmm/src/windows/whpx.rs` |
| 内核加载 | `kernel/` crate | `vmm/src/windows/boot/loader.rs` |
| ACPI 表 | `arch/` crate | `vmm/src/windows/boot/acpi.rs` |

---

## 11. Production Readiness 评估

### 11.1 当前状态

当前 Windows WHPX 支持已实现：基本 VM 生命周期（创建、exec、stop、remove）、gvproxy 网络、ACPI 关机、9p 文件共享、100% E2E 通过率（Win10 + Win11）。但存在第 1-8 节所述的架构差异。

### 11.2 实现 P0-P1 四项改进后的预期水平

假设完成以下四项改进：
1. virtio-blk 独立 worker 线程（P0）
2. 多 vCPU 支持（P1）
3. virtio-balloon 动态内存（P1）
4. virtiofs 替代 9p（P2）

**能达到的水平**：

| 能力 | 改进后状态 |
|------|-----------|
| 基本 exec + 网络 | 与 macOS/Linux 持平 |
| 重 I/O + gRPC 并发 | 解决（async blk worker） |
| 浏览器自动化（Playwright/Chromium） | 理论上可行 |
| 多核 guest | 可用 |
| 动态内存 | 可用 |
| volume mount 性能 | 接近原生（virtiofs） |

这 4 项解决了**功能层面**最大的缺口。对 BoxLite 的核心场景（AI agent sandbox：执行代码、基本网络、文件操作），**基本够用**。

### 11.3 仍然存在的结构性差距

#### 差距 1：VMM 整体架构仍是单线程轮询

即使 virtio-blk 改为 async worker，**其余设备仍在单线程 `tick_and_poll()` 中同步处理**：

```
// 改进后的 vCPU 循环（伪代码）
loop {
    devices.tick_and_poll();  // vsock poll + net poll + PIT tick — 仍然同步
    // virtio-blk 已异步，但 vsock/net/9p 没有
    vcpu.run();
    match exit { ... }
}
```

而上游是：

```
// EventManager 驱动（伪代码）
EventManager::run() {
    epoll_wait() → 哪个设备有事件就处理哪个
    // vsock 有自己的 muxer_thread
    // blk 有自己的 worker_thread
    // net 有自己的 event handler
    // 全部异步，互不阻塞
}
```

**具体影响**：vsock 数据到达时，如果 vCPU 正在执行 guest 代码（两次 `tick_and_poll()` 之间），数据必须等到下一个 timer tick (1ms) 才被发现。上游通过 EventFd 立即唤醒。这意味着 **gRPC 延迟的下限是 ~1ms**（macOS/Linux 可以 <0.1ms）。

#### 差距 2：vsock 仍是 3 文件 TCP bridge vs 13 文件完整协议栈

| 维度 | 改进后 Windows | macOS/Linux |
|------|--------------|------------|
| 传输 | TCP bridge (127.0.0.1) | Unix domain socket |
| 线程 | 无独立线程（仍在 tick_and_poll） | 独立 muxer_thread |
| 功能 | 仅 stream | stream + dgram |
| 连接管理 | 简化 | proxy + reaper + timesync |

**具体影响**：高并发 gRPC 场景下，TCP bridge 的连接建立/拆除开销比 Unix socket 高。无 timesync 影响 guest 时钟精度。

#### 差距 3：中断系统 — 8259 PIC vs IOAPIC

| 维度 | 改进后 Windows | macOS/Linux |
|------|--------------|------------|
| IRQ 数量 | 15 | 24+ |
| MSI-X | 不支持 | 支持 |
| 中断注入 | 同步轮询 | 内核态异步注入 |

**具体影响**：当前 5 个 MMIO slot 用了 5 个 IRQ，加上 PIT(IRQ0)、Serial(IRQ4)，已用 7/15。如果未来要加更多 virtio 设备，IRQ 会不够。无 MSI-X 意味着无法做到每 queue 独立中断。

#### 差距 4：仍缺失的设备

| 设备 | 影响 |
|------|------|
| virtio-rng | SSH keygen、TLS 等需高质量随机数的操作可能很慢 |
| virtio-console | Serial COM1 吞吐低，大量 log 输出时丢数据 |

这两个对 production 环境有实际影响，但不是阻塞项。

#### 差距 5：代码维护成本

Windows VMM 是**完全独立的实现**，不与上游共享代码。任何上游的 bug fix、性能优化、新 feature 都需要手动移植到 Windows 后端。长期维护成本高。

### 11.4 成熟度评估

```
                        ┌─────────────────────────────────────┐
  当前 Windows WHPX     │████████████░░░░░░░░░░░░░░░░░░░░░░░░│  ~35%
                        └─────────────────────────────────────┘
                        ┌─────────────────────────────────────┐
  + 4项改进后           │████████████████████████████░░░░░░░░░│  ~75%
                        └─────────────────────────────────────┘
                        ┌─────────────────────────────────────┐
  macOS/Linux           │█████████████████████████████████████│  100%
                        └─────────────────────────────────────┘
```

- **~35%（当前）**：基本 VM 生命周期可用，轻量 exec 正常，重 I/O 场景受限
- **~75%（+4 项改进后）**：覆盖 BoxLite 核心场景（AI sandbox: exec + 网络 + 文件），可作为 **"Windows beta"** 发布
- 剩余 **~25%** 差距来自：架构层面（单线程轮询 vs EventManager）、vsock 完整度、中断系统、缺失设备
- 要达到真正的 **100% parity**，需要**重写 VMM 核心为多线程 EventManager 架构**，工作量接近重写整个 Windows 后端

### 11.5 发布建议

实现 4 项改进后，建议以 **"Windows beta / experimental"** 定位发布：

- 明确文档标注 Windows 支持为 beta 阶段
- 告知用户已知限制：gRPC 延迟下限 ~1ms、PIC 中断限制、缺少 virtio-rng/console
- 核心场景（轻量 AI sandbox）可正式支持
- 重 I/O 场景（浏览器自动化等）标注为实验性
