# Windows WHPX 支持：Function Ready → Production Ready 开发迭代计划

> **日期**: 2026-04-29 (updated)
> **初版日期**: 2026-04-28
> **参考文档**: `docs/windows-whpx-vmm-ecosystem-research.md`（生态调研）、`docs/windows-whpx-technical-differences.md`（技术差异）
> **当前分支**: `feat/windows-whpx-support`（42 commits ahead of main）

---

## 当前状态（Iter 1 已完成，成熟度 ~50%）

### 已完成

**核心 VMM（33 Rust 文件，~20,000 行）:**
- 单 vCPU WHPX 运行循环（`runner.rs`）
- PIC (8259) 中断控制器 + HLT wakeup + pending-interruption guard
- **异步 virtio-blk**（Plan B: worker 线程不接触 guest memory，vCPU 线程完成所有 guest mem 操作）
- virtio-net（gvproxy DLL，DELAYLOAD）
- vsock TCP bridge（gRPC host↔guest 通信，64KB buffer）
- ext4 root disk + 9p volume mounts
- Serial COM1 console 输出
- ACPI S5 graceful shutdown
- OCI image 管理（含 Unicode 文件名）

**平台集成:**
- Stop 优化（Win11 2,080ms→327ms，6.3x 提升）
- gvproxy DLL 构建 + DELAYLOAD
- CI: Windows compile + clippy + unit test workflow
- 构建脚本（cross-compile kernel/e2fsprogs/gvproxy）

### 核心指标

| 指标 | macOS (M5) | Win10 (MBP 2014) | Win11 (T14) |
|------|-----------|-------------------|-------------|
| E2E pass rate | 100% | **100%** (10/10) | **100%** (10/10) |
| unit tests | 636/636 | — | — |
| cold exec | 1,759ms | 1,726ms | ~617ms |
| warm exec | 1.4ms | 45ms | ~8ms |
| stop (no-net) | 2,076ms | ~413ms | ~327ms |
| async blk mode | N/A | **100%** (5/5) | **100%** (5/5) |

### 已知限制

1. **guest_init 网络强依赖**: `NetworkSpec` 默认 `Enabled`，无 gvproxy 时 guest_init 在 eth0 配置步骤失败，box 创建中止
2. **单 vCPU**: 无法利用多核
3. **PIC 限制**: 最多 15 IRQ，无法扩展设备
4. **无 balloon**: 无法动态调整内存
5. **无 virtio-rng**: guest 熵源不足（影响 crypto 和 SSH）
6. **Serial COM1**: 性能低于 virtio-console
7. **Raw ext4**: 不支持 COW，每次创建 box 需完整拷贝 rootfs

### 关键技术突破（本轮已完成）

- **Plan B 异步 blk worker**: worker 线程只做 disk I/O 到 `Vec<u8>`，所有 guest memory 读写在 vCPU 线程完成。解决 WHPX memory coherence 问题，实现 100% 可靠性
- **Pending-interruption guard**: 读 `WHvRegisterPendingInterruption` 再注入中断，防止 silent overwrite 导致 PIC ISR bit 永久 stuck
- **Spurious cascade guard**: PIC `acknowledge()` 只在 slave 有真实可交付 IRQ 时才 acknowledge master

---

## 迭代计划总览

```
Iter 1: Async Disk I/O              ✅ DONE         ~35% → ~50%
Iter 1.5: 当前功能 Production 打磨  [1-2 周]        ~50% → ~58%
Iter 2: IOAPIC + 中断架构升级       [3-4 周]        ~58% → ~68%
Iter 3: 多 vCPU                     [3-4 周]        ~68% → ~80%
Iter 4: Balloon + 辅助设备          [2-3 周]        ~80% → ~88%
Iter 5: 性能优化 + Production 打磨  [2-3 周]        ~88% → ~92%
                                              总计: ~11-16 周
```

---

## ~~Iteration 1: Async Disk I/O~~ ✅ DONE (2026-04-28)

**已完成**。采用 Plan B 方案（worker 线程不接触 guest memory），双平台 10/10 验证通过。

### 实现摘要

