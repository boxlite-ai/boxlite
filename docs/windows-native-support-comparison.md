# BoxLite Windows Native 支持方案对比报告

## 1. 概述

本报告对比两个方案，使 BoxLite 在 Windows 上实现原生虚拟化支持：

| 维度 | 方案 A: libwkrun（新建库） | 方案 B: 基于 Cloud Hypervisor |
|------|--------------------------|------------------------------|
| 核心思路 | 参考 libkrun 设计，新建 libwkrun 库，提供 libkrun 兼容 API，使用 WHPX/MSHV 后端 | 直接将 Cloud Hypervisor 作为外部进程，通过 REST API 与 BoxLite 集成 |
| 一句话描述 | "嵌入式 VMM 库" | "外部 VMM 进程" |

---

## 2. 方案详述

### 方案 A: libwkrun（新建项目）

```
BoxLite Host Process
└── boxlite-shim.exe (子进程)
    └── libwkrun (in-process 库)
        ├── WHPX 后端 (Windows Hypervisor Platform)
        ├── Virtio 设备 (blk, fs, net, console)
        ├── Hyper-V Socket 桥接
        └── vCPU 线程循环
```

- **完全嵌入式**: libwkrun 编译为 `.lib` / `.dll`，链接到 boxlite-shim.exe
- **libkrun 兼容 API**: 提供 `wkrun_create_ctx()`, `wkrun_start_enter()` 等 26 个函数
- **Rust 原生实现**: 基于 rust-vmm crate 生态（vm-memory, virtio-queue 等）
- **Process model**: vCPU 在线程中运行，`wkrun_start_enter()` 阻塞直到 VM 退出

### 方案 B: 基于 Cloud Hypervisor

```
BoxLite Host Process
└── boxlite-shim.exe (子进程)
    ├── 启动 cloud-hypervisor.exe (独立进程)
    ├── REST API 通信 (HTTP over Named Pipe)
    └── 管理 VM 生命周期
```

- **外部进程**: Cloud Hypervisor 作为独立二进制运行
- **REST API 集成**: 通过 OpenAPI 3.0 兼容的 HTTP API 管理 VM
- **需要移植**: Cloud Hypervisor 目前 **不支持 Windows Host**，需要社区/自行移植
- **MSHV 已有**: 但仅限 Linux root partition on Hyper-V，不是 Windows 原生

---

## 3. 多维度对比

### 3.1 技术可行性

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **Windows Host 支持现状** | 不存在，需从零构建 | 不存在，需移植（目前仅支持 Linux Host） | **持平** — 两者都需要大量 Windows 适配工作 |
| **Hypervisor 抽象** | 需自建 WHPX 后端（参考 Cloud Hypervisor 的 hypervisor crate） | Cloud Hypervisor 已有 hypervisor 抽象层，但仅实现了 KVM 和 MSHV（Linux） | **A 略优** — A 可以只实现 WHPX，代码更少 |
| **Virtio 设备** | 需实现 4 个设备（blk, fs, net, console） | Cloud Hypervisor 已有完整 virtio 实现（10+ 设备） | **B 优** — B 已有成熟实现 |
| **MSHV 集成** | 可借鉴 rust-vmm/mshv crate | 已有 MSHV 后端（但在 Linux 上） | **B 略优** — B 有现成参考实现 |
| **Windows API 调用** | 直接调用 WHPX API（WinHvPlatform.h） | 需要修改 Cloud Hypervisor 核心以支持 WHPX | **A 优** — A 从零设计，无历史包袱 |
| **依赖链复杂度** | 少（rust-vmm 基础 crate + windows-sys） | 多（23 个 workspace crate + 外部依赖） | **A 优** — 最小依赖原则 |

