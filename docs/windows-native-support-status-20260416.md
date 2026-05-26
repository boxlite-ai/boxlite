# BoxLite Windows 原生支持 — 状态报告

**日期**: 2026-04-18 (最后更新)
**阶段**: virtio-blk/init 接线完成, image_disk.rs 需要修复后方可 E2E

---

## 已完成工作

### Layer 1: libkrun WHPX VMM (完成)
- 33 个 VMM 文件移植到 `vendor/libkrun/src/vmm/src/windows/`
- C API (`windows_api.rs`) 实现所有 `krun_*` 函数
- Unix 端添加 stub 函数 (krun_start/wait/stop/get_console_output/add_net)

### Layer 2: libkrun-sys FFI Bridge (完成)
- 5 个新 FFI 声明: krun_start, krun_wait, krun_stop, krun_get_console_output, krun_add_net
- `krun_setuid`/`krun_setgid` 通过 `#[cfg(unix)]` 隔离 (libc::uid_t/gid_t)
- Windows build 路径在 `build.rs` 中配置

### Layer 3: BoxLite 平台适配 (完成)

**Stage A — 核心引擎:**
- KrunContext 封装: start/wait/stop/get_console_output/add_net
- NetworkBackendEndpoint::TcpSocket 变体 (Windows 网络)
- WhpxProbe 系统检查
- Engine Windows 分支代码

**Stage B — 依赖隔离 (~20 个文件):**
- Cargo.toml: Unix-only 依赖移到 `[target.'cfg(unix)'.dependencies]`
- 源码 `#[cfg(unix)]` / `#[cfg(any(unix, feature = "krun"))]` 门控

**Stage C — 测试隔离:**
- 11 个测试通过 `#[cfg(unix)]` 门控 (Unix 专属功能)
- spawn 测试修复 (显式设置 jailer_enabled: true)

### Step 3.9: 新 Windows 文件 (完成)
- **port.rs**: TCP 端口分配器 (4 个测试)
- **job_object.rs**: Windows Job Object 沙箱
- **image_disk.rs**: 跨平台 `extract_layer_tarball` (magic-byte 压缩检测)

### Step 4: 集成 Stub 接线 (完成)

**guest_connect.rs — TCP Ready Signal:**
- `wait_for_guest_ready_tcp()` 实现 TCP 监听路径
- 共享 `race_ready_signal()` 辅助函数 (避免 Unix/TCP 代码重复)
- `ready_transport: Option<Transport>` 添加到 InitPipelineContext
- 2 个新跨平台测试: `test_guest_ready_tcp_success`, `test_guest_ready_tcp_timeout`

**container_rootfs.rs — 统一磁盘根文件系统:**
- `prepare_disk_rootfs()` 从 `#[cfg(unix)]` 拓宽为 `#[cfg(any(unix, feature = "krun"))]`
- Unix 和 Windows 共享相同代码路径
- 删除 `prepare_disk_rootfs_vm()` (不再需要 BuilderVm)

**guest_rootfs.rs — 统一客户根文件系统:**
- `prepare_guest_rootfs()` 从 `#[cfg(unix)]` 拓宽为 `#[cfg(any(unix, feature = "krun"))]`
- 删除 `prepare_guest_rootfs_vm()` (不再需要 BuilderVm)

**rootfs/guest.rs — GuestRootfsManager 统一:**
- `get_or_create()` 和 `build_and_install()` 拓宽为 `#[cfg(any(unix, feature = "krun"))]`
- 删除 `get_or_create_vm()` 和 `build_and_install_vm()` (BuilderVm 版本)
- Unix 和 Windows 都使用原生 `inject_file_into_ext4` (debugfs)

**disk/ext4.rs — 跨平台化:**
- `libc` 调用通过 `#[cfg(unix)]` 隔离
- `create_ext4_from_dir` 和 `inject_file_into_ext4` 现在跨平台可用

**架构决策 — 原生 debugfs 替代 Builder VM:**
- Builder VM (`builder_vm.rs`) 已删除
- Windows 使用原生 `mke2fs.exe` + `debugfs.exe` (交叉编译)
- 性能提升 45 倍 (80ms vs 3-5s per ext4 操作)
- 统一 Unix/Windows 代码路径

### WHPX Kernel Boot 配置 (完成)
- `engine.rs`: Windows (WHPX) 下内核不嵌入在 libkrunfw 中, 需要显式提供
- 通过 `find_binary("vmlinuz")` / `find_binary("initrd.img")` 发现内核和 initrd
- 调用 `ctx.set_kernel()` 配置 WHPX 启动
- `#[cfg(not(unix))]` 门控, 对 macOS/Linux 零影响
- Commit: `5e666a6`