| 文件 | 变更 |
|------|------|
| `block_worker.rs` | Plan B worker: disk I/O → `Vec<u8>` buffer，不写 guest memory |
| `block.rs` | `drain_completions()`: vCPU 线程将 buffer 写入 guest memory |
| `manager.rs` | `tick_and_poll()` 轮询 blk completions → raise IRQ |
| `runner.rs` | pending-interruption guard + slave PIC diagnostics |
| `whpx.rs` | `has_pending_interruption()` 方法 |
| `pic.rs` | spurious cascade guard + `slave_state()` diagnostics |

### 验证结果

- [x] Win10 10/10 boot 成功 (5 sync + 5 async)
- [x] Win11 10/10 boot 成功 (5 sync + 5 async, gRPC 0-23ms)
- [x] macOS 636/636 unit tests 通过
- [x] clippy clean
- [ ] ~~`find /` 期间 gRPC 不死~~ → 移至 Iter 1.5
- [ ] ~~Playwright 镜像测试~~ → 移至 Iter 1.5

### 关键经验

- **WHPX guest memory 只能从 vCPU 线程修改**: 非 vCPU 线程通过 raw pointer 写 guest memory 导致 ~60% boot failure
- **`WHvRegisterPendingInterruption` 只能保存一个 pending 中断**: 覆写会丢失已 acknowledge 的中断，导致 PIC ISR bit 永久 stuck
- **`BOXLITE_SYNC_BLOCK=1`** 环境变量保留为 A/B 切换开关，方便回退诊断

---

## Iteration 1.5: 当前功能 Production 打磨

**目标**: 在进入重量级架构改动（IOAPIC/多vCPU）之前，确保当前功能集达到 production 可用状态

**成熟度**: ~50% → ~58%

### 1.5.1 Guest 网络 Graceful Degradation（高优先级）

**问题**: `NetworkSpec` 默认 `Enabled`，无 gvproxy 时 guest_init 尝试配置 eth0 → `No such device` → box 创建失败。

**影响**: 无网络模式完全不可用。用户必须显式传 `NetworkSpec::Disabled` 才能在无网络环境使用。

**方案选型**:

| 方案 | 描述 | 改动范围 |
|------|------|---------|
| A: Guest 端容错 | guest agent 的 `configure_network()` 检测到无 eth0 时 warn 而非 error | guest crate |
| B: Host 端检测 | 构建 `GuestInitConfig` 时，如果 VMM 没有配置 virtio-net 设备，自动跳过 network init | boxlite crate |
| C: 两端都做 | B 为主（不发送 network init），A 为防御（guest 也容错） | 两个 crate |

**推荐方案 C**（defense-in-depth），但由于本分支 scope 限于 Windows WHPX，优先做方案 B（host 端检测），方案 A 涉及 guest 代码变更，需评估对 macOS/Linux 的影响。

### 1.5.2 Heavy I/O + gRPC 存活验证

验证异步 blk worker 是否真正解决了 "disk I/O starves vsock" 问题：

| 测试 | 命令 | 验证标准 |
|------|------|---------|
| ext4 遍历 | `find / -xdev -type f \| wc -l` | gRPC 不超时 |
| 大文件写 | `dd if=/dev/zero of=/tmp/big bs=1M count=100` | gRPC 存活 |
| 并发 I/O | `find / & echo hello` | exec 正常返回 |

### 1.5.3 Win11 Gvproxy 网络验证

Win10 gvproxy DLL 网络已验证 8/8 PASS。需在 Win11 上完成同等验证：
- DLL 拷贝 + DELAYLOAD 正常
- 8 项网络测试通过（curl、DNS、ping 等）

### 1.5.4 Async + 有网络 场景 E2E

已验证：async + 无网络。需验证：async + gvproxy 网络：
- vm-bench.py 全 8 phases 通过
- 无 flakiness

### 1.5.5 构建脚本 + CI 提交

当前 untracked 但已在使用的文件：

