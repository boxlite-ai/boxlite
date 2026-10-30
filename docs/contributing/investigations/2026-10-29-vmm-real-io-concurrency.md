# Firecracker / libkrun：无注入延迟的并发 I/O 测试

2026-10-29 · 已执行 · Firecracker v1.17.0、libkrun v1.19.7。

**在这台机器上，不注入延迟，也重复观察到了之前的两类现象。** Firecracker Sync 的单盘负载会拖高网络和另一块盘的延迟；libkrun 的不同设备隔离较好，但单块盘的同步 worker 很快达到吞吐平台，并发请求主要增加排队时间。Firecracker Async 和宿主原生读取对照表明，本次存储路径仍有明显的并发余量。

这里复用上次实验的发布版本和二进制，不声称它们是阅读本文时的最新版本。本实验验证运行时行为，没有修改两个 VMM 的实现。

## 测试条件

| 项目 | 设置 |
| --- | --- |
| 宿主 | WSL2，Linux 6.6.87.1-microsoft-standard-WSL2，24 个逻辑 CPU、约 31 GiB RAM；沙箱外 KVM |
| Guest | 相同 Linux 6.1.188 内核，4 vCPU、256 MiB RAM |
| CPU 分工 | Guest CPU0 处理 UDP echo，CPU1 做另一块盘的探针，CPU2–3 运行负载进程 |
| 存储 | `/tmp` 的 ext4 / 虚拟磁盘；两个实际写满并 fsync 的临时文件，各 8 GiB 负载区加 128 MiB 保留区 |
| 负载 | 对磁盘 A 做对齐的 4 KiB `O_DIRECT pread`；1、4、16、32 个并发调用者，每个持续读取 8 秒 |
| 双盘对照 | 总计 32 个调用者，A/B 各 16 个；两块虚拟盘共用同一底层存储 |
| 实现对照 | Firecracker Sync、libkrun、Firecracker Async、宿主直接运行同一读取程序 |
| 重复 | 每个组合 3 次，轮换实现顺序；4 × 5 × 3 = 60 个正式场景，另有 4 个 smoke 场景 |

**没有 dm-delay、请求内 sleep、系统调用拦截或人为等待 I/O。** 负载进程从 barrier 同时起跑，每次读取完成后立即发起下一次。独立探针的发送间隔仅用于采样。