### WHPX 内核启动验证 — 成功 (2026-04-17)

**里程碑: Linux 内核在 WHPX 虚拟机中成功启动到用户空间 shell!**

- **内核**: Linux 6.12.80-0-virt (Alpine), `vmlinuz-virt` + `initramfs-virt.cpio.gz`
- **平台**: Win10 x86_64 (MacBook Pro 2014, Haswell), WHPX/Hyper-V
- **启动时间**: ~5 秒到 shell 提示符
- **启动出口数**: ~45,543 次 vCPU exit

**启动过程关键节点:**
1. 内存初始化, CPU 拓扑, 页表 — 正常
2. `tsc: Unable to calibrate against PIT` — 优雅跳过 (使用 `lpj=1000000`)
3. PIC 模式 (8259) — 无 APIC (`noapic nolapic`)
4. 串口控制台 ttyS0 — 工作正常, 输出 13,481 字节内核日志
5. 所有内核驱动加载完成
6. Initramfs 解包并执行
7. `/init` 作为 init 进程运行
8. `[initramfs] Dropping to shell...` — 到达交互式 shell `/ #`

**使其工作的关键修复:**

| 修复 | 文件 | 说明 |
|------|------|------|
| MSR/CPUID 拦截 | runner.rs, whpx.rs, types.rs | 通过 `WHvPartitionPropertyCodeExtendedVmExits` 拦截; MSR 读返回 0, 写跳过; CPUID 透传宿主默认值 |
| Hyper-V CPUID 屏蔽 | runner.rs | Leaf 1 ECX bit 31 清除; 0x40000000-0x400000FF 返回零 |
| PIT 时间基准计数器 | pit.rs | 基于墙钟时间递减计数器 (`ns_accumulator`); BIOS 默认: counter 0 Mode 2, reload=65536 (~18.2Hz); 20+ 单元测试 |
| Port 0x61 bit 5 切换 | manager.rs | `pit_calibrate_tsc()` 所需 — 每次读取切换 |
| i8042 键盘控制器 | manager.rs | 端口 0x60/0x64 返回 0x00 (空缓冲区) |
| 1ms 定时器线程 | runner.rs | 通过 `WHvCancelRunVirtualProcessor` 唤醒 vCPU 以注入中断 |

**IO 端口统计 (启动后):**

| 端口 | 方向 | 次数 | 设备 |
|------|------|------|------|
| 0x3F8 | 写 | 13,483 | Serial TX (控制台输出) |
| 0x3FD | 读 | 12,949 | Serial LSR (状态查询) |
| 0x64 | 读 | 10,003 | i8042 键盘控制器 (轮询) |
| 0x21 | 读/写 | ~500/~1000 | PIC IMR (中断屏蔽) |
| 0x20 | 写 | ~500 | PIC EOI (中断确认) |
| 0x42 | 读 | 64 | PIT Counter 2 (TSC 校准尝试) |
| 0x61 | 读/写 | 7/4 | NMI/Speaker (PIT 校准) |
| — | MSR | 6 | 模型特定寄存器 |
| — | CPUID | 415 | CPU 功能查询 |

**内核命令行:**
```
console=ttyS0 earlyprintk=serial noapic nolapic noacpi nosmp lpj=1000000 nokaslr panic=-1
```

**烟雾测试二进制:**
- 源码: `src/vmm/examples/boot_kernel.rs` (直接使用 vmm runner)
- 构建: 从 vmm 目录 (非 boxlite workspace) 执行 `cargo build --example boot_kernel --no-default-features --release`
- 用法: `boot_kernel.exe <vmlinuz> [initrd] [-- extra-cmdline-args...]`

### Step 5: VMM 子模块推进 — 设备仿真 + virtio-blk + init 接线 (2026-04-17~18)

已提交 6 个新 commit (c01cfd0..33080df), 将 libkrun 子模块从 kernel boot 推进到 box lifecycle:

| Commit | 描述 | 关键变更 |
|--------|------|---------|
| `c01cfd0` | MSR/CPUID 拦截 | 修复 WHPX triple fault; runner.rs, whpx.rs, types.rs |
| `ed14096` | WHPX 设备仿真 + 构建修复 | system_check.rs, build.rs, .cargo/config.toml |
| `acdb196` | virtio-blk 磁盘支持 | engine.rs 简化, system_check.rs 清理 |
| `5dc26ce` | root disk remount + init 接线 + stop 修复 | shim.rs Windows stop 实际调用 kill_process() |
| `9b7c7a1` | boot_kernel --init/--root 选项 | 子模块: init path, root device, argv |
| `33080df` | vendor ID 修复 + block error logging | 子模块: virtio vendor ID, 磁盘错误日志 |