| 文件 | 用途 |
|------|------|
| `scripts/build/build-initrd-windows.sh` | 构建 Windows initrd |
| `scripts/build/build-windows-runtime.sh` | 构建完整 Windows runtime |
| `scripts/build/cross-compile-e2fsprogs-windows.sh` | 交叉编译 e2fsprogs |
| `scripts/build/cross-compile-gvproxy-windows.sh` | 交叉编译 gvproxy DLL |
| `scripts/build/cross-compile-kernel-windows.sh` | 交叉编译 Linux kernel |
| `.github/workflows/test-windows-e2e.yml` | Windows CI workflow |

### 验证标准

- [ ] 无网络模式下 box 创建+exec 成功（不报 eth0 错误）
- [ ] `find /` 期间 gRPC 存活
- [ ] Win11 gvproxy 网络 8/8 PASS
- [ ] async + 有网络 vm-bench 8 phases PASS（Win10 + Win11）
- [ ] 构建脚本 + CI workflow 已提交

---

## Iteration 2: IOAPIC + 中断架构升级

**目标**: 从 PIC (8259) 升级到 IOAPIC，支持 24+ IRQ，为多 vCPU 做前置准备

**成熟度**: ~58% → ~68%

**前置依赖**: Iter 1.5 完成（当前功能稳定）

### 背景

当前 PIC (8259) 限制：
- 最多 15 个 IRQ（master 8 + slave 7，IRQ2 级联）
- 只能路由中断到 vCPU 0（无法支持多 vCPU SMP）
- edge-triggered only（某些设备需要 level-triggered）

IOAPIC 优势：
- 24 个 IRQ entry
- 可路由中断到任意 vCPU（SMP 必需）
- 支持 edge 和 level triggered
- MSI (Message Signaled Interrupts) 支持

### 架构设计（参考 crosvm WhpxSplitIrqChip）

```
┌─────────────────────────────────────────────┐
│  用户态（BoxLite/libkrun Rust 代码）        │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ PIC 8259│  │  IOAPIC  │  │   PIT     │  │
│  │ (legacy)│  │ (24 IRQ) │  │ (timer)   │  │
│  └────┬────┘  └────┬─────┘  └───────────┘  │
│       │            │                         │
│       └─────┬──────┘                         │
│             │ IRQ → vector                   │
│             ▼                                │
│  ┌──────────────────┐                       │
│  │   IRQ Router     │                       │
│  │  (WhpxSplitIrq)  │                       │
│  └────────┬─────────┘                       │
│           │ inject_interrupt(vector)         │
│           ▼                                  │
│  ┌──────────────────┐                       │
│  │  WHPX 内核态     │                       │
│  │  LAPIC (per-vCPU)│                       │
│  └──────────────────┘                       │
└─────────────────────────────────────────────┘
```

### 实施步骤

1. **新增 `ioapic.rs`**: 24 entry redirect table, level/edge trigger, mask/unmask
   - 参考 crosvm `devices/src/irqchip/ioapic.rs`（BSD-3）
   - 实现 MMIO 接口（base address 0xFEC00000）

2. **新增 `irq_chip.rs`**: WhpxSplitIrqChip trait 及实现
   - PIC + IOAPIC 路由逻辑
   - LAPIC 交互通过 WHPX API (`WHvGetVirtualProcessorRegisters` LAPIC 区域)
   - MSI 递送

3. **修改 `manager.rs`**: 将当前 `Pic` 替换为 `IrqChip`
   - IRQ 分配: 0-15 保持 PIC 兼容，16-23 IOAPIC 专用
   - `raise_irq()` 路由到正确的控制器

4. **修改 `runner.rs`**: 中断注入改用 IrqChip 接口
   - 移除直接 PIC 操作
   - interrupt window 请求改由 IrqChip 管理

5. **ACPI table 更新**: MADT 中声明 IOAPIC
   - 现有 `acpi.rs` 添加 IOAPIC entry + Local APIC entry

6. **保持向后兼容**: 单 vCPU 下 PIC 仍可工作（legacy mode）

### 验证标准

- [ ] Win10/Win11 10/10 boot 成功
- [ ] PIC legacy 中断仍正常（timer, serial, keyboard）
- [ ] IOAPIC 中断路由正确（新设备可用 IRQ 16+）
- [ ] macOS 全部 unit tests 通过
- [ ] `cat /proc/interrupts` 显示 IOAPIC 条目