每个场景建立新的只读 loop 映射，打开 backing-file direct I/O，关闭自有 loop 和 guest 块队列的 readahead。负载使用不重复、非相邻的偏移，逐块校验全部返回数据，并比较 loop 实际读扇区数与 guest 成功读取字节数。这样可以检查 Linux 层是否存在明显的缓存命中；它不能排除 WSL2 以下的宿主缓存。[loop direct I/O 的语义](https://man7.org/linux/man-pages/man8/losetup.8.html)只覆盖 backing file，不等于绕过所有层的缓存。

libkrun 沿用 `direct_io=true`，Firecracker 沿用正常的 buffered host open。这一配置差异仍然存在；不能仅凭 guest 的 `O_DIRECT` 把两者视为相同的后端打开方式。此次所有场景的 backing/guest 读取字节比为 **1.000000–1.001849**，没有观察到大批请求命中 Linux 缓存、绕过 loop 底层读取的现象。

## 单盘吞吐和请求延迟

以下均为三次运行的中位数；延迟是先计算每次运行的 p99，再取三次的中位数。并发数 N 表示独立阻塞调用者数量，不代表设备实际在途 I/O 深度。

**吞吐，IOPS：**

| 实现 | 单盘 N=1 | 单盘 N=4 | 单盘 N=16 | 单盘 N=32 | 双盘 16+16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Firecracker Sync | 3,620 | 4,735 | 5,141 | 5,193 | 5,256 |
| libkrun | 4,091 | 5,350 | 5,410 | 5,325 | 10,279 |
| Firecracker Async | 3,702 | 15,169 | 47,918 | 63,954 | 64,893 |
| 宿主原生读取 | 5,628 | 21,097 | 63,207 | 78,564 | 79,402 |

**负载读取 p99，ms：**

| 实现 | 单盘 N=1 | 单盘 N=4 | 单盘 N=16 | 单盘 N=32 | 双盘 16+16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Firecracker Sync | 0.539 | 1.188 | 4.039 | 8.771 | 7.213 |
| libkrun | 0.406 | 1.041 | 3.706 | 7.556 | 3.726 |
| Firecracker Async | 0.471 | 0.430 | 0.577 | 0.847 | 0.902 |
| 宿主原生读取 | 0.311 | 0.287 | 0.440 | 0.858 | 0.855 |

Firecracker Sync 和 libkrun 在 4–16 并发时已接近约 5 千 IOPS 的平台。继续增加到 32，并未增加多少吞吐，却显著抬高请求延迟。libkrun 把相同的 32 个调用者分配到两块盘后，吞吐增加到约 1.93 倍；Firecracker Sync 仅约 1.01 倍。这个差别与每设备独立 worker、多个设备共享同步事件线程的实现相符。

同一存储路径下，Async 在 32 并发达到约 6.4 万 IOPS，宿主对照约 7.9 万。因此，约 5 千 IOPS 的平台不能解释为本机底层存储整体已经饱和。宿主对照与 VM 的 CPU 成本不同，其用途是证明并发余量，不是计算虚拟化开销百分比。

**关键场景的三次最小值–最大值：**

| 场景 | IOPS 范围 | 负载读取 p99 范围，ms |
| --- | ---: | ---: |
| Firecracker Sync，单盘 N=32 | 5,126–5,209 | 8.008–8.984 |
| libkrun，单盘 N=32 | 5,221–5,386 | 6.939–9.317 |
| Firecracker Async，单盘 N=32 | 63,827–67,288 | 0.844–0.862 |
| 宿主原生，单盘 N=32 | 78,016–78,572 | 0.856–0.865 |
| libkrun，双盘 16+16 | 10,224–10,300 | 3.676–3.749 |

## 其他设备是否被拖慢

每个 VMM 场景依次测量 2 秒空闲基线、8 秒磁盘负载、2 秒恢复。网络每 5 ms 发一个 UDP echo，不等待上一包返回；RTT 使用 Linux `SO_TIMESTAMPNS` 的内核接收时间，并单独记录发送调度迟延及用户态接收处理迟延。[socket 时间戳文档](https://man7.org/linux/man-pages/man7/socket.7.html)说明该接收时间戳使用 CLOCK_REALTIME，因此同时检查 realtime/monotonic 偏移变化。

磁盘 B 探针每次完成后等待 10 ms 再读，属于闭环探针；除 p99 外，还保留完成间隔和样本数。下表只使用**单盘 A 的 N=32 负载**，B 没有负载进程。

| 实现 | 网络 p99：基线 → 负载 → 恢复，ms | 磁盘 B p99：基线 → 负载 → 恢复，ms |
| --- | --- | --- |
| Firecracker Sync | **0.490 → 12.302 → 0.603** | **0.704 → 6.872 → 0.710** |
| libkrun | 0.564 → 0.357 → 0.424 | 0.940 → 0.584 → 0.724 |
| Firecracker Async | 0.585 → 0.574 → 0.465 | 1.125 → 0.896 → 0.753 |

Firecracker Sync 的三次负载期网络 p99 分别落在 **11.913–12.333 ms**，磁盘 B 为 **5.423–6.935 ms**，卸载后恢复。磁盘 B 负载期最大完成间隔的三次中位数为 19.841 ms，包含正常的约 10 ms 探针间隔。

libkrun 负载期网络 p99 为 **0.326–0.443 ms**、磁盘 B 为 **0.517–0.587 ms**；没有重复出现 Firecracker Sync 那种跨设备延迟抬升。Async 也没有出现同等幅度的干扰。部分基线比负载期更慢，不能据此认为磁盘负载能改善其他设备性能。

双盘 16+16 时 B 本身也在承载负载，因此该场景的 B 探针不用于判断设备之间的隔离。

## 与实现机制的对应

[Firecracker v1.17.0 的块设备实现](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/src/vmm/src/devices/virtio/block/virtio/device.rs)在 Sync 路径中同步执行读请求；[事件处理入口](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/src/vmm/src/devices/virtio/block/virtio/event_handler.rs)在共享事件线程中推进设备。Async 路径把提交和完成处理分开，等待后端时可以继续处理其他事件。

[libkrun v1.19.7 的 block worker](https://github.com/libkrun/libkrun/blob/v1.19.7/src/devices/src/virtio/block/worker.rs#L161)在 `process_queue()` 循环中逐个调用 `process_request()`，执行完读写、发布 used 后再处理下一项。不同块设备由不同 worker 处理。

线程采样提供了运行时辅助证据。以第一轮单盘 N=32 的 40 次负载期采样为例：

| 实现 | 观测 |
| --- | --- |
| Firecracker Sync | 主事件线程 37/40 次位于 `folio_wait_bit_common`；34 次系统调用采样能关联到测试盘 |
| libkrun | 负责负载盘的 block worker 34/40 次位于 `submit_bio_wait`；另外可见独立的 block worker 和网络 worker |
| Firecracker Async | 主事件线程 33/40 次未显示阻塞等待点，7/40 次为 `do_epoll_wait`；没有采到该线程阻塞读取测试盘 |

这些低频采样不能证明每个请求的精确执行顺序。**延迟随并发增加，也不能单独证明 VMM 串行化**：任何饱和资源都会排队。这里的判断结合了源码、吞吐平台、双盘扩展、其他设备延迟恢复，以及 Async/原生对照。

## 验证、边界与复现

60 个正式场景共完成 **11,962,895 次负载读取**，全部校验成功；所有场景完成资源清理。没有网络丢包、重复回复、缺失的磁盘探针延迟或运行告警。每个负载期至少 1,601 个网络样本，基线与恢复各 400 个。所有阶段中，发送迟延 p99 最大为 0.347 ms，用户态接收处理迟延 p99 最大为 0.229 ms；时钟偏移变化最大 0.030 ms。这些量远小于 Firecracker Sync 约 12 ms 的负载期网络 p99。

由实际计时的 `pread` 持续时间总和除以负载窗口，得到 N=32 场景的平均重叠调用数为 **31.891–31.995**，确认调用端确实提供了并发。程序中的 active counter 还包含数据校验阶段，不能当作后端队列深度。读取 p99 来自全量直方图，在 65.536 ms 以下使用 1 µs 桶并取桶上界。

结论限于此次 Linux/WSL2、KVM 和读取负载。此次没有测试写入、flush、持久化语义、持续高吞吐网络、长时间稳定性或物理 SSD 的冷缓存性能。每组合 3 次、每次 8 秒，范围不是统计置信区间。此次使用 4 vCPU，之前注入延迟的实验使用 2 vCPU，不能直接比较两次实验的绝对延迟。自然 I/O 复现的是干扰和排队模式，不是之前人为延迟的幅度。

本地实验目录：`/tmp/vmm-real-io-20261029`。正式 run：`results/20261029T021511.616602Z`；smoke run：`results/20261029T021357.660921Z`。`SUMMARY.json` 保留全部重复和各组中位数/范围，`CASES.csv` 是逐场景表，`QUALITY.json` 汇总测量质量；各场景目录保存控制台、全量延迟直方图、探针时间戳、线程采样、磁盘计数器及退出/清理结果。`environment.json` 保存测量代码和所有复用二进制的 SHA-256。

实验包：`/tmp/vmm-real-io-20261029.tar.gz`，不包含 16.25 GiB 临时数据或完整上游源码。它依赖原实验 `/tmp/libkrun-io-isolation-20261028` 中的二进制、头文件和辅助脚本；原实验包为 `/tmp/libkrun-v1.19.7-io-isolation-20261028.tar.gz`，其中 README/Makefile 记录依赖获取和构建步骤。它不是可脱离这些依赖直接启动的独立镜像。

从新实验目录运行：

```sh
make verify
make data
make smoke
make test
make analyze
```

`make test` 需要宿主 KVM、sudo、loop、TAP 和网络命名空间权限。它只创建自有临时设备，并在每个场景后检查进程组退出及 loop 实际解除关联。设计在实现前经过独立审查，测量实现随后经过只读复核；审查记录在 `AUDIT.txt`。本报告的执行和结果分析由主执行者完成。
