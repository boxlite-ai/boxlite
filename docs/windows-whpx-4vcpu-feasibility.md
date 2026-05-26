# Windows WHPX 4+ vCPU 支持可行性分析

## 1. 问题定义

### 1.1 现象

在 Win11 (T14, i5-1135G7) 上将 vCPU 数从 2 提升到 4 后：
- vm-bench 偶尔通过（cold exec 47s vs 正常 2.4s）
- net-test 连续失败（VM 启动挂死，空 console log）
- **失败率约 50%**

### 1.2 根因链条

```
Linux 内核 SMP timer calibration
  → 4 个 vCPU 同时 busy-loop 读 LAPIC CCR (offset 0x390)
    → 每次读需要 MMIO exit → vCPU 线程处理
      → Per-LAPIC locking 已解决 LAPIC 读本身的竞争 ✓
        → 但 BSP 的 tick_and_poll() 仍需锁 DeviceManager
          → 竞争点: AP 的 IoOut/MmioWrite 也需要 DeviceManager 锁
            → BSP 被饿死 → block I/O completions 无法排出
              → 内核挂死（无法完成 rootfs 初始化）
```

### 1.3 已有优化

| 优化 | 状态 | 效果 |
|------|------|------|
| Per-vCPU LAPIC `Arc<Mutex<>>` | 已实现 | 消除了 LAPIC MMIO 读写的跨 vCPU 竞争 |
| LAPIC 快速路径（绕过 DeviceManager） | 已实现 | 读全量 + 5 个写寄存器无需锁 DeviceManager |
| HLT tiered sleep | 已实现 | 减少 HLT 期间的锁竞争 |
| LAPIC timer tick 节流 | 已实现 | <500µs 不 tick，减少锁持有时间 |

**结论**：LAPIC 层面的竞争已基本消除，瓶颈在 DeviceManager 锁的其他持有者。

---

## 2. 锁竞争热力图

### 2.1 tick_and_poll() 锁内操作分解

BSP 每次循环迭代都执行 `tick_and_poll()`，锁持有期间的操作：

| 操作 | 耗时 | 访问 guest memory | 能否解耦 |
|------|------|-------------------|----------|
| PIT tick + raise_irq | ~1µs | 否 | 可以，但收益极小 |
| LAPIC timer tick (all vCPUs) | ~10-50µs | 否 | **已解耦**（per-LAPIC lock） |
| Block I/O completion drain | **1-10ms** | **是** | **核心瓶颈** |
| Vsock poll | 0-1ms | 是 | 可以 |
| Net poll | 0-1ms | 是 | 可以 |

### 2.2 其他锁持有者

| 调用点 | 线程 | 频率 | 锁内操作 |
|--------|------|------|----------|
| BSP top-of-loop | BSP | 每次迭代 | tick_and_poll + try_inject |
| BSP IoOut/IoIn | BSP | I/O port 访问 | handle_io_out/in |
| BSP MmioWrite (slow path) | BSP | EOI/SVR/ICR | handle_mmio_write + dispatch_ipi |
| BSP HLT 轮询 | BSP | HLT 期间每 10 次 yield | tick_and_poll |
| AP IoOut/IoIn | AP×N | I/O port 访问 | handle_io_out/in |
| AP MmioWrite (slow path) | AP×N | EOI/SVR/ICR | handle_mmio_write |

### 2.3 真正的瓶颈

**Block I/O completion drain** 是唯一耗时超过 1ms 的操作。其他操作都在微秒级别。

4 vCPU 挂死的时序：
```
时间   BSP                           AP0          AP1          AP2
0ms    lock(DM)                     [SMP calib]  [SMP calib]  [SMP calib]
       tick_and_poll():
         pit.tick()                  IoOut →
         lapic tick (all)            wait(DM)...
         blk drain (3 completions)               MmioWrite →
         vsock poll                              wait(DM)...  IoOut →
         net poll                                             wait(DM)...
2ms    try_inject()
       unlock(DM)
       vcpu.run()
                                     lock(DM)     wait...      wait...
                                     io_out()
                                     unlock(DM)
                                                  lock(DM)     wait...
                                                  mmio_write()
                                                  unlock(DM)
                                                               lock(DM)
3ms    [需要 vcpu exit]                                         io_out()
       MmioWrite → wait(DM)...                                unlock(DM)
4ms    lock(DM)
       tick_and_poll()...    ← 如果 AP 同时也需要 DM，BSP 可能抢不到
```