**libkrun 子模块** 从 `f1ed2ca` 推进到 `f414587` (6 个新 commit):
- `0478cd6`: MSR/CPUID 拦截
- `4e81f72`: 完整 WHPX 设备仿真 (PIT/PIC/Serial 完善)
- `7bc1931`: virtio-blk 磁盘支持 + cmdline 细化
- `9c6d1dd`: root disk remount + init path 接线
- `0f0b803`: boot_kernel 示例扩展 (--init, --root, --fstype, --argv)
- `f414587`: vendor ID 修复 + block error logging

### Step 6: Windows image_disk.rs 增强 — 延迟符号链接 (未提交)

**新增功能**: OCI 层提取时收集符号链接, 通过 debugfs 在 ext4 镜像内创建

**关键变更 (未提交):**

| 文件 | 变更说明 |
|------|---------|
| `images/image_disk.rs` | `DeferredSymlink` 结构体; `extract_tar_entries()` 逐条提取 tar 条目, 收集符号链接; `create_symlinks_in_ext4()` 通过 debugfs 批量创建 |
| `disk/ext4.rs` | `get_debugfs_path()` 可见性提升为 `pub(crate)` |
| `util/binary_finder.rs` | Windows 路径分隔符 `;`; `.exe` 后缀自动查找 |
| `sdks/python/src/lib.rs` | tracing-subscriber 初始化 (非 Windows 相关, 调试辅助) |
| `sdks/python/Cargo.toml` | 添加 `tracing-subscriber` 依赖 |

**Code Review 发现的问题 (必须修复后再提交):**

| 严重性 | 问题 | 描述 |
|--------|------|------|
| **CRITICAL** | OCI whiteout 未处理 | `.wh.*` 文件 (OCI 层删除标记) 在 Windows 路径未处理, 导致被删除的文件仍存在于 ext4 镜像 |
| **MAJOR** | Windows 路径反斜杠 | `PathBuf::display()` 在 Windows 生成 `\`, debugfs 要求 `/`; 影响 `create_symlinks_in_ext4()` 中的 mkdir/symlink/sif 命令 |
| **MAJOR** | 常规文件解压失败被静默忽略 | `extract_tar_entries()` 对所有条目类型的解压失败都记录 debug 日志后继续, 应只对设备节点等静默跳过 |
| **MAJOR** | debugfs 失败不返回错误 | `create_symlinks_in_ext4()` 在 debugfs 非零退出码时 warn + `Ok(())`, 缺失符号链接会导致容器完全不可用 |
| **MINOR** | 跨层符号链接覆盖 | 后层应覆盖前层同路径符号链接 (OCI 语义), 当前 Vec 追加导致 debugfs 创建第一个后续失败 |
| **MINOR** | 无单元测试 | 新增的 3 个函数 (`extract_tar_entries`, `create_symlinks_in_ext4`, `DeferredSymlink`) 均无测试 |

### libkrun 子模块结构重构 (完成)
- `libkrun/Cargo.toml`: 依赖分为跨平台 (`log`, `vmm`) + Unix-only
- `libkrun/src/lib.rs`: Unix C API 包裹进 `mod unix_api` + `#[cfg(not(target_os = "windows"))]`; stub 函数无条件编译
- `vmm/Cargo.toml`: 依赖分为跨平台 + Unix-only + Windows-only (`windows-sys`, `zerocopy`, `rand`)
- `vmm/src/lib.rs`: 上游 VMM 基础设施 (builder, Vmm, Error 等) 门控为 `#[cfg(unix)]`
- 子模块 Commit: `f1ed2ca`

### Windows 测试修复 (完成)
修复所有 15 个预存在的 Windows 测试失败 (最终 495 pass, 0 fail):
- **rt_impl (8)**: 跨平台 `spawn_dummy_process()`, Windows kill
- **lock (2)**: 真实 `LockFileEx` 实现
- **db/boxes (1)**: `get_boot_id()` 通过 `OnceLock` 缓存
- **db/migration (2)**: 路径分隔符使用 `MAIN_SEPARATOR`
- **embedded (1)**: 同上
- **PID monitoring (1)**: 真实 `OpenProcess` + `GetExitCodeProcess`

### Windows 警告清理 (完成)
清理所有 42 个 Windows 警告:
- `#[cfg(unix)]` / `#[cfg(any(unix, feature = "krun"))]` 门控
- `#[allow(dead_code)]` 用于跨平台结构体字段
- `#[cfg(not(unix))] let _ = var;` 模式

