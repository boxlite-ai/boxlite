# Phase 3a: Windows OCI 镜像流水线设计

> BoxLite Windows 平台 OCI 镜像支持设计文档
> 作者: Claude (AI) + lilongen | 日期: 2026-04-11

## 问题陈述

BoxLite 的 OCI 镜像流水线使用 Unix 专有 API 来解压容器层并创建 ext4 磁盘镜像。
在 Windows (NTFS) 上，这些 API 不可用：

| Unix API | 用途 | NTFS 等价物 |
|----------|------|-------------|
| `libc::mknod()` | 创建设备节点 (block/char) | 无 |
| `libc::mkfifo()` | 创建命名管道 (FIFO) | `CreateNamedPipe` (语义不同) |
| `std::os::unix::fs::symlink()` | 创建符号链接 | `CreateSymbolicLink` (需要特权) |
| `libc::lchown()` | 设置文件所有权 (UID/GID) | SID (不兼容的模型) |
| `xattr::set()` | 设置扩展属性 | NTFS ADS (不同的 API) |
| `mke2fs` | 创建 ext4 文件系统 | 无 Windows 构建 |
| `debugfs` | 修改 ext4 文件系统 | 无 Windows 构建 |
| `cp -a` | 保留元数据的复制 | `robocopy /COPY:DAT` (有损) |

流水线的输出始终是 **ext4 磁盘镜像** — 无论宿主机操作系统如何，客户机 VM 都将
挂载它。核心问题是：如何在 Windows 上创建该 ext4 镜像？

## 现有流程 (Unix)

```
OCI Registry
    |
    v
+------------------+
| 1. 拉取镜像       |  <-- oci-client crate (跨平台)
|    (tar blobs)    |
+--------+---------+
         |
         v
+------------------+
| 2. 解压层         |  <-- tar.rs: symlink, mknod, lchown, xattr (仅 UNIX)
|    到宿主文件系统  |
+--------+---------+
         |
         v
+------------------+
| 3. 创建 ext4      |  <-- mke2fs + debugfs (仅 UNIX)
|    磁盘镜像       |
+--------+---------+
         |
         v
+------------------+
| 4. QCOW2 COW     |  <-- qcow2-rs crate (跨平台)
|    叠加层         |
+--------+---------+
         |
         v
+------------------+
| 5. 启动 VM        |  <-- libkrun/libwkrun (平台相关，已完成)
+------------------+
```

步骤 2 和 3 是阻塞项。步骤 1、4、5 已经是跨平台的。

## 核心洞察

我们不需要将 OCI 层解压到 NTFS。我们需要的是从 **tar blobs 直接生成 ext4 磁盘
镜像**。中间步骤"解压到宿主文件系统"是实现细节，而非必要需求。

---

## 方案对比

### 方案 A: Builder VM (推荐)

使用 libwkrun 启动一个临时 Linux 辅助 VM 来创建 ext4 磁盘。

```
Windows 宿主机                        Builder VM (Linux)
+---------------+                    +---------------------+
| 拉取 OCI       |                    |                     |
| tar blobs     |---- virtio-blk --->| 解压 tar 层          |
|               |     (包含 tar 数据  | mke2fs -d /merged   |
|               |      的原始磁盘)    | debugfs 修复所有权   |
|               |                    |                     |
|               |<--- virtio-blk ----| 输出: ext4 镜像      |
| 安装 ext4      |     (ext4 结果)    |                     |
| 到缓存         |                    | 退出                 |
+---------------+                    +---------------------+
```

**流程：**
1. 收集 OCI tar 层 blobs (已下载到缓存)
2. 创建包含 tar blobs 的原始磁盘镜像 (附带清单文件)
3. 使用以下组件启动 builder VM：kernel + initramfs + 输入磁盘 + 输出磁盘
4. Builder initramfs 脚本：读取 tar blobs，解压，运行 mke2fs，写入结果
5. Builder VM 退出；宿主机从输出磁盘读取 ext4 结果
6. 缓存 ext4 磁盘镜像 (与现有 `ImageDiskManager` 缓存机制相同)

**实现文件：**

```
src/boxlite/src/
  images/
    builder_vm.rs      # 新增: Builder VM 编排逻辑
    builder_vm/
      kernel           # 内嵌: linux-virt 内核 (~8MB 压缩后)
      initramfs.cpio   # 内嵌: BusyBox + mke2fs + 构建脚本 (~3MB)
```

Builder initramfs 内容：
- BusyBox (shell, tar, cp)
- mke2fs + debugfs (e2fsprogs 静态链接)
- Builder 脚本：`/init` (解压层，创建 ext4，发送完成信号)