当 4 个 vCPU 都在 SMP calibration 阶段高频 MMIO 操作时，BSP 的 `tick_and_poll()` 被推迟 → block I/O completions 积压 → 内核 rootfs mount 超时。

---

## 3. 业界方案对比

### 3.1 KVM 生态（crosvm / Firecracker / QEMU）

| 机制 | 说明 | WHPX 等价物 |
|------|------|-------------|
| **ioeventfd** | Guest 写 QUEUE_NOTIFY → KVM 内核直接 signal eventfd，**无 VM exit** | **无**。每次 MMIO 写都产生 exit |
| **irqfd** | 设备线程写 eventfd → KVM 内核直接注入中断到 LAPIC，**无需 vCPU 参与** | **无**。必须 `WHvCancelRun` + 设置寄存器 |
| **Per-device worker thread** | 每个 virtio 设备独立线程，拥有 Queue 和 GuestMemory | 部分实现（block worker 只做磁盘 I/O） |
| **Used ring 无锁更新** | 只有 worker 线程写 used ring，guest 只读，内存屏障同步 | 受限（guest memory 写必须在 vCPU 线程） |

**关键差异**：KVM 生态的 virtio 数据面（data plane）**完全在内核或独立线程中运行**，vCPU 线程不参与 I/O 完成处理。WHPX 没有这些机制，所有 I/O 完成必须经过 vCPU 线程。

### 3.2 WHPX 的根本限制

1. **无 ioeventfd**：每次 guest 写 QUEUE_NOTIFY 都产生完整 VM exit
2. **无 irqfd**：中断注入必须通过 vCPU 线程（`WHvSetVirtualProcessorRegisters`）
3. **Guest memory 写的安全约束**：从非 vCPU 线程写 guest memory 在 WHPX 下有约 60% 的启动失败率（已验证），因此当前设计强制所有 guest memory 写在 vCPU 线程执行
4. **`WHvCancelRunVirtualProcessor`**：可从任意线程调用，但只能让 vCPU 退出，不能注入中断

---

## 4. 方案评估

### 方案 A：拆分 tick_and_poll() — 分离 device polling 和 IRQ routing

**思路**：将 `tick_and_poll()` 拆分为两步：
1. **不持锁的 device polling**（try_recv completions，收集待处理事件）
2. **短暂持锁的 IRQ routing + guest memory 写**（raise_irq + drain）

**实现**：
```rust
// Step 1: 不持锁 — 从 completion channel 收集完成事件
let blk_completions: Vec<BlockCompletion> = {
    // completion_rx 可以通过 Arc<Mutex<Receiver>> 或移出 DeviceManager
    blk_completion_rx.try_iter().collect()
};

// Step 2: 短暂持锁 — 写 guest memory + raise IRQ
if !blk_completions.is_empty() {
    let mut dm = devices.lock().unwrap();
    for comp in blk_completions {
        // 写 guest memory（scatter read data, status, used ring）
        dm.apply_block_completion(comp, guest_mem);
    }
    dm.irq_chip.raise_irq(irq_for_slot(0));
}
```

**优点**：
- 改动最小，只需将 `completion_rx` 移出 DeviceManager
- 锁持有时间从 "channel drain + guest write + IRQ" 缩短为 "guest write + IRQ"
- 不需要修改 worker 线程

**缺点**：
- 锁持有时间缩短有限 — guest memory 写和 IRQ routing 仍在锁内
- Vsock/Net polling 仍在锁内（它们也写 guest memory）
- **收益有限**：channel try_recv 本身很快（<1µs），真正的时间在 guest memory 写

**预期效果**：锁持有时间从 ~5ms 降到 ~3ms。**不够**。

**可行性**：⭐⭐（容易实现但收益不足）

---

### 方案 B：Per-Device 细粒度锁