### test-utils 跨平台 (完成)
- `symlink_or_exists()`: Unix symlink / Windows symlink_dir
- `flock_exclusive()`: Unix libc::flock / Windows OpenOptions
- `/tmp` -> `std::env::temp_dir()`

---

## 验证结果

### 单元测试

最后一次完整验证: commit `33080df` + 未提交变更 (2026-04-18)

| 平台 | 测试数 | 结果 | 验证时间 |
|------|--------|------|---------|
| macOS (ARM64) | 623 | 全部通过, clippy 0 warning, fmt clean | 2026-04-18 |
| Linux (Lima/Ubuntu aarch64) | 609 + 24 预存在失败 | 全部通过 (24 需要 /dev/kvm) | 2026-04-16 |
| Win10 (x86_64) | 495 | 全部通过, 0 警告 | 2026-04-16 (待重新验证) |

### WHPX 内核启动测试

| 测试项 | 结果 | 验证时间 |
|--------|------|---------|
| Linux 6.12.80-0-virt 启动到 shell | 通过 (~5 秒) | 2026-04-17 |
| MSR/CPUID 拦截 (6 MSR, 415 CPUID) | 通过 | 2026-04-17 |
| PIT 时间基准计数器 (20+ 单元测试) | 通过 | 2026-04-17 |
| 串口控制台输出 (13,481 字节) | 通过 | 2026-04-17 |
| 定时器中断 (PIC IRQ 0) | 通过 | 2026-04-17 |
| Initramfs 解包并执行 /init | 通过 | 2026-04-17 |

---

## 关键 cfg 门控模式

```rust
// 共享实现 (Unix + Windows with krun feature)
#[cfg(any(unix, feature = "krun"))]
fn shared_impl() { ... }

// 回退错误 (Windows without krun feature)
#[cfg(all(not(unix), not(feature = "krun")))]
fn fallback() { return Err(BoxliteError::Unsupported(...)); }

// Unix 专属 (overlayfs, xattr, etc.)
#[cfg(unix)]
fn unix_only() { ... }
```

---

## 接下来的计划

### 立即 (阻塞 E2E 测试)

1. **修复 image_disk.rs 代码质量问题** (CRITICAL/MAJOR)
   - [ ] 实现 OCI whiteout 处理 (`.wh.*` 文件)
   - [ ] 修复 Windows 路径反斜杠问题 (debugfs 要求 `/`)
   - [ ] 区分文件类型: 只对设备节点等静默跳过, 常规文件失败应报错
   - [ ] debugfs 失败应返回错误而非 `Ok(())`
   - [ ] 跨层符号链接去重 (后层覆盖前层)
   - [ ] 添加 debugfs 命令生成的单元测试

2. **Python SDK tracing 初始化应独立提交**
   - `sdks/python/` 的变更与 Windows WHPX 无关, 不应混在同一批

### 近期 (高优先级)

3. **Windows E2E 测试**
   - 验证完整 box 生命周期: create -> start -> exec -> stop
   - 验证 virtio 设备: 磁盘 (virtio-blk), 网络, vsock
   - 验证 OCI image 提取 + ext4 创建流程 (含符号链接)

4. **e2fsprogs 交叉编译管道**
   - 在 Linux 上交叉编译 mke2fs.exe / debugfs.exe
   - 打包到 Windows 分发包中

5. **PR 创建**
   - 分支 `feat/windows-whpx-support` 已有 14 个 commit (含子模块更新)
   - 需要 image_disk.rs 修复 + Windows E2E 验证通过后提交

### 中期

6. **CI/CD Windows 支持**
   - GitHub Actions Windows runner
   - 自动化 Windows 测试

### 长期

7. **Windows 安装包**
   - MSI / portable zip 分发
   - 包含 mke2fs.exe, debugfs.exe, protoc.exe

8. **Windows 文档**
   - 安装指南
   - WHPX 配置要求
   - 故障排除

---

## Git 提交历史

分支: `feat/windows-whpx-support` (14 commits on top of main)