### 3.2 架构兼容性

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **与 BoxLite 架构匹配度** | **高** — libkrun 兼容 API，drop-in 替换 | **低** — 需要重新设计 VMM 集成层 | **A 大优** |
| **进程模型** | 嵌入式（shim 进程内），与现有 libkrun 模型一致 | 外部进程（shim → cloud-hypervisor → VM），多一层 IPC | **A 优** |
| **Vmm trait 适配** | 自然适配 — `Wkrun` 实现 `Vmm` trait，`enter()` 阻塞 | 需重新设计 — `CloudHypervisor` 实现 `Vmm` trait，但 `enter()` 变成 IPC | **A 优** |
| **Shim 子进程** | 保持现有模式：shim 启动 → 配置 VM → enter() 阻塞 | 完全不同：shim 启动 → 启动 CH 进程 → REST API 创建 VM → 等待 | **A 优** |
| **VmmController / VmmHandler** | 完全兼容（ProcessMonitor 监控 shim PID） | 需修改（监控 CH 进程 PID + VM 状态） | **A 优** |
| **Host-Guest 通信** | Hyper-V Socket → Named Pipe（类似 vsock → Unix socket） | Cloud Hypervisor vsock → 需要额外适配层 | **A 略优** |

### 3.3 开发工作量

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **新代码量** | ~12,000 行 Rust（libwkrun 库 + BoxLite 集成） | ~5,000 行修改 + 大量 CH 代码理解/移植 | **持平** — A 代码多但目标清晰，B 代码少但理解成本高 |
| **BoxLite 改动量** | 少（新增 `vmm/wkrun/` 模块，~2,000 行） | 多（重新设计 VMM 层，修改 shim，新增 IPC，~5,000 行） | **A 优** |
| **第三方代码理解成本** | 低（只需理解 rust-vmm 基础 crate） | 高（需深入理解 CH 23 个 crate 的交互） | **A 优** |
| **移植工作** | 无移植（从零构建，只做 BoxLite 需要的功能） | 重度移植（CH 全栈 Linux 假设：epoll → IOCP, Unix socket → Named Pipe, /dev/mshv → WHPX） | **A 大优** |
| **团队学习曲线** | 中（需学习 WHPX API + rust-vmm） | 高（需学习 CH 架构 + 23 个 crate + WHPX + 移植技巧） | **A 优** |
| **预计开发周期** | 4-6 个月（4 阶段） | 8-12 个月（移植 + 集成 + 稳定化） | **A 优** |

### 3.4 性能

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **VM 启动时间** | ~100ms（嵌入式，无 IPC 开销） | ~300ms（启动 CH 进程 + REST API 调用 + VM 创建） | **A 优** |
| **内存开销** | 低（仅 shim 进程内的 VMM 线程） | 高（shim + CH 进程 = 两个进程） | **A 优** |
| **Host-Guest 延迟** | 低（Named Pipe 直连） | 中（CH 进程 → Named Pipe → 再桥接到 vsock） | **A 优** |
| **Virtio 设备性能** | 中（新实现，需优化） | 高（CH 经过多年优化，支持 vhost-user/DPDK） | **B 优** |
| **I/O 吞吐量** | 中（virtio-mmio transport） | 高（virtio-pci + vhost-user offload） | **B 优** |
| **CPU 利用率** | 低（最小设备集） | 中（更多后台线程） | **A 略优** |

### 3.5 维护性与可演进性

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **代码所有权** | 完全自有 — 我们控制所有代码 | 分裂 — 依赖 CH 上游 + 自有 patch | **A 大优** |
| **上游同步** | 无上游（自建项目） | 需持续 rebase CH 上游更新 | **A 优** |
| **Bug 修复** | 自行修复，快速迭代 | 需区分 CH bug vs 移植 bug vs BoxLite bug | **A 优** |
| **功能裁剪** | 只构建需要的（4 个 virtio 设备） | 携带 CH 所有 10+ 设备和功能 | **A 优** |
| **社区贡献** | 有限（小项目，但设计文档开放） | 大（Linux Foundation 项目，活跃社区） | **B 优** |
| **长期演进** | 按需添加功能，完全自主 | 受限于 CH 上游架构决策 | **A 优** |
| **跨平台一致性** | 高 — libkrun(Linux/macOS) + libwkrun(Windows) API 对称 | 低 — libkrun(Linux/macOS) + CH REST API(Windows) 模型不同 | **A 大优** |

