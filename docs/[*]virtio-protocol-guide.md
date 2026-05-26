# Virtio 协议技术介绍

> 目标: 从协议规范、数据结构、数据流到 libkrun 实现, 全面介绍 virtio 半虚拟化 I/O 框架

---

## 核心结论

Virtio 是 OASIS 标准化的**半虚拟化 (paravirtualization) I/O 框架**, 由 Rusty Russell (Linux 内核开发者) 于 2008 年提出。当前最新规范为 [VIRTIO v1.3](https://docs.oasis-open.org/virtio/virtio/v1.3/csd01/virtio-v1.3-csd01.html)。

核心思想: Guest OS 内核**知道自己运行在虚拟环境中**, 不再假装访问真实硬件, 而是通过优化的共享内存协议与 VMM 直接通信。

**Virtio 让 VMM 从"模拟硬件"变成"共享内存通信", 这正是 microVM 能做到 125ms 启动、5MiB 开销的技术基础。**

---

## 目录

1. [架构三层模型](#1-架构三层模型)
2. [设备组成四要素](#2-设备组成四要素)
3. [Device Status — 设备生命周期状态机](#3-device-status--设备生命周期状态机)
4. [Feature Bits — 特性协商](#4-feature-bits--特性协商)
5. [Virtqueue — 核心数据传输机制](#5-virtqueue--核心数据传输机制)
6. [数据流: 一个完整的 I/O 请求](#6-数据流-一个完整的-io-请求)
7. [Transport 层: MMIO vs PCI](#7-transport-层-mmio-vs-pci)
8. [通知优化](#8-通知优化)
9. [Packed Virtqueue (v1.1+)](#9-packed-virtqueue-v11)
10. [为什么 Virtio 适合 MicroVM / AI Sandbox](#10-为什么-virtio-适合-microvm--ai-sandbox)

---

## 1. 架构三层模型

```
┌──────────────────────────────────────────────────┐
│                    Guest OS                       │
│  ┌──────────────────────────────────────────┐     │
│  │         Virtio Driver (前端, FE)          │     │
│  │  (Linux: drivers/virtio/virtio_*.c)      │     │
│  └──────────────┬───────────────────────────┘     │
│                 │ virtqueue (共享内存)              │
├─────────────────┼────────────────────────────────┤
│  Transport 层   │  PCI / MMIO / Channel I/O       │
├─────────────────┼────────────────────────────────┤
│                 ▼                                  │
│  ┌──────────────────────────────────────────┐     │
│  │         Virtio Device (后端, BE)          │     │
│  │  (VMM 侧: libkrun/Firecracker/QEMU)     │     │
│  └──────────────────────────────────────────┘     │
│                    Host / VMM                      │
└──────────────────────────────────────────────────┘
```

三层职责:

| 层 | 职责 | 例子 |
|---|------|------|
| **Device (后端)** | VMM 中的设备实现, 处理 I/O 请求 | libkrun 的 `virtio/block/device.rs` |
| **Driver (前端)** | Guest 内核中的驱动, 提交 I/O 请求 | Linux `virtio_blk.c` |
| **Transport** | 连接前后端的通信机制 | virtio-mmio, virtio-pci |

设计四原则 (来自规范):

- **Straightforward**: 使用标准中断和 DMA 机制, 设备驱动作者无需学习新范式
- **Efficient**: 描述符环形缓冲区经过优化, 避免 cache line 争用
- **Standard**: 跨多种传输类型 (PCI, MMIO, Channel I/O) 通用
- **Extensible**: Feature bits 机制实现前后向兼容

---

## 2. 设备组成四要素

每个 virtio 设备由 4 部分组成:

```
┌─────────────────────────────────────────────┐
│               Virtio Device                  │
│                                              │
│  ① Device Status Field   (设备状态字段)       │
│     控制设备初始化生命周期                      │
│                                              │
│  ② Feature Bits          (特性协商位)         │
│     前后端能力协商                             │
│                                              │
│  ③ Configuration Space   (设备配置空间)       │
│     设备特定参数 (如 block 的磁盘大小)          │
│                                              │
│  ④ Virtqueue(s)          (数据传输队列)       │
│     实际 I/O 数据传输通道                      │
└─────────────────────────────────────────────┘
```

---

## 3. Device Status — 设备生命周期状态机

设备通过状态字段驱动初始化。状态位**只能递增设置, 不能清除** (除非写 0 重置):

```
                    写 0 重置
         ┌─────────────────────────────────┐
         ▼                                 │
    ┌─────────┐                            │
    │  INIT   │  status = 0                │
    │  (0x0)  │                            │
    └────┬────┘                            │
         │ Driver 发现设备                   │
         ▼                                 │
    ┌──────────────┐                       │
    │ ACKNOWLEDGE  │  "我认出这是 virtio"    │
    │   (0x01)     │                       │
    └────┬─────────┘                       │
         │ Driver 可以驱动此设备             │
         ▼                                 │
    ┌──────────────┐                       │
    │   DRIVER     │  "我有这个设备的驱动"   │
    │   (0x02)     │                       │
    └────┬─────────┘                       │
         │ 特性协商完成                      │
         ▼                                 │
    ┌──────────────┐                       │
    │ FEATURES_OK  │  "特性协商达成一致"     │
    │   (0x08)     │                       │
    └────┬─────────┘                       │
         │ 队列配置完成, 准备就绪            │
         ▼                                 │
    ┌──────────────┐                       │
    │  DRIVER_OK   │  "设备已激活, 可以工作" │
    │   (0x04)     │                       │
    └────┬─────────┘                       │
         │                                 │
         ▼                                 │
    ┌──────────────────┐                   │
    │  DEVICE_NEEDS_   │  设备遇到错误      │
    │  RESET (0x40)    │  需要恢复          │
    └────┬─────────────┘                   │
         │ 出错                             │
         ▼                                 │
    ┌──────────────┐                       │
    │   FAILED     │  status |= 0x80       │
    │   (0x80)     │───────────────────────┘
    └──────────────┘
```

### 完整初始化序列 (规范 3.1.1)

1. 重置设备 (写 status = 0)
2. 设置 `ACKNOWLEDGE` — 识别出 virtio 设备
3. 设置 `DRIVER` — 知道如何驱动此设备
4. 读取 device feature bits, 写入 driver 理解的子集
5. 设置 `FEATURES_OK` — 特性协商完成
6. **重新读取** status 确认 `FEATURES_OK` 仍然设置 (设备可能拒绝)
7. 配置 virtqueue (设置描述符表/可用环/已用环地址)
8. 设置 `DRIVER_OK` — 设备激活, 可以开始 I/O

### libkrun 中的实现

来自 `src/devices/src/virtio/mmio.rs`:

```rust
fn set_device_status(&mut self, status: u32) {
    match !self.device_status & status {
        ACKNOWLEDGE if self.device_status == INIT => {
            self.device_status = status;
        }
        DRIVER if self.device_status == ACKNOWLEDGE => {
            self.device_status = status;
        }
        FEATURES_OK if self.device_status == (ACKNOWLEDGE | DRIVER) => {
            self.device_status = status;
        }
        DRIVER_OK if self.device_status == (ACKNOWLEDGE|DRIVER|FEATURES_OK) => {
            self.device_status = status;
            if !device_activated {
                self.activate();  // ← 激活设备, 将 queue 所有权转移给 device
            }
        }
        _ if status == 0 => {
            self.reset();  // ← 写 0 = 重置设备
        }
        _ => {
            warn!("invalid virtio driver status transition");
        }
    }
}
```

关键规则: **设备在 DRIVER_OK 设置前, 不得消费缓冲区或发送中断。**

---

## 4. Feature Bits — 特性协商

协商机制实现前后向兼容:

```
Device 广播:  "我支持 features = 0b1111_0011"
                                    │
Driver 回应:  "我理解 features = 0b0011_0001"  (子集)
                                    │
              ──── 取交集 ────
                                    │
              生效特性 = 0b0011_0001
```

### Feature Bit 分配

| 范围 | 用途 | 例子 |
|------|------|------|
| **0-23** | 设备特定特性 | VIRTIO_BLK_F_FLUSH, VIRTIO_NET_F_CSUM |
| **24-40** | 队列和协商扩展 | VIRTIO_RING_F_EVENT_IDX, VIRTIO_F_VERSION_1 |
| **41-49** | 保留/未来扩展 | — |
| **50-127** | 设备特定特性 (扩展) | — |
| **128+** | 未来扩展 | — |

### 协商规则

- Driver **不得**接受 Device 未声明的特性
- Driver **不得**接受依赖未被接受特性的特性
- 重新协商的唯一方式是**重置设备**
- 如果设备曾成功协商某特性集, 重置后**不应拒绝**相同特性集的再次协商

### libkrun 中的实现

来自 `src/devices/src/virtio/device.rs`:

```rust
fn ack_features_by_page(&mut self, page: u32, value: u32) {
    let mut v = match page {
        0 => u64::from(value),
        1 => u64::from(value) << 32,
        _ => { warn!("Cannot acknowledge unknown features page"); 0u64 }
    };

    // 检查 Guest 是否在确认我们未声明的特性
    let unrequested_features = v & !self.avail_features();
    if unrequested_features != 0 {
        warn!("Received acknowledge request for unknown feature");
        v &= !unrequested_features;  // 忽略未声明的特性
    }
    self.set_acked_features(self.acked_features() | v);
}
```

---

## 5. Virtqueue — 核心数据传输机制

Virtqueue 是 virtio 的核心 — Driver 和 Device 之间通过**共享 Guest 物理内存**传递 I/O 请求的环形缓冲区。

### 5.1 Split Virtqueue 结构 (v1.0 格式)

```
Guest 物理内存中的三段区域:

┌──────────────────────────────────────────────────────┐
│                  Descriptor Table                     │
│  (描述符表: 存放所有缓冲区的地址/长度/标志)            │
│                                                      │
│  ┌──────┬──────┬───────┬──────┐                      │
│  │ desc │ desc │ desc  │ ...  │  每项 16 字节          │
│  │  #0  │  #1  │  #2   │      │  共 QueueSize 项       │
│  └──────┴──────┴───────┴──────┘                      │
│  对齐: 16 字节                                        │
│  大小: 16 × QueueSize 字节                            │
├──────────────────────────────────────────────────────┤
│                  Available Ring                       │
│  (可用环: Driver 告知 Device "这些缓冲区准备好了")      │
│                                                      │
│  ┌───────┬─────┬──────────────────┬────────────┐     │
│  │ flags │ idx │ ring[QueueSize]  │ used_event │     │
│  └───────┴─────┴──────────────────┴────────────┘     │
│  Driver 写, Device 只读                               │
│  对齐: 2 字节                                         │
│  大小: 6 + 2 × QueueSize 字节                         │
├──────────────────────────────────────────────────────┤
│                    Used Ring                          │
│  (已用环: Device 告知 Driver "这些缓冲区处理完了")      │
│                                                      │
│  ┌───────┬─────┬──────────────────┬─────────────┐    │
│  │ flags │ idx │ ring[QueueSize]  │ avail_event │    │
│  └───────┴─────┴──────────────────┴─────────────┘    │
│  Device 写, Driver 只读                               │
│  对齐: 4 字节                                         │
│  大小: 6 + 8 × QueueSize 字节                         │
└──────────────────────────────────────────────────────┘

QueueSize 必须是 2 的幂, 最大 32768
```

### 5.2 Descriptor (描述符) 结构

```c
struct virtq_desc {
    le64 addr;    // 缓冲区 Guest 物理地址
    le32 len;     // 缓冲区长度 (字节)
    le16 flags;   // 标志位
    le16 next;    // 链中下一个描述符的索引
};
// 每个描述符 16 字节
```

**Flags 定义**:

| 标志 | 值 | 含义 |
|------|---|------|
| `VIRTQ_DESC_F_NEXT` | 0x1 | 描述符链继续, `next` 字段有效 |
| `VIRTQ_DESC_F_WRITE` | 0x2 | 缓冲区供 Device 写入 (否则供 Device 读取) |
| `VIRTQ_DESC_F_INDIRECT` | 0x4 | 缓冲区包含间接描述符表 |

**描述符链**: 一个 I/O 请求可由多个不连续内存块组成, 通过 `next` 字段串联:

```
desc[0]              desc[3]              desc[7]
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ addr: 0x1000 │     │ addr: 0x3000 │     │ addr: 0x5000 │
│ len:  512    │     │ len:  1024   │     │ len:  256    │
│ flags: NEXT  │────→│ flags: NEXT  │────→│ flags: WRITE │
│ next: 3      │     │ next: 7      │     │ next: -      │
└──────────────┘     └──────────────┘     └──────────────┘
 Device 读取 512B     Device 读取 1024B     Device 写入 256B

这条链 = 一个 I/O 请求: 读取请求头+数据 → 处理 → 写入结果
```

**规则**: 描述符链总长度不得超过 2^32 字节; 链中不允许有环。

### 5.3 Available Ring (可用环)

```c
struct virtq_avail {
    le16 flags;              // 通知抑制标志 (VIRTQ_AVAIL_F_NO_INTERRUPT)
    le16 idx;                // 下一个写入位置 (单调递增, 永不回绕)
    le16 ring[QueueSize];    // 描述符链头部索引的数组
    le16 used_event;         // EVENT_IDX 特性: 期望 Device 通知的 used idx 阈值
};
```

**Driver 的操作**:
1. 填好描述符链 (在 Descriptor Table 中)
2. 将链**头部**索引写入 `ring[idx % QueueSize]`
3. 内存屏障 (确保 Device 看到描述符内容)
4. `idx++`
5. 通知 Device (kick)

**关键**: `idx` 只增不减 — Driver **不能**撤回已发布的缓冲区。

### 5.4 Used Ring (已用环)

```c
struct virtq_used {
    le16 flags;              // 通知抑制标志 (VIRTQ_USED_F_NO_NOTIFY)
    le16 idx;                // 下一个写入位置 (单调递增)
    struct virtq_used_elem {
        le32 id;             // 完成的描述符链头部索引
        le32 len;            // Device 实际写入的字节数
    } ring[QueueSize];
    le16 avail_event;        // EVENT_IDX: 期望 Driver 通知的 avail idx 阈值
};
```

**Device 的操作**:
1. 从 Available Ring 取出描述符链头索引
2. 遍历描述符链, 执行 I/O
3. 将 `{id, len}` 写入 `ring[idx % QueueSize]`
4. 内存屏障
5. `idx++`
6. 设置 len (规范要求: **必须在更新 idx 之前设置 len**)
7. 发送中断通知 Driver

### 5.5 三个操作原语

Virtqueue 的全部交互归结为三个操作:

| 操作 | 方向 | 含义 |
|------|------|------|
| **add_buf** | Driver → Available Ring | 提交新的 I/O 请求缓冲区 |
| **get_buf** | Driver ← Used Ring | 获取已完成的 I/O 结果 |
| **kick** | Driver → Device | 通知 Device 有新缓冲区可处理 |

批量操作和延迟通知是高性能 I/O 的关键 — 因为 Driver 和 Device 之间的通知通常涉及昂贵的 VM EXIT。

---

## 6. 数据流: 一个完整的 I/O 请求

以 virtio-block 读操作为例:

```
Driver (Guest 内核)                    Device (VMM / libkrun)
      │                                        │
  ①   │ 分配描述符, 填写:                        │
      │  desc[0]: request header (读, sector N)  │
      │    flags: NEXT, next: 1                  │
      │  desc[1]: data buffer (512 bytes)        │
      │    flags: WRITE|NEXT, next: 2            │
      │  desc[2]: status byte (1 byte)           │
      │    flags: WRITE                          │
      │                                        │
  ②   │ 将 desc[0] 的索引写入 avail ring          │
      │ avail.ring[avail.idx % size] = 0        │
      │ wmb()  // 写屏障                         │
      │ avail.idx++                             │
      │                                        │
  ③   │ ─── kick (通知 Device) ───────────────→ │
      │  (写 MMIO 偏移 0x50 = QueueNotify)      │
      │  → 触发 KVM ioeventfd                   │
      │  → EventFd 通知 VMM worker 线程         │
      │                                        │
      │                                    ④   │ worker 线程被唤醒
      │                                        │ 读取 avail ring
      │                                        │ 取出 desc[0] 索引
      │                                        │ 遍历描述符链: [0]→[1]→[2]
      │                                        │
      │                                    ⑤   │ 执行 I/O:
      │                                        │ 从 desc[0] 读取请求头
      │                                        │ 读取磁盘 sector N 数据
      │                                        │ 写入 desc[1] 指向的 Guest 内存
      │                                        │ 写入 desc[2] 状态 = OK
      │                                        │
      │                                    ⑥   │ 将 {id=0, len=513} 写入 used ring
      │                                        │ wmb()
      │                                        │ used.idx++
      │                                        │
      │ ←───── 发送中断 (irqfd) ──────────── ⑦  │
      │  InterruptStatus |= VRING              │
      │  触发 irqfd → KVM 注入虚拟中断          │
      │                                        │
  ⑧   │ 中断处理程序:                            │
      │  读取 InterruptStatus, 确认 VRING       │
      │  读取 used ring, 取出 {id=0, len=513}    │
      │  回收 desc[0-2] 到空闲池                 │
      │  将数据交给上层文件系统                    │
```

### libkrun 中通知的实现

**Driver → Device (kick)**: Guest 写 MMIO 偏移 0x50

```rust
// mmio.rs, BusDevice::write, offset 0x50
0x50 => {
    // Guest 写入 queue 索引, 触发对应 EventFd
    if let Some(eventfd) = self.queue_evts.get(v as usize) {
        eventfd.write(1).unwrap();
    }
}
```

VMM 将此地址注册为 KVM ioeventfd, 使得 Guest 写操作**不触发 VMEXIT**, 直接通知 VMM 线程。

**Device → Driver (中断)**:

```rust
// mmio.rs
pub fn signal_used_queue(&self) {
    self.status.fetch_or(VIRTIO_MMIO_INT_VRING as usize, Ordering::SeqCst);
    self.intc.lock().unwrap().set_irq(self.irq_line, Some(&self.event))?;
}
```

VMM 将中断 EventFd 注册为 KVM irqfd, 使得 VMM 写 EventFd 即可直接注入虚拟中断, 无需额外 VMEXIT。

---

## 7. Transport 层: MMIO vs PCI

Transport 负责三件事: 设备发现、寄存器访问、通知/中断传递。

### 7.1 对比

| 维度 | virtio-pci | virtio-mmio |
|------|-----------|-------------|
| **发现** | PCI 总线枚举 (Vendor 0x1AF4) | 平台特定 (设备树/内核命令行) |
| **寄存器访问** | PCI BAR + Capability 结构 | 固定偏移 MMIO 寄存器 |
| **中断** | MSI-X (多队列独立中断) | 单个 IRQ line |
| **通知** | IO port 或 MMIO 写 | MMIO 偏移 0x50 写 |
| **设备数量** | 数千 (多 PCI bus) | 受地址空间限制 (~几十个) |
| **热插拔** | 支持 | 不支持 |
| **Linux 代码量** | 161 文件, 78,237 行 | **1 文件, 538 行** |
| **适用场景** | 通用 VM (QEMU) | **MicroVM** (libkrun, Firecracker) |

### 7.2 libkrun virtio-mmio 寄存器布局

从 `src/devices/src/virtio/mmio.rs` 源码提取:

```
偏移     方向    寄存器名             功能
────     ────   ──────              ──────
0x00     R      MagicValue          固定 0x74726976 ("virt"), 识别 virtio 设备
0x04     R      Version             固定 2 (virtio modern, v1.0+)
0x08     R      DeviceID            设备类型 (block=2, net=1, vsock=19...)
0x0c     R      VendorID            厂商 ID (libkrun 固定为 0)
0x10     R      DeviceFeatures      按页读取设备特性位
0x14     W      DeviceFeaturesSel   选择特性页 (0=低32位, 1=高32位)
0x20     W      DriverFeatures      Driver 确认的特性位
0x24     W      DriverFeaturesSel   选择 Driver 特性页
0x30     W      QueueSel            选择当前操作的队列索引
0x34     R      QueueNumMax         当前队列的最大容量
0x38     W      QueueNum            设置当前队列大小
0x44     R/W    QueueReady          队列就绪标志
0x50     W      QueueNotify         队列通知 (kick) ← ioeventfd 注册点
0x60     R      InterruptStatus     中断状态位图
0x64     W      InterruptACK        中断确认 (清除状态位)
0x70     R/W    Status              设备状态 (驱动初始化状态机)
0x80     W      QueueDescLow        描述符表地址 (低 32 位)
0x84     W      QueueDescHigh       描述符表地址 (高 32 位)
0x90     W      QueueAvailLow       Available Ring 地址 (低 32 位)
0x94     W      QueueAvailHigh      Available Ring 地址 (高 32 位)
0xa0     W      QueueUsedLow        Used Ring 地址 (低 32 位)
0xa4     W      QueueUsedHigh       Used Ring 地址 (高 32 位)
0xac     W      SHMRegionSel        共享内存区域选择
0xb0-bc  R      SHMRegion*          共享内存区域长度/基地址
0xfc     R      ConfigGeneration    配置空间版本号 (原子读取用)
0x100+   R/W    Config Space        设备特定配置空间
```

每个设备占用 **4KB (一页)** MMIO 地址空间。

### 7.3 为什么 MicroVM 选择 MMIO

```
virtio-pci 的开销:
  ├── 需要 PCI 总线模拟 (配置空间、BAR 映射、MSI-X 表)
  ├── Guest 内核需要 PCI 枚举 (BIOS/ACPI 协助)
  ├── 代码复杂度高 (78K 行 vs 538 行)
  └── 启动时间增加 (PCI 枚举 + ACPI 解析)

virtio-mmio 的优势:
  ├── 无需 PCI/ACPI 基础设施
  ├── 设备地址通过内核命令行 (x86) 或 FDT (ARM) 直接告知
  ├── 极简实现, 代码量小 100x+
  └── 对于 <10 个设备的 microVM 场景完全够用
```

---

## 8. 通知优化

频繁的通知 (kick/中断) 会导致大量 VMEXIT, 严重影响性能。Virtio 提供两种抑制机制:

### 8.1 Flags 抑制 (简单模式)

```
Driver 视角:
  avail.flags = VIRTQ_AVAIL_F_NO_INTERRUPT (0x1)
  → 告诉 Device: "处理完缓冲区后别给我发中断, 我会轮询 used ring"

Device 视角:
  used.flags = VIRTQ_USED_F_NO_NOTIFY (0x1)
  → 告诉 Driver: "有新缓冲区别通知我, 我会轮询 avail ring"
```

### 8.2 EVENT_IDX (精细模式, 推荐)

需要协商 `VIRTIO_RING_F_EVENT_IDX` 特性:

```
Driver 写 avail.used_event = N:
  → 告诉 Device: "只在 used.idx 从 N-1 变到 N 时才发中断"

Device 写 used.avail_event = M:
  → 告诉 Driver: "只在 avail.idx 从 M-1 变到 M 时才通知我"
```

效果: 高负载时, 多个 I/O 完成合并为一次中断; 低负载时, 每次 I/O 仍及时通知。

### 8.3 libkrun 中的 EVENT_IDX

```rust
// mmio.rs, 设备激活时检查 EVENT_IDX 特性
fn activate(&mut self) {
    let event_idx_enabled =
        (locked_device.acked_features() & (1 << VIRTIO_RING_F_EVENT_IDX)) != 0;
    for dq in &mut device_queues {
        dq.queue.set_event_idx(event_idx_enabled);
    }
    locked_device.activate(self.mem.clone(), self.interrupt.clone(), device_queues)?;
}
```

### 8.4 KVM 加速: ioeventfd + irqfd

在 KVM 环境下, 通知进一步优化:

```
传统通知路径 (无 ioeventfd):
  Guest 写 MMIO 0x50 → VMEXIT → KVM → 返回 VMM → VMM 处理 → VMENTER
  开销: 每次通知 ~1-2μs

ioeventfd 优化路径:
  Guest 写 MMIO 0x50 → KVM 直接写 eventfd (无 VMEXIT!) → VMM epoll 唤醒
  开销: ~0.1μs

传统中断路径 (无 irqfd):
  VMM 调用 ioctl → KVM 注入中断 → Guest 处理
  开销: 需要 ioctl 系统调用

irqfd 优化路径:
  VMM 写 eventfd → KVM 自动注入中断 (无 ioctl!)
  开销: 仅 eventfd 写操作
```

---

## 9. Packed Virtqueue (v1.1+)

Virtio 1.1 引入 Packed Virtqueue, 优化 cache 局部性:

### Split vs Packed 对比

```
Split Virtqueue (v1.0):
  3 块独立内存: Descriptor Table + Available Ring + Used Ring
  → 3 块内存分散, cache miss 频繁
  → Driver 和 Device 写不同区域 (cache bouncing)

Packed Virtqueue (v1.1):
  1 块统一内存: 描述符/可用/已用信息合并
  → 所有信息在同一 cache line 附近
  → 减少 cache miss 和 cache line bouncing
```

```
Packed 描述符结构:
struct pvirtq_desc {
    le64 addr;
    le32 len;
    le16 id;
    le16 flags;    // 包含 AVAIL 和 USED 标志位
};

Driver 和 Device 通过翻转 AVAIL/USED flag 位来标识状态:
  AVAIL=1, USED=0 → Driver 提供的缓冲区 (等价于在 avail ring 中)
  AVAIL=1, USED=1 → Device 已处理完 (等价于在 used ring 中)
```

Packed Virtqueue 在高吞吐场景下性能更优, 但实现更复杂。libkrun 当前使用 Split Virtqueue。

---

## 10. 为什么 Virtio 适合 MicroVM / AI Sandbox

### 10.1 对比全硬件模拟

| 维度 | 全硬件模拟 (QEMU e1000/IDE) | Virtio |
|------|---------------------------|--------|
| **原理** | 模拟真实硬件寄存器时序 | 共享内存环形缓冲区 |
| **Guest 驱动** | 使用真实硬件驱动 (不知道虚拟化) | 使用 virtio 驱动 (知道虚拟化) |
| **每次 I/O** | 多次寄存器读写 = 多次 VMEXIT | 批量描述符 + 一次通知 |
| **DMA** | 模拟 DMA 引擎 | 直接共享内存访问 |
| **性能** | 原生的 ~60-70% | 原生的 ~95%+ |
| **代码复杂度** | 极高 (精确模拟硬件状态机) | 低 (简单环形缓冲区) |
| **安全风险** | 高 (复杂代码 = 更多 CVE) | 低 (简单协议 = 更少 bug) |

### 10.2 对 AI Sandbox 的具体收益

| Virtio 特性 | AI Sandbox 收益 |
|------------|----------------|
| 无硬件模拟, 代码量小 | VMM 攻击面极小, 不可信代码难以逃逸 |
| 共享内存传输 | 文件读写、网络 I/O 接近原生性能 |
| MMIO transport (无 PCI) | 启动快 10x (无 PCI 枚举), 内存省 |
| 标准化驱动 (Linux 内核内置) | 无需定制 Guest 内核, 任意 Linux 发行版直接可用 |
| 通知优化 (ioeventfd/irqfd) | 高吞吐 I/O, 满足频繁代码执行场景 |
| 简单实现 | 容易审计, 更高的安全可信度 |

### 10.3 libkrun 中的 virtio 设备全景

| 设备 | Type ID | Virtqueue 数量 | 用途 (AI Sandbox 场景) |
|------|---------|---------------|----------------------|
| **virtio-block** | 2 | 1 | 挂载根文件系统, 存储代码/数据 |
| **virtio-net** | 1 | 2 (rx+tx) | pip install, API 调用, 网络访问 |
| **virtio-console** | 3 | 2×N (每端口) | 标准输出/错误捕获, 日志 |
| **virtio-vsock** | 19 | 2 (rx+tx) | host-guest gRPC 通信, TSI 网络代理 |
| **virtio-fs** | 26 | 1+ | 宿主目录共享到 Guest (代码挂载) |
| **virtio-balloon** | 5 | 3 | 动态内存回收 (高密度部署) |
| **virtio-rng** | 4 | 1 | 为 Guest 提供高质量随机数 |
| virtio-gpu | 16 | 2 | 可选: GUI 渲染 |
| virtio-input | 18 | 2 | 可选: 输入设备直通 |
| virtio-sound | 25 | 4 | 可选: 音频 |

**全部使用 virtio-mmio v2 传输**, 无 PCI, 无 ACPI。

---

## 附录: 信息来源

- [OASIS VIRTIO Specification v1.2](https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html)
- [OASIS VIRTIO Specification v1.3](https://docs.oasis-open.org/virtio/virtio/v1.3/csd01/virtio-v1.3-csd01.html)
- [Virtio on Linux — Kernel Documentation](https://docs.kernel.org/driver-api/virtio/virtio.html)
- [Virtio Devices High-Level Design — Project ACRN](https://projectacrn.github.io/latest/developer-guides/hld/hld-virtio-devices.html)
- [Rusty Russell: virtio — Towards a De-Facto Standard](https://ozlabs.org/~rusty/virtio-spec/virtio-paper.pdf)
- [Virtqueues and virtio ring: How the data travels — Red Hat](https://www.redhat.com/en/blog/virtqueues-and-virtio-ring-how-data-travels)
- [Packed virtqueue: How to reduce overhead — Red Hat](https://www.redhat.com/en/blog/packed-virtqueue-how-reduce-overhead-virtio)
- [Virtio devices and drivers overview — Red Hat](https://www.redhat.com/en/blog/virtio-devices-and-drivers-overview-headjack-and-phone)
- libkrun 源码: `src/devices/src/virtio/mmio.rs`, `device.rs`, `queue.rs`