**优点：**
- 零修改现有解压/ext4 代码 (在 VM 内复用 tar.rs、ext4.rs)
- 完整的 OCI 保真度 (设备节点、符号链接、xattr、所有权)
- 相同的缓存语义 (按镜像摘要缓存磁盘镜像)
- Docker Desktop 使用完全相同的架构 (LinuxKit VM)

**缺点：**
- VM 启动延迟 (~2-5s / 新镜像，通过缓存摊销)
- 增加内嵌二进制大小 (~11MB 内核 + initramfs)
- 编排逻辑较复杂 (virtio-blk 数据传递)

**工作量：** ~2 周

---

### 方案 B: 纯 Rust ext4 写入器

完全用 Rust 实现 ext4 镜像创建，绕过宿主文件系统。

```
tar blob --> tar crate 解析器 --> ext4 写入器 --> ext4 磁盘镜像
```

**流程：**
1. 使用 `tar` crate 解析每个 tar 层 (已有依赖)
2. 处理 OCI whiteout (`.wh.` 文件，表示层删除)
3. 将文件/目录/符号链接/设备节点直接写入 ext4 镜像结构
4. 输出：ext4 磁盘镜像 (与 mke2fs 输出格式相同)

**实现文件：**

```
src/boxlite/src/
  disk/
    ext4_writer.rs     # 新增: 纯 Rust ext4 文件系统构建器
    ext4_writer/
      superblock.rs    # Ext4 超级块 + 块组描述符
      inode.rs         # Inode 表管理
      directory.rs     # 目录项哈希树
      extent.rs        # 基于 extent 的块分配
      journal.rs       # 最小化日志 (clean unmount)
```

**优点：**
- 无 VM 开销 (瞬间创建磁盘)
- 无内嵌二进制 (更小的发行包)
- 完全跨平台 (任何 OS 都能工作)
- 可替代所有平台上的 mke2fs

**缺点：**
- 复杂 (~4000-5000 行 ext4 布局代码)
- 目前没有生产可用的 Rust ext4 写入 crate
- 需要处理：extent 树、哈希树目录、日志、块分配
- 存在 ext4 兼容性 bug 风险
- 最小实现不支持 xattr (可后续添加)

**工作量：** ~4-6 周

---

### 方案 C: WSL2 辅助

通过 WSL2 调用 Linux 工具。

```
boxlite.exe --> wsl.exe tar xf ... --> wsl.exe mke2fs ... --> ext4 disk
```

**优点：**
- 实现最简单 (~200 行代码)
- 完整的工具可用性 (mke2fs, debugfs, cp, tar)

**缺点：**
- 需要安装 WSL2 + Linux 发行版 (~300MB)
- 用户必须管理 WSL 设置
- 在没有 Hyper-V 的 Windows Server 上不可用
- 通过 9P 文件系统的跨 VM 文件 I/O 较慢

**工作量：** ~1 周

---

## 推荐方案

**首选方案 A (Builder VM)**，后续可选择性添加方案 B 作为优化。

**理由：**
1. 我们已经为客户机 VM 提供了 Linux 内核 + initramfs
2. libwkrun 已经能在 Windows 上启动 VM (Phase M1 已完成)
3. Builder VM 100% 复用现有的解压代码
4. Docker Desktop 在大规模场景下验证了此架构
5. ~2-5s 的延迟对新镜像是可接受的 (首次拉取后即缓存)
6. 方案 B 可作为无 VM 快速路径在后续添加

### 为什么不用 WSL2？

WSL2 是一个硬依赖，许多 Windows 用户没有安装。BoxLite 的核心价值是
"无守护进程、无需 root、直接嵌入" — 要求 WSL2 与此相矛盾。Builder VM 方案
完全自包含在 BoxLite 运行时内。

### 为什么不先做纯 Rust？

ext4 文件系统格式非常复杂。一个正确的实现需要：
- 超级块 + 块组描述符
- Inode 分配 + extent 树
- 哈希树目录 (htree)
- 日志初始化 (clean unmount 标记)
- 块分配位图管理
- 特殊 inode 处理 (lost+found, resize_inode)

这是 ~4000-5000 行底层文件系统代码。先用 Builder VM 可以在 2 周内实现可用的
Windows 支持；之后再将 Rust ext4 写入器作为性能优化添加。

---

## 详细设计：方案 A (Builder VM)

### 1. Builder 镜像

**内嵌在 BoxLite 二进制中** (类似现有的 `embedded-runtime` 特性)：

| 组件 | 大小 (压缩后) | 来源 |
|------|-------------|------|
| `vmlinuz-virt` | ~5MB | Alpine `linux-virt` 包 |
| `initramfs-builder.cpio.gz` | ~3MB | 自定义：BusyBox + e2fsprogs |
| **合计** | ~8MB | |

Builder 内核与客户机内核相同。initramfs 不同：是一个包含解压工具的最小环境，
而非客户机代理。