### 3.6 安全性

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **攻击面** | 小（嵌入式，单进程边界） | 大（多进程 + IPC + REST API 暴露） | **A 优** |
| **沙箱隔离** | Job Objects 包含整个 shim | 需分别 sandbox shim 和 CH 进程 | **A 优** |
| **代码审计** | 少量代码，容易审计 | 大量代码，审计困难 | **A 优** |
| **安全更新** | 自主控制 | 依赖 CH 上游安全响应 | **A 优** |
| **隔离模型** | VM 隔离（WHPX）+ 进程隔离（Job Object） | VM 隔离（WHPX/MSHV）+ 进程隔离 + REST API ACL | **持平** |
| **SEV/TDX 支持** | 无（需未来添加） | 已有（SEV-SNP, TDX via MSHV） | **B 优** |

### 3.7 用户体验

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **安装复杂度** | 低 — 单个 DLL/LIB，无额外进程 | 高 — 需要安装 cloud-hypervisor.exe + virtiofsd | **A 优** |
| **磁盘占用** | ~5MB（libwkrun.dll） | ~20MB（CH + virtiofsd + 依赖） | **A 优** |
| **API 一致性** | 与 macOS/Linux 完全一致 | Windows 行为可能不同（REST API vs 嵌入式） | **A 大优** |
| **错误信息** | BoxLite 原生错误体系（BoxliteError） | 需翻译 CH 错误 → BoxliteError | **A 优** |
| **调试体验** | 简单 — RUST_LOG=debug 即可 | 复杂 — 需要看 BoxLite 日志 + CH 日志 | **A 优** |
| **依赖管理** | Cargo 管理，自动编译 | 需要预构建/下载 CH 二进制 | **A 优** |

### 3.8 生态与社区

| 维度 | 方案 A: libwkrun | 方案 B: Cloud Hypervisor | 评判 |
|------|-----------------|------------------------|------|
| **项目成熟度** | 0（全新项目） | 高（Linux Foundation 项目，5+ 年历史） | **B 大优** |
| **社区支持** | 无（自建维护） | 大（Intel/ARM/MS 贡献者） | **B 大优** |
| **文档** | 需自建 | 丰富（架构文档、API 文档、教程） | **B 优** |
| **CI/测试** | 需自建 | 已有完善的 CI/CD | **B 优** |
| **先例项目** | 无先例 | Kata Containers, ACRN 等使用 | **B 优** |
| **Windows 移植先例** | 不适用 | 无先例（CH 从未在 Windows 上运行过） | **持平** |

---

## 4. 风险分析

### 方案 A 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| WHPX API 不支持某些功能（如 MSI 中断注入） | 中 | 高 | 早期原型验证；MSHV 备选 |
| 从零实现 virtio 设备有 bug | 中 | 中 | 基于 rust-vmm 成熟 crate；充分测试 |
| Windows virtiofs 实现困难 | 中 | 中 | Phase 1 使用 Plan 9（简单可靠） |
| 维护负担重（自有代码库） | 低 | 中 | 最小设备集；清晰的分层架构 |

### 方案 B 风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| CH Windows 移植失败（Linux 假设太深） | **高** | **高** | 深入评估 epoll/signal/mmap 依赖 |
| CH 上游不接受 Windows patch | **高** | **高** | 维护 fork（长期维护负担） |
| CH 进程模型与 BoxLite shim 冲突 | 中 | 高 | 重新设计 VMM 集成层 |
| CH 更新破坏自有 patch | 中 | 中 | 固定版本 + 定期 rebase |
| REST API 延迟影响启动速度 | 中 | 中 | 优化 API 调用路径 |
| 安装/分发 CH 二进制复杂 | 中 | 中 | 内置下载或 bundled 分发 |

---

## 5. 决策矩阵

