# libkrun 分阶段快照计划

2026-10-22 · 设计研究，尚未实现。

## 目标与范围

最小闭环：**运行中的 box → 导出单个快照文件 → 导入后创建继续运行的 box**。
恢复的是原 guest 进程、内存和磁盘在同一切点的状态，而非重新启动容器。

首版限定 Linux x86_64/KVM、普通非加密内存、内核内中断控制器、固定设备拓扑及兼容的 CPU/KVM 能力。
允许整个导出期间暂停 VM，允许外部连接断开并重连。暂停时长和文件大小暂不设优化目标。
不包含 virtio-fs 快照、业务层迁移调度、跨架构恢复、增量快照或不停机迁移。
首版拒绝 split irqchip、嵌套虚拟化、TEE、直通及未列入下述阶段的设备配置。

## 固定源码基线与取舍

以下“现有实现”均指这些固定提交，阶段中的改动和验收均为后续工作：

| 项目 | 固定版本 | 作用 |
| --- | --- | --- |
| BoxLite | [`2794df3f4ee38738b5d3c2dc73b1d566a82f94cd`][boxlite] | 调用方、启动流程、现有归档 |
| libkrun | [`e12b9b3780ffa8df9f3e1797b217d13453479167`][libkrun] | BoxLite gitlink 指定的 VMM 和设备实现 |
| libkrunfw | `e0647fa7a3932c4570fb2c0fd483b9f7a382ebdd` | 同一 BoxLite 提交的固件 gitlink |

- 复用已有 KVM 状态读写：[VM 状态][vm-state]包含 PIT、clock、PIC 和 IOAPIC；[vCPU 状态][vcpu-state]包含寄存器、MSR、LAPIC 等。但保存函数未接入运行时请求，不能据此认定已有完整快照能力。
- 复用 BoxLite 的[磁盘展平与归档][export]经验。当前导出只打包容器盘及配置，[导入][import]创建 `Stopped` box；这些机制不能恢复运行中进程。
- 采用暂停后全量保存，避免首版引入脏页追踪和多轮内存复制。只有所有 RAM 写入者停止后，磁盘、内存、设备和 CPU 才能属于同一个切点。
- 按 [KVM API][kvm-api] 的能力查询及状态读写约束重建 VM/vCPU；宿主 FD 和线程不属于可移植状态。兼容性由实际 CPUID、MSR、XSAVE 和 KVM 能力校验决定，不能只比较操作系统版本。

## 前置工作与公共契约

### 消除隐式 virtio-fs 启动依赖

[BoxLite 磁盘启动路径][krun-engine]调用 `krun_set_root_disk_remount`。
该 [libkrun 实现][root-remount]仍创建 `/dev/root` virtio-fs 设备，让 `init.krun` 从虚拟文件启动后切换到块设备根目录。
因此，仅禁止用户共享目录不能满足“无 virtio-fs 快照”的范围。

在恢复闭环前，为快照支持的 box 建立不创建 virtio-fs 设备的启动路径：将所需 init/guest agent 放入块设备或 initramfs，显式配置内核入口与根盘。
检查 guest root、容器根目录、引导文件及内部共享，禁止任何剩余宿主目录依赖。
验收必须同时检查 guest 挂载和 VMM 实际设备清单；切换根目录或卸载共享并不等于设备不存在。
已按旧路径启动且仍有 virtio-fs 设备的 box 不在首版支持范围内，导出前明确拒绝。

### 冻结与恢复边界

建立 VMM 内部控制通道，能够在 `krun_start_enter` 接管执行后处理请求；BoxLite/shim 只发起操作并等待完成。
保存状态不能通过直接序列化整个宿主进程实现。

1. 阻止新的管理变更和外部输入；请求所有 vCPU 暂停并等待逐个确认，完成挂起的 KVM I/O/MMIO 退出语义。
2. 各设备停止接收新工作，在完整请求边界处理已取出的描述符；等待 worker、event loop 和 muxer 确认不再修改 RAM、队列或中断状态。
3. 刷新磁盘后端，处理 KVM 时钟/定时器及中断冻结边界；在共同切点保存 RAM、CPU、设备和磁盘。只暂停 vCPU 不足以建立该切点。
4. 文件完整写入并原子发布后，源 VM 可继续运行。失败时撤销冻结；不能可靠恢复运行则保留明确的暂停/失败状态，不报告成功。
5. 导入先校验文件及兼容性，再创建暂停的 VM。重建内存映射、磁盘、设备拓扑及宿主资源，恢复状态后统一放行设备和 vCPU。