**Initramfs `/init` 脚本：**

```sh
#!/bin/sh
set -e

# 挂载输入磁盘 (tar 层清单 + blobs)
mkdir -p /input /output /merged
mount /dev/vda /input      # virtio-blk: tar 数据
mount /dev/vdb /output     # virtio-blk: 结果 ext4

# 读取清单 (层数量、大小、偏移)
. /input/manifest.sh

# 按顺序解压层 (与 tar.rs 逻辑一致)
for layer in $LAYERS; do
    tar xf "/input/$layer" -C /merged
done

# 处理 whiteout (OCI 层删除标记)
find /merged -name '.wh.*' -exec sh -c '
    name="${1##*.wh.}"
    dir="$(dirname "$1")"
    rm -rf "$dir/$name" "$1"
' _ {} \;

# 创建 ext4 镜像
mke2fs -t ext4 -d /merged -r 1 -N 0 -m 0 \
    -O ^has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize \
    /output/image.ext4 ${DISK_SIZE_BLOCKS}

# 修复所有权 (所有文件设为 root:root，如果当前非 root)
if [ $(id -u) -ne 0 ]; then
    debugfs -w -f /tmp/fix_owner.cmds /output/image.ext4
fi

# 发送完成信号
echo "DONE" > /output/.complete
poweroff -f
```

### 2. 数据传递方式：virtio-blk

使用两个原始磁盘镜像在宿主机与 builder VM 之间传递数据：

**输入磁盘** (宿主机 --> builder)：
```
+----------------------------------+
| 分区 1: ext4 (或原始格式)         |
|   /manifest.sh                   |  <-- 层名称、大小
|   /layer-0.tar.gz                |  <-- OCI 层 blob
|   /layer-1.tar.gz                |  <-- OCI 层 blob
|   ...                            |
+----------------------------------+
```

**输出磁盘** (builder --> 宿主机)：
```
+----------------------------------+
| 原始 ext4 镜像                    |  <-- 完成的 rootfs
|   /bin /etc /usr /var ...        |
|   /.complete                     |  <-- 哨兵文件
+----------------------------------+
```

**替代方案：9P 文件系统共享**

如果 libwkrun 的 virtio-9p 可用 (已可用 — libwkrun Phase 1)，可以共享宿主机
目录代替原始磁盘镜像：

```
宿主机目录: %TEMP%\boxlite-builder-{id}\
  input/
    manifest.sh
    layer-0.tar.gz
    layer-1.tar.gz
  output/
    image.ext4       <-- Builder 将结果写入此处
```

9P 方案更简单 (无需创建磁盘镜像)，但对大文件较慢。
对于典型 OCI 镜像 (<1GB)，差异可忽略。

**建议：** 先用 9P (更简单)，如有需要再优化为 virtio-blk。

### 3. API 设计

```rust
// src/boxlite/src/images/builder_vm.rs

/// 使用 Linux 辅助 VM 从 OCI 层构建 ext4 磁盘镜像。
///
/// 在 Unix 上不会被调用 (使用原生 mke2fs 路径)。
/// 在 Windows 上替代原生 ext4 创建路径。
pub struct ImageBuilder {
    kernel_path: PathBuf,
    initramfs_path: PathBuf,
}

impl ImageBuilder {
    /// 从 OCI 层 tar blobs 创建 ext4 磁盘镜像。
    ///
    /// 启动一个临时 builder VM，通过 9P 共享传递 tar 层，
    /// 收集生成的 ext4 镜像。
    pub async fn build_ext4(
        &self,
        layer_tarballs: &[PathBuf],
        output_path: &Path,
        disk_size: u64,
    ) -> BoxliteResult<()> {
        // 1. 创建包含输入文件的临时目录
        // 2. 写入 manifest.sh
        // 3. 符号链接/复制 tar 层到 input/
        // 4. 使用 9P 共享启动 builder VM
        // 5. 等待 VM 退出
        // 6. 验证 output/.complete 存在
        // 7. 移动 output/image.ext4 到 output_path
    }
}
```

### 4. 集成点

**`ImageDiskManager::build_and_install()`** — 主调用方：

```rust
// 当前 (Unix):
let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;
let temp_disk = create_ext4_from_dir(&prepared_path, &disk_clone)?;

// 新增 (Windows):
#[cfg(unix)]
{
    let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;
    let temp_disk = create_ext4_from_dir(&prepared_path, &disk_clone)?;
}
#[cfg(windows)]
{
    let layer_tarballs = image.layer_tarballs();
    let builder = ImageBuilder::from_embedded_runtime()?;
    builder.build_ext4(&layer_tarballs, &temp_disk_path, disk_size).await?;
}
```

**`GuestRootfsManager`** — 客户机二进制注入：