### 参考资源

- crosvm: `devices/src/irqchip/whpx.rs` (WhpxSplitIrqChip)
- crosvm: `devices/src/irqchip/ioapic.rs`
- crosvm: `devices/src/irqchip/pic.rs`
- Intel IOAPIC spec (82093AA datasheet)

---

## Iteration 3: 多 vCPU

**目标**: 支持 2-4 vCPU SMP，解锁多核性能

**成熟度**: ~68% → ~80%

**前置依赖**: Iter 2 (IOAPIC) 必须完成

### 架构设计

```
┌───────────────────────────────────────────────┐
│  Main Thread                                  │
│  ├─ create WHV partition                      │
│  ├─ setup memory                              │
│  ├─ create devices (DeviceManager)            │
│  ├─ spawn N vCPU threads                      │
│  └─ wait for all threads                      │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ vCPU 0   │  │ vCPU 1   │  │ vCPU N   │   │
│  │ thread   │  │ thread   │  │ thread   │   │
│  │ run loop │  │ run loop │  │ run loop │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       └──────────────┼──────────────┘         │
│                      ▼                         │
│  ┌────────────────────────────────────┐       │
│  │  Arc<Mutex<DeviceManager>>         │       │
│  │  或 per-vCPU Bus clone             │       │
│  └────────────────────────────────────┘       │
└───────────────────────────────────────────────┘
```

### 实施步骤

1. **修改 `whpx.rs`**: 支持创建多个 vCPU
   - `WHvCreateVirtualProcessor` per vCPU
   - BSP (vCPU 0) vs AP (vCPU 1+) 初始化差异

2. **修改 `runner.rs`**: per-vCPU thread 模型
   - `run_vcpu_loop()` 改为接受 `vcpu_id: u32` 参数
   - main thread spawn N 个 vCPU threads

3. **修改 `manager.rs`**: 设备并发访问
   - `DeviceManager` 加 `Arc<Mutex<>>` 保护
   - 或采用 crosvm Bus 模型

4. **修改 `irq_chip.rs`**: 多 vCPU 中断路由
   - IOAPIC destination field 路由到目标 vCPU

5. **ACPI table**: MADT 声明多 processor

6. **SMP 启动协议**: AP bootstrap (INIT-SIPI-SIPI)

### 验证标准

- [ ] `nproc` 返回配置的 vCPU 数
- [ ] 多核编译 (`make -j4`) 比单核快
- [ ] SMP 下 boot 成功率 100% (10/10)
- [ ] macOS unit tests 全部通过

### 参考资源

- crosvm: `hypervisor/src/whpx/vcpu.rs`
- crosvm: `src/crosvm/sys/unix/vcpu.rs` (thread management)

---

## Iteration 4: Balloon + 辅助设备

**目标**: 完成常用 virtio 设备集，提升 guest 体验

**成熟度**: ~80% → ~88%

**前置依赖**: Iter 2 (IOAPIC, 需要额外 IRQ)

### 4.1 virtio-balloon

动态内存管理，允许 host 回收 guest 未使用内存。

- 新增 `devices/virtio/balloon.rs`
- inflate/deflate 队列处理
- 参考 crosvm `virtio/balloon.rs`（BSD-3）

### 4.2 virtio-rng

Guest 高质量随机数源。实现简单（crosvm < 200 行）。

- 新增 `devices/virtio/rng.rs`
- 从 host `CryptGenRandom` (Windows) 读取随机数
- 提升 SSH key generation 速度

### 4.3 virtio-console

替代 Serial COM1，性能更高。

- 新增 `devices/virtio/console.rs`
- tx/rx 队列 + control 队列
- 保留 Serial COM1 作为 early boot 输出

### 4.4 vsock 增强

增强现有 vsock TCP bridge。

- 参考 crosvm 纯用户态 vsock 实现
- 支持 stream + datagram
- 连接超时和重连机制

---

## Iteration 5: 性能优化 + Production 打磨

**目标**: 性能优化，错误处理完善，达到 GA 质量

**成熟度**: ~88% → ~92%

