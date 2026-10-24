# libkrun 分阶段快照计划

2026-10-24 · **当前状态**：阶段 1–12 已在私有 `RamSnapshotVm` 中实现并经审查：RAM、CPU/KVM、virtio-blk、virtio-net、virtio-vsock、virtio-console、virtio-rng、virtio-balloon、UART、CMOS、i8042 与最多七个 virtio-fs 共享（独立文件副本），全部设备统一使用 KRUNVM v7 和显式 `pause` → `export`（保持暂停，可重复）→ `resume` 生命周期，契约见文末“完整快照统一契约（v7）”。非 KVM 测试在 amd64 容器中通过；全部 KVM 运行验收仍为 **UNVERIFIED**；没有公共 C ABI/SDK/CLI 入口，也没有真实 BoxLite/shim 恢复，阶段 13 单文件集成仍为后续工作。文末阶段 1–4 各节及 v4 契约验证是当时的历史记录，其中 KRUNVM v1–v6、`save_full`/`restore_full`/`restore_full_with_disks`/`restore_full_with_net` 等版本与入口已被 v7 取代。

## 目标与范围

最小闭环：**运行中的 box → 导出单个快照文件 → 导入后创建继续运行的 box**。
恢复的是原 guest 进程、内存和磁盘在同一切点的状态，而非重新启动容器。

首版限定 Linux x86_64/KVM、普通非加密内存、内核内中断控制器、固定设备拓扑及兼容的 CPU/KVM 能力。
允许整个导出期间暂停 VM，允许外部连接断开并重连。暂停时长和文件大小暂不设优化目标。
首版包含 virtio-fs 快照，覆盖启动用内部共享与用户共享目录；设备状态及其依赖的文件内容一起保存，恢复后使用新 box 自有副本。
不包含业务层迁移调度、跨架构恢复、增量快照或不停机迁移。
首版拒绝 split irqchip、嵌套虚拟化、TEE、直通及未列入下述阶段的设备配置。

## 固定源码基线与取舍

以下阶段条目中的“现有实现”均描述这些固定研究基线；各阶段实施记录见文末（阶段 1–4 为历史记录，当前契约见“完整快照统一契约（v7）”）；virtio-vsock/console/fs 已在私有 owner 中实现，单文件集成（阶段 13）和全部 KVM 运行验收仍为后续工作：

| 项目 | 固定版本 | 作用 |
| --- | --- | --- |
| BoxLite | [`2794df3f4ee38738b5d3c2dc73b1d566a82f94cd`][boxlite] | 调用方、启动流程、现有归档 |
| libkrun | [`e12b9b3780ffa8df9f3e1797b217d13453479167`][libkrun] | BoxLite gitlink 指定的 VMM 和设备实现 |
| libkrunfw | `e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd` | 同一 BoxLite 提交的固件 gitlink |

