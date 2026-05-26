# Windows WHPX VMM 生态调研：可借鉴的成熟实现

> **日期**: 2026-04-28
> **目的**: 调研 QEMU、crosvm 等成熟 VMM 对 Windows WHPX 的支持，评估其代码/架构对 BoxLite 的可借鉴性
> **关联文档**: `docs/windows-whpx-architecture-diff.md`（架构差异审计）

---

## 目录

1. [VMM 生态全景](#1-vmm-生态全景)
2. [QEMU WHPX 支持详细分析](#2-qemu-whpx-支持详细分析)
3. [crosvm Windows/WHPX 支持详细分析](#3-crosvm-windowswhpx-支持详细分析)
4. [其他 Rust VMM 项目](#4-其他-rust-vmm-项目)
5. [逐项差距对照：谁能提供参考](#5-逐项差距对照谁能提供参考)
6. [推荐借鉴策略](#6-推荐借鉴策略)

---

## 1. VMM 生态全景

| VMM | 语言 | Windows 宿主 | WHPX | 许可证 | 成熟度 | 可借鉴性 |
|-----|------|:-----------:|:----:|--------|--------|---------|
| **QEMU** | C | Yes | Yes | **GPLv2** (copyleft) | Production (2018起) | 仅架构参考，不可复制代码 |
| **crosvm** | **Rust** | Yes | Yes | **BSD-3** (宽松) | Production (Chrome OS/Android) | **最佳参考，可直接借鉴代码** |
| **OpenVMM** | **Rust** | Yes | Yes | **MIT** (宽松) | WIP，未 production | 可参考，但不够成熟 |
| **Hyperlight** | **Rust** | Yes | WHP | **Apache 2.0** | CNCF sandbox | 仅 micro-VM，场景不同 |
| Cloud-Hypervisor | Rust | No | No | Apache 2.0 | Production | 不适用（无 Windows 宿主） |
| Firecracker | Rust | No | No | Apache 2.0 | Production | 不适用（无 Windows 宿主） |

**关键发现**: crosvm 是唯一同时满足「Rust + WHPX + 宽松许可证 + Production 成熟」的 VMM，是 BoxLite 的最佳借鉴对象。

---

## 2. QEMU WHPX 支持详细分析

### 2.1 历史与成熟度

- **2018年1月**: Microsoft Hyper-V 团队提交初始 WHPX patch
- **2018年8月 (QEMU 3.0)**: 首次正式发布，标记为 experimental
- **2020年12月**: 加入 kernel-irqchip on/off 支持（Hyper-V 内核态 APIC/IOAPIC）
- **2026年4月 (QEMU 11.0)**: 修复 Windows 10 PIC HLT wakeup 问题

QEMU 官方定位 WHPX 为「开发者工作流加速器」，非 production hypervisor。已知问题包括：`-cpu` 参数被忽略、无 xsave 状态保存、某些场景下比 TCG 软件模拟还慢。

### 2.2 架构细节

| 维度 | QEMU WHPX 实现 |
|------|---------------|
| 源码位置 | `target/i386/whpx/whpx-all.c` + `whpx-apic.c` |
| vCPU 模型 | **每 vCPU 一个 OS 线程**（与 KVM 模式一致） |
| 事件循环 | 主循环线程 + IOThread（`aio-win32.c`，基于 `WaitForMultipleObjects`） |
| 中断 | 两种模式：kernel-irqchip=on（WHPX 内核 APIC）/ off（全软件模拟） |
| HLT 处理 | `whpx_vcpu_kick_out_of_hlt()` — 与 BoxLite 的 `clear_halt()` 完全一致 |

### 2.3 设备在 Windows 宿主上的可用性

| 设备 | 后端类型 | Windows 宿主可用 | 说明 |
|------|---------|:---------------:|------|
| virtio-blk | 纯用户态 + IOThread | **Yes** | 无 vhost-blk 加速 |
| virtio-balloon | 纯用户态 | **Yes** | 完整支持 |
| virtio-rng | 纯用户态 | **Yes** | 完整支持 |
| virtio-console | 纯用户态 | **Yes** | 完整支持 |
| virtio-net | 纯用户态 + SLIRP | **Yes** | 无 vhost-net 加速 |
| **virtio-vsock** | vhost 内核模块 | **No** | 需要 Linux `/dev/vhost-vsock` |
| **virtiofs** | vhost-user (virtiofsd) | **No** | 需要 Linux FUSE |
| **virtio-9p** | QEMU 用户态 | **No** (WIP) | Patch 存在但未合入 |

**关键发现**: QEMU 在 Windows 宿主上同样**无法提供 vsock、virtiofs、9p**。这验证了 BoxLite 自行实现 vsock TCP bridge 和 9p 的合理性。

### 2.4 virtio-blk IOThread 模型

QEMU 在所有平台（含 Windows）提供三种 I/O 模型：

1. **主循环**（默认）：virtqueue 处理在主事件循环线程，与其他活动串行
2. **IOThread**：独立事件循环线程处理存储 I/O，与 vCPU 线程解耦
3. **IOThread Virtqueue Mapping**（QEMU 9.0+）：多个 IOThread 各处理不同 virtqueue

Windows 上的异步 I/O 层（`aio-win32.c`）使用 `WaitForMultipleObjects()`，限制 64 个并发 event handle。使用线程池处理阻塞文件 I/O。

### 2.5 许可证限制

QEMU 整体为 **GPLv2**（copyleft）：
- **不可**将代码复制到非 GPL 项目
- **可以**研究 API 使用模式并 clean-room 重新实现
- WHPX API 调用模式（如 `WHvRegisterInternalActivityState` / `clear_halt`）是 Microsoft API 用法，不受 QEMU 版权保护

---

## 3. crosvm Windows/WHPX 支持详细分析

### 3.1 概况

crosvm 是 Google 的 Rust VMM，用于 Chrome OS 和 Android。BSD-3 许可证，**允许商业使用和代码修改**。

- **Windows 支持**: 完整，WHPX + HAXM 两种后端
- **构建命令**: `cargo build --features all-msvc64,whpx`
- **注意**: Windows 支持未在上游 CI 测试，需下游自行验证
- **WHPX 代码位置**: `hypervisor/src/whpx/`（`vcpu.rs`, `vm.rs`, `types.rs`, `whpx_sys.rs`）

### 3.2 多 vCPU 模型

crosvm 使用 **thread-per-vCPU** 模型：

- 每个 vCPU 独立 OS 线程，各自的 run loop
- 每 vCPU 获得 `Bus` 结构的完整副本，地址查找无竞争
- 设备访问通过 `Bus` 获取 `BusDevice` 的 exclusive mutex lock
- `WaitContext` 抽象事件循环：Linux 用 epoll，**Windows 用 `WaitForMultipleObjects`**

### 3.3 Virtio 设备线程模型

**每个 virtio 设备都有独立 worker 线程**：

- `VirtioDevice` trait 的 `activate()` 方法不可阻塞
- 每个设备启动 worker 线程，接管 GuestMemory、Interrupt、queues 的所有权
- Worker 线程使用 `WaitContext`（Windows 下包装 `WaitForMultipleObjects`）做事件循环
- `Tube` 抽象替代 Unix domain socket 用于进程/线程间通信

### 3.4 Virtio-blk 异步 I/O

crosvm 有专用异步运行时 `cros_async`，支持平台特定后端：

| 平台 | 后端选项 | 说明 |
|------|---------|------|
| Linux | `uring` (io_uring), `epoll` | 默认 epoll |
| **Windows** | **`handle`**, **`overlapped`** | handle 用 WaitForMultipleObjects；overlapped 用 Windows Overlapped I/O |

Block 设备（`devices/src/virtio/block/asynchronous.rs`）使用 async/await + `cros_async::IoSource`，自动选择平台后端。

### 3.5 中断控制器 — WhpxSplitIrqChip

**这是 crosvm 最值得借鉴的部分之一**。

crosvm 实现了 `WhpxSplitIrqChip`（`devices/src/irqchip/whpx.rs`）：

| 组件 | 实现位置 |
|------|---------|
| **PIC** (8259) | 用户态（crosvm Rust 代码） |
| **IOAPIC** | 用户态（crosvm Rust 代码） |
| **LAPIC** | 委托给 WHPX 内核态 |
| **PIT** | 用户态（crosvm Rust 代码） |

关键实现细节：
- PIC 将 legacy 中断路由到 vCPU 0
- IOAPIC 使用 **delayed event queue** 防止锁争用死锁
- LAPIC 状态通过 `get_vcpu_lapic_state`/`set_vcpu_lapic_state` WHPX API 访问
- MSI (Message Signaled Interrupts) 通过 WHPX 递送到 LAPIC
- 实现 `IrqChip` 和 `IrqChipX86_64` trait

此外还有完全用户态的 `UserspaceIrqChip`（`userspace.rs`），在用户态模拟所有中断设备（PIC + IOAPIC + LAPIC + PIT），可与任何 hypervisor 配合。

### 3.6 Virtio-vsock — 纯用户态实现

**重要发现**: crosvm 的 virtio-vsock 在 Windows 上是**纯用户态实现**（因 Linux 上用 vhost-vsock 内核模块）。

这与 BoxLite 的情况完全匹配——在 Windows 上必须自己实现 vsock 而非依赖内核。crosvm 的实现可作为直接参考。

### 3.7 设备在 Windows 上的可用性

| 设备 | Linux | Windows | 说明 |
|------|:-----:|:-------:|------|
| block | Yes | **Yes** | 独立 worker 线程 + async I/O |
| console | Yes | **Yes** | 纯用户态 |
| net | Yes | **Yes** | 纯用户态 |
| rng | Yes | **Yes** | 纯用户态 |
| balloon | Yes | **Yes** | 纯用户态 |
| gpu | Yes | **Yes** | 用户态 |
| input | Yes | **Yes** | 用户态 |
| snd | Yes | **Yes** | 用户态 |
| **vsock** | vhost-vsock (内核) | **Yes (纯用户态)** | Windows 独有的用户态实现 |
| **fs (virtiofs)** | Yes | **No** | Linux/Android only |
| **p9** | Yes | **No** | Linux/Android only |

### 3.8 Windows 平台抽象层

crosvm 的 `base` crate 提供了 **31 个 Windows 专用抽象模块**：

```
base/src/sys/windows/
├── event.rs           # Windows Event 对象
├── timer.rs           # 定时器
├── mmap.rs            # 内存映射
├── wait.rs            # WaitForMultipleObjects 包装
├── tube.rs            # IPC 通信（替代 Unix socket）
├── named_pipes.rs     # 命名管道
├── stream_channel.rs  # 流式通信
├── descriptor.rs      # HANDLE 描述符
├── ...                # 其他 27 个模块
```

### 3.9 许可证

**BSD-3-Clause** — 非常宽松：
- 可商业使用
- 可修改和再分发
- 仅需保留版权声明
- 不可用 Google 名义为衍生产品背书

---

## 4. 其他 Rust VMM 项目

### 4.1 Microsoft OpenVMM

- **语言**: Rust，**许可证**: MIT
- 支持 Windows (WHPX)、Linux (KVM, MSHV)、macOS (Hypervisor.framework)
- 2,120 commits，活跃开发中
- 状态: **"work in progress, not ready for production use"**
- 聚焦 OpenHCL 机密计算 paravisor，与 BoxLite 场景不同
- 可参考其 WHPX 绑定和设备模型

### 4.2 Microsoft Hyperlight

- **语言**: Rust，**许可证**: Apache 2.0
- 支持 Windows (WHP)、Linux (KVM)、Azure Linux (MSHV)
- CNCF sandbox 项目，平均 0.9ms 启动
- **仅支持 function-level 隔离**（无 OS/内核在 guest 内），与 BoxLite 场景不同
- Hyperlight Nanvix (2026年1月) 加入 POSIX 支持

### 4.3 rust-vmm 生态 crate

| Crate | Windows 支持 | 说明 |
|-------|:----------:|------|
| **vm-memory** | **Yes** | 跨平台 guest 内存管理 |
| **virtio-queue** | **Yes** (平台无关) | 纯 virtqueue 逻辑 |
| **virtio-bindings** | **Yes** (仅常量) | virtio 规范自动生成绑定 |
| **vm-superio** | 可能 Yes | 串口模拟 |
| vhost | No | 需 Linux vhost 内核模块 |
| vhost-user-backend | No | vhost-user 协议 |
| kvm-ioctls | No | KVM 专用 |
| mshv-ioctls | No | Linux 上的 MSHV |

rust-vmm 正在进行 **monorepo 整合**（FOSDEM 2026 宣布），贡献者包括 AWS、Intel、Google、Microsoft、Red Hat、Alibaba、Linaro。

### 4.4 其他

- **Zero-Tang/whpx** crate：纯 Rust WHPX 绑定，支持 `no_std`，动态 DLL 加载，2026年4月更新，可作为 `windows-sys` 的替代

---

## 5. 逐项差距对照：谁能提供参考

基于 `windows-whpx-architecture-diff.md` 第 11 节识别的差距，逐项分析可借鉴来源：

### 差距 1：virtio-blk 独立 worker 线程

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | `block/asynchronous.rs` + `cros_async` Windows 后端 (`handle`/`overlapped`) | BSD-3 **Yes** | **最佳** |
| QEMU | IOThread 架构 + `aio-win32.c`（`WaitForMultipleObjects`） | GPLv2 仅参考 | 次选 |

**crosvm 方案**:
- 每个 block 设备有独立 worker 线程
- `cros_async::IoSource` 自动选择 Windows 异步后端
- Worker 线程通过 `WaitContext` 等待 virtqueue 事件和停止信号
- 完成后通过 interrupt transport 通知 vCPU

**迁移到 BoxLite 的路径**:
1. 在 `VirtioBlock` 的 `queue_notify` 中，将请求提交到 channel 而非同步处理
2. Worker 线程从 channel 取请求，执行 disk I/O，写 used ring，触发 IRQ
3. vCPU 循环在 `tick_and_poll` 中检查 worker 的完成事件

### 差距 2：多 vCPU

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | `hypervisor/src/whpx/vcpu.rs` + per-vCPU thread model | BSD-3 **Yes** | **最佳** |
| QEMU | `whpx-all.c` per-vCPU threading | GPLv2 仅参考 | 次选 |
| OpenVMM | WHPX multi-vCPU 支持 | MIT **Yes** | 可参考 |

**crosvm 方案**:
- 每 vCPU 一个 OS 线程，各自调用 `WHvRunVirtualProcessor`
- 每 vCPU 获得 `Bus` 副本，避免地址查找竞争
- 设备访问通过 Bus + exclusive mutex
- vCPU 间通过 `WaitContext` 事件同步

**迁移到 BoxLite 的路径**:
1. `run_vcpu_loop` 改为 per-vCPU 函数，创建 N 个线程
2. DeviceManager 需加 `Arc<Mutex<>>` 或改为 per-vCPU Bus 副本
3. PIC/IOAPIC 中断路由需区分目标 vCPU

### 差距 3：IOAPIC 替代 PIC

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | `WhpxSplitIrqChip` (Rust IOAPIC + LAPIC via WHPX) | BSD-3 **Yes** | **最佳** |
| **crosvm** | `UserspaceIrqChip` (全用户态 PIC+IOAPIC+LAPIC+PIT) | BSD-3 **Yes** | 备选 |
| QEMU | `whpx-apic.c` + kernel-irqchip=on | GPLv2 仅参考 | 次选 |

**crosvm 方案 — WhpxSplitIrqChip**:
- PIC (8259) + IOAPIC 在用户态 Rust 代码模拟
- LAPIC 委托给 WHPX 内核态（性能最优）
- MSI 通过 WHPX API 递送到 LAPIC
- 支持 24+ IRQ（IOAPIC），突破 PIC 15 IRQ 限制
- 实现 `IrqChip` 和 `IrqChipX86_64` trait，接口清晰

**这是最值得借鉴的组件**——BoxLite 当前的 PIC 实现可以直接对照 crosvm 的 `WhpxSplitIrqChip` 升级为 IOAPIC。

### 差距 4：virtio-balloon

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | `devices/src/virtio/balloon.rs`（跨平台） | BSD-3 **Yes** | **最佳** |
| QEMU | `hw/virtio/virtio-balloon.c`（纯用户态） | GPLv2 仅参考 | 次选 |

两者均为纯用户态实现，不依赖内核模块。crosvm 的 Rust 实现可直接参考。

### 差距 5：virtiofs 替代 9p

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| — | **无成熟实现** | — | — |

**重要发现**: **没有任何 VMM 在 Windows 宿主上支持 virtiofs 或 9p**：
- QEMU: virtiofs 需要 Linux FUSE，9p Windows patch 存在但未合入
- crosvm: virtiofs 和 9p 均为 Linux/Android only
- OpenVMM: 未知

这意味着 BoxLite 的 9p 实现实际上是**领先于所有竞品的**。如果要做 virtiofs，BoxLite 将是先行者，没有现成代码可借鉴，需要在 Windows 上实现 FUSE 协议处理或找到替代方案。

**务实建议**: 保持 9p，优化其性能（缓存、批量操作），而非追求 virtiofs。

### 差距 6：vsock 完善

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | 纯用户态 virtio-vsock（Windows 专用实现） | BSD-3 **Yes** | **最佳** |

**重要发现**: crosvm 的 vsock 在 Windows 上是**纯用户态实现**（Linux 上用 vhost-vsock 内核模块），这与 BoxLite 的情况完全匹配。可参考其实现来增强 BoxLite 的 vsock（加 muxer、stream/dgram 支持等）。

### 差距 7：virtio-rng / virtio-console

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | `devices/src/virtio/rng.rs` + `console.rs`（跨平台） | BSD-3 **Yes** | **最佳** |

均为纯用户态实现，无平台依赖。

### 差距 8：VMM 事件循环架构

| 参考来源 | 可借鉴内容 | 许可证兼容 | 推荐度 |
|---------|-----------|:---------:|:-----:|
| **crosvm** | `WaitContext` 抽象 + per-device worker thread 模型 | BSD-3 **Yes** | **最佳** |
| QEMU | EventLoop + IOThread 架构 | GPLv2 仅参考 | 次选 |

crosvm 的做法是每个设备独立 worker 线程 + `WaitContext`（Windows 下用 `WaitForMultipleObjects`），而非一个中心化事件循环。这个模式可以渐进式应用到 BoxLite：先给 blk 加 worker，再逐步扩展到 vsock、net。

---

## 6. 推荐借鉴策略

### 6.1 总体结论

**crosvm 是 BoxLite 改进 Windows WHPX 支持的最佳参考来源**：
- Rust 语言（与 BoxLite 匹配）
- BSD-3 许可证（可自由借鉴/复制代码）
- Production 级成熟度（Chrome OS、Android 生产环境使用）
- 完整的 WHPX 支持（多 vCPU、IOAPIC、async I/O、vsock）
- 全面的 Windows 平台抽象层（31 个模块）

### 6.2 各项改进的推荐路径

| 改进项 | 推荐来源 | 借鉴方式 | 预估复杂度 |
|--------|---------|---------|:---------:|
| **P0: async blk worker** | crosvm `block/asynchronous.rs` | 参考架构，适配 libkrun 的 VirtioBlock | 中 |
| **P1: 多 vCPU** | crosvm `whpx/vcpu.rs` + Bus 模型 | 参考线程模型，重构 runner.rs | 高 |
| **P1: IOAPIC** | crosvm `irqchip/whpx.rs` (WhpxSplitIrqChip) | **可直接参考 Rust 代码**，适配 libkrun trait | 高 |
| **P1: balloon** | crosvm `virtio/balloon.rs` | 参考实现，新增设备到 DeviceManager | 中 |
| **P2: vsock 增强** | crosvm 用户态 vsock | 参考 muxer/stream 实现，增强现有 TCP bridge | 中 |
| **P2: rng** | crosvm `virtio/rng.rs` | 简单设备，可快速实现 | 低 |
| **P2: console** | crosvm `virtio/console.rs` | 替代 Serial COM1 | 低 |
| **不建议: virtiofs** | 无可借鉴来源 | 保持 9p，优化性能 | — |

### 6.3 优先级重新评估

基于调研发现，原优先级列表调整如下：

| 优先级 | 改进项 | 调整 | 理由 |
|:------:|--------|------|------|
| P0 | async blk worker | 不变 | crosvm 有成熟参考，是解除重 I/O 限制的关键 |
| P1 | IOAPIC (WhpxSplitIrqChip) | **提升** | crosvm 有完整 Rust 实现可直接参考，且是多 vCPU 的前置依赖 |
| P1 | 多 vCPU | 不变 | crosvm 有参考，但依赖 IOAPIC 先完成 |
| P1 | balloon | 不变 | 简单设备，crosvm 有参考 |
| P2 | rng + console | **新增** | 工作量小，收益明确，crosvm 可直接参考 |
| ~~P2~~ | ~~virtiofs~~ | **移除** | 无任何 VMM 在 Windows 上实现，投入产出比极低 |
| P2 | 9p 性能优化 | **替代 virtiofs** | 保持现有方案，优化缓存和批量操作 |

### 6.4 成熟度预测（修正）

基于对生态的了解，修正预期：

```
                            ┌─────────────────────────────────────┐
  当前 Windows WHPX         │████████████░░░░░░░░░░░░░░░░░░░░░░░░│  ~35%
                            └─────────────────────────────────────┘
                            ┌─────────────────────────────────────┐
  + P0 (async blk)          │██████████████████░░░░░░░░░░░░░░░░░░│  ~50%
                            └─────────────────────────────────────┘
                            ┌─────────────────────────────────────┐
  + P1 (IOAPIC+多vCPU+bal.) │█████████████████████████████░░░░░░░│  ~80%
                            └─────────────────────────────────────┘
                            ┌─────────────────────────────────────┐
  + P2 (rng+console+vsock)  │████████████████████████████████░░░░│  ~88%
                            └─────────────────────────────────────┘
                            ┌─────────────────────────────────────┐
  macOS/Linux production    │█████████████████████████████████████│  100%
                            └─────────────────────────────────────┘
```

剩余 ~12% 差距来自：
- VMM 事件循环架构差异（单线程轮询 vs EventManager）— 需要更大规模重构
- virtiofs（Windows 上无成熟实现，QEMU/crosvm 均无，保持 9p）
- vhost 加速（仅 Linux 可用，Windows 无等价物）
- 上游代码不共享的长期维护成本

**88% 足以支撑 "Windows GA (General Availability)" 定位**，而非仅仅 beta。核心场景完全可用，已知限制清晰且合理（virtiofs 缺失是整个行业的现状，非 BoxLite 独有）。

---

## 附录 A：crosvm 关键源码路径

| 功能 | crosvm 源码路径 |
|------|----------------|
| WHPX hypervisor 绑定 | `hypervisor/src/whpx/` |
| WhpxSplitIrqChip | `devices/src/irqchip/whpx.rs` |
| UserspaceIrqChip | `devices/src/irqchip/userspace.rs` |
| IOAPIC | `devices/src/irqchip/ioapic.rs` |
| PIC (8259) | `devices/src/irqchip/pic.rs` |
| PIT | `devices/src/irqchip/pit.rs` |
| virtio-blk (async) | `devices/src/virtio/block/asynchronous.rs` |
| virtio-balloon | `devices/src/virtio/balloon.rs` |
| virtio-vsock | `devices/src/virtio/vsock/` |
| virtio-rng | `devices/src/virtio/rng/` |
| virtio-console | `devices/src/virtio/console/` |
| virtio-net | `devices/src/virtio/net/` |
| Windows async I/O | `cros_async/src/sys/windows/` |
| Windows 平台抽象 | `base/src/sys/windows/` (31 modules) |
| VirtioDevice trait | `devices/src/virtio/mod.rs` |

## 附录 B：参考链接

- [crosvm 官方文档](https://crosvm.dev/book/)
- [crosvm GitHub](https://github.com/google/crosvm) (BSD-3-Clause)
- [crosvm 架构概述](https://crosvm.dev/book/architecture/overview.html)
- [crosvm 中断架构](https://crosvm.dev/book/architecture/interrupts.html)
- [crosvm 设备列表](https://crosvm.dev/book/devices/index.html)
- [crosvm Windows 构建](https://crosvm.dev/book/building_crosvm/windows.html)
- [QEMU WHPX 文档](https://www.qemu.org/docs/master/system/whpx.html)
- [QEMU whpx-all.c 源码](https://github.com/qemu/qemu/blob/master/target/i386/whpx/whpx-all.c)
- [QEMU 11.0 Release Notes](https://www.qemu.org/2026/04/22/qemu-11-0-0/)
- [Microsoft OpenVMM](https://github.com/microsoft/openvmm) (MIT)
- [Microsoft Hyperlight](https://github.com/hyperlight-dev/hyperlight) (Apache 2.0)
- [rust-vmm 社区](https://github.com/rust-vmm/community)
- [FOSDEM 2026 rust-vmm talk](https://fosdem.org/2026/schedule/event/WEHLEY-rust-vmm_evolution_on_ecosystem_and_monorepo/)