| 维度（权重） | 方案 A: libwkrun | 方案 B: Cloud Hypervisor |
|-------------|-----------------|------------------------|
| 技术可行性 (20%) | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 架构兼容性 (25%) | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| 开发工作量 (15%) | ⭐⭐⭐⭐ | ⭐⭐ |
| 性能 (10%) | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 维护性 (15%) | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| 安全性 (5%) | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 用户体验 (5%) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| 社区生态 (5%) | ⭐⭐ | ⭐⭐⭐⭐ |
| **加权总分** | **4.30 / 5** | **2.50 / 5** |

---

## 6. 关键发现

### Cloud Hypervisor 不支持 Windows Host

这是最关键的发现。经过深入调研：

- Cloud Hypervisor 的 MSHV 支持是指 **Linux 运行在 Hyper-V 上作为 root partition**，不是 Windows 原生
- Cloud Hypervisor **从未在 Windows 上运行过**
- 社区反馈："On the radar, but not working on it any time soon"
- 移植所需工作量巨大（23 个 crate 全栈 Linux 假设）

因此，方案 B 的前提条件（"基于 Cloud Hypervisor 实现 Windows 支持"）比表面看起来要困难得多。

### 移植 vs 新建的本质区别

```
方案 A: 新建 (Build)
  ✅ 只做需要的
  ✅ 从 Day 1 就是 Windows-native
  ✅ API 与 libkrun 对称
  ❌ 需要实现 virtio 设备
  ❌ 没有社区

方案 B: 移植 (Port)
  ✅ virtio 设备已有
  ✅ 有社区支持
  ❌ 23 个 crate 的 Linux 假设需要全部修改
  ❌ epoll → IOCP, signal → event, mmap → VirtualAlloc
  ❌ Unix socket → Named Pipe (贯穿整个代码库)
  ❌ 进程模型完全不同
  ❌ 上游可能不接受 Windows patch
```

### 方案 A 的 "不公平优势"

libwkrun 的核心优势在于 **BoxLite 只用了 libkrun 的 26 个 API 中最基础的部分**。这意味着：

1. 不需要实现 GPU (virtio-gpu)、音频 (virtio-snd)、输入设备等
2. 不需要热插拔
3. 不需要实时迁移
4. 只需 4 个 virtio 设备（blk, fs, net, console）
5. 只需 virtio-mmio transport（最简单的 transport）

这大幅降低了 libwkrun 的实现复杂度。

---

## 7. 混合方案考量

### 方案 C: libwkrun + 借用 Cloud Hypervisor 组件

在方案 A 基础上，直接复用 Cloud Hypervisor 的部分 Rust crate：

```rust
// Cargo.toml
[dependencies]
# 从 Cloud Hypervisor 借用的 crate
hypervisor = { git = "...", features = ["whpx"] }  # 如果 CH 添加 WHPX
vm-memory = "0.14"                                   # rust-vmm
virtio-queue = "0.12"                                 # rust-vmm
linux-loader = "0.12"                                 # rust-vmm

# 自实现
libwkrun-devices = { path = "./devices" }   # 最小 virtio 设备集
libwkrun-whpx = { path = "./whpx" }         # WHPX 后端
```

这是一个实际可行的"两全"方案：
- 用 rust-vmm 底层 crate（vm-memory, virtio-queue）— 已经非常成熟
- 自建 WHPX 后端 + 最小设备集
- 提供 libkrun 兼容 API

---

## 8. 结论与建议

### 推荐方案: A（libwkrun）

基于以上全面对比，**强烈推荐方案 A**，理由：

1. **架构一致性最高** — libkrun(Linux/macOS) + libwkrun(Windows) 形成完美对称
2. **开发可控** — 4 阶段渐进式交付，每阶段都有可验收产物
3. **最小实现原则** — 只做 BoxLite 需要的 4 个 virtio 设备
4. **风险可控** — Phase 1 (MVP) 可在 2-3 周内验证技术可行性
5. **Cloud Hypervisor 不支持 Windows Host** — 方案 B 的基础假设不成立

### 建议的执行路径