当前使用 `inject_file_into_ext4()` (debugfs)。在 Windows 上，builder VM 也可以
处理此操作 — 将客户机二进制文件与层一起传递。

或者，通过第二次 builder VM 调用注入，或将客户机二进制包含在 9P 共享中。

### 5. 缓存

缓存层 (`ImageDiskManager`) 保持不变。缓存键是 OCI 镜像摘要。无论 ext4 是由
mke2fs 还是 builder VM 创建，输出格式相同，存储在相同的缓存目录中。

首次拉取新镜像：
1. 下载 tar blobs (与现在相同)
2. 通过 builder VM 创建 ext4 (~5-10s: 2s 启动 + 解压时间)
3. 缓存 ext4 到 `~/.boxlite/images/disk-images/{digest}.ext4`

后续使用：
1. 缓存命中 --> 立即返回 (与现在相同)

### 6. 客户机二进制注入

当前方案：`inject_file_into_ext4()` 使用 `debugfs write` 在创建 ext4 后注入
`boxlite-guest`。

**Windows 方案选项：**

a) **包含在 builder VM 中** — 将客户机二进制传递给 builder VM，在 ext4 创建期间
   注入。需要 builder initramfs 处理注入逻辑。

b) **单独的注入 VM** — 启动一个小型 VM 仅运行 `debugfs write`。
   更简单但多一次 VM 启动。

c) **预注入到层中** — 将客户机二进制作为额外"层"添加到 OCI 层之上。Builder VM
   将其视为普通文件处理。

**推荐：** 选项 (c) — 将客户机二进制作为附加文件放入 9P 共享。Builder 脚本在
运行 mke2fs 之前将其复制到正确位置。这避免了第二次 VM 启动，并自然地集成到
现有流程中。

---

## 实施计划

### Phase 3a-1: Builder Initramfs (1 周)

1. 创建基于 Alpine 的 initramfs，包含 BusyBox + e2fsprogs (静态链接)
2. 编写 `/init` builder 脚本
3. 手动测试：使用 libwkrun 启动，传递测试数据，验证 ext4 输出
4. 压缩并内嵌到 BoxLite 二进制中

### Phase 3a-2: ImageBuilder API (1 周)

1. `images/builder_vm.rs` — VM 编排逻辑
2. 通过 `#[cfg(windows)]` 集成到 `ImageDiskManager::build_and_install()`
3. 处理客户机二进制注入 (选项 c)
4. 集成测试 (CI 使用 mock VM，本地测试使用真实 VM)

### Phase 3a-3: 端到端测试 (3 天)

1. 在 Win10 开发机上测试：`boxlite run alpine echo hello`
2. 验证缓存工作正常 (第二次运行命中缓存)
3. 验证复杂镜像 (多层、符号链接、设备节点)
4. 性能基准测试 (首次拉取 vs 缓存命中)

---

## 待决问题

1. **内嵌大小预算**：新增 ~8MB 的 builder 内核 + initramfs。对于 embedded-runtime
   特性是否可接受？客户机内核已经 ~5MB。

2. **Builder VM 内存**：Builder 需要多少 RAM？mke2fs + tar 解压通常需要 ~256MB。
   可配置。

3. **并行镜像构建**：如果多个 box 同时拉取不同镜像，builder VM 是否应并行运行？
   libwkrun 支持多个 VM。

4. **非 libwkrun 后端的回退**：如果有人在没有 libwkrun 的情况下将 BoxLite 移植到
   Windows (例如 Hyper-V 后端)，builder VM 需要与该引擎兼容。`ImageBuilder` 应使用
   引擎抽象层，而非直接依赖 libwkrun。

---

## 考虑过的替代方案

### Rust ext4 crate (ext4-rs)

`ext4-rs` crate 是**只读的**。目前没有生产可用的 Rust ext4 写入库。从零编写需要
~4000-5000 行代码和深入的文件系统知识。

### FUSE + ext4fuse (Windows)

Windows FUSE (WinFsp) + ext4 驱动可以在 Windows 上挂载 ext4 镜像。但这增加了
内核驱动依赖，且不解决创建问题。

### Docker-in-Docker 方案

使用 Docker Desktop 的 VM 来创建镜像。这违背了 BoxLite "无需守护进程" 的初衷。

### 预构建镜像仓库

为常见 OCI 镜像托管预构建的 ext4 镜像。对 Alpine/Ubuntu 有效，但不支持自定义
镜像。可作为冷启动加速的 CDN 方案。

---

## 成功标准

1. `boxlite run alpine:latest echo hello` 在 Windows 上正常工作
2. 包含符号链接和多层 whiteout 的复杂 OCI 镜像正常工作
3. 镜像缓存正常工作 (首次拉取慢，后续即时)
4. 不需要 WSL2 或 Docker Desktop
5. 内嵌二进制大小增量 < 15MB