本分支从 [lfld287/libkrun](https://github.com/lfld287/libkrun) fork 获取阶段 1 实现；`.gitmodules`、子模块初始化脚本的精确 URL 白名单和测试 fixture 同步使用该来源，保证新克隆可通过 `make setup:submodules` 获取对应 gitlink。libkrunfw 仍来自 boxlite-ai；上表及下文固定提交链接保留原始基线来源，不随 fetch URL 改写。URL 调整仅做 `bash -n` 与 `git diff --check` 静态检查，未运行初始化测试、构建或 Linux KVM 验收。

- 复用已有 KVM 状态读写：[VM 状态][vm-state]包含 PIT、clock、PIC 和 IOAPIC；[vCPU 状态][vcpu-state]包含寄存器、MSR、LAPIC 等。但保存函数未接入运行时请求，不能据此认定已有完整快照能力。
- 复用 BoxLite 的[磁盘展平与归档][export]经验。当前导出只打包容器盘及配置，[导入][import]创建 `Stopped` box；这些机制不能恢复运行中进程。
- 采用暂停后全量保存，避免首版引入脏页追踪和多轮内存复制。只有所有 RAM 写入者停止后，磁盘、内存、设备和 CPU 才能属于同一个切点。
- 按 [KVM API][kvm-api] 的能力查询及状态读写约束重建 VM/vCPU；宿主 FD 和线程不属于可移植状态。兼容性由实际 CPUID、MSR、XSAVE 和 KVM 能力校验决定，不能只比较操作系统版本。

## 前置工作与公共契约

### 纳入 virtio-fs 启动与共享目录状态

[BoxLite 磁盘启动路径][krun-engine]调用 `krun_set_root_disk_remount`。
该 [libkrun 实现][root-remount]仍创建 `/dev/root` virtio-fs 设备，让 `init.krun` 从虚拟文件启动后切换到块设备根目录。
首版将这类内部设备与用户配置的 virtio-fs 共享一起纳入快照，不再要求改为无 virtio-fs 启动路径。

逐一登记 guest root、容器根目录、引导文件及内部/用户共享对应的设备与后端，按阶段 12 保存设备运行状态和所需文件内容；恢复时重建到新 box 自有目录，不依赖原宿主路径，也不重新执行 init/guest agent 初始化。
共享目录复制期间必须停止 guest 与宿主外部写入者，或使用已建立一致切点的后端快照；无法保证一致性时拒绝导出。恢复后的共享是切点上的独立副本，不自动重新绑定原目录或保持与原宿主的实时共享。
验收必须同时检查 guest 挂载和 VMM 实际设备清单；切换根目录或卸载共享并不等于设备不存在。私有 `RamSnapshotVm` 已通过 `attach_fs` 支持此设备（阶段 12，KVM 运行 **UNVERIFIED**）；BoxLite 启动路径中的内部 `/dev/root` 共享尚未接入，属于阶段 13。

### 冻结与恢复边界

建立 VMM 内部控制通道，能够在 `krun_start_enter` 接管执行后处理请求；BoxLite/shim 只发起操作并等待完成。
保存状态不能通过直接序列化整个宿主进程实现。

1. 阻止新的管理变更和外部输入；请求所有 vCPU 暂停并等待逐个确认，完成挂起的 KVM I/O/MMIO 退出语义。
2. 各设备停止接收新工作，在完整请求边界处理已取出的描述符；等待 worker、event loop 和 muxer 确认不再修改 RAM、队列或中断状态。
3. 刷新磁盘与 virtio-fs 文件后端，固定共享目录及 DAX 映射的一致切点，先 drain/save 设备，再保存 CPU、KVM 和 RAM，并处理计时器及 pending interrupt 的运行时迁移语义。只暂停 vCPU 不足以冻结用户态设备或宿主共享目录写入者。
4. 写入、同步并发布镜像（整个文件 sync 后才写有效标记）期间，源 VM 始终保持暂停；导出从不恢复源。成功后保持暂停，可重复导出；普通失败删除半成品、不发布有效快照，同样保持暂停可重试；不确定或致命的控制状态禁用 owner 并停止、join 全部线程，不报告成功。源是否继续运行由调用方另行显式 `resume`（重挂 irqfd，先恢复全部设备，最后恢复 vCPU）。
5. 导入先校验文件、兼容性及恢复资源，再创建暂停的 VM。重建内存映射、磁盘、virtio-fs 文件及映射、设备拓扑及宿主资源并载入状态，返回与源 pause 后相同的暂停状态（可先再次导出）；调用方显式 `resume` 后才统一放行设备和 vCPU。

恢复路径不得执行覆盖 RAM 的冷启动初始化，不得再次运行 guest/container 初始化来替代恢复。
阶段 2 使用 `clock_realtime=false`，不向恢复的时钟添加快照存储期间的墙钟时间；按运行时迁移语义处理 PIT/LAPIC/deadline，不逐 tick 重放。暂停源 vCPU 不代表硬件时钟停止。TSC 频率需匹配或成功缩放，多核 offset 同步必须成功。
外部服务可已超时，恢复后由连接重建处理。

### 通用 virtio 状态

阶段 3 首次实现，阶段 4–8 与阶段 12 复用，避免每个设备各建一种恢复协议。
[MMIO transport][mmio]在激活时把队列移交设备；[Queue][queue]自身还保存不在 guest RAM 中的游标和通知状态。
不能仅保存 MMIO 寄存器，或用全新 `Queue` 替代已激活队列。

| 层次 | 保存内容 | 恢复责任 |
| --- | --- | --- |
| 拓扑 | 设备类型/ID、MMIO 地址与长度、IRQ、队列数量和上限 | 按原布局注册，不能依靠新建顺序碰巧一致 |
| Transport | features selector、acked features selector、queue selector、device status、config generation、interrupt status、共享内存选择器（若适用） | 保留协商及激活状态，恢复中断可见性 |
| 设备与队列 | offered/acked features、设备配置；每队列 size、ready、descriptor/avail/used 地址、next_avail/next_used、event-index 和 num_added | 从真正持有队列的设备/worker 取回状态；与 RAM 中 ring 内容一致 |
| 宿主资源 | 不保存 FD、指针、锁、线程或 epoll 编号 | 重建 eventfd、irqfd、ioeventfd 和事件订阅，重新检查 pending work，避免丢失唤醒 |

每种设备都需覆盖未激活、已激活和有待处理通知的状态。
已消费请求不得重复完成，尚未消费请求不得丢失；恢复不得要求 guest 重新协商驱动。
中断恢复须区分已进入 KVM 的中断和尚未注入的通知，避免重复注入或遗漏。

## 分阶段实施

阶段可分别交付和验收，但中间阶段不宣称支持任意运行中 box。
阶段 1–2 使用受控的最小 VM 验证基础状态；完整设备集通过阶段 3–12 后，阶段 13 才提供用户闭环。
2026-10-23 范围调整：新增阶段 12 virtio-fs，原单文件集成顺延为阶段 13（当时仅更新计划）。实施结果（2026-10-24）：阶段 1–12 已在私有 owner 中实现，见文末 v7 契约；以下各阶段条目保留原始研究与计划，其中“现有实现”指固定研究基线。libkrun README 的阶段编号按实施顺序（vsock 为 stage 7、console 为 stage 8），与本计划编号不同。

### 1. 内存快照

- **现有实现：** [builder][memory]按 guest 物理地址创建 `GuestMemoryMmap`，并加载 payload；内置内核路径还会插入由 libkrunfw 内存支持的 region。没有完整内存文件保存/恢复入口。
- **改动范围：** 定义带版本的 region 表，保存 GPA、长度、属性和内容，包括实际注册的内核 region；从快照分配新映射并注册 KVM memslot。拒绝区域重叠、越界和不支持的映射，恢复不重新写入内核或启动参数。
- **前置依赖：** 全 vCPU 暂停确认及无后台写入的最小 VM；设备冻结接口先定义，真实设备闭环由各设备阶段补齐。禁止将普通 RAM 复制当作 virtio-fs DAX 状态保存。
- **验收标准：** 销毁源映射，在不同宿主虚拟地址恢复多 region、空洞边界和内核 region；逐区内容一致。截断文件、错误长度和重叠 GPA 被拒绝。本阶段只证明内存恢复，不证明进程续跑。

### 2. CPU、KVM 中断控制器、时钟和定时器快照

- **现有实现：** [vstate][vcpu-state]已有私有、未接入请求的 `Vcpu::save_state/restore_state`；`VcpuEvent` 仅有 Pause/Resume。[KvmIoapic][kvm-ioapic]创建内核 irqchip 和 PIT，`VmState` 保存 PIC master/slave、IOAPIC、PIT2 和 clock。暂停分支仍有 `KVM_KVMCLOCK_CTRL` 待办。
- **改动范围：** 在暂停的 vCPU 线程执行保存/恢复请求并返回结果。覆盖 CPUID、regs/sregs、XSAVE/XCRS、debug regs、MP state、LAPIC、MSR 和 vCPU events；序列化 VM 级状态。保留现有 ioctl 顺序约束，检查 MSR 部分读写，处理 TSC 频率/偏移、deadline、kvmclock 和暂停通知；不支持的扩展状态明确拒绝。
- **前置依赖：** 阶段 1；创建 irqchip/PIT 后再建立 vCPU，所有 vCPU 恢复完成前保持暂停。校验源/目标 CPU 和 KVM 能力，审计 KVM 内部定时器及 pending interrupt 与切点的关系。
- **验收标准：** 销毁源 VM 后，多 vCPU 的计数循环、栈/寄存器及 SIMD 计算继续执行；覆盖 halted vCPU、pending interrupt、PIT/LAPIC 定时器及长暂停。时间不倒退，不出现中断丢失、重复完成或 watchdog 假死；不兼容能力在运行前报错。

### 3. virtio-blk 快照

- **现有实现：** [Block][block]持有配置、磁盘对象和 worker 句柄，激活后 `BlockWorker` 拥有队列。现有停止 worker 的路径退出线程，不返回完整运行状态；BoxLite 导出可展平 QCOW2 容器盘。
- **改动范围：** 实现公共 virtio 状态和 worker 冻结/恢复；已取出的读写请求完成到 used ring 后停下，刷新数据及格式元数据。保存容量、只读属性、缓存策略、设备身份和队列。将所有块设备变为独立镜像，包含只读 guest 根盘及容器盘的全部 backing 数据。
- **前置依赖：** 阶段 1–2；磁盘复制期间冻结所有写入者。带 virtio-fs 的完整 box 还依赖阶段 12，内部块设备最小 VM 可独立验证。guest 脏页保留在 RAM，与磁盘和队列形成同一切点，不以 guest `sync` 代替设备一致性。
- **验收标准：** 带并发读写和 flush 的 VM 恢复后可继续文件 I/O；切点前完成的写入存在，未消费请求正常完成，无重复完成。删除源盘、backing chain 和镜像缓存后仍可读取全部块设备内容。

### 4. virtio-net 快照

- **现有实现：** [NetWorker][net]持有 RX/TX 队列、deferred frame 缓冲和宿主网络后端；线程启动后没有用于快照的暂停/回收接口。BoxLite 将网络 socket 路径和 MAC 传入 libkrun。
- **改动范围：** 首版只做 Linux x86_64/KVM、单网卡、UnixStream 后端、私有 `RamSnapshotVm`。保存公共 virtio 状态、MAC/attach features/设备配置、MMIO transport 与 RX/TX 队列游标；为 worker 增加确认式冻结（落在完整描述符边界）。worker 私有缓冲（deferred RX、半帧 RX、未写完的 TX）不保存、不迁移：源端保留原后端和缓冲继续运行；恢复端连接一个新启动的兼容后端。恢复时把切点前未消费的 TX 链全部以长度 0 完成（不发给新后端），已 used 的请求不重放，RX 描述符保留。旧宿主 TCP/NAT 状态、帧和半帧都不迁移；guest 驱动/设备/队列状态保留，guest socket 靠自身错误与超时恢复。
- **前置依赖：** 阶段 3 的公共机制、阶段 1–2；固定首版网络后端与地址配置，明确后端重建和 guest 网络重新可用的流程。
- **验收标准：** 在 RX/TX 活跃、TX 背压与 deferred frame 状态下保存并恢复；旧连接允许断开，旧包不进入新后端、used 环无重复项；新 DNS 查询和 TCP 连接成功，队列不依赖旧 eventfd kick 继续推进。

### 5. virtio-vsock 快照

- **现有实现：** [Vsock][vsock]保留 CID、RX/TX 队列和 muxer；`activate` 将第三条 event queue 取出后丢弃。muxer、代理及宿主 socket 状态不在 guest RAM 内。
- **改动范围：** 保存公共状态、CID、端口映射及队列；冻结 muxer/后台线程。补齐 event queue 的持有与处理，恢复后按 virtio-vsock transport reset 语义使旧连接失效，重建宿主监听 socket 和桥接。重连 guest agent，并重新发现存活 execution，避免重新初始化容器。
- **前置依赖：** 阶段 3 公共机制、阶段 1–2；host/guest RPC 支持断线重连，新的 box ID、宿主路径与保留的 guest 身份明确映射。
- **验收标准：** 快照时有活跃 RPC 和长期运行命令；销毁源 shim 后，新宿主连接能 Ping、查询旧进程并执行新命令。event queue 暂无可用描述符时延迟投递 reset，不能静默遗失或永久等待旧连接。

### 6. virtio-console 快照

- **现有实现：** [Console][console]包含多端口配置、控制消息队列和数据队列；端口激活后 RX/TX 线程持有队列，控制事件和终端状态还有独立宿主资源。
- **改动范围：** 保存公共状态、端口 ID/名称、尺寸、开闭和就绪状态、待发控制消息及设备已接收但未交付的数据。冻结各端口线程，恢复时绑定新终端/日志端点，重建事件订阅，避免再次发送全部启动握手覆盖 guest 状态。
- **前置依赖：** 阶段 3 公共机制、阶段 1–2；输出边界明确：已交付宿主的日志不回放，设备内部尚未交付的字节保留。
- **验收标准：** 在控制消息和数据收发交错时恢复，多端口输入、输出、resize 与 open/close 继续工作；未完成字节不重复消费，驱动无需重新探测。

### 7. virtio-rng 快照

- **现有实现：** [Rng][rng]通过 `OsRng.try_fill_bytes` 获取宿主随机数，保存 features、请求队列和激活状态，没有需要迁移的设备 PRNG 种子。
- **改动范围：** 保存公共 virtio 状态，在完整请求边界停止处理；恢复后重新使用目标宿主随机源，重建激活/队列事件。不保存宿主随机源内部状态，不承诺恢复后随机流相同。
- **前置依赖：** 阶段 3 公共机制、阶段 1–2；冻结 event handler，防止在 RAM 保存期间填充描述符。
- **验收标准：** 覆盖空队列、待处理请求和已完成未通知请求；恢复后 guest 持续获得新随机数据，无队列停滞或重复完成。已写入 guest RAM 的字节作为 RAM 原样保留。

### 8. virtio-balloon 快照

- **现有实现：** [Balloon][balloon]有配置和五条队列，实际 free-page reporting 处理调用 `MADV_DONTNEED`；inflate/deflate/page-hinting 事件处理尚不支持，stats 被忽略，不能描述成完整 balloon 实现。
- **改动范围：** 保存公共状态和全部现有配置字段、队列进度；在完整 reporting 描述符链边界冻结。内存复制期间禁止 reporting 回收页面，恢复后仅处理尚未完成的描述符，避免再次丢弃已经被 guest 重新使用的页面。首版全量保存 RAM，不依靠 reporting 跳过页面。
- **前置依赖：** 阶段 1 的内存切点和阶段 3 公共机制；保持既有支持范围，不借快照阶段扩展 balloon 功能。
- **验收标准：** 在 reporting 活跃时保存，恢复后分配、写入并复用这些页面，校验有效数据不被回收；配置、协商位和队列游标一致，后续 reporting 可继续。

### 9. UART 快照

- **现有实现：** [x86 Serial][uart]保存中断、line/modem、scratch、baud divisor 寄存器及输入缓冲，并持有不可序列化的输入/输出对象和中断 eventfd。
- **改动范围：** 保存所有 guest 可见寄存器和未读输入，停止宿主输入采集；恢复时重新绑定 I/O、IRQ 和事件订阅，协调阶段 2 的 pending interrupt。已写出的宿主输出不回放。
- **前置依赖：** 阶段 1–2、[legacy device manager][legacy]的原端口/IRQ 布局；不依赖 virtio-console 实现。
- **验收标准：** 在 divisor latch、loopback、非空输入缓冲和待处理中断状态恢复；寄存器读取一致，新输入可读、新输出可见，无重复注入。

### 10. CMOS 快照

- **现有实现：** [Cmos][cmos]仅保存 index 和 128 字节 data，构造时写入内存容量信息；该实现不是完整 RTC，不提供独立运行的 RTC 定时器。
- **改动范围：** 保存并恢复 index 和 data，继续使用原 I/O 端口，验证容量字段与恢复内存布局一致。KVM 时钟和定时器归阶段 2，避免在此虚构 RTC 状态。
- **前置依赖：** 阶段 1 的固定内存布局及 legacy device manager；恢复前不让 vCPU 访问半初始化状态。
- **验收标准：** 在选择非默认 index 后保存，恢复后读取选中寄存器及全部数据一致；低于/高于 4 GiB 的内存容量编码与原 VM 一致。

### 11. i8042 快照

- **现有实现：** [I8042Device][i8042]保存 status、control、outp、最后命令、16 字节缓冲和头尾游标，使用 reset 与 keyboard interrupt eventfd，承担键盘/关机控制的最小模拟。
- **改动范围：** 保存上述逻辑状态，重建两类 eventfd 及 IRQ/退出事件接线。与已进入 KVM 的 IRQ 状态协调；收到 reset 并进入退出流程的 VM 拒绝导出，不能把 reset 信号带到新 VM 误触发退出。
- **前置依赖：** 阶段 1–2、legacy device manager 的端口布局和冻结边界。
- **验收标准：** 覆盖非空缓冲和命令等待参数的中间状态；恢复后按原顺序读出数据、继续完成命令，新的键盘中断和关机/重启请求有效，不自发复位。

### 12. virtio-fs 快照

- **现有实现：** 本地 `src/devices/src/virtio/fs/` 中，`Fs` 持有 tag、features、配置和可选共享内存窗口；`FsWorker` 持有高优先级/请求队列、FUSE server 与 passthrough 后端。Linux 后端还保存 inode/node ID、引用计数、打开的文件/目录句柄和分配计数器，并支持文件到共享窗口的 DAX 映射；这些状态不能由 RAM 或目录复制单独替代。
- **冻结与设备状态：** 复用公共 virtio 状态，保存 tag、只读属性、配置、拓扑及全部队列。增加确认式冻结/恢复/停止，在完整 FUSE 请求边界完成已取出的请求及回复后确认；冻结后不再修改 RAM、ring、文件或映射。未消费请求恢复后继续处理，已完成的请求不重放，恢复不依赖旧 kick 或再次协商 FUSE INIT。
- **文件与句柄：** 保存 FUSE 协商状态、guest 可见 node ID/handle、引用计数、分配计数器、打开模式和目录遍历进度，将其关联到归档内稳定的文件对象身份；恢复时重建宿主 FD，不能把宿主 inode 数值或原路径当作恢复身份。归档内部共享和用户共享的文件内容及所需权限、所有权、时间戳、扩展属性、目录、符号链接和硬链接关系，包含已删除但仍被句柄或映射引用的文件。跨共享的同一文件别名须保留；不支持的文件类型、锁或其他活跃后端状态在导出前明确拒绝，不能静默丢弃。
- **DAX 与一致性：** 显式记录共享窗口的 GPA/大小、有效映射范围、文件对象/偏移和访问权限，在暂停 vCPU、冻结 worker 并停止外部写入后同步文件及映射脏数据。RAM、文件内容和映射必须来自同一切点；恢复先在原 guest 地址重建映射及未映射区，再放行 vCPU，不将普通 RAM 复制当作 DAX 恢复，也不要求 guest 重新 mmap。文件复制和恢复不得改变源端句柄、目录游标或映射。
- **前置依赖与失败：** 阶段 1–3 的 RAM/CPU/公共设备机制、共享目录一致性约束及版本化文件对象/映射元数据。导入先校验身份引用、长度、路径和映射边界，再在新 box 自有目录重建；目录恢复不得经路径穿越或符号链接写出目标根目录。失败清理新建 worker、映射、FD 和文件，源端保存失败尝试恢复全部资源，不发布有效快照。
- **验收标准：** 只读启动共享、可写用户共享、多个共享设备在活动读写、目录遍历、rename/unlink、硬链接及未关闭文件时恢复；源目录移除后，原 guest FD 和已有 mmap 仍可继续使用，读取内容与切点一致，DAX 后续读写可见，源端后续修改不混入。覆盖未激活设备、pending 中断、无新 kick、外部写入无法冻结及中途导入失败；保持原进程和挂载，无重新初始化、重复请求或资源泄漏。

### 13. 单文件 export/import 集成

- **现有实现：** BoxLite 的[导出][export]打包 manifest 和展平的容器盘，[导入][import]生成新 box；没有 RAM、CPU、设备状态，也没有快照恢复专用启动路径。
- **改动范围：** 将统一冻结、保存、恢复接到 libkrun 控制通道、shim 和 BoxLite 生命周期。定义独立的运行态快照类型/版本，保留已有磁盘归档语义；容器中包含 manifest、兼容性与拓扑、全部 RAM、CPU/VM/设备状态、全部独立磁盘、virtio-fs 文件对象/内容/映射状态和必需引导资产。
- **前置依赖：** 启动及共享设备清单核对和阶段 1–12 全部完成；导出逐设备核对支持清单。文件记录各段版本、长度和校验和，校验大小上限、偏移、路径及完整性后才创建资源；不允许依赖源路径、原共享目录、镜像仓库或 QCOW2 backing 文件。
- **验收标准：** 执行下述最终验收。新 box 获得新宿主 ID/目录/端点，guest 内进程身份保留；恢复重连不重新执行 entrypoint。截断、损坏、不支持版本/设备及不兼容 CPU 均明确失败，不发布半成品 box。

## 最终验收标准

以下是功能实现后的验收要求，不是本次文档变更已运行的结果。

1. 在支持配置的 box 中启动长期运行进程，记录 PID、进程启动标记、只存在于堆内存中的随机标记和递增计数；同时产生磁盘及 virtio-fs 共享文件写入，保留打开的文件/目录句柄与 mmap，并建立外部连接。
2. 从运行中的 box 导出单个快照文件，记录一致切点。切点后在源 VM 上修改内存/文件，用于确认恢复不会混入后续状态。
3. 销毁源 VM、shim 和网络后端；移除源 box 目录、原磁盘及 backing 数据、原 virtio-fs 共享目录。在无源缓存和镜像仓库依赖的新运行时目录准备导入。
4. 在兼容 Linux x86_64/KVM 宿主上，仅提供快照文件和已安装的兼容运行时。创建新 box，原进程从切点继续运行：PID、启动标记、堆标记保持，计数继续，文件与切点对应，切点后源修改不存在。
5. 通过重新建立的控制通道执行新命令、继续磁盘读写及已有 virtio-fs 文件句柄、目录遍历和 mmap 访问，并成功建立新的网络连接。旧连接允许断开，不能因此要求重启 guest 或容器。
6. 覆盖多 vCPU、设备有未完成工作、长暂停、导出失败和导入失败。验证恢复后的时钟/中断、随机数、free-page reporting、控制台、virtio-fs（含 DAX）及 legacy 设备仍工作。

仅能启动新内核、恢复文件、重新执行原命令，或依赖源进程/源盘存活的方案，均不满足闭环。

## 本次文档检查范围

原始记录（阶段 1 时）：本次核对固定版本源码和依赖 API，并检查 Markdown、Rust 格式及 `git diff --check`。已编写阶段 1 实现与测试，但遵照任务要求不构建、不运行任何测试；条件编译、Linux KVM 行为及全部运行时验收尚未验证。后续各阶段的验证见文末各节。

[boxlite]: https://github.com/boxlite-ai/boxlite/tree/2794df3f4ee38738b5d3c2dc73b1d566a82f94cd
[libkrun]: https://github.com/boxlite-ai/libkrun/tree/e12b9b3780ffa8df9f3e1797b217d13453479167
[vm-state]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/vmm/src/linux/vstate.rs#L831-L904
[vcpu-state]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/vmm/src/linux/vstate.rs#L1307-L1739
[kvm-api]: https://docs.kernel.org/virt/kvm/api.html
[memory]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/vmm/src/builder.rs#L1292-L1528
[root-remount]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/libkrun/src/lib.rs#L2250-L2338
[krun-engine]: https://github.com/boxlite-ai/boxlite/blob/2794df3f4ee38738b5d3c2dc73b1d566a82f94cd/src/boxlite/src/vmm/krun/engine.rs#L407-L475
[export]: https://github.com/boxlite-ai/boxlite/blob/2794df3f4ee38738b5d3c2dc73b1d566a82f94cd/src/boxlite/src/litebox/clone_export.rs#L191-L334
[import]: https://github.com/boxlite-ai/boxlite/blob/2794df3f4ee38738b5d3c2dc73b1d566a82f94cd/src/boxlite/src/runtime/import.rs#L21-L63
[mmio]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/mmio.rs#L61-L80
[queue]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/queue.rs#L324-L375
[kvm-ioapic]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/legacy/kvmioapic.rs#L16-L30
[block]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/block/device.rs#L204-L442
[net]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/net/worker.rs#L21-L98
[vsock]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/vsock/device.rs#L233-L279
[console]: https://github.com/boxlite-ai/libkrun/tree/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/console
[rng]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/rng/device.rs#L17-L88
[balloon]: https://github.com/boxlite-ai/libkrun/tree/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/virtio/balloon
[uart]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/legacy/x86_64/serial.rs#L60-L105
[cmos]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/legacy/x86_64/cmos.rs
[i8042]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/devices/src/legacy/i8042.rs#L73-L114
[legacy]: https://github.com/boxlite-ai/libkrun/blob/e12b9b3780ffa8df9f3e1797b217d13453479167/src/vmm/src/device_manager/legacy.rs#L38-L147

> 以下阶段 1–4 各节保留当时的设计与验证记录；其中“当前实现”“KRUNVM v1–v3”及旧恢复入口的表述已被“完整快照统一契约（v7）”取代。

## 阶段 1 本地实施设计（2026-10-22）

问题是最终注册的 RAM 缺少独立文件契约；本阶段增加 krun-vmm 内部保存和新 KVM VM 的内存恢复，仍不提供进程续跑、C ABI 或 BoxLite 用户入口。

### 依据与取舍

- 固定源码 `linux/vstate.rs::running/run_emulation`：IO/MMIO 返回 `Handled` 后继续 `KVM_RUN`，只在 EINTR 后处理 Pause；signal handler 设置 immediate_exit。因此沿用该完成边界，不额外执行可能运行 guest 的 ioctl。依据 [KVM API §5][kvm-run]，挂起 IO/MMIO 在重入完成，然后才检查信号/immediate_exit。
- `builder.rs::create_guest_memory/load_payload`：KernelMmap 将 libkrunfw 的 raw region 插入最终内存；ShmManager 的 DAX/GPU region 同样是 anonymous，单看 mmap flags 不足以判定可保存性。
- vm-memory 0.17.1 `MmapRegion::{owned,flags,prot,file_offset}` 和 `GuestMemory::iter` 可校验与枚举真实映射；不保存宿主地址或 FD。普通映射必须 owned、private anonymous、可读写；仅允许加载器产生并记录的精确 kernel raw region。
- 普通 builder 无条件附加 balloon/rng，故必然拒绝阶段 1 保存。增加独立受控最小构造路径，复用 create_guest_memory 和 Vm::memory_init，但不建立任何设备、event subscriber 或后台 worker；不增加“已冻结”布尔开关。

### 调用与所有权

- `Vmm::save_ram_snapshot(path)` 在 Vmm 管理锁下检查实际 MMIO 注册表、共享区域和后台 observer，再验证映射；发送所有 Pause，再逐 CPU 有界等待 Paused。已暂停 CPU 对重复 Pause 返回 Paused；失败仍向全部 CPU 发 Resume，并逐个等待，容忍此前 Pause 的滞后确认，但不接受 Exited/断链。
- 新模块 `ram_snapshot` 内部完成 region 表验证、固定大小分块读写；保存先写无效 magic 到 create_new 文件，完成复制与 flush 后先恢复源 CPU，再写有效 magic。任何暂停、写入或恢复失败均返回错误并删除/保持无效文件；成功文件必须在 Resume 成功后才成为可恢复文件。
- `builder::build_ram_snapshot_vm(mem_size_mib, resources, payload)` 创建无设备最小 VM，复用 `create_guest_memory` 加载 payload，再通过现有 `Vm::memory_init` 注册最终 RAM；不执行 configure_system/启动参数覆盖或自动运行 CPU。返回 `ram_snapshot::RamSnapshotVm`，其 `start_vcpus(count, entry)` 仅启动受控 real-mode RAM 程序，使用同样的 Pause/Resume 通道；不接受外部 CPU/bus/后台 writer。启动中途失败时退出并 join 已创建线程，禁止再次快照。
- `RamSnapshotVm::restore` 先用目标 KVM max_memslots 和实际文件长度验证全部 metadata，再分配新 anonymous mappings、分块填充，调用现有 `Vm::memory_init`。返回私有字段的拥有者，VM 先于 RAM drop；创建/注册失败时先关闭整个新 VM，撤销全部部分注册，然后释放 RAM，不将半注册 VM 暴露给调用者。
- 实际恢复入口为 `RamSnapshotVm::restore(path)`，保存入口为 `RamSnapshotVm::save(path)` 和 `Vmm::save_ram_snapshot(path)`，全部仅为 crate 内部入口。恢复不创建 CPU；调用 `start_vcpus` 会初始化全新 CPU，不能解释为恢复原进程。最小 owner 在销毁时发送 Finish 并 join CPU，再释放 VM 与 RAM；普通退出仍等待正常 Vmm 进程退出。`KvmContext::new` 对 `/dev/kvm` 打开失败返回上下文错误。
- 任意暂停/恢复通信不确定都会将 controller 标记为不可再次快照，避免旧确认污染下一次请求；恢复会尝试每一个 handle 并保留原始错误和恢复错误。队列仅在 EINTR 或已暂停边界排空，避免合并 kick 遗留控制命令，也不跳过 pending IO/MMIO 完成。

### 文件契约与冻结边界

- 独立版本 1，little endian：8-byte magic、u32 version、u32 count；随后 count 个 `{u64 GPA,u64 length,u64 attributes}`，然后各 region 的全部字节，GPA 顺序且允许空洞。attributes=0 唯一表示普通非加密读写 RAM，kernel 来源不影响恢复属性。
- magic 为 `KRUNRAM\0`（8 字节）；保存以 `create_new` 拒绝覆盖已有路径，以 0600 创建文件（umask 可进一步收紧），失败文件不会获得有效 magic。
- 分配前验证 count 非零且不超 KVM memslot 容量、4 KiB 对齐、非零长度、地址/总长度溢出、相邻重叠/乱序、未知属性、版本、截断及尾随字节。读取有上限的 metadata 后才分配 RAM；内容缓冲固定 64 KiB。
- 阶段 1 的设备冻结契约是拒绝：任意实际 virtio、DAX/GPU shared ranges、file/shared/任意未知 raw mappings、后台 RAM 写入者均不支持。最小构造器没有这些 writer；正常 Vmm 在实际拓扑边界拒绝，不让配置开关宣称冻结。
- 恢复仅产生新 VM 和 RAM，不创建/运行 CPU，不调用 payload loader、cmdline 或 boot parameter 初始化；CPU/中断/时钟与设备状态仍属后续阶段。

### 阶段 1 验证历史记录

阶段 1 当时的授权是只写、不运行测试或构建；阶段 2 已明确授权本地构建和测试，以下保留历史证据。阶段 1 测试覆盖最终内存/kernel region/空洞、销毁源后保留旧地址占位从而强制新地址、比较内容、新 KVM 注册及 guest 实际写入、畸形 metadata、全 CPU 暂停/重复暂停/超时/退出/通信失败、创建/中途复制写入失败后恢复、恢复失败时无有效 magic、共享/DAX/virtio/后台 writer 拒绝，以及 pending IO/MMIO 的真实 KVM 完成边界和排队控制命令。
中途写入失败注入只存在于测试编译的 payload File 写入处，使用线程局部限额，不改变进程全局资源限制。测试源码位于 `src/vmm/src/ram_snapshot/tests.rs`，KVM run-loop 和实际 virtio 注册回归分别在 `linux/vstate.rs`、`device_manager/kvm/mmio.rs`。
源码/API 静态核对、指定 Rust 文件的 rustfmt 检查，以及父仓库和 libkrun 子模块的 `git diff --check` 已通过；Linux KVM 执行、条件编译和所有测试验收均未验证。

[kvm-run]: https://docs.kernel.org/virt/kvm/api.html#the-kvm-run-structure

## 阶段 2 实施前设计（2026-10-22）

### TL;DR

在阶段 1 `943cea58e02354c9da091f6d60ff7c2b35c6ff42` 的私有最小 VM owner 上增加完整 CPU/KVM/RAM 保存、暂停恢复和显式继续运行；RAM-only 文件及入口保持不变。普通 Vmm、C ABI、SDK、CLI 和用户态设备不接入。

### 原始依据与取舍

已下载并阅读 Firecracker 固定提交 [`6ec271414300fb8f0ff1ff79ad321bb7467d072f` 的 vcpu.rs](https://github.com/firecracker-microvm/firecracker/blob/6ec271414300fb8f0ff1ff79ad321bb7467d072f/src/vmm/src/arch/x86_64/vcpu.rs#L325-L805) 和 [builder.rs](https://github.com/firecracker-microvm/firecracker/blob/6ec271414300fb8f0ff1ff79ad321bb7467d072f/src/vmm/src/builder.rs#L428-L532) 原文。

| 问题 | 原文机制、现有代码核对与决定 |
| --- | --- |
| CPU 读取副作用 | vcpu.rs:648–703 先 MP state、events 最后；现有 libkrun dormant save_state 仅 legacy XSAVE、单批 MSR、缓存 CPUID，不能直接调用。用暂停线程独立请求替换；所有 Paused 确认前不请求状态。 |
| XSAVE | vcpu.rs:338–394 用 KVM_CAP_XSAVE2 动态字节数分配 Xsave；现有 kvm-bindings 0.12.1 / kvm-ioctls 0.22.1 已提供 Xsave、get_xsave2/set_xsave2，无须升级。恢复验证目标大小、CPUID 叶 0xD 布局、XSTATE/XCOMP 位与 XCR0；拒绝未覆盖扩展状态。 |
| MSR 与计时器 | vcpu.rs:474–621 对零 deadline 仅修改镜像，分批读取并全局延后 deadline，检查部分 ioctl。采用相同运行时迁移语义，不重放每个 tick；源暂停期间硬件时钟可能前进。 |
| TSC | vcpu.rs:723–737 使用 250 ppm 阈值；builder.rs:428–532 在 CPU restore 后同步 offset，再 restore clock。采用该顺序，但多核缺少 offset 属性或失败直接拒绝，区别于上游 best-effort。 |
| ioctl 边界 | [KVM API](https://docs.kernel.org/virt/kvm/api.html) 的 GET/SET_XSAVE2、GET/SET_MSRS、KVMCLOCK_CTRL、GET/SET_CLOCK 和 vCPU device attributes 规定缓冲区、部分完成和 clock 标志。KVMCLOCK_CTRL 失败仅警告，其余失败传回。时钟清除 realtime/host-TSC 标志，不补偿离线墙钟时间。 |

保留原 Amazon Apache-2.0 及 Chromium/BSD 说明；新适配模块标注固定源和本地差异。只启用现有 serde、serde_json 及 KVM/FAM serde feature。

### 机制、边界与所有权

- 独立 full 文件：version、最多 16 MiB JSON metadata（目标兼容信息、VM/CPU 状态、RAM region 表），随后按 region 顺序写 RAM；固定 64 KiB buffer。全部表项和精确文件长度先校验，再分配独立 anonymous mapping。
- 保存顺序：实际 owner/映射/CPU 能力验证 → 所有 CPU Pause/确认 → 每个 CPU 独立有界 reply 请求 → VM 状态 → RAM → 恢复全部源 CPU → 写有效 magic。create_new/0600，任意失败恢复尽可能多的 CPU，失败不得返回成功或留下有效文件。
- 状态请求只在 owning paused thread 执行，运行态收到请求则回错误；reply channel 容量为 1，每次独立创建，超时不污染 Pause/Resume 响应通道。过期接收者不得阻塞 owning thread。
- 恢复：校验 metadata/兼容性 → 新 RAM/VM → 内核 irqchip/PIT → 创建所有初始暂停 CPU → 恢复确认 → vCPU0 offset 同步 → VM/PIT/PIC/IOAPIC/clock → 返回暂停 owner；显式 resume 才 KVM_RUN。任何中途失败由 owner Drop 停止并 join 所有已创建线程，再释放 VM/RAM，不调用 payload loader 或 boot 初始化。
- 仅最小 owner 暴露 full 入口，私有 bus/memory/handles 杜绝后台 writer、用户态设备和 split irqchip。验证实际 CPUID 禁止 VMX/SVM 和未覆盖的扩展状态；保守要求同 vendor/支持集/XSAVE 布局及所有保存 MSR 均兼容。未来设备阶段必须在 CPU/KVM/RAM 前 drain/save 设备，并在继续运行前恢复。

### 验证计划

新增单元检查解析边界、deadline/MSR 分批/部分完成、动态 XSAVE 大小/位图、250 ppm 和 offset 同步失败策略，以及请求超时/断链；真实 KVM 检查销毁源后的多核寄存器/栈/SIMD 和计时器继续。现有 RAM 失败恢复测试继续适用；只将实际执行通过记为 verified。

本机为 macOS，无 /dev/kvm；安装了 x86_64-unknown-linux-gnu/musl Rust target 和 x86_64-linux-musl C 工具链。增加最小 make fmt/check/test 工作流，先尝试 Linux target 编译；KVM 执行必须标记 UNVERIFIED，禁止新远程环境或远程测试。此阶段是新增功能；若修复已存在缺陷并增加回归，按 AGENTS 全量生产回退验证失败信号。

### 阶段 2 最终契约与实施结果

- 内部入口为 `RamSnapshotVm::{save_full,restore_full,resume}`。普通 `Vmm`、C ABI、SDK、CLI 均未接入。`KRUNRAM` 版本 1 与 RAM-only 保存/恢复仍保持内存语义；对有已恢复暂停 CPU 的 owner，RAM-only save 明确拒绝，避免悄悄运行 guest。
- 最小源 VM 使用内核 irqchip/PIT、现有 CPUID topology filter 和显式 runnable MP state；支持 **1–128 vCPU**，还受宿主 KVM 容量限制。该上限来自现有 CPUID package count 的非零 u8 二次幂表达。导入校验实际 CPUID vendor、family/model、features、唯一叶、XSAVE 布局和 CPU ID/数量；不接受重排/不匹配的 CPU 拓扑。
- 独立 full version 1：8-byte `KRUNVM\0\0`、little-endian u32 version、u32 JSON 长度、JSON、各 region RAM。JSON 最多 16 MiB，编码也有界；包含 compatibility、CPU 数组、VM state、region 表。分配 RAM 前校验精确文件长度、region 表、目标能力与 CPU 状态。
- `linux/vstate/snapshot.rs` 替换原 dormant CPU 保存/恢复。全部 Paused 后，状态请求在 owning thread 执行，使用容量 1 的独立有界 reply；超时、退出、断链返回错误，过期 reply 不阻塞线程。控制队列在 Pause 后跟踪逻辑暂停状态，不会因确认与排队的竞态拒绝合法请求。
- 先保存 MP state、实际 CPUID，再 regs/sregs、debug/LAPIC、动态 XSAVE/XCRS、MSR，events 最后。XSAVE 分配使用该 VM 的 `KVM_CAP_XSAVE2` 字节数，旧内核用 4096-byte legacy；恢复检查相同大小、标准非 compacted 位图、reserved header、组件边界与重叠、XCRS。KVM 固定记录严格要求字节长度：现有 kvm-bindings 0.12 serde visitor 会对短记录补零，故通过本地 strict adapter 拒绝截断，不升级依赖。
- MSR 按 `KVM_MAX_MSR_ENTRIES` 分批，部分读写报告 vCPU 与失败 MSR；deadline 全局移到该 CPU 所有 chunk 最后。零 deadline 仅在镜像变为保存的 TSC；非零不变，保存不 SET 源 deadline。恢复按 CPUID、MP、regs、sregs、XSAVE/XCRS、debug、LAPIC、MSR、events 顺序执行。
- 必需能力包含 irqchip、PIT2 创建与 PitState2 读写、MP/events/debug、XSAVE/XCRS、TSC kHz/deadline、clock。目标 supported CPUID/MSR/XSAVE/capability 指纹保守要求相同。未覆盖的 PMU、SGX/PT/CET/LBR/AMX、supervisor XSTATE、AMD perf/encryption、SMM/SMI、nested、TEE 明确拒绝或在最小源 CPUID 禁用。
- 导入先创建 irqchip/PIT，再创建所有初始暂停线程；恢复确认后用 vCPU0 同步多核 TSC offset，再恢复 PIT/PIC/IOAPIC 和 clock。多核缺少 offset 属性或同步失败即失败；单核无需 offset 属性。`clock_realtime=false`，不加离线墙钟时间；频率差严格大于 250 ppm 才 SET_TSC_KHZ，失败发生在 guest entry 前。Pause/Resume 调用 KVMCLOCK_CTRL，失败警告；其他状态 ioctl 失败为错误。
- full 保存校验实际私有 owner 的拓扑/映射和 RAM Arc 唯一性，拒绝外部 alias/writer。错误恢复尝试每个源 CPU，只有所有 Resume 确认后写有效 magic；中途写入或恢复失败不留下有效快照。部分导入通过 owner Drop 停止并 join 所有已创建线程，再释放 VM 和 RAM。
- guest fixture 的 SIMD/寄存器/栈循环带启动次数标记；PIT、x2APIC periodic/one-shot 和 TSC deadline fixture 通过真实 guest counter 检查继续与单次完成。另检查真实 halted MP、PIC pending IRQ、TSC/clock 不包含离线墙钟时间、源 zero deadline 不被保存操作改变，以及部分 KVM restore 失败后的线程/FD 清理。
- 后续设备阶段仍须先 drain/save 设备，再捕获 CPU/KVM/RAM；当前实现不支持用户态设备或任意运行中的 box。

### 阶段 2 实际验证与剩余缺口

以下命令在 libkrun 子模块目录执行；GNU 检查/构建公共环境为 `CC_x86_64_unknown_linux_gnu=/opt/homebrew/bin/x86_64-linux-musl-gcc CARGO_TARGET_DIR=/private/tmp/boxlite-stage2-target`。`CC_LINUX` 必须作为 make 命令行参数，macOS Makefile 会覆盖同名环境变量。

| 实际 make 命令 | 结果 |
| --- | --- |
| `make snapshot-guest SNAPSHOT_AS=/opt/homebrew/bin/x86_64-linux-musl-as SNAPSHOT_OBJCOPY=/opt/homebrew/bin/x86_64-linux-musl-objcopy` | 通过；最后一次生成包含所有入口，guest.bin SHA-256 为 `b24871c75d9b38eb4113309cb8e2bb46ab1c1b50f5325f87239217038bf6c3b4`。汇编源和 binary 均纳入改动。 |
| `make snapshot-fmt` | 最终源码通过。 |
| `make snapshot-check CC_LINUX=/opt/homebrew/bin/x86_64-linux-musl-gcc` | 最终通过，包含 `--tests --target x86_64-unknown-linux-gnu`；最终 CPUID filter/topology 和 PitState2/deadline capability 改动已重查。 |
| `make snapshot-build CC_LINUX=/opt/homebrew/bin/x86_64-linux-musl-gcc` | 最终通过，生成 krun-vmm rlib（非 libkrun shared library/可运行产物）；内部实验入口未由生产调用方使用，因此存在 dead-code warnings。 |
| `make snapshot-test SNAPSHOT_CARGO_FLAGS='--offline --no-run' CC_LINUX=/opt/homebrew/bin/x86_64-linux-musl-gcc`，另设置 `CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/opt/homebrew/bin/x86_64-linux-musl-gcc` | Rust codegen 到达链接，但失败：本机只有 musl cross linker/native 库，GNU std 需要的 `ftruncate64/fstat64/open64` 等及 compression symbols 未解析。不能据此称测试 executable 已构建或测试已通过。 |
| `make snapshot-test SNAPSHOT_TARGET=x86_64-unknown-linux-musl SNAPSHOT_CARGO_FLAGS='--offline --no-run' CC_LINUX=/opt/homebrew/bin/x86_64-linux-musl-gcc`，使用 musl target CC/linker | 失败于已有 `devices/src/virtio/fs/linux/passthrough.rs`：libc 0.2.183 的该 target 不提供 `statx/STATX_BASIC_STATS/STATX_MNT_ID`。未改动相邻 fs 代码或依赖版本。 |

没有依赖升级。Cargo.lock 仅增加 kvm-bindings 启用 serde 后的 serde/zerocopy feature 边；最后的检查、构建和测试链接尝试均使用已缓存的锁定版本与 offline 模式。

父仓库和子模块 `git diff --check` 通过。所有 KVM 运行、guest continuation/timer 验收、通信单元测试执行以及全生产回退的回归失败/恢复通过对照均为 **UNVERIFIED**；没有把 `check --tests` 或 rlib build 当成运行结果。验证仅在本机完成，未使用远程测试环境。

## 阶段 3 实施前设计（2026-10-22）

### TL;DR

在阶段 2 私有 `RamSnapshotVm` 上增加内部 virtio-blk 磁盘挂载、设备冻结与 KRUNVM v2 全量快照：单个快照文件含 CPU/KVM/RAM 与按序 raw 磁盘段；恢复把磁盘段导入调用方指定的新目录并返回暂停 VM。不接入普通 `Vmm`、C ABI、SDK、CLI。

### 原始依据与取舍

已下载并阅读 Firecracker 固定提交 `6ec271414300fb8f0ff1ff79ad321bb7467d072f` 的 `src/vmm/src/devices/virtio/persist.rs` 原文，以及 Linux v6.12 `virt/kvm/eventfd.c` 原文，并与本地代码核对：

| 问题 | 原文机制、现有代码核对与决定 |
| --- | --- |
| 可复用 virtio 状态 | Firecracker `QueueState` 保存 max/size/ready、三环 GPA、next_avail/next_used/num_added；`VirtioDeviceState` 保存类型/features/队列/activated；`MmioTransportState` 保存全部 selector、status、config generation 与 interrupt status。本地 `Queue` 额外有 `event_idx_enabled`（激活时由 acked features 派生），v2 版序列化显式保存并在恢复时校验与 acked features 一致；未激活队列该值必须为 false（本地仅在 activate 设置）。Firecracker `restore` 对激活队列调用 `queue.initialize`，本地等价为 `is_valid` 式范围/对齐校验加游标与 RAM 环内容一致性校验。 |
| 队列状态来源 | 本地 mmio transport 激活时把队列移交设备（`queues.take()`），活动队列在 `BlockWorker` 内。保存时活动队列状态只能来自 worker 冻结确认（每个请求独立 bounded(1) reply），未激活队列来自 transport 自持队列；与 Firecracker 从 device.queues() 读取的结构差异一致处理。 |
| irqfd 注入完成边界 | Linux v6.12 `virt/kvm/eventfd.c`：`kvm_irqfd_deassign` 匹配 fd+gsi 后 `irqfd_deactivate` 并 `flush_workqueue(irqfd_cleanup_wq)`，`irqfd_shutdown` 内 `eventfd_ctx_remove_wait_queue` 后 `flush_work(&irqfd->inject)`；即 DEASSIGN ioctl 返回后所有已排队注入完成且不再有新注入。用 `kvm_ioctls::VmFd::unregister_irqfd`（KVM_IRQFD_FLAG_DEASSIGN）实现中断 drain，随后 poll-drain 事件计数，再捕获 CPU/KVM。 |
| 中断恢复 | 注入完成的中断存于内核 irqchip（阶段 2 已随 VM state 保存/恢复）；目标端只注册新 eventfd 的 irqfd，不向其写入。transport `interrupt_status` 仅恢复寄存器可见性，不复播 eventfd。 |
| 磁盘内容归一 | 现有 `DiskProperties`/`SyncFormatAccess`（imago RAW/QCOW2/VMDK 统一读写）即现有读取接口；冻结 flush 后经共享 `Arc<Mutex<SyncFormatAccess>>` 分块读取逻辑容量，QCOW2 backing 内容随逻辑读自然展平，不需要单独的格式归一器。 |
| guest 可见配置 | `VirtioBlkConfig` 为 packed POD；按字节整体保存/恢复，容量字段与磁盘段长度、恢复文件实际 nsectors 三方校验；恢复端按保存的 avail features 反推 sync_mode/只读，重建后必须与保存 features 逐位相等，保持原 guest flush 语义。 |

保留 Firecracker Apache-2.0/BSD 来源标注；新模块注明固定来源与本地差异。

### 机制、边界与所有权

- 设备侧新增（krun-devices，feature `blk`）：`virtio/persist.rs` 提供 `QueueState`/`VirtioDeviceState`/`MmioTransportState` serde 状态与校验（类型/feature 子集/队列数/max size；激活队列要求 ready、2 的幂、范围与对齐、used.idx==next_used、avail 未消费数 ≤ size，含 u16 环绕算术）；`MmioTransport` 增加 transport 状态与队列保存/恢复入口及 `activate_restored`（用恢复队列直接激活，不重走协商、不重置）；`VirtioDevice` trait 增加 `activate_frozen` 默认实现；`BlockWorker` 增加控制 eventfd + 命令通道 + 每请求独立 bounded(1) reply。
- 冻结语义：worker 以单一 `frozen` 字段为准；控制命令在弹出下一个描述符之前检查，Freeze 落在单个描述符链边界（该链完成 status 写、used 环更新与必要中断之后），每个链的处理都在独立作用域内持有 guest 内存克隆，冻结确认发出时没有任何临时映射克隆存活。确认后不再执行任何 ring 写（含 enable_notification）。冻结确认前无条件对磁盘 `flush()+sync()`（与 guest cache mode 无关；未激活设备直接 flush 共享 image），失败回 Err 且置 frozen，由保存方走恢复路径。Resume 只清 frozen 并把 reply 交给 epoll 循环延后确认，随后在循环层主动重查队列（disable→处理→enable_notification），绝不从命令处理内递归处理队列；丢失 eventfd 计数不会挂起。命令通道容量 16，`send_timeout` 计入 30 秒控制预算；超时不取消 I/O、不释放存活资源、不发布快照；过期 reply 由容量 1 通道丢弃，不污染共享通道；worker 退出/断链报错。
- 内部挂载（krun-vmm，cfg feature `blk`）：`RamSnapshotVm::attach_disk` 仅允许在 vCPU 启动前；固定内部 MMIO 窗口（0xd0000000 起，0x1000 步进，最多 8 个）与 GSI 16–23；首个设备挂载前先做阶段 2 RAM 别名探测（无设备附加基准），之后保存时按"每设备 transport 1 份 + 激活后 device_state 与 worker 各 1 份"的预期克隆数校验 region Arc 计数，不删除阶段 2 保护。
- KRUNVM v2：同 v1 头布局（magic/version/JSON 长度），JSON 增加有序 `disks` 数组（MMIO 地址/长度/IRQ/device id、transport 与 device 可复用状态、config 字节、image id、只读/cache、磁盘字节数），RAM 后按序追加 raw 磁盘段。JSON ≤16 MiB；恢复前校验版本、精确总长、容量乘法溢出、设备数 ≤8、唯一身份、MMIO/IRQ 窗口与 RAM/互不重叠（含 irqchip 保留 GSI 0–15 不用于内部设备）、config/image id 长度与三方容量一致。v1 `restore_full` 保持；v2 交给新 `restore_full_with_disks(path, destination)`，v1 文件在该入口下按无设备恢复。
- 保存顺序：配置检查 → Pause/确认全部 vCPU → 冻结并 flush 全部设备 → 在冻结后的静默边界按受控克隆数做 RAM 别名探测 → 逐设备同步 DEASSIGN irqfd（内核 flush 语义）并 drain 事件计数 → 捕获设备/CPU/KVM/RAM 与磁盘段 → sync 文件 → 重赋源 irqfd → 恢复全部源设备 → 恢复全部源 CPU → 写有效 magic。恢复阶段（irqfd 重赋、设备 Resume、CPU Resume）各自独立全量尝试并聚合错误；任一步失败 poison owner，绝不发布有效文件。
- 恢复顺序：metadata 校验（版本/长度/窗口/身份/features 契约等结构性检查）→ 读取 RAM 并校验活动 ring → 在创建守卫下导入磁盘文件（0700 目录、0600 独占编号文件）→ 创建 VM/irqchip/PIT → 按保存位置重建 frozen 设备 → 创建暂停 vCPU → 载入 CPU/TSC/VM 时钟状态（沿用阶段 2 契约）→ 返回暂停 owner，显式 resume 才启动。任何失败与销毁的清理顺序都是先 join 全部 CPU，再 join 全部 worker，最后释放资源与 owner 自建文件；守卫只删除自己创建的文件，预存在目录永不触碰。

### 验证计划

krun-devices 单测（无 KVM）：队列状态未激活/协商中/激活、游标环绕、event-index 一致性、pending 通知与 interrupt status 恢复；畸形队列拒绝；worker 冻结覆盖读/写/flush 中的边界、已消费请求恰好完成一次、未消费请求 resume 后完成、冻结切点内 RAM/磁盘稳定；控制超时/迟回复/线程退出。krun-vmm 测试（KVM，UNVERIFIED）：多磁盘/只读/QCOW2 backing 链与删除源文件后的恢复读写 flush、真实 guest 块 I/O 续跑（手写字节 fixture，保留现有 guest.bin 不再生成）、pending 中断与长暂停、畸形元数据/截断段/非法队列、注入写失败的中途清理与保存恢复。全部测试本阶段只写源码不执行。

### 阶段 3 最终契约与实施结果

- 设备侧（krun-devices，新增 serde 依赖，Cargo.lock 仅加边）：`virtio/persist.rs`（Firecracker 派生，保留来源标注）提供 `QueueState`/`VirtioDeviceState`（`validate_structure` 与带 RAM 的 `validate` 两级校验）/`MmioTransportState`（保留全部 guest 可写 selector 含 `shm_region_select`，不设范围检查；只拒绝状态机外的 device_status 与未知 interrupt 位）。`Queue::{is_event_idx_enabled}` 与 `pub(crate) num_added` 补只读/可见入口。`MmioTransport::{save_transport_state,queue_states,restore_transport_state,activate_restored}`；`VirtioDevice::activate_frozen` 默认返回 `BadActivate`（未支持设备不得静默起活 worker），Block 覆盖。
- `BlockWorker`：控制 eventfd + 容量 16 命令通道 + 每请求独立 bounded(1) reply；`send_timeout` 与 30 秒控制预算；单一 `frozen` 字段；控制命令在弹出下一个描述符前检查；每链独立作用域持有映射克隆（冻结确认时无临时克隆）；确认后零 ring 写；未激活设备由保存方直接 flush 共享 image；Resume reply 延后到 epoll 循环层主动重查后确认。`Block` 提供 `worker_control/config_bytes/nsectors/image_id/cache_type/shared_image/read_snapshot_chunk`（直接借用共享 image，无临时 DiskProperties Drop flush）与 `restore_snapshot_identity`；`reset` 同时丢弃控制句柄；`snapshot_offered_features(read_only)` 是恢复端校验用的预期 offered features 集合（与 `Block::new` 固定 `SyncMode::Full` 构造出的集合一致，含 RO 位一致性；`Block::new` 仍有自己的构造表达式，二者未共享实现）。
- vmm 侧 `ram_snapshot/blk/`（cfg feature `blk`）：`attach_disk` 仅 vCPU 启动前、拒绝非普通文件/不可用 owner/MMIO 窗口与 RAM 重叠（调用方前置条件：源盘文件及其整条 backing 链在挂载生命周期内不得有本私有 owner 之外的写入者，一致切点假设独占所有权，实现不取任何锁），任何失败 poison owner 并回滚已注册 ioeventfd/irqfd；`register_device` 需要 `&mut` owner（Bus::insert），先 ioevent 后 irqfd 后入 bus，失败全回滚。保存：pause → freeze 全部（active 走 worker，inactive 直接 flush）→ 静默边界按受控克隆数做 RAM 别名探测 → 逐盘 DEASSIGN+drain → 捕获（活动 ring 一致性用 guest RAM 校验）→ 分段拷贝 → sync → 独立依次重赋 irqfd / Resume 全部设备 / Resume 全部 CPU（聚合失败、poison、不发布）。恢复：metadata-only 校验（窗口/唯一性/重叠/config 与 image id 长度/容量乘法/transport 状态/结构 features/offered features 契约/DRIVER_OK⇔activated）在创建任何资源前；read_ram 后校验活动 ring；`ImportedDir` 创建守卫独占 0700 目录、逐文件 create_new 0600 并在创建时记录路径，Drop 只删除自己创建的文件与目录（预存在目录报错且永不触碰，有 sentinel 回归测试）；owner 在任何 worker 启动前接管守卫；`resume` 设备先行，任一失败即 join 全部 CPU 再 join 全部 worker 并 poison；Drop 顺序 CPU → worker → 守卫。
- KRUNVM v1/KRUNRAM v1 语义不变；`restore_full` 对 v2 明确报错；带盘 `save_full` 即 v2；RAM-only `save` 对已挂盘 owner 明确拒绝。guest fixture 由测试内字节 emitter 生成（GDTR@0x500→GDT@0x520、16 位代码段 D=0 G=1 与 4 GiB 数据段的 unreal mode 设置，返回实模式后不重载 DS/ES；三描述符链 header/data/status、状态哨兵 0xEE、0x41+计数写模式、读校验 0xC7、FLUSH 轮转、IOAPIC GSI16/x2APIC 中断；第 BARRIER_REQUEST-1=10 号请求提交前先 cli（该号为 WRITE 相位），完成计数达到 BARRIER_REQUEST=11 后驻留屏障并置字节标记，释放后 sti 并以独立 post-STI 标记证明 pending IRQ 在没有任何新请求的情况下送达；普通测试预置释放字节不驻留），阶段 2 fixture 与测试保持不动；worker 侧用按队列 eventfd 键控的一次性 RAII 请求门（键控 map，等待前移除条目，互不干扰、panic 安全）确定性覆盖 IN/OUT/FLUSH 三种 held 请求。Makefile snapshot 目标启用 `blk` feature 并纳入 krun-devices 测试（按 `snapshot` 名称过滤）；snapshot-fmt 覆盖全部新文件。libkrun README 增补 stage 3 行为。

### 阶段 3 未验证事项（原记录：全部 UNVERIFIED）

以下为阶段 3 提交时的原始记录；阶段 4 实施时的实际执行结果见“阶段 4 实际验证”。

遵照任务要求未运行任何格式检查、构建、测试、KVM 验收或 `git diff --check`；仅做源码阅读与逐项核对。因此：测试内字节 emitter 生成的 unreal-mode guest 程序（含全部编码与标签 fixup）、手工 qcow2 v3+backing 头部布局、irqfd DEASSIGN/drain 时序、屏障 pending 中断跨切点保存与恢复、导入目录权限/守卫清理、以及全部单测/集成测试的可编译性与通过性均未经执行验证。阶段 2 遗留的 musl/GNU 交叉链接限制对新增代码同样适用。下一执行环境应在 Linux x86_64/KVM 主机上先运行 `make snapshot-check`、`make snapshot-fmt`、`make snapshot-test`，再跑 blk KVM 验收；真实 guest 续跑断言依赖 emitter 编码正确性，首次执行需按失败现场逐条核对指令编码。

## 阶段 4 virtio-net 快照（2026-10-23）

### 契约

- 范围：Linux x86_64/KVM、单网卡、UnixStream（4 字节大端长度前缀帧）后端，仅私有 `RamSnapshotVm`（cargo feature `blk` + `net`），不接入普通 `Vmm`、C ABI、SDK、CLI。
- `attach_net(socket_path, mac, features)`：vCPU 启动前挂载；固定 MMIO 0xd0008000、GSI 23（占用磁盘窗口最后一个 GSI，带网卡时最多 7 个磁盘，无网卡仍为 8 个）；`features` 只接受 libkrun `NET_FEATURE_*` offload 位。后端在设备激活时同步连接：未激活网卡（包括恢复时）从不连接；连接失败则激活失败、不启动 worker。
- 后端 I/O：socket 非阻塞；前缀/帧体跨多次读取拼接；空帧跳过；超过 64 KiB 缓冲的帧丢弃；EOF 只报告一次，半帧丢弃不投递；每次读最多花 256 KiB 或 64 次 recv 后交还控制（含 EINTR）。TX 背压：未写出的链留在 avail 环（undo_pop），部分写出的帧余量留在 worker；`send` 返回 0 视为后端断开。无法发送的 guest TX 链（只有头、设备可写、超长、后端已失败）以长度 0 完成，不卡住队列。worker 每方向每轮最多 64 帧，剩余工作经自唤醒 eventfd 继续，每个描述符链前检查控制命令。
- 冻结：确认时所有已取出的链已进入 used 环且中断已发出；确认后不再写 guest RAM、ring、中断，也不做后端 I/O，直到 resume 或 stop。resume 主动重查后端和两个队列，冻结期间被吸收的 kick/readiness 不会导致卡死。`stop_worker` 在冻结状态下也能停止并 join 线程、关闭后端连接；`Net` drop 同样 join。
- 保存（KRUNVM v3）：pause 全部 vCPU → 冻结全部磁盘再冻结网卡 → 一次 RAM 别名探测（全部 worker 已冻结，无临时映射克隆）→ 逐设备 DEASSIGN irqfd 并 drain → 捕获设备/CPU/KVM/RAM/磁盘 → sync → 重赋 irqfd、恢复全部设备、恢复全部 CPU（各自独立尝试）→ 全部成功才写有效 magic。v3 = v2 布局（JSON、RAM、可选有序磁盘段）+ 网卡 metadata（MAC、attach features、设备 config、transport 寄存器、协商 features、RX/TX 队列状态）。无网卡 owner 仍写 v1/v2；`restore_full`、`restore_full_with_disks` 对 v3 明确报错。
- 恢复 `restore_full_with_net(path, disk_destination, socket_path)`：先做 metadata-only 校验（固定槽位、磁盘数、offered features 与 attach features 一致、config 字节与 MAC 一致、transport 状态机、队列结构），读 RAM 后校验两个 ring 及每个切点 TX head，之后才创建目录、socket、线程；有磁盘时按阶段 3 导入（无磁盘不创建目录）；磁盘与网卡都在 vCPU 线程创建前挂上；连接新后端失败即恢复失败并清理；返回暂停 owner。切点前未消费的 TX 在恢复后的 worker 存在之前以长度 0 完成，因此旧帧不可能到达新后端；丢弃只使用已校验的 avail 环 head 索引，不解析旧描述符，数量在开始时固定；对应中断在 KVM irqchip 状态恢复之后、任何 vCPU 运行之前发出（否则载入 irqchip 状态会覆盖之前的注入）。`resume` 先恢复磁盘和网卡，任一设备失败则不恢复任何 vCPU；清理顺序为 CPU → worker（关闭后端）→ 自有导入文件。
- 设计依据：沿用阶段 3 已核对的 Firecracker persist 结构与 Linux v6.12 irqfd DEASSIGN 语义；未新增依赖。阶段 3 的冻结/采集函数拆分为“冻结全部磁盘 / drain / 采集”，与网卡共享同一次别名探测与 drain。

### 阶段 4 实际验证

环境：macOS arm64 本机，x86_64 Linux 交叉目标。交叉 C 工具链由 Makefile 现有 sysroot 规则生成 Debian amd64 sysroot（额外 `libgcc-s1`，`lib64` 动态链接器绝对软链改相对），clang + lld。执行容器：本机 OrbStack `rust:1-bookworm`（linux/amd64，无 `/dev/kvm`），通过 Makefile 新增的 `SNAPSHOT_RUNNER`（cargo target runner）运行。

- 阶段 3 基线（未改动的 HEAD 38f72ef）：`make snapshot-check` 编译失败（3 处：block worker 测试门的 `std::os::unix::fd` 路径、vm-memory 0.17 的 `VolatileSlice::new` 签名、blk 测试移动非 Copy 的 `ImageType`）；`make snapshot-fmt` 会重排 8 个阶段 3 文件。三处已做最小修复并格式化。Linux 执行还暴露阶段 3 persist 测试夹具错误（ack EVENT_IDX 但未 offer、未设置队列标志），已修夹具，未放宽生产校验。
- 通过：`make snapshot-fmt`、`snapshot-check`、`snapshot-build`、`snapshot-test --no-run`；`make snapshot-net-host-test`（macOS 原生）；容器内全部 `krun-devices` snapshot 测试（块/网 worker、UnixStream 后端、persist）以及全部不打开 KVM 的 krun-vmm 测试（网卡 metadata/ring/丢弃校验、镜像版本分派）。
- 先红后绿：对 HEAD 的网络代码，半个前缀与半帧 EOF 让读取永久阻塞（看门狗 SIGALRM）、超长帧切片越界 panic、只有头的 TX 链使 worker 线程断言 panic、deferred RX 投递后不发中断；对修订前的后端，空帧洪泛使单次读取不受限并在 worker 层饿死 TX（20 s 内 TX used 停在 0）。现均通过。
- 无 KVM 设备层恢复测试（复制 RAM、按切点游标重建队列、生产丢弃原语、新后端双向流量、无 kick 推进；两种切点：半帧 RX+剩余 RX buffer，以及 deferred RX+部分写出的 TX+event index+u16 环绕）在 macOS 通过，前者也在 Linux 容器通过；去掉丢弃步骤时前者失败（新 worker 重放旧 TX）。丢弃改为只读 head 后，旧的基于 pop 的实现对“head 合法但旧描述符体非法”的链报 `InvalidDescriptorIndex`（先红后绿）。Linux 执行还暴露测试时序问题：ET 读唤醒同时报告可写，worker 会合法地检查 TX，测试改为等待该唤醒结束后再放入切点 TX。
- KVM 测试（`nic/kvm_tests.rs`：测试代码经 owner 的 MMIO 总线扮演 virtio-net 驱动，阶段 2 计数 guest 证明 CPU 续跑；覆盖活跃流量+半帧+未消费 TX 时保存、源端在原后端继续、新后端恢复后旧 TX 丢弃与中断状态、暂停 CPU、resume 后双向流量、未激活网卡+磁盘、后端失败与旧入口清理、保存失败恢复、GSI 共享上限）只编译通过。没有测试让 guest 自己经 MMIO 读取恢复后的网卡或在恢复后接收 pending 网卡中断；该项按用户要求精简测试，作为 UNVERIFIED 验收项记录在 libkrun README。
- **UNVERIFIED**：所有需要 KVM 的测试在容器中均因无法打开 `/dev/kvm` 失败；阶段 3 块设备续跑与上述阶段 4 KVM 测试均未在 Linux KVM 主机上执行。真实 DNS/TCP 验收无法在当前私有 harness 中执行（`start_vcpus` 只启动实模式 fixture，不启动 Linux guest）；验收步骤见 libkrun README（需能启动 Linux guest 的 harness 扩展、`virtio_mmio.device=4K@0xd0008000:23`、passt/gvproxy 的 QEMU stream 模式后端、保存后换新后端恢复，期望旧 TCP 断开、新 DNS/TCP 成功）。

## 完整快照统一契约（v7）

### TL;DR

私有 `RamSnapshotVm` 以唯一的 KRUNVM v7 导出/导入 RAM、CPU/KVM 与 virtio-blk、virtio-net、virtio-vsock、virtio-console、virtio-rng、virtio-balloon、UART、CMOS、i8042 及最多七个 virtio-fs 共享；生命周期为显式 `pause` → `export`（保持暂停，可重复）→ `resume`，导入返回同样的暂停状态。目标资源由 `RestoreResources` 提供，每项当且仅当镜像含对应设备时提供。virtio-fs 导出一份独立文件副本，恢复不依赖源目录。KVM 运行验收仍 **UNVERIFIED**。详细契约以 libkrun `README.md`“Internal minimal VM checkpoints”及 `docs/phase12-virtio-fs-snapshot.md` 为准。

### 契约

| 项 | 当前行为 |
|---|---|
| 范围 | 仅 Linux x86_64/KVM 私有 `RamSnapshotVm`；不接入普通 `Vmm`、C ABI、SDK、CLI；无通用设备框架；BoxLite/shim 未接入（阶段 13） |
| 生命周期 | `declare_host_writers_stopped`（运行、可用、未暂停时；pause 保留，resume 与禁用清除；含共享的导出必须先声明）→ `pause`（暂停并确认全部 vCPU，冻结全部设备 worker 与事件线程，解除并 drain irqfd）→ `export(path)`（捕获同一切点，不恢复任何东西，可重复；失败删除半成品，保持暂停可重试）→ `resume`（清除声明，重挂 irqfd，先恢复全部设备，最后恢复 vCPU）。`import(path, resources)` 返回与 pause 后源相同的暂停状态，可先再次导出；导入的共享视为已声明。不确定的控制禁用 owner 并停止、join 全部线程 |
| 格式 | 只有 KRUNVM v7：16 字节头、≤16 MiB JSON（CPU/KVM/RAM、有序磁盘表、可选 NIC/RNG/balloon/vsock/console/legacy/virtio-fs 段）、RAM、磁盘段，然后 virtio-fs 文件字节、去重 init.krun 字节、非零 4 KiB DAX 页；先校验 RAM 区域再校验设备段，所有长度以 checked 加法核对精确文件长度；v1–v6 明确拒绝，RAM-only `KRUNRAM` 仍为 v1 |
| 恢复资源 | `RestoreResources { disk_dir, nic_socket, serial, vsock_ports, console_ports, fs_dir }`，每项当且仅当镜像含对应设备时提供；`fs_dir` 须为不含 NUL 的绝对路径，0700 独占创建，成功后保留（guest 数据）；资源匹配先于创建 RAM、目录、socket 或线程 |
| 布局 | 无网卡最多 8 盘、有网卡 7 盘（网卡 0xd0008000/GSI 23）；RNG 0xd0009000/GSI 5；balloon 0xd000a000/GSI 6；vsock 0xd000b000/GSI 7；console 0xd000c000/GSI 8；virtio-fs 共享 i 在 0xd000d000 + i×0x1000/GSI 9+i；COM1–4 端口 0x3f8/0x2f8/0x3e8/0x2e8、IRQ 4/3/4/3；CMOS 0x70；i8042 0x60/IRQ 1。DAX 窗口为 owner 映射的额外 memslot，不与 RAM、MMIO 槽、其他窗口及 KVM 自身地址重叠 |
| vsock | 仅 Unix IPC（无 TSI）；连接与 RPC 不跨 pause 保留，guest 监听保留；恢复时投递 transport reset 后重开后端 |
| console | 多端口；保存控制状态、端口握手、未交付控制消息与在途数据；已交付宿主的输出不回放；恢复绑定新端口 |
| virtio-fs | 导出一次归档全部共享（独立文件副本：对象跨共享去重，硬链接、孤儿对象、xattr 保留），需要初始 user namespace 中的 CAP_SYS_ADMIN；保存 FUSE session、node/handle、目录游标、inode 投影与 DAX 窗口 ledger；带 DAX 窗口的 owner 以执行屏障保证重映射期间无 vCPU 运行，宿主映射失败为致命，可能失去所有权的范围保留至进程结束 |
| RNG/balloon/UART/CMOS/i8042 | 与 v4 时相同：RNG/balloon 由事件线程运行，每回调最多 64 条链，balloon 先校验整条报告再 discard；UART 仅接受非阻塞 `UnixStream`，不迁移输出队列，满/断开时丢弃并计数，输入上限 4 KiB；CMOS 容量字段须与 RAM 布局一致；i8042 缓冲按读出顺序保存（细节见 libkrun README stage 5/6） |
| 中断 | MMIO 与 legacy 共用 irqfd 接线；pause 时 DEASSIGN+drain，resume 时重挂；已注入中断在 KVM 状态中，不重放 |
| 退出 | i8042 reset 与每个 vCPU 退出写同一 owner exit eventfd，事件线程锁存并停止全部 vCPU；`pause`、`export`、`resume` 与 RAM-only `save` 拒绝退出状态，目标不重放 reset |
| 清理顺序 | 关闭 vsock 闸门 → 停止/join 事件线程 → retire 执行屏障 → join vCPU → 磁盘、网卡、vsock、console worker → retire 并 join fs 共享 → 释放自有资源（DAX 窗口晚于 VM fd）；启动、导入、resume 失败均走同一路径 |

### v7 验证（2026-10-24，阶段 12 最终）

- amd64 `rust:1-bookworm` 离线容器（`--cap-add SYS_ADMIN --tmpfs /tmp:rw,exec`，无 `/dev/kvm`）：`snapshot-check`（含无 feature 的 `krun-vmm`、`krun-devices`）、`snapshot-build` 通过；`krun-devices` snapshot 132/132；`krun-vmm` 59 通过、54 失败，全部为打开 `/dev/kvm` 失败（原有 48 + 6 个 `snapshot_fs_kvm`）；无 feature `krun-vmm` 55 通过、41 失败，原因相同。macOS `snapshot-fmt`、`krun-devices` check 及原生 console/net/vsock 26/26、20/20、16/16 通过。
- **UNVERIFIED**：全部 KVM 测试与需要 VM 的 owner 路径、Linux guest 的 virtiofs/DAX 驱动、真实 BoxLite/shim 恢复。KVM 测试为失败，不是跳过或通过。

### v4 实际验证（2026-10-23，历史记录）

- 通过：`make snapshot-fmt`；`CC_x86_64_unknown_linux_gnu=… make snapshot-check CC_LINUX=…`（仅既有基线告警）；无 feature 的 `krun-vmm --tests` Linux 检查。
- amd64 `rust:1-bookworm` 容器（无 `/dev/kvm`）内 `make snapshot-test SNAPSHOT_FILTER=…` 通过：UART 端点（阻塞拒绝且不改标志、满/断开丢弃计数且有 THR、4 KiB 上限与 overrun、EOF 空/短/恰好 4 KiB/超容量尾部均 drain 并注销且不忙等）、UART/CMOS/i8042 状态往返、legacy metadata 与端点校验、无设备事件线程的退出停止与冻结竞态、既有事件线程冻结/恢复测试；批次 1 的 RNG/balloon/版本/资源与 NIC 非 KVM 测试见其记录。
- 先红后绿：普通 UART 空读测试在未修改树上失败（`EOF reported as data`）；HUP 超容量尾部（drain 预算回退为 4096 时 `overrun disagrees …`）与 i8042 跨 `usize` 回绕游标（`attempt to add with overflow`）在仅回退对应生产行时失败，修复后通过。exit 锁存/轮询顺序是竞态修复，无确定性复现。
- **UNVERIFIED**：全部 KVM 测试，包括扩展的阶段 2 fixture（入口 0x800：COM1 输出、保存、新端点恢复且不重放输出、恢复后继续运行；guest i8042 reset 后仍持续计数，测试等待 vCPU 线程结束、计数停止，且 save/resume 被拒绝）及既有 v4 路径 KVM 测试。`cfg(test)` 下 vCPU 自身退出不写 exit eventfd，vCPU 退出接线仅由 eventfd 层测试覆盖。