恢复路径不得执行覆盖 RAM 的冷启动初始化，不得再次运行 guest/container 初始化来替代恢复。
guest 内可见时间采用冻结期间不倒退的暂停语义；阶段 2 明确 TSC、kvmclock、PIT/LAPIC 计时与外部时间同步的处理。
外部服务可已超时，恢复后由连接重建处理。

### 通用 virtio 状态

阶段 3 首次实现，阶段 4–8 复用，避免每个设备各建一种恢复协议。
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
阶段 1–2 使用受控的最小 VM 验证基础状态；完整设备集通过阶段 3–11 后，阶段 12 才提供用户闭环。

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
- **前置依赖：** 阶段 1–2、无 virtio-fs 启动路径；磁盘复制期间冻结所有写入者。guest 脏页保留在 RAM，与磁盘和队列形成同一切点，不以 guest `sync` 代替设备一致性。
- **验收标准：** 带并发读写和 flush 的 VM 恢复后可继续文件 I/O；切点前完成的写入存在，未消费请求正常完成，无重复完成。删除源盘、backing chain 和镜像缓存后仍可读取全部块设备内容。

### 4. virtio-net 快照

- **现有实现：** [NetWorker][net]持有 RX/TX 队列、deferred frame 缓冲和宿主网络后端；线程启动后没有用于快照的暂停/回收接口。BoxLite 将网络 socket 路径和 MAC 传入 libkrun。
- **改动范围：** 保存公共 virtio 状态、MAC/设备配置及已取出描述符对应的缓冲进度；为 worker 增加确认式冻结。恢复时重建 gvproxy/TAP/Unix socket 后端和网络策略。旧宿主 TCP/NAT 状态不迁移，网络边界允许丢包和重连，但不得破坏 ring 进度。
- **前置依赖：** 阶段 3 的公共机制、阶段 1–2；固定首版网络后端与地址配置，明确后端重建和 guest 网络重新可用的流程。
- **验收标准：** 在 RX/TX 活跃及 deferred frame 状态恢复；旧连接允许断开，新 DNS 查询和 TCP 连接成功，队列继续推进且不会因丢失事件永久卡住。

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

### 12. 单文件 export/import 集成

- **现有实现：** BoxLite 的[导出][export]打包 manifest 和展平的容器盘，[导入][import]生成新 box；没有 RAM、CPU、设备状态，也没有快照恢复专用启动路径。
- **改动范围：** 将统一冻结、保存、恢复接到 libkrun 控制通道、shim 和 BoxLite 生命周期。定义独立的运行态快照类型/版本，保留已有磁盘归档语义；容器中包含 manifest、兼容性与拓扑、全部 RAM、CPU/VM/设备状态、全部独立磁盘和必需引导资产。
- **前置依赖：** 前置启动改造和阶段 1–11 全部完成；导出逐设备核对支持清单。文件记录各段版本、长度和校验和，校验大小上限、偏移、路径及完整性后才创建资源；不允许依赖源路径、镜像仓库或 QCOW2 backing 文件。
- **验收标准：** 执行下述最终验收。新 box 获得新宿主 ID/目录/端点，guest 内进程身份保留；恢复重连不重新执行 entrypoint。截断、损坏、不支持版本/设备及不兼容 CPU 均明确失败，不发布半成品 box。

## 最终验收标准

以下是功能实现后的验收要求，不是本次文档变更已运行的结果。

1. 在支持配置的 box 中启动长期运行进程，记录 PID、进程启动标记、只存在于堆内存中的随机标记和递增计数；同时产生磁盘写入，并建立外部连接。
2. 从运行中的 box 导出单个快照文件，记录一致切点。切点后在源 VM 上修改内存/文件，用于确认恢复不会混入后续状态。
3. 销毁源 VM、shim 和网络后端；移除源 box 目录、原磁盘及 backing 数据。在无源缓存和镜像仓库依赖的新运行时目录准备导入。
4. 在兼容 Linux x86_64/KVM 宿主上，仅提供快照文件和已安装的兼容运行时。创建新 box，原进程从切点继续运行：PID、启动标记、堆标记保持，计数继续，文件与切点对应，切点后源修改不存在。
5. 通过重新建立的控制通道执行新命令、继续磁盘读写，并成功建立新的网络连接。旧连接允许断开，不能因此要求重启 guest 或容器。
6. 覆盖多 vCPU、设备有未完成工作、长暂停、导出失败和导入失败。验证恢复后的时钟/中断、随机数、free-page reporting、控制台及 legacy 设备仍工作。

仅能启动新内核、恢复文件、重新执行原命令，或依赖源进程/源盘存活的方案，均不满足闭环。

## 本次文档检查范围

仅核对固定版本源码、Markdown 结构和 `git diff --check`。本次不实现快照，也不运行测试；所有运行时验收留待对应阶段实现。

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
