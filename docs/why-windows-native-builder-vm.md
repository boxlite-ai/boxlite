# Why Windows Needs a Builder VM for ext4 Operations

## English

### Background

BoxLite creates ext4 disk images from OCI container layers as part of its image pipeline. On Unix (Linux/macOS), this uses host-native tools:

- **`mke2fs -d`** — creates an ext4 image and populates it from a directory/tarball (bundled via `e2fsprogs-sys`)
- **`debugfs -w -R write`** — injects individual files into an existing ext4 image

On Windows, these tools have no native equivalent. BoxLite solves this by booting a lightweight Alpine Linux VM (the "builder VM") that runs the same `mke2fs`/`debugfs` tools inside the guest.

This document investigates whether Windows-native alternatives exist that could replace the builder VM approach.

### Research Summary

**Conclusion: No viable Windows-native replacement exists. The builder VM remains the best approach.**

Five directions were investigated, and none can fully replace the builder VM:

### 1. Upstream e2fsprogs (tytso/e2fsprogs)

**Status: Partial support, actively maintained**

Upstream e2fsprogs added `windows_io_manager` since v1.46.2. Versions v1.47.1 and v1.47.3 fixed Windows-specific bugs (creating non-existent files, supporting >2GB images). A [mke2fs Windows build patch](https://www.spinics.net/lists/linux-ext4/msg86980.html) replaced `unix_io_manager` with a `default_io_manager` macro.

| Tool | Windows compile status | Key issue |
|------|----------------------|-----------|
| **mke2fs** | Basically works | `mke2fs -d` (populate from directory) **unverified on Windows** |
| **debugfs** | **Unverified** | Upstream patches and release notes **never mention** debugfs Windows support |

**Build method**: Requires MinGW/MSYS2 cross-compilation, no MSVC support. [Issue #176](https://github.com/tytso/e2fsprogs/issues/176) reports missing POSIX signal functions (`sigemptyset`, `sigprocmask`).

**Risks**:
- `mke2fs -d` is our core dependency (populate ext4 from directory/tarball), unverified on Windows
- debugfs may not compile at all
- Requires MinGW runtime dependency (not pure MSVC native)

### 2. danielhousar/e2fsprogs_win32

**Status: Abandoned**

- Based on e2fsprogs **v1.41.14** (2010 vintage, 16 years old)
- Includes mke2fs and e2fsck, **unclear if debugfs is included**
- Compiled with MinGW GCC >= 4.4.0
- **Long unmaintained**
- v1.41 does not support `mke2fs -d` (feature added in v1.42+)

**Not viable**: Version too old, lacks critical features.

### 3. Ext2Fsd bundled mke2fs.exe

**Status: Abandoned (last update 2017)**

- Ext2Fsd v0.69 includes mke2fs.exe, installs to `system32`
- Based on a **very old** e2fsprogs version
- Does not support `mke2fs -d`
- **Does not include debugfs**
- Only supports physical partition formatting, not image file creation

**Not viable**: Functionality does not meet requirements.

### 4. AOSP make_ext4fs

**Status: Available but different functionality**

- Android toolchain's [make_ext4fs](https://github.com/superr/make_ext4fs), Windows Cygwin version exists
- Can only create ext4 images, **cannot inject files into existing images** (no debugfs equivalent)
- Sparse image format not fully compatible with standard ext4

**Not viable**: Lacks inject_file capability.

### 5. Pure Rust ext4 Libraries

**Status: Read-only, no write support**

- [ext4-view](https://crates.io/crates/ext4-view) — read-only, no_std, explicitly states write is a non-goal
- [ext4fs](https://lib.rs/crates/ext4fs) — read-only

**Not viable**: No Rust library exists for creating/writing ext4 filesystems.

### Comparison Table

| Approach | mke2fs | mke2fs -d | debugfs | Maintenance | Viability |
|----------|--------|-----------|---------|-------------|-----------|
| Upstream e2fsprogs (MinGW) | Basically works | **Unverified** | **Unverified** | Active | Requires significant validation |
| e2fsprogs_win32 | Yes | No (v1.41) | Unclear | Abandoned | Not viable |
| Ext2Fsd mke2fs.exe | Yes | No | No | Abandoned | Not viable |
| AOSP make_ext4fs | Yes | Yes | No | Low activity | Partially viable |
| Rust ext4 crate | No | No | No | Active (read-only) | Not viable |
| **Builder VM (current)** | **Full** | **Full** | **Full** | **We control** | **Fully viable** |

### Verification Results (2026-04-14)

We successfully compiled e2fsprogs v1.47.4 on Windows 10 using MSYS2/MinGW-w64 (GCC 15.2.0). The build required patching several files for Windows compatibility:

**Patches applied:**
- `lib/ss/help.c` — stubbed `fork()`/`wait()` (pager not needed)
- `lib/ss/listen.c` — added POSIX signal stubs via `win_compat.h`
- `lib/ss/pager.c` — `#ifdef _WIN32` guard (no fork/pipe)
- `lib/ss/list_rqs.c` — guarded `<sys/wait.h>`
- `debugfs/debugfs.c` — `unix_io_manager` → `default_io_manager`
- `debugfs/journal.c` — same io_manager fix
- `debugfs/util.c` — guarded `SIGPIPE`
- `debugfs/dump.c` — stubbed `fchmod`/`chown`/`symlink`, fixed `mkdir` signature

**Runtime dependency:** Only `libwinpthread-1.dll` (47KB) from MinGW.

| Tool | Status | Notes |
|------|--------|-------|
| `mke2fs` (no -d) | **Works** | Creates empty ext4 image |
| `mke2fs -d` | **Broken** | `__populate_fs` has path encoding bug (garbled `lstat` paths) |
| `debugfs -R "ls"` | **Works** | Lists ext4 contents |
| `debugfs -R "cat"` | **Works** | Reads files from ext4 |
| `debugfs -w -R "mkdir"` | **Works** | Creates directories in ext4 |
| `debugfs -w -R "write"` | **Works** | Injects host files into ext4 (requires `C:/` paths, not `/c/`) |
| `debugfs -w -f batch.txt` | **Works** | Batch inject multiple files in one invocation |

**Performance (Win10, MBP 2014):**

| Operation | Native tools | Builder VM |
|-----------|-------------|-----------|
| Create 16MB ext4 | 2.2s (`mke2fs`) | ~3.5s (`build_ext4`) |
| Create 64MB ext4 | 7.5s (`mke2fs`) | ~3.5s (`build_ext4`) |
| Inject 10 files (batch) | **33ms** (`debugfs -f`) | ~1.5s (`inject_file`) |
| Inject 1 file | **23ms** (`debugfs -R`) | ~1.5s (`inject_file`) |

**Key finding:** `debugfs -f` batch mode is **~45x faster** than builder VM `inject_file()` for per-file injection. However, `mke2fs` is slower than the builder VM for full rootfs creation because `mke2fs -d` doesn't work, so all files must be injected individually.

### Recommendation

**Hybrid approach is optimal:**

1. **For `inject_file()` (single file injection):** Use native `debugfs.exe` — **45x faster** (23ms vs 1.5s), no VM boot overhead
2. **For `build_ext4()` (full rootfs creation):** Continue using builder VM — `mke2fs -d` doesn't work natively, and injecting hundreds of files individually would be slower than one VM boot with in-guest `mke2fs -d`

**Implementation plan:**
- Bundle `mke2fs.exe` + `debugfs.exe` + `libwinpthread-1.dll` (~6MB total) in the BoxLite runtime
- Replace `ImageBuilder::inject_file()` (builder VM) with native `debugfs.exe -w -R "write ..."` call
- Keep `ImageBuilder::build_ext4()` (builder VM) for full rootfs creation
- Long-term: fix `mke2fs -d` path encoding bug to eliminate builder VM entirely

### Sources

- [tytso/e2fsprogs — Official repository](https://github.com/tytso/e2fsprogs)
- [Building for Windows — Issue #176](https://github.com/tytso/e2fsprogs/issues/176)
- [mke2fs: fix Windows build patch](https://www.spinics.net/lists/linux-ext4/msg86980.html)
- [danielhousar/e2fsprogs_win32](https://github.com/danielhousar/e2fsprogs_win32)
- [Ext2Fsd — SourceForge](https://sourceforge.net/projects/ext2fsd/)
- [Ext2Fsd mke2fs downloads](https://sourceforge.net/projects/ext2fsd/files/Mke2fs/)
- [E2fsprogs Release Notes](https://e2fsprogs.sourceforge.net/e2fsprogs-release.html)
- [ext4-view Rust crate](https://crates.io/crates/ext4-view)
- [AOSP make_ext4fs](https://github.com/superr/make_ext4fs)

---

## 中文

### 背景

BoxLite 在镜像流水线中需要从 OCI 容器层创建 ext4 磁盘镜像。在 Unix（Linux/macOS）上，使用主机原生工具：

- **`mke2fs -d`** — 创建 ext4 镜像并从目录/tarball 填充内容（通过 `e2fsprogs-sys` 绑定）
- **`debugfs -w -R write`** — 向已有 ext4 镜像注入单个文件

Windows 上没有这些工具的原生等价物。BoxLite 通过启动一个轻量级 Alpine Linux VM（"builder VM"）来解决，在虚拟机内运行相同的 `mke2fs`/`debugfs` 工具。

本文调研 Windows 上是否存在可替代 builder VM 的原生方案。

### 调研结论

**结论：不存在可行的 Windows 原生替代方案。Builder VM 仍是最佳选择。**

共调研了 5 个方向，均无法完全替代 builder VM：

### 1. 上游 e2fsprogs 官方 (tytso/e2fsprogs)

**状态：部分支持，活跃维护中**

上游 e2fsprogs 从 v1.46.2 起加入了 `windows_io_manager`，在 v1.47.1 和 v1.47.3 修复了 Windows 相关 bug（创建不存在的文件、支持 >2GB 镜像）。有人提交过 [mke2fs Windows build patch](https://www.spinics.net/lists/linux-ext4/msg86980.html)，将 `unix_io_manager` 替换为 `default_io_manager` 宏。

| 工具 | Windows 编译状态 | 关键问题 |
|------|-----------------|---------|
| **mke2fs** | 基本可用 | `mke2fs -d`（从目录填充）能否在 Windows 上工作**未经验证** |
| **debugfs** | **未验证** | 上游补丁和 release notes **从未提及** debugfs 的 Windows 支持 |

**编译方式**：需要 MinGW/MSYS2 交叉编译，不支持 MSVC。[Issue #176](https://github.com/tytso/e2fsprogs/issues/176) 报告了 POSIX signal 函数 (`sigemptyset`, `sigprocmask`) 缺失问题。

**风险**：
- `mke2fs -d` 是我们的核心依赖（从目录/tarball 填充 ext4），Windows 上未经验证
- debugfs 可能根本无法编译
- 需要 MinGW 运行时依赖（不是纯 MSVC 原生）

### 2. danielhousar/e2fsprogs_win32

**状态：废弃**

- 基于 e2fsprogs **v1.41.14**（2010 年版本，距今 16 年）
- 包含 mke2fs 和 e2fsck，**不确定是否包含 debugfs**
- MinGW GCC >= 4.4.0 编译
- **长期未维护**
- v1.41 不支持 `mke2fs -d` 选项（该功能在 v1.42+ 才加入）

**不可用**：版本太旧，缺少关键功能。

### 3. Ext2Fsd 附带的 mke2fs.exe

**状态：废弃（2017 年停更）**

- Ext2Fsd v0.69 包含 mke2fs.exe，安装到 `system32`
- 基于**极老版本**的 e2fsprogs
- 不支持 `mke2fs -d` 选项
- **不包含 debugfs**
- 仅支持物理分区格式化，不支持镜像文件创建

**不可用**：功能不满足需求。

### 4. AOSP make_ext4fs

**状态：可用但功能不同**

- Android 工具链中的 [make_ext4fs](https://github.com/superr/make_ext4fs)，有 Windows Cygwin 版本
- 只能创建 ext4 镜像，**不能向已有镜像注入文件**（无 debugfs 等效功能）
- sparse image 格式与标准 ext4 不完全兼容

**不可用**：缺少 inject_file 能力。

### 5. 纯 Rust ext4 库

**状态：仅读取，无写入**

- [ext4-view](https://crates.io/crates/ext4-view) — 只读，no_std，明确声明 write 是 non-goal
- [ext4fs](https://lib.rs/crates/ext4fs) — 只读

**不可用**：没有创建/写入 ext4 的 Rust 库。

### 对比总结

| 方案 | mke2fs | mke2fs -d | debugfs | 维护状态 | 可用性 |
|------|--------|-----------|---------|---------|-------|
| 上游 e2fsprogs (MinGW) | 可用 | **不可用** (路径bug) | **可用** | 活跃 | 部分可用 (已验证) |
| e2fsprogs_win32 | 有 | 无 (v1.41) | 不确定 | 废弃 | 不可用 |
| Ext2Fsd mke2fs.exe | 有 | 无 | 无 | 废弃 | 不可用 |
| AOSP make_ext4fs | 有 | 有 | 无 | 低活跃 | 部分可用 |
| Rust ext4 crate | 无 | 无 | 无 | 活跃(只读) | 不可用 |
| **Builder VM (当前方案)** | **完整** | **完整** | **完整** | **我们控制** | **完全可用** |

### 建议

**Builder VM 方案仍是当前最佳选择。** 理由：

1. **功能完整性**：builder VM 内运行的是完整的 Linux e2fsprogs，`mke2fs -d` 和 `debugfs` 都正常工作
2. **零移植风险**：不需要解决 POSIX signal、MinGW 运行时、Windows IO manager 等移植问题
3. **性能可接受**：`build_ext4` ~3.5s + `inject_file` ~1.5s，且结果缓存在 `~/.boxlite/images/disk-images/`
4. **唯一可能的替代**是尝试从上游 e2fsprogs 用 MinGW 交叉编译 mke2fs.exe + debugfs.exe，但这需要：验证 `mke2fs -d` 是否工作、验证 debugfs 是否能编译、处理 MinGW 运行时依赖。投入产出比不高。

### 参考来源

- [tytso/e2fsprogs — 官方仓库](https://github.com/tytso/e2fsprogs)
- [Building for Windows — Issue #176](https://github.com/tytso/e2fsprogs/issues/176)
- [mke2fs: fix Windows build patch](https://www.spinics.net/lists/linux-ext4/msg86980.html)
- [danielhousar/e2fsprogs_win32](https://github.com/danielhousar/e2fsprogs_win32)
- [Ext2Fsd — SourceForge](https://sourceforge.net/projects/ext2fsd/)
- [Ext2Fsd mke2fs 下载](https://sourceforge.net/projects/ext2fsd/files/Mke2fs/)
- [E2fsprogs Release Notes](https://e2fsprogs.sourceforge.net/e2fsprogs-release.html)
- [ext4-view Rust crate](https://crates.io/crates/ext4-view)
- [AOSP make_ext4fs](https://github.com/superr/make_ext4fs)