**思路**：将 DeviceManager 中的每个设备用独立的 `Arc<Mutex<>>` 包装：
```rust
struct DeviceManager {
    pit: Mutex<Pit>,
    irq_chip: Mutex<IrqChip>,          // 或进一步拆分
    virtio_blk: Mutex<Option<VirtioMmio<VirtioBlock>>>,
    virtio_vsock: Mutex<VirtioMmio<VirtioVsock>>,
    virtio_net: Mutex<Option<VirtioMmio<VirtioNet>>>,
    // ...
}
```

**优点**：
- BSP 可以只锁 block 设备 drain completions，不影响 AP 操作其他设备
- AP 的 IoOut（serial/PIT）不阻塞 BSP 的 block drain

**缺点**：
- **死锁风险高**：`raise_irq()` 需要 `&mut IrqChip`，而 IrqChip 内部还要锁 LAPIC。多个设备可能同时 raise_irq → 需要严格的锁序
- **MMIO dispatch 需要知道地址映射** → 需要共享的路由表
- **大量代码重构**：`handle_mmio_read/write`、`handle_io_in/out` 都需要改造
- **IRQ routing 共享状态**：IOAPIC 的 redirection table 是多个设备共享的

**死锁示例**：
```
BSP: lock(blk) → blk.drain() → need raise_irq() → lock(irq_chip) ✓
AP:  lock(irq_chip) → raise_irq() → need lock(lapic[0]) → DEADLOCK?
```

**预期效果**：如果实现正确，锁竞争大幅降低。但实现复杂度极高。

**可行性**：⭐⭐（理论可行，工程风险高，ROI 低）

---

### 方案 C：BSP 专用 Polling 线程（Dedicated I/O Thread）

**思路**：参考 QEMU IOThread 模式，创建一个专用线程负责所有 device polling：

```rust
// I/O Thread（独立于所有 vCPU）
fn io_thread(devices: Arc<Mutex<DeviceManager>>, guest_mem: &GuestMemory) {
    loop {
        // 短暂持锁：drain completions + poll devices + raise IRQs
        {
            let mut dm = devices.lock().unwrap();
            dm.tick_and_poll(0, guest_mem);
        }
        // 立即释放锁
        std::thread::sleep(Duration::from_micros(500));
    }
}

// BSP 不再调用 tick_and_poll()，只处理 exit
loop {
    // 不需要 tick_and_poll
    let exit = vcpu.run();
    match exit {
        // 只处理 MMIO/IO exit，不做 device polling
    }
}
```

**优点**：
- BSP 不再承担 device polling 职责
- I/O 线程可以高频轮询，不受 vCPU exit 节奏影响
- BSP 和 AP 只在处理 MMIO/IO exit 时需要锁

**缺点**：
- **Guest memory 写安全问题**：I/O thread 不是 vCPU 线程，从非 vCPU 线程写 guest memory 在 WHPX 下有约 60% 的启动失败率
- 即使使用 `WHvMapGpaRange` 映射为通用内存，WHPX 内部的 TLB 管理可能导致 race condition
- 新增线程增加调度复杂度

**关键阻碍**：**guest memory 写必须在 vCPU 线程**（WHPX 硬限制）。这使得方案 C 不可行，除非 guest memory 写也通过消息传递回 vCPU 线程 — 这又退化为方案 D。

**可行性**：⭐（WHPX guest memory 限制阻碍）

---

### 方案 D：Completion Queue + vCPU 自服务（推荐方案）

**思路**：将 device polling 的"检测"和"执行"分离：
- 一个轻量级 I/O thread 负责检测 completions（不写 guest memory）
- 将待处理事件推入 lock-free queue
- 每个 vCPU 在合适时机自行消费 queue 中的事件（写 guest memory + raise IRQ）

```
                     ┌──────────────┐
                     │  Block Worker│ ── disk I/O
                     └──────┬───────┘
                            │ mpsc::channel (completions)
                     ┌──────▼───────┐
                     │  I/O Monitor │ ── try_recv(), 不写 guest memory
                     │  Thread      │    只做 channel drain
                     └──────┬───────┘
                            │ crossbeam::ArrayQueue (lock-free)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌─────────┐  ┌─────────┐  ┌─────────┐
         │ BSP     │  │ AP0     │  │ AP1     │
         │ vCPU    │  │ vCPU    │  │ vCPU    │
         └─────────┘  └─────────┘  └─────────┘
         每个 vCPU 在 top-of-loop 或 HLT 时：
         1. 从 lock-free queue pop 事件（无锁）
         2. 写 guest memory（vCPU 线程，安全）
         3. 短暂锁 DeviceManager: raise_irq()
```