### 5.1 性能优化

| 优化点 | 当前值 | 目标值 | 方法 |
|--------|--------|--------|------|
| warm exec | 45ms (Win10) | <20ms | vsock 连接复用，减少 TCP 开销 |
| cold exec | 1,726ms (Win10) | <1,200ms | 延迟加载非必要设备 |
| 9p 大文件 | 慢 | 2x 提升 | 9p readdir 批量，readahead cache |

### 5.2 错误处理与恢复

1. graceful degradation: 设备初始化失败不崩溃，禁用该设备继续
2. 超时机制: 所有 WHPX API 调用加超时保护
3. crash recovery: shim 异常退出后清理残留资源
4. 诊断日志: 结构化日志，性能指标上报

### 5.3 测试覆盖

1. CI 集成: Windows compile + clippy + unit test workflow（已有）
2. E2E 自动化: GitHub Actions self-hosted Windows runner
3. 压力测试: 并发 VM 创建/销毁，内存压力
4. 兼容性: Win10 + Win11 + Server 2019+ 验证

### 5.4 文档

1. Windows 安装/使用指南
2. WHPX 已知限制说明
3. 性能调优建议
4. troubleshooting 指南

---

## 依赖关系图

```
Iter 1:   Async Disk I/O ────────── ✅ DONE ────────────────┐
                                                              │
Iter 1.5: Production 打磨 ──────────────────────────────────┤
                                                              │
Iter 2:   IOAPIC ──────┬─────────────────────────────────────┤
                       │                                      │
                       ▼                                      │
Iter 3:   Multi-vCPU   │                                     │
                       │                                      │
                       ▼                                      ▼
Iter 4:   Balloon + Devices (需要 Iter 2 的 IOAPIC IRQ)      │
                       │                                      │
                       ▼                                      │
Iter 5:   Performance + Polish ◄──────────────────────────────┘
```

**并行可能性**:
- Iter 1.5 和 Iter 2 **可部分并行**（1.5 偏验证，2 偏开发）
- Iter 3 **必须等** Iter 2 完成
- Iter 4.1-4.4 **可并行**
- Iter 5 最后执行

---

## 风险与缓解

| 风险 | 影响 | 概率 | 缓解策略 |
|------|------|------|----------|
| ~~方案 B (worker 不写 guest mem) coherence 问题~~ | ~~Iter 1 延期~~ | ~~低~~ | ✅ 已解决，100% 可靠 |
| guest_init 网络容错改动影响 macOS/Linux | Iter 1.5 延期 | 低 | Host 端检测为主（不改 guest），方案 B 最小改动 |
| IOAPIC 实现复杂度超预期 | Iter 2 延期 | 中 | 先实现最小可用版本（仅 level-triggered），逐步完善 |
| 多 vCPU SMP 启动不稳定 | Iter 3 延期 | 中 | 先 2 vCPU 验证，再扩展 |
| Win10 vs Win11 WHPX 行为差异 | 全程 | 中 | 每个 Iter 都双平台验证 |
| APIC emulation 在老硬件崩溃 | Iter 2-3 | 低 | 保持 UserspaceIrqChip 作为 fallback |

---

## 成熟度路线图

```
                          ┌──────────────────────────────────────┐
 Iter 1 (DONE)            │██████████████████░░░░░░░░░░░░░░░░░░░│  ~50%
                          └──────────────────────────────────────┘
                          ┌──────────────────────────────────────┐
 + Iter 1.5 (Polish)      │█████████████████████░░░░░░░░░░░░░░░░│  ~58%
                          └──────────────────────────────────────┘
                          ┌──────────────────────────────────────┐
 + Iter 2 (IOAPIC)        │████████████████████████░░░░░░░░░░░░░│  ~68%
                          └──────────────────────────────────────┘
                          ┌──────────────────────────────────────┐
 + Iter 3 (Multi-vCPU)    │████████████████████████████░░░░░░░░░│  ~80%
                          └──────────────────────────────────────┘
                          ┌──────────────────────────────────────┐
 + Iter 4 (Devices)       │████████████████████████████████░░░░░│  ~88%
                          └──────────────────────────────────────┘
                          ┌──────────────────────────────────────┐
 + Iter 5 (Polish)        │█████████████████████████████████░░░░│  ~92%
                          └──────────────────────────────────────┘
                          ┌──────────────────────────────────────┐
 macOS/Linux Production   │█████████████████████████████████████│  100%
                          └──────────────────────────────────────┘
```