```
Week 1-2:   Phase 1 原型 — WHPX 后端 + bzImage boot + virtio-console
Week 3-6:   Phase 1 完善 — virtio-blk + 基本 C API
Week 7-10:  Phase 2 — Hyper-V Socket + Plan 9 FS + Guest Agent 适配
Week 11-16: Phase 3 — BoxLite 集成 + virtio-net + SDK
Week 17-24: Phase 4 — virtiofs + 优化 + CI
```

### 如果选择方案 B 的前提条件

如果团队仍倾向方案 B，需要先满足以下前提：

1. **Cloud Hypervisor 社区接受 Windows Host 支持 RFC** — 否则长期维护 fork
2. **完成 epoll → IOCP 移植原型**（1-2 周 POC）— 验证移植可行性
3. **完成 REST API → Vmm trait 适配设计** — 解决架构不兼容问题
4. **接受 ~300ms 额外启动延迟** — 多进程模型的固有开销

---

## 附录 A: Cloud Hypervisor Linux 假设清单

以下是 Cloud Hypervisor 中需要为 Windows 移植的 Linux-specific 代码（不完全列表）：

| 类别 | Linux API | Windows 等价物 | 改动复杂度 |
|------|----------|---------------|-----------|
| 事件循环 | `epoll` | `IOCP` / `CompletionPort` | 高 — 贯穿所有 crate |
| 信号处理 | `signal`, `signalfd` | `Event` objects | 高 |
| 内存映射 | `mmap`, `madvise` | `VirtualAlloc`, `MapViewOfFile` | 高 |
| 进程管理 | `fork`, `exec`, `waitpid` | `CreateProcess`, `WaitForSingleObject` | 中 |
| 文件系统 | `/proc`, `/sys`, `O_DIRECT` | WMI, `FILE_FLAG_NO_BUFFERING` | 中 |
| Socket | Unix domain socket | Named Pipe / TCP | 高 |
| 设备访问 | `/dev/kvm`, `/dev/vfio` | WHPX API, WDF driver | 高 |
| Terminal | `ioctl(TIOCGWINSZ)` | `GetConsoleScreenBufferInfo` | 低 |
| 用户/权限 | `uid`, `gid`, `capabilities` | SID, ACL, Token Privileges | 中 |
| cgroup | cgroup v2 | Job Objects | 低 |

**估计总改动**: 10,000+ 行代码修改，涉及 15+ 个 crate。

## 附录 B: libwkrun vs Cloud Hypervisor 代码规模对比

| 指标 | libwkrun (预估) | Cloud Hypervisor |
|------|----------------|-----------------|
| 总代码量 | ~12,000 行 | ~150,000+ 行 |
| Crate 数量 | 3-5 个 | 23 个 |
| 外部依赖 | ~15 个 | ~80+ 个 |
| 编译时间 | ~30 秒 | ~5 分钟 |
| 二进制大小 | ~5 MB | ~3.3 MB (已优化) |
| 支持的设备 | 4 个 | 10+ 个 |
| 支持的架构 | x86-64 | x86-64, AArch64, RISC-V64 |
| 支持的 Hypervisor | WHPX (+ 可选 MSHV) | KVM + MSHV |
| 支持的 Host OS | Windows | Linux |

## 附录 C: 关键参考资源

- [libkrun GitHub](https://github.com/containers/libkrun) — 设计参考
- [Cloud Hypervisor GitHub](https://github.com/cloud-hypervisor/cloud-hypervisor) — 代码参考
- [rust-vmm organization](https://github.com/rust-vmm) — 底层 crate 生态
- [WHPX Documentation](https://learn.microsoft.com/en-us/virtualization/api/) — Windows Hypervisor Platform API
- [rust-vmm/mshv](https://github.com/rust-vmm/mshv) — Microsoft Hypervisor Rust bindings
- [Hyper-V Socket Documentation](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/make-integration-service) — AF_HYPERV 协议
- [virtio-win drivers](https://github.com/virtio-win/kvm-guest-drivers-windows) — Windows 客户机 virtio 驱动