**实现细节**：

```rust
// 共享的 lock-free completion queue
use crossbeam::queue::ArrayQueue;

struct CompletionEvent {
    device_slot: u8,  // 哪个设备
    read_data: Option<Vec<u8>>,
    read_targets: Vec<BufferDesc>,
    status_addr: u64,
    status: u8,
    head_index: u16,
    bytes_written: u32,
}

// I/O Monitor 线程 — 不写 guest memory
fn io_monitor(
    blk_rx: Receiver<BlockCompletion>,
    completion_queue: Arc<ArrayQueue<CompletionEvent>>,
) {
    loop {
        // 非阻塞 drain block completions
        while let Ok(comp) = blk_rx.try_recv() {
            let event = CompletionEvent::from_block(comp);
            let _ = completion_queue.push(event);
        }
        // TODO: 也可以 drain vsock/net 的 host-side events
        std::thread::sleep(Duration::from_micros(100));
    }
}

// vCPU 线程 — 在合适时机 self-service
fn process_completions(
    completion_queue: &ArrayQueue<CompletionEvent>,
    dm: &mut DeviceManager,  // 已持锁
    guest_mem: &dyn GuestMemoryAccessor,
) {
    while let Some(event) = completion_queue.pop() {
        // 写 guest memory（安全：在 vCPU 线程）
        apply_completion_to_guest(event, guest_mem);
        // raise IRQ（已持锁）
        dm.irq_chip.raise_irq(irq_for_slot(event.device_slot));
    }
}
```

**优点**：
- **消除了 completion channel drain 的锁内等待**：try_recv 在 I/O monitor 线程，不持 DeviceManager 锁
- **vCPU 自服务**：任何 vCPU（不仅 BSP）都可以处理 completions，负载分散
- **符合 WHPX 约束**：guest memory 写始终在 vCPU 线程
- **Lock-free queue**（crossbeam ArrayQueue）：pop/push 是 wait-free O(1)
- **增量修改**：不需要重构整个 DeviceManager

**缺点**：
- 新增 I/O monitor 线程 + crossbeam 依赖
- completion 处理延迟增加一跳（monitor 线程的 sleep interval）
- raise_irq 仍需锁 DeviceManager — 但持有时间从 ms 级降到 µs 级
- Vsock/Net polling 仍需要在 vCPU 线程做（它们的 poll() 直接写 guest memory）

**预期效果**：
- BSP top-of-loop 的锁持有时间从 ~5ms 降到 ~50µs（只剩 PIT tick + raise_irq）
- Block I/O completion 的 guest memory 写分散到所有 vCPU
- SMP calibration 期间 BSP 不再被饿死

**可行性**：⭐⭐⭐⭐（推荐，改动可控，收益明确）

---

### 方案 E：Vsock/Net 也走 Completion Queue

**思路**：方案 D 的扩展。将 Vsock/Net 的 host-side polling 也移到 I/O monitor 线程：

```
I/O Monitor:
  - drain block completions
  - try_read vsock TCP streams → 将数据包装为 VsockRxEvent
  - try_read net socket → 将帧包装为 NetRxEvent
  - 全部推入 lock-free queue
```

**优点**：
- tick_and_poll() 彻底退化为只做 PIT tick（~1µs）
- DeviceManager 锁持有时间从 ~5ms 降到 ~10µs

**缺点**：
- 需要将 vsock/net 的 socket 读操作移到 I/O monitor 线程
- 数据预缓冲增加内存使用
- 实现复杂度高于方案 D

**可行性**：⭐⭐⭐（方案 D 成功后的增量优化）

---

### 方案 F：WHvRequestInterrupt + APIC Emulation

**思路**：利用 WHPX 自带的 APIC 模拟（`WHvX64LocalApicEmulationModeXApic`），让 WHPX 内核处理中断路由：

```rust
// 从任意线程注入中断
WHvRequestInterrupt(partition, &interrupt_control, 0)?;
```