剩余 ~8% 差距来自:
- VMM 事件循环架构差异（单线程轮询 vs EventManager）— 需大规模重构
- virtiofs 缺失（整个行业在 Windows 上均无实现，QEMU/crosvm 均不支持）
- vhost 加速（仅 Linux 可用）
- 与 macOS/Linux 共享上游代码的长期维护成本

**92% 足以支撑 Windows GA (General Availability)**，核心场景完全可用，已知限制清晰且合理。

---

## Iteration 1.5 详细任务分解（即时可执行）

### Week 1: 网络容错 + Heavy I/O 验证

| # | 任务 | 产出 |
|---|------|------|
| 1.1 | Guest 网络 graceful degradation: host 端检测无 virtio-net 时跳过 network init | 代码 + 测试 |
| 1.2 | 无网络模式 E2E: Win10 + Win11 各 5 次 `exec echo hello` 成功 | 10/10 PASS |
| 1.3 | Heavy I/O 验证: `find /`, `dd`, 并发 I/O 期间 gRPC 存活 | 报告 |
| 1.4 | Win11 gvproxy 网络验证: 8 项网络测试通过 | 8/8 PASS |

### Week 2: Async + 网络 + 收尾

| # | 任务 | 产出 |
|---|------|------|
| 2.1 | Async + gvproxy: vm-bench 8 phases (Win10) | 报告 |
| 2.2 | Async + gvproxy: vm-bench 8 phases (Win11) | 报告 |
| 2.3 | 构建脚本提交 (scripts/build/*-windows*.sh) | commit |
| 2.4 | CI workflow 提交 (test-windows-e2e.yml) | commit |
| 2.5 | 更新 MEMORY.md + 文档 | — |

---

## WHPX 关键技术经验（附录）

本轮开发积累的 WHPX 平台核心经验，供后续迭代参考：

| 经验 | 说明 |
|------|------|
| Guest memory 只能从 vCPU 线程修改 | 非 vCPU 线程通过 raw pointer 写 guest memory 导致 WHPX 内存追踪不一致，~60% boot failure |
| `WHvRegisterPendingInterruption` 只能保存一个 | 覆写会丢失已 acknowledge 的中断，PIC ISR bit 永久 stuck |
| `WHV_REGISTER_VALUE` 数组必须堆分配 | 栈分配导致 WHPX 读取错误值 |
| `WHV_PARTITION_HANDLE` 是 `isize` | 用 `0` 不是 `ptr::null_mut()` |
| `WHV_RUN_VP_EXIT_REASON` 是 `i32` | 用 if/else 不是 match |
| APIC emulation 在 Win10 MBP 2014 崩溃 | 老硬件的 WHPX 实现有 bug |
| `RUST_LOG=debug` 杀死 WHPX 网络 | 日志量太大拖慢 vCPU 循环，vsock 超时 |

---

## 参考资源汇总

| 用途 | crosvm 源码路径 |
|------|----------------|
| WHPX hypervisor 绑定 | `hypervisor/src/whpx/` |
| WhpxSplitIrqChip | `devices/src/irqchip/whpx.rs` |
| IOAPIC | `devices/src/irqchip/ioapic.rs` |
| virtio-blk (async) | `devices/src/virtio/block/asynchronous.rs` |
| Windows async I/O | `cros_async/src/sys/windows/` |
| virtio-balloon | `devices/src/virtio/balloon.rs` |
| virtio-vsock | `devices/src/virtio/vsock/` |
| virtio-rng | `devices/src/virtio/rng/` |
| virtio-console | `devices/src/virtio/console/` |
| Windows 平台抽象 | `base/src/sys/windows/` (31 modules) |

**crosvm 仓库**: https://github.com/google/crosvm (BSD-3-Clause)