| Commit | 描述 |
|--------|------|
| `33080df` | chore: update libkrun submodule (vendor ID fix, block error logging) |
| `9b7c7a1` | chore: update libkrun submodule (boot_kernel init/root options) |
| `5dc26ce` | feat(vmm): root disk remount, init wiring, and Windows stop fix |
| `acdb196` | feat(vmm): virtio-blk disk support and WHPX cmdline updates |
| `ed14096` | feat(vmm): WHPX device emulation and build fixes for Linux kernel boot |
| `c01cfd0` | feat(vmm): intercept MSR/CPUID exits to fix WHPX triple fault during Linux boot |
| `5e666a6` | feat(vmm): configure kernel boot for Windows WHPX and update libkrun submodule |
| `d619f0c` | feat(vmm): implement WhpxProbe with dynamic WHPX detection |
| `360b118` | feat(test-utils): make test utilities cross-platform |
| `e41f95f` | fix(boxlite): fix Windows test failures across 6 test modules |
| `af11871` | feat(boxlite): wire Windows integration for box lifecycle |
| `ef9d582` | refactor(boxlite): gate Unix-only code for Windows compilation |
| `1e4fc3b` | feat(vmm): add Windows WHPX engine and platform primitives |
| `f1ebccb` | feat(libkrun-sys): add Windows WHPX FFI bridge |

libkrun 子模块 (8 commits on top of upstream `060eb87`):

| Commit | 描述 |
|--------|------|
| `f414587` | fix(vmm): set valid virtio vendor ID and add block error logging |
| `0f0b803` | feat(vmm): add --init, --root, --fstype, --argv options to boot_kernel example |
| `9c6d1dd` | feat(vmm): wire root disk remount and init path into WHPX kernel cmdline |
| `7bc1931` | feat(vmm): add virtio-blk disk support and WHPX cmdline refinements |
| `4e81f72` | feat(vmm): complete WHPX device emulation for Linux kernel boot |
| `0478cd6` | feat(vmm): intercept MSR/CPUID exits to fix WHPX triple fault during Linux boot |
| `f1ed2ca` | refactor: gate Unix-only code and add Windows platform support |
| `49c951b` | feat: add Windows WHPX hypervisor backend |

### 未提交变更 (2026-04-18)

**父仓库 (6 files):**

| 文件 | 变更说明 | 状态 |
|------|---------|------|
| `images/image_disk.rs` | 延迟符号链接: `DeferredSymlink`, `extract_tar_entries()`, `create_symlinks_in_ext4()` | **需修复** (见 Code Review) |
| `disk/ext4.rs` | `get_debugfs_path()` 提升为 `pub(crate)` | OK |
| `util/binary_finder.rs` | Windows 路径分隔符 `;`, `.exe` 后缀查找 | OK |
| `sdks/python/src/lib.rs` | tracing-subscriber 初始化 | OK (应独立提交) |
| `sdks/python/Cargo.toml` | 添加 `tracing-subscriber` 依赖 | OK (应独立提交) |
| `Cargo.lock` | 对应 Cargo.toml 变更 | OK |

---

## 文件变更统计

| 类别 | 文件数 |
|------|--------|
| 新增文件 | 3 (port.rs, job_object.rs, windows_api.rs) |
| 已删除文件 | 1 (builder_vm.rs) |
| 修改文件 | ~46 (含未提交 6 文件) |
| 新增测试 | ~20 |
| VMM 移植文件 | 33 |
| libkrun 子模块 commits | 8 (49c951b..f414587) |
| 父仓库 commits | 14 (f1ebccb..33080df) |
| 烟雾测试 | 1 (boot_kernel.rs) |

## 迁移准则合规性评估 (2026-04-18 更新)

### 已通过

| 准则 | 评估 | 说明 |
|------|------|------|
| **P1: 最大化 libkrun 复用** | PASS | 协议/模式级复用 ~40%; 所有新代码遵循 libkrun 调用约定 |
| **P2: 解释平台差异** | PASS | 每个差异都有技术理由; 无不必要的差异 |
| **P3: Windows 性能对等** | CONDITIONAL PASS | WHPX 固有 ~40% 开销; 迁移未引入额外开销 |

### 违反项 (未提交代码)

| 准则 | 违反 | 说明 |
|------|------|------|
| CLAUDE.md Rule #3 (Search Before Implement) | image_disk.rs | Unix 路径已有 whiteout 处理 (`rootfs/operations.rs:process_whiteouts`, `rootfs/builder.rs:copy_directory_overlay`), Windows 路径未复用 |
| CLAUDE.md Rule #6 (Explicit Errors) | image_disk.rs | `create_symlinks_in_ext4()` 在 debugfs 失败时返回 `Ok(())`, 不符合显式错误准则 |
| CLAUDE.md Post-Coding Checklist: Tests | image_disk.rs | 新增 3 个函数无对应测试, 违反 "每个新行为都必须有测试" |
| CLAUDE.md Rule #11 (Validate Early) | image_disk.rs | 解压失败时不区分条目类型, 常规文件失败应尽早报错 |