**优点**：
- 理论上可以实现类似 irqfd 的效果
- WHPX 内核处理中断路由，不需要用户态 IOAPIC/LAPIC

**缺点**：
- **Win10 MBP 2014 上 APIC 模拟会崩溃**（已验证）
- WHPX APIC 模拟和自定义 IOAPIC/LAPIC 不兼容
- 需要重写整个中断架构
- 文档极少，行为不可预测

**可行性**：⭐（Win10 兼容性问题 + 架构重写风险）

---

## 5. 推荐方案及实施路径

### 5.1 推荐：方案 D（Completion Queue + vCPU 自服务）

这是 **ROI 最高** 的方案，原因：

1. **精准解决瓶颈**：Block I/O completion drain 是唯一 ms 级锁内操作
2. **改动可控**：~200 行新代码，不需要重构 DeviceManager
3. **符合 WHPX 约束**：guest memory 写始终在 vCPU 线程
4. **可增量验证**：先只做 block I/O，验证后再扩展到 vsock/net

### 5.2 实施步骤（预估 ~400 行代码变更）

```
Step 1: 引入 crossbeam 依赖 + CompletionEvent 类型定义
        (~30 行)

Step 2: 将 completion_rx 从 VirtioBlock 移出到 runner 层
        (~50 行) 需要修改 start_blk_workers()

Step 3: 创建 I/O monitor 线程，从 completion_rx drain 到 ArrayQueue
        (~80 行)

Step 4: 修改 tick_and_poll() — 移除 block drain 逻辑
        (~-20 行)

Step 5: 在每个 vCPU 的 top-of-loop 添加 completion 自服务
        (~100 行) BSP + AP 都消费 queue

Step 6: 确保 used ring 更新 + raise_irq 正确
        (~50 行)

Step 7: 修改 HLT 处理 — 检查 completion queue 是否有待处理事件
        (~40 行)

Step 8: 调整 vCPU cap 从 2 → 4/8
        (~5 行)
```

### 5.3 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| Completion 事件丢失 | 低 | ArrayQueue 容量设足够大（1024），监控 push 失败 |
| 延迟增加 | 中 | I/O monitor sleep interval 调为 50-100µs |
| race condition | 低 | Lock-free queue 是 well-tested（crossbeam），guest write 在 vCPU 线程 |
| Vsock/Net 仍在锁内 | 低 | 它们的 poll 是 sub-ms，不是瓶颈 |
| crossbeam 依赖 | 低 | 成熟库，no_std 可选，零 unsafe |

### 5.4 验证计划

1. **本地**：641 tests pass + clippy + fmt
2. **Win11 E2E (4 vCPUs)**：vm-bench 8/8 + net-test 8/8，连续 5 次无失败
3. **Win10 E2E (4 vCPUs)**：vm-bench 8/8 + net-test 8/8
4. **压力测试**：连续创建/销毁 20 个 box，无 hang
5. **2 vCPU 回归**：确认不引入退步

---

## 6. 结论

| 方案 | 可行性 | 改动量 | 预期收益 | 推荐 |
|------|--------|--------|----------|------|
| A: 拆分 tick_and_poll | ⭐⭐ | ~100 行 | 锁持有 5ms→3ms | 否 |
| B: Per-Device 细粒度锁 | ⭐⭐ | ~800 行 | 大幅降低竞争 | 否（风险高） |
| C: 专用 I/O Thread | ⭐ | ~300 行 | N/A | 否（WHPX 限制） |
| **D: Completion Queue** | **⭐⭐⭐⭐** | **~400 行** | **锁持有 5ms→50µs** | **是** |
| E: 扩展到 Vsock/Net | ⭐⭐⭐ | ~600 行 | 锁持有 50µs→10µs | 后续迭代 |
| F: WHPX APIC 模拟 | ⭐ | ~2000 行 | 类似 irqfd | 否（兼容性） |

**核心结论**：WHPX 缺少 KVM 的 ioeventfd/irqfd 内核加速，但通过 **Completion Queue + vCPU 自服务**（方案 D），可以将 DeviceManager 锁持有时间从 ~5ms 降到 ~50µs，足以支持 4+ vCPU 稳定运行。这是一个 ~400 行的增量修改，风险可控。
