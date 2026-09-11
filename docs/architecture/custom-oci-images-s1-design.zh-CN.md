# 自定义 OCI 镜像 — S1 详细设计与执行计划

> **本文是 v3。** v1 按上游方案设计了一条独立的 register 流程（`POST /images/registers`
> ＋ `apps/image-builder` ＋ 平台 OCI registry ＋ `image_build` 表）。v2 取消整条
> register，改为**复用现有 pull 机制、在拉取成功后自动登记**。v3 对着
> [Notion: Issue 清单（S1–S4）](https://app.notion.com/p/3d68d8d971798181b56fde0962110267)
> 与当前代码逐条复核，**裁决未变、事实有更正**——最重的一条是
> `imageRevalidate` 的载体（§0.3.3 V1）。逐条差异见 §0.3.3。

上游三份文档（**不在本仓库**，读于 `082a5a4a` / `af28785c`）：

- `custom-oci-images.md` — 工程方案（英文）
- `custom-oci-images.zh-CN.md` — 同一份方案的中文版
- `custom-oci-images-issues.md` — 上游 S1–S5 的 issue 拆分

分期与阶段边界：`custom-oci-images-staging.zh-CN.md`（同样不在本仓库）。
S1–S4 的 issue 拆分：[Notion: Issue 清单（S1–S4）](https://app.notion.com/p/3d68d8d971798181b56fde0962110267)。
产品旅程：[Notion: Images user journey](https://app.notion.com/p/Images-user-journey-3ce8d8d97179808a9ee0c3c936c3673c)。

本文只覆盖 **S1**：交付物、架构与调用图的前后对比、表结构、新增功能与性能变化、
按 PR 切分的实施计划、测试与验收判据。

**事实读取基准**：`4d806970`（v1 读于 `305d089a`，v2 读于 `fd1a0f32`）。**注意 `4d806970`
不在本分支的历史里** —— 它是同日另一条特性分支（`silverzkili/pol-507-…`）的顶端，本分支
从 `783609f2` 切出；本文引用的 `file:line` 已按本分支重核。
`fd1a0f32..4d806970` 只触及 `src/guest/` 与一份 docs，**不改动 `apps/` 或
`src/boxlite/src/` 下任何被引用的文件**。本文引用的 `file:line` **全部在本版重读过**，
未标注的即为已核实；三处沿用未重读的引用在 §9 索引里标了 ✗。**注意这批 `file:line`
是改动**前**的快照** —— 设计章节描述的是当时的代码，所以 `src/boxlite/` 下的行号在本
设计落地之后普遍已经偏移（例如 `get_or_create` 当时在 `image_disk.rs:78`，现在在
`:269`）。只有 §0.3.4 与 §9 里标了「实现期新增」的条目指向改动**后**的树。符号名在两
种情况下都准确，按名字查比按行号查可靠。凡与上游冲突之处**以本文
为准**。周数与 LOC 是判断，代码事实不是。

**本文的设计部分（§1–§6、§7.1–§7.3、§8）写于实现之前，未经构建或测试**；之后新增的
三处是实现与验收跑完才写的，标注了实测值：§0.3.4 的修订日志、§5 的 P16／P17 两行、
以及 §7.4／§7.5 里记着观察值与实测数字的那些行。两者不要混读。

**S1 的一句话验收：我能直接用任意公开镜像创建 box，并在控制台看到我用过的镜像。**

---

## 0. 要交付的东西

### 0.1 交付物清单

| # | PR | 交付物 | 路径 | 形态 | 用户可见 |
|---|:--:|--------|------|------|:--------:|
| 1 | B | 残留清扫 | 20 处 `TODO(image-rewrite)` 删除点 ＋ `organization` 删列（**连带 `organization.dto.ts:93`、`:175`**）＋ `*:templates` 隐藏 ＋ `/api/templates` 指标删除 | 删除 | 否 |
| 2 | B | 镜像目录表 | `image` / `image_version` / `image_tag` ＋ `organization.image_count_limit`，一个 pre-deploy 迁移 | 新增 | 否 |
| 3 | B/C | `ImageModule` | `apps/api/src/image/`（entities / dto / controllers / services / guards / utils），照 Volume 模块形状 | 新增 | 否 |
| 4 | B | **`ImageAdmission`** | `apps/api/src/box/services/image-admission.service.ts`，替换 `box.service.ts:209` 的 `assertSupportedImage` | 新增一跳 | **是**（错误信息） |
| 5 | B | **`ImageResolver`** | `apps/api/src/box/services/image-resolver.service.ts`，目录命中则送 digest 钉死 ref，未命中透传 | 新增一跳 | 否 |
| 6 | B | **digest 回报链路** | core 暴露解析出的 manifest digest 与层大小之和 → Go binding → `UpdateBoxStateDto` → 目录 upsert | 跨 3 语言新增 | 否 |
| 7 | B | **tag 重新解析** | `BoxOptions` 加一个非持久化的 `image_revalidate` 开关；**开关值在派活时由 `box.image` 现算**（§0.3.3 V1） | 行为变化 | 否 |
| 8 | A | **下载上限（两层）** | manifest 声明总量拒绝（`store.rs`）＋ 写入侧流式上限（`storage.rs`），补齐解压侧已有的对等物。见 §0.3.4 W1 | 行为变化 | 否 |
| 9 | C | REST 四个端点 | `GET /api/images`、`GET /api/images/usage`、`GET /api/images/:idOrRef`、`DELETE /api/images/:idOrRef` | 新增 | **是** |
| 10 | C | 权限 | `read:images` / `delete:images`；`*:templates` 隐藏 ＋ **把已存在但指向 templates 的 "Images" 权限分组改指到真的 `*:images`**（`OrganizationPermissionsGroups.ts:15-18`）；`CreateApiKeyPermissionsGroups.ts:9-14` 今天**只有 Boxes 一组**，要加 Images。**不加 `write:images`** | 新增 | **是** |
| 11 | C | `BoxDto.progress` | `{ phase: 'preparing_image', retryAfterMs }`，由 API 派生 | 新增字段 | **是** |
| 12 | C | 极小 Python 客户端 | `sdks/python/boxlite/cloud/`：`images.list/get/delete/usage`，同步面 ＋ 异步面，**零第三方依赖** | 新增 | **是** |
| 13 | C | 控制台 Images 页 | `apps/dashboard/src/pages/Images*`；`RoutePath.IMAGES` 取消隐藏；`CreateBoxDialog` 改读 API | 新建页面 | **是** |
| 14 | B | warm pool 收窄到 curated | `requiresFreshBox` 加镜像维度 ＋ `createForWarmPool` 拒绝 ＋ **四处站点五份**字段清单收成一个共用谓词 | 行为变化 | 否（租户隔离） |
| 15 | A | **D1 — 回收不可达的镜像基盘** | `src/boxlite/src/images/image_disk.rs` ＋ 三个触发点 ＋ `load_from_local` 补 index 行 | 行为变化 | 否 |
| 16 | C | e2e | `apps/e2e/cases/test_images_catalog.py`，经第 12 项的同步面驱动 | 新增 | 否 |
| 17 | C | `/api/images` 指标 | `apps/api/src/interceptors/metrics.interceptor.ts` | 新增 | 否 |
| 18 | C | 本地栈支持 | 本地 registry 同时充当"外部公开来源"；准入允许表在本地放开到 `127.0.0.1:25000` | 修改 | 否 |
| 19 | A | **D2-min — 空间压力下淘汰冷基盘** | `image_disk.rs` 的建盘前空间检查 ＋ 按 `last_used_at` 淘汰；`image_index` 加一列 | 行为变化 | 否 |
| 20 | A | **`autoDelete` 默认值定稿** | `box-lifecycle.constants.ts:8` 今天是 `AUTO_DELETE_DISABLED = 0`；不定它，"用完可弃"在机制上通、在回收上不通（§0.3.3 V4） | 决策 ＋ 可能改默认值 | **是**（若改） |
| 21 | A | **回收的两个计数器** | `RuntimeMetrics` 上 `image_disks_evicted_total` ＋ `image_disk_bytes_reclaimed_total`；镜像到四个 SDK、两处 REST DTO、`openapi/box.openapi.yaml` 与它的参考服务端（W12，对 A13 的有意破例）。**日志落到 journald 不在本期**（W13） | 只增只读 API | 否 |

### 0.2 S1 明确不交付

- **私有 registry 凭证**（PAT / ECR）、`registry_credential` 表、`apps/image-service` → **S2**
- **tag 移动 / History**（`image_tag_event`）、`write:images` scope → **S2**
- **积极淘汰 ＋ HRW 亲和**（缩小工作集、抬高命中率）、上游消失检测、version 级 `lastUsedAt` → **S2**。**紧急淘汰（D2-min）留在 S1**，理由见 §0.3.1 N13
- **fleet 共享的预建基盘缓存**（建盘时上传对象存储、任何 runner 首次需要就下载）→ **S3**，理由见 §0.3.1 N14
- **构建**（Dockerfile / 声明式 DSL）、BuildKit、构建日志、上下文上传、`cmd/builder/` → **S3**
- **平台 OCI registry / 平台存储**、`image_storage_limit_gib`（字节闸门）、镜像 GC 清扫器、`inactive` / rehydrate → **S3**
- 生成的 Python 客户端（`apps/libs/api-client-python`） → **S3**；S1 的 `boxlite.cloud` import 路径与之保持一致
- **reflink 基盘去重** → **S4**
- **多地域镜像存在性** → 只发 `us`
- **每 box qcow2 的高水位回收** —— 今天没有判据（guest 里释放的块不还给宿主），未排期

---

### 0.3 相对上游方案的修订

> 每条都带代码依据。不接受其中任何一条，就要相应改掉本文 §1–§8 里对应的部分。

#### 0.3.1 v2 引入、v3 保留的裁决

| # | 上游怎么说 | 本文裁决 | 代码依据 |
|---|-----------|---------|---------|
| N1 | S1 的核心动作是 register：把用户指定的镜像 copy 进平台 registry | **取消整条 register。** 用现有 pull 机制直连上游，**拉取成功后自动登记**进目录 | 未列入 runtime registry 表的 host 一律匿名认证（`images/store.rs:1072`）；runner 把 `boxDto.Image` 原样喂给 runtime、路径上无任何 ref 限制（`client.go:314`）；注释已写明 core 会拉 "public user images"（`client.go:163`）；基盘按内容 digest 缓存、ext4 大小由镜像内容决定（`image_disk.rs:78-88`）；解压侧已按不可信输入加固（20 GiB 放大上限，GHSA-gcpm-8w8q-gp9v，`archive/extractor.rs:704-722`）；box 创建本来就是异步的——`BoxService.create` 只落一行，真正派活的是对账循环（`box-start.action.ts:59-83`），拉取不占 HTTP 连接。用户和任意镜像之间**只隔着 `box.service.ts:209`** |
| N2 | （不适用） | **目录行只在拉取成功后写入，不写 `pending` 行** | 写 `pending` 行就会有卡死的行，于是需要陈旧判定与心跳——正是 N1 删掉的那套机器。失败已有归宿：box 进 ERROR ＋ `errorReason`（`update-box-state.dto.ts:11-35`，它 `:24` 的示例恰好是 `'Failed to pull artifact image'`）。并发同 ref 由 `UNIQUE(imageId, digest)` ＋ `ON CONFLICT DO NOTHING` 兜住 |
| N3 | `assertSupportedImage` 是 S1 要替换掉的门 | **换成 `ImageAdmission`，不是删除。** registry host 允许表 ＋ per-org 并发冷拉上限 ＋ per-org 镜像数量上限 ＋ ref 语法校验 | 直接删门 = 攻击者可选的 egress 从 KVM 宿主出去 ＋ 无界镜像种类堆在共享 runner 盘上 |
| N4 | resolver 输出永远是 digest 钉死的平台 ref | **digest 必须由 runner 回报**，因为 API 不得抓取用户提供的 ref。**今天做不到**：manifest digest 只作为 `pub(super)` 字段存在（`images/manager.rs:34`），`ImageObject` 没有公开访问器；而 `compute_image_digest()` 是**层 digest 串的 sha256、不是 OCI manifest digest**（`images/object.rs:284-292`），且是 `pub(crate)`。`ImageInfo.id`（`manager.rs:158`）才是 manifest digest——**证明值就在手里，缺的只是访问器** | 让 API 对用户可控的 host 发出站请求 = SSRF 面。而 runner **本来就在拉**，digest 与大小都是拉取的副产品 |
| N5 | （未提及） | **首次用 tag 拉取时必须重新解析**，不能命中按 ref 字符串的缓存 | `ImageStore::pull` 的快路径 `try_load_cached(&inner, &ref_str)` 在**任何网络调用之前**按 ref 字符串返回（`images/store.rs:172-179`，调用点 `:176`）。tag 是可变指针，缓存它而不重校验，在 curated-only 下被运维轮换掩盖；pull-through 下会"首次用 `python:3.12` 拉到三个月前的字节，然后把那个 digest 永久钉死"。**必须按 create 传入的开关**触发，不能对所有 tag ref 一律重解析——那会给 curated 的每次创建加一次 registry 往返，打破 §7.3 的"逐字节一致"基线 |
| N6 | （未提及） | **压缩层下载缺流式上限** | `storage.rs:619` 是**事后**校验（`bytes_written != expected_size` 在 `commit()`（`:603`）时才比），且 `expected_size <= 0` 时整个跳过——`LayerInfo.size` 的字段注释自己写明 "Values <= 0 mean 'unknown' and skip size validation"（`manager.rs:46-48`）。恶意 registry 声明 `size: 0` 即可无界写满共享 runner 的盘。解压侧有 20 GiB 上限，下载侧没有对等物 |
| N7 | `organization.image_storage_limit_gib`（字节闸门） | **S1 换成 `image_count_limit`（数量闸门）** | S1 没有中心存储可计量；pull-through 下真正压 runner 盘的量是**镜像种类数**——runner 是从可用性前 10 台里随机选的（`runner.service.ts:308`、`:788`），每台最终缓存每个租户的每个镜像。字节闸门随平台存储回到 S3，届时两个闸门并存 |
| N8 | `DELETE /images/:name` 必须真的删平台 registry 的 manifest，否则字节泄漏 | **S1 无平台字节，`DELETE` 只软删目录行。**语义是"从我的目录里移除"，不是"删除字节"——下次再用同一个 ref 会重新拉回来。文案必须这么写 | 字节从来不是我们的，上游才是权威。真删除是 S3 的属性。**副作用**：`DELETE` 因此成为 S1 唯一的 re-pin 逃生口（见 N9） |
| N9 | （未提及） | **digest 钉死之后 tag 无法前进**：`app:latest` 永远停在第一次解析到的 digest，而 S1 不做 tag 移动 | 逃生口是"`DELETE` 后再用一次"。S2 的 `PUT .../tags/:tag` 把它升级成一等操作。这条要写进端点文档与控制台文案 |
| N10 | `image.name` 是用户起的短名（register 的入参） | **`image.name` 是上游仓库路径**（`docker.io/library/python`），tag 进 `image_tag.name`。因此：`varchar(128)` 放宽到 `255`；`:name` 路由参数吃不下斜杠，改成 **`:idOrRef`**（uuid 或 URL 编码的 ref），照 `VolumeService` 的"id 或 name"解析形状 | pull-through 下没有起名环节。Artifact Registry 那种深路径会超 128 |
| N11 | 权限 `read/write/delete:images` | **S1 只加 `read:images` / `delete:images`。** 隐式登记是 `write:boxes` 的副作用，不得要求调用方额外持有 `write:images` | 否则每个建 box 的调用方都要多一个 scope。`write:images` 留给 S2 的 tag 移动。参照既有 enum：templates 与 registries 只有 write/delete，volumes 才是三件套（`organization-resource-permission.enum.ts:10-39`） |
| N12 | `BoxDto.progress`（`preparing_image`）在上游 S3 | **上移到 S1** | pull-through 下冷拉从 day one 就在 box 创建路径上，不是"新机器上第一个 box"的边缘场景 |
| N13 | D2（LRU 淘汰）在上游 S3，且**必须与 HRW 同期发** | **拆开：紧急淘汰（D2-min）上移到 S1，积极淘汰 ＋ HRW 留在 S2。**淘汰信号用 `image_index.last_used_at`，**不用 mtime** | 上游的绑定理由是"淘汰越狠越多 box 付冷启动，亲和抬高命中率"——那是**性能**论证，缓解是保守阈值而不是"别发淘汰"。而 S1 的容量算术不允许推迟：root 卷 100 GB（`settings.ts:14-19`），留 30% 给 box qcow2 与系统 ≈ 70 GB，按实测上界 141 MiB/块 → **约 500 块基盘**；随机调度（`runner.service.ts:308`、`:788`）下每台 runner 最终缓存每个镜像，`image_count_limit=20` 时**25 个活跃 org 就能填满一台**。而**运行时今天没有任何剩余空间检查**（`available_space`/`statvfs`/`free_space`/`disk_usage`/`fs2::` 在 `src/boxlite/src` **零命中，本版复查仍为零**），满了就是 ENOSPC。增量只有 1 人日，因为 I12 的守卫 B 已经把"活 box 的 backing 盘不动"做好了。**mtime 不行**：基盘是只读 backing 文件，读不改 mtime，mtime-LRU 退化成按创建顺序 FIFO，会优先淘汰共享度最高的 curated 基础镜像 |
| N14 | （未提及） | **"淘汰 → 对象存储 → 取回"不做；"建盘时上传、任何 runner 首次需要就下载"是对的，但归 S3** | 本地重建贵在 `prepare_copy_based` 是**真实字节拷贝**（`rootfs/builder.rs:84-140`，`CopyMode::Content` 在 `:124`，whiteout 内联在 `:132-140`），加上 `mke2fs -d`（`image_disk.rs:117-121`）再读一遍，≈ **4 遍未压缩内容的小文件密集 I/O**；而取回一块预建 ext4 是 **1 遍顺序传输**，量级上快一个数量级。但**作为淘汰层是亏的**：先上传 A 字节才能省下本地 A 字节，而被淘汰的盘按定义最不常用，那次上传大概率永不被读。**换成建盘时就上传**则把 `N × (下载+解压+拷贝+mke2fs)` 变成 `1 × (建+上传) + N × 下载`，淘汰-恢复顺带免费。三个前提把它钉在 S3：① ext4 稀疏（表观 718 MiB / 实占 141 MiB），对象存储无稀疏概念，要 zstd ＋**稀疏感知写入**，否则本地 materialize 出全量真实块、空间收益归零；② `mke2fs -d` 输出**不可字节复现**（fs UUID / 时间戳 / inode 顺序），不能自内容寻址，只能另存校验和并**信任上传方**；③ **信任是决定性的**——基盘被当作 rootfs 启动，任意 runner 可上传就意味着一台被攻破能污染整个 fleet 该镜像的 rootfs，所以**只有 S3 期可信的 builder 能当上传方**。另：core 里没有任何对象存储客户端（`aws_sdk`/`object_store` 在 `src/boxlite/src` 零命中），而 runner 侧有（`apps/runner/pkg/storage/`）——取回动作应由 Go runner 执行、core 只被喂一个路径，复用 `images/blob_source.rs:30-36` 的闭合 enum 接缝，避免四个嵌入式 SDK 背上 AWS 依赖 |
| N15 | 权限分组"必须同步改 `CreateApiKeyPermissionsGroups.ts`"（枚举头部注释） | **有两个分组文件，注释（`organization-resource-permission.enum.ts:8`）只提了一个；而且其中一个已经有一个名叫 "Images" 的组，指向的却是 `*:templates`** | `OrganizationPermissionsGroups.ts:9-34` 有四组 Boxes / **Images（`WRITE_TEMPLATES` ＋ `DELETE_TEMPLATES`，`:15-18`）** / Registries（`:19-25`）/ Volumes；`CreateApiKeyPermissionsGroups.ts:9-14` **只有 Boxes 一组**。所以 S1 不是"新增 Images 组"，是**把一个已经叫 Images、实际指向 templates 的组改指到真的 `*:images`**，同时给 API key 那份补上 Images——否则 API key 永远授不到镜像权限。**另有一条与 S2 相关的权限问题不在本文记录**：它属安全类，按 `SECURITY.md` 走私有通道，不写进公开仓库的文档 |

#### 0.3.2 从 v1 承接（依据未变，本版逐条重读）

| # | 上游怎么说 | 本文裁决 | 代码依据 |
|---|-----------|---------|---------|
| C1 | 20 处标记 / 13 个文件 | **21 处 / 14 个文件**（排除 `apps/dist/` 的构建产物）；裁决为**重建 1 处、删除 20 处** | `grep -rn 'TODO(image-rewrite)' apps --exclude-dir=dist` → 21 命中 / 14 文件（本版复查一致） |
| C2 | 把 curated 以 `organizationId = null` 的行种进 `image` 表 | **不种。curated 留在 env，`GET /images` 做 union** | `supportedImages()` 由 env 驱动、rotate 无需 deploy（`curated-images.constant.ts:80-86`，内置三条的 env 名与 fallback 在 `:35-54`），种进表就会在每次 rotate 后与 env 漂移 |
| C3 | `image_version.digest` "org 内唯一" | **收到 `UNIQUE (imageId, digest)`** | 同一个公开镜像被登记成两条不同上游路径是正常用法 |
| C4 | 目录表照 Volume 的形状 | **`image` 的 org+name 唯一性用部分唯一索引 `WHERE "deletedAt" IS NULL`，不用表级 `@Unique`** | Volume 抄了后者并因此带着一个潜在 500：`volume.service.ts:109-150` 只检查状态就允许重名，而 `volume.entity.ts:11` 的 `@Unique(['organizationId','name'])` 在 DB 层拒绝——软删过的名字永远不能复用。抄形状，不抄这个 bug（§6.3 O1） |
| C5 | D1"照抄 `gc_orphans` 的判据" | **D1 的第一道守卫是"文件名可达性"，不是"digest 在 index 里"** | `disk_path()` 是 `{digest 去冒号}-r{reserve_bytes}.ext4`（`image_disk.rs:170-174`），而 `reserve_bytes` 来自 `IMAGE_DISK_GUEST_BINARY_HEADROOM_BYTES`（`rt_impl.rs:215`，512 MiB，`:342` 传入）。**headroom 常量一变，全部已缓存的盘立刻对 `find()`（`:91-95`）不可达**，而它们的 digest 仍命中活跃 index 行 |
| C6 | （未提及） | **`load_from_local` 必须补写 `image_index` 行**，否则 D1 会误删本地 bundle 的盘 | `ImageManager::load_from_local`（`images/manager.rs:185-201`）不写 index——只有 `ImageStore::update_index`（`images/store.rs:621-635`）写，而它只在网络 pull 路径上被调 |
| C7 | "D1 是准入条件"，因为"没有通路告知 runner 某个 org 删了镜像" | **D1 不给 runner 磁盘设上限，它只收垃圾。** 准入条件改写成"D1 ＋ D2-min ＋ 一个运维可见的上限"，残余风险写进 §8 R1 | `gc_orphans` 形状的机制收不到"org 删了镜像"这一类。真正设上限的是 D2 |
| C8 | warm pool 那条元组有**两份**手工字段清单 | **四处站点、五份清单**：`fetchWarmPoolBox` 的 WarmPool 查找（`box-warm-pool.service.ts:69-84`，有 gpu）、认领查询（`:93-112`，**无 gpu**）、补池 count（`:151-167`）、`handleBoxOrganizationUpdated` 里**两份**（`:193-205` 与 `:211-227`）。而 `WarmPool.gpuType`（`warm-pool.entity.ts:38`）**五份里都没有**，连索引 `warm_pool_find_idx`（`:11`）也没有 | 共用谓词必须覆盖五份，否则这次只修一半 |
| C9 | （未提及） | **org 镜像不能走到那个 Redis 负缓存。** org 判定放在 `requiresFreshBox` 里，在 `box.service.ts:235` **之前**短路 | `warm-pool:skip:{image}` 写在 `box-warm-pool.service.ts:132`、读在 `box.service.ts:235`。org 镜像永远匹配不到 `warm_pool` 行，所以每次 create 都会写一个**由用户输入决定 key** 的条目 |

#### 0.3.3 v3 对 v2 的事实更正

> 裁决没变，事实变了。每条都会改到 §2 或 §6 的具体内容。

| # | v2 怎么写 | v3 更正 | 代码依据 |
|---|----------|--------|---------|
| **V1** | **`CREATE_BOX` job 载荷加 `imageRevalidate: boolean`，由 `BoxService.create` 填** | **做不到，也不必做。** `CREATE_BOX` 的载荷不是 `BoxService.create` 造的——它由对账循环在**稍后**造，且**字段全部来自持久化的 `Box` 行**。所以正确形状是：**在派活点由 `box.image` 现算**——`imageRevalidate = !isCurated(box.image) && !isDigestPinned(box.image)`。零新增载荷字段、零新增列、零跨组件状态传递，而且 `CREATE_BOX` 重放时**自动重算**（重放时 `box.image` 可能已被前一次回报钉死，于是自动不再重解析） | `BoxService.create`（`box.service.ts:187`）只落 box 行；派活在 `BoxStartAction.handleRunnerBoxUnknownStateOnDesiredStateStart`（`box-start.action.ts:59-83`，`:79` 调 `createBox`）；载荷在 `runnerAdapter.v2.ts:120-152` **逐字段从 `box` 读**，`:153` 才 `createJob(...)`。`box.service.ts` 里**没有任何 `jobService.create*` 调用**（`grep` 只命中 `:1367` 的 `updateJobStatus`） |
| **V2** | 删除守卫返回 **400** | **409。** 照抄的那个守卫用的是 `ConflictException` | `volume.service.ts:148-150` 抛 `ConflictException`。既然"照 Volume 形状"是本文的裁决，状态码也要照 |
| **V3** | 429 带 `Retry-After` 需要新增 | **机制已经在树里，直接用。** 异常上挂一个 `retryAfterSeconds` 数字，全局过滤器就会写 `Retry-After` 头 | `all-exceptions.filter.ts:74-78`；另有 `rate-limit-headers.util.ts:25-36` 的 `setRateLimitHeaders` 可复用。**不要新写一套** |
| **V4** | `autoDelete` 默认值只在 issue 清单里被提到 | **升为本期第 20 项交付物 ＋ 一个 day-0 决策（§6.0 B6）。** 今天 `AUTO_DELETE_DISABLED = 0`，`box` 表 `autoDelete` 的 DB 默认也是 `0`——box 只是被 `autoStop` 停下（默认 900 秒），**盘留在 runner 上**。而一个停止的 box 的 `disk.qcow2` 仍然 backing 着它的基盘，于是 **D1 守卫 B 与 D2-min 都不会碰那块基盘**。"用完可弃"这条路在机制上通、在回收上不通 | `box-lifecycle.constants.ts:6-9`；`DEFAULT_AUTO_STOP_SECONDS = 900`；DB 默认见迁移 `1784250000000-add-box-lifecycle-seconds-migration.ts:13`（`ALTER COLUMN "autoDelete" SET DEFAULT 0`）；`box-to-box.mapper.ts:31` 用 `box.autoDelete ?? AUTO_DELETE_DISABLED` |
| **V5** | B1"两个候选访问器，待定" | **已定。** `ImageObject` 内部就持有 `ImageManifest`，加两个访问器即可：`manifest_digest()` 返回 `manager.rs:34` 那个字段，`total_layer_size()` 返回 `manifest.layers[].size` 之和 | `manager.rs:32-40`（`ImageManifest`）、`:42-49`（`LayerInfo`，含 `size: i64`）；`ImageObject::new(reference, manifest, blob_source)`（`manager.rs:122-126`）；`list()` 已经把同一个字段当 `ImageInfo.id` 交出去（`:158`）——**证明值可达** |
| **V6** | "`BoxOptions` 是落盘的 box 配置（`options.rs:712-714`）" | **引用错了对象**（`:705-714` 是 `VolumeSpec.host_path` 的注释）。**正确依据更强**：`BoxConfig` 的文档注释直说"persisted to database and remains immutable"，它的 `options` 字段就是 `BoxOptions`，整个结构以 JSON 落进 `box_config` 表 | `litebox/config.rs:19-21`（注释）、`:40`（`pub options: BoxOptions`）；`db/schema.rs:27-32`（`box_config(id, name, created_at, json)`）。`BoxOptions` 自身 `#[derive(Serialize, Deserialize)]` ＋ `#[serde(default)]`（`options.rs:317-319`），所以加一个 `#[serde(skip)]` 字段在反序列化时回落 `false`——**重启不重解析 tag，正是想要的** |
| **V7** | 若干 `file:line` 偏移 | 逐条对齐（`box.service.ts:185→187`、`runner.service.ts:787→778`/`:788`、`:790→791`、`metrics.interceptor.ts:120→131`、`rt_impl.rs:344→225`、`schema.rs:71-78→70-79`、`layout.rs:224-258→225-262`、`blob_source.rs:31-36→30-36`、`api-key.strategy.ts:127-131→130`、`store.rs:173-180→172-179`） | 见 §9 索引 |
| **V8** | `buildImageRegistries(...)` 产出"insecure ＋ ghcr ＋ dockerhub" | **函数只产出 insecure ＋ ghcr**（`client.go:132-152`，三个入参）；Docker Hub 那条是 `NewClient` 事后追加的（`:165-173`）。S2 加网关三元组时要注意改的是**哪一处** | `client.go:132`、`:161`、`:165-173` |
| **V9** | I12/I13/I7 的阈值与开关"进 `BoxliteOptions` 并从 `cmd/runner/config/config.go` 打开" | **不进 `BoxliteOptions`，只经 env 覆盖**，照 `extractor.rs:714-722` 的 `OnceLock` ＋ env 形状 | 四个 SDK 各自**手工镜像**核心选项结构——Python `PyBoxOptions`（`sdks/python/src/options.rs:536`）＋ `TryFrom`（`:683`）、Node `JsOptions`（`sdks/node/src/options.rs:61`）/ `JsBoxOptions`（`:170`）、Go 的 25 个 `WithXxx`（`sdks/go/options.go`）、C 的 cbindgen 头（`sdks/c/include/boxlite.h:1139`）。往 `BoxliteOptions` 加一个字段就是**四份镜像各改一遍**，也就是四份漂移源；而这是**运维旋钮不是用户旋钮**。树里已有同类先例且**在 SDK 里零出现**：`BOXLITE_MAX_LAYER_DECOMPRESSED_SIZE` 与 `BOXLITE_MAX_DEFERRED_DIRS`（`extractor.rs:692-722`，`grep -rn 'MAX_LAYER_DECOMPRESSED' sdks/` 零命中） |

#### 0.3.4 实现期对 v3 的修订

> 前三节是设计期的裁决。这一节是**实现并跑完验收之后**才发现要改的，写在这里而不是
> 直接改上文，是为了让"当时怎么想"和"实际怎么定"都留档。

| # | v3 怎么写 | 实现期改成 | 依据 |
|---|----------|-----------|------|
| **W1** | I7 是**一条**"写入侧流式上限"：`expected_size <= 0` 时用全局上限（与解压侧 20 GiB 同量级） | **拆成两层，且全局上限重新定位。** ① **manifest 级总量拒绝**：层的声明大小求和 > 20 GiB 就拒，在取到 manifest 之后、**拉第一层之前**（`assert_declared_size_fits`，`store.rs:61`，`BOXLITE_MAX_IMAGE_DOWNLOAD_SIZE`）。② **流式上限**：声明 > 0 的 blob 上限**就是它自己的声明值**，**不再 clamp 到全局数字**；声明未知的 blob 回落到**整次 pull 共享的余额**（默认 256 MiB，`BOXLITE_MAX_UNSIZED_BLOB_BYTES`） | 三条：**(a)** 20 GiB per-blob 对 100 GB root 卷太松 —— 留 30% 给 qcow2 与系统后可用 ≈ 70 GB，一个 blob 就能占 29%，而 per-blob 意味着 N 层可以相乘。**(b)** "要留足真实镜像余量"这条论证在下载侧**不成立**：声明 > 0 的 blob 由声明值卡住，全局上限只在 `size <= 0` 时参与，而 OCI descriptor 的 `size` 是必填字段（本代码里唯一传 0 的是 config blob，几 KB JSON）—— 所以那条余额可以很紧。**(c)** 真正能装满卷的是一份**诚实地**声明了超大总量的 manifest，per-blob 检查对此无能为力，只有总量闸门能挡 |
| **W2** | "**三个** env 覆盖点" | **五个**：`BOXLITE_MAX_IMAGE_DOWNLOAD_SIZE`、`BOXLITE_MAX_UNSIZED_BLOB_BYTES`、`BOXLITE_IMAGE_DISK_GC_MIN_INTERVAL_SECS`、`BOXLITE_IMAGE_DISK_EVICT_HIGH_PERCENT`（100 即关闭淘汰）、`BOXLITE_IMAGE_DISK_EVICT_LOW_PERCENT` | W1 把下载侧从一条变成两条；淘汰的高低水位各一个（合成一个字符串更难读）。V9 的裁决不变：**都只经 env，`BoxliteOptions` 一个字段不加** |
| **W3** | （未提及） | **`state = ERROR` 的 box 没有自动销毁通路**，因此可能永久钉住一块基盘 | 三道过滤同时挡住它：`syncStates` 排除 ERROR（`box.manager.ts:244`）、`autoStopCheck`/`autoDeleteCheck` 都要求 `state = STOPPED`（`:96`、`:177`）、`syncInstanceState` 把 ERROR 当终态（`:336`）。这不属镜像线，已单开 bug（POL-552） |
| **W4** | 低水位 75%（"退到 75% 停"） | **70%** | 与控制面撞车：`RUNNER_DISK_PENALTY_THRESHOLD` 默认就是 **75**（`configuration.ts:550`），runner 从这条线开始被指数降分、掉到 `RUNNER_AVAILABILITY_SCORE_THRESHOLD` 以下就完全退出投放。停**在**那条线上等于"腾了空间但没恢复投放资格"，一次成功的淘汰白做。两边读的是同一个数字（runner 报 `disk.UsageWithContext(ctx, "/")`，`collector.go:136`；核心读同卷上缓存目录的 `statvfs`），所以这两个数必须**一起选**。**有测试钉**：`the_low_watermark_stays_under_the_control_plane_disk_penalty` 去读 `configuration.ts` 里的真值，而不是把 75 抄进测试（抄进来的话对面改了照样绿，是反向的保证）。所以**两侧任意一边漂移都会红**；那个 env 名断言恰好出现一次（`RUNNER_DISK_PENALTY_EXPONENT` 与它共享前缀），解析不到默认值或解析出非百分数则整条炸掉，不静默通过。**高水位刻意不这么钉**：它与"退出投放点"的关系要把整条打分公式复刻进核心侧的测试，公式一改测试的算术就悄悄失效 —— 那才是反向保证。低水位只需读**一个数**再比较，所以能钉 |
| **W5** | 淘汰只挂在"建盘前"这一个触发点 | **加一个 6 小时周期触发 `reclaim_now`（D1 ＋ 淘汰两趟），且首趟立即执行** | 同一条降分逻辑的第二个后果：盘越满越拿不到投放，于是**最需要淘汰的机器恰好是不再有 build 的机器**，建盘前触发对它永远不会响。周期触发是这类机器自己恢复的唯一通路（`rt_impl.rs:415`）。首趟不等一个间隔，否则重启后仍要空转 6 小时。**真正的门不是分数阈值，是名次**：`findAvailableRunners` 把候选降序排序后 `.slice(0, 10)`（`runner.service.ts:309`），所以一台机器远在分数掉到 10 之前就已经排不进前 10、事实上停止接活；那个点**相对于整个机群**，机群里健康机器越多它来得越早。复刻 `calculateTOPSISScore` 实算（七指标加权 TOPSIS × 四道指数惩罚相乘）：空闲（cpu 0／mem 0／0 box）在 disk@85 得 16 分、出局于 **89%**；繁忙健康（cpu 50／mem 60／20 box）得 14 分、出局于 **88%**。两者都在 HIGH=85 之上，所以分数门槛本身不会挡在淘汰前面 —— 挡住的是前 10 名切片：16 分在一群 66～86 分的机器里垫底，进不去。而**磁盘是七个指标里唯一不释放的那个**（停止的 box 对 CPU／内存／已分配／运行数的贡献全部归零，`collector.go:226` 的 `if box.Running`；只有它的 qcow2 与被钉住的基盘留在盘上），所以长命 runner 的终态就是「其它维度全 0、磁盘高」—— 能自愈的三维早已归零，剩下唯一一维不自愈，建盘前触发点对它永远不会响。这个洞只能由周期触发盖 |
| **W6** | （未提及）淘汰候选只排除"有 box 压着的盘" | **再排除两类：本次正在装的 digest，以及 mtime 年龄 < `ORPHAN_GRACE`（300 s）的盘** | 装盘是 rename 进缓存**先于**它的 box overlay 存在，中间这段窗口里，并发的另一次 create 跑淘汰会认为这块盘无人引用而删掉它——正在建盘的那次创建随后失败。两条守卫分别盖住"自己这次"和"别人刚落地的那次"（`coldest_first`，`image_disk.rs:647`），与 D1 的守卫 C 同源 |
| **W7** | 淘汰复用 `referenced_backing_paths` 判定「有没有 box 压着」 | **改用会报告完整性的严格版，扫描不完整就整趟放弃**（`ReferencedPaths::complete`，链走另加 `BackingChain::complete`） | 该函数自己的文档写明「可能少报，绝不单独作数」——对 `gc_orphans` 成立，因为那里有第二道守卫。但**淘汰按定义没有第二道**：它的目标就是「有 index 行但很冷」的盘，守卫 A 结构性地帮不上忙。于是 `read_dir(boxes_dir)` 出错（只 warn、返回空集）、**逐条目的 `read_dir` 错误被 `flatten()` 丢掉**、链读错返回部分结果、链深 > 8 静默截断，任何一条都会让「无人引用」成立；而淘汰**只在 ≥85% 压力下运行**、一旦触发就删到低水位，后果是一台机器上所有运行中 box 的 backing 一起消失。与本设计已有的两条同源原则对齐（`statvfs` 读不到整趟放弃、DB 出错整趟放弃），第三处补齐 |
| **W8** | （曾怀疑）qcow2 头存的是调用方给的原样路径，与 canonicalize 过的 `cache_dir` 比不上 | **误判，撤回。** 头里**永远是规范路径** | `write_cow_child_header` 自己就 canonicalize（`qcow2.rs:556-557`，`git show HEAD:` 确认早于本次改动）；走 `qemu-img -b` 的 `create_cow_child_disk_external`（`:746`）**从无调用方**。据此加的防御性 canonicalize 已删（无用即死代码），改为在不变量产生处钉住：`a_backing_path_is_recorded_canonical_even_when_given_through_a_symlink`，两侧验证的失败信号是 `left: ".../linked/base.ext4"` vs `right: ".../real/base.ext4"` |
| **W9** | 第 20 项交付物「`autoDelete` 默认值定稿」与 §6.0 B6 都算在 **PR-A** 头上（§0.1、§7.5 的判据表同此） | **决策挪到 PR-B**；PR-A 只把它记录成有效回收率的封顶项 | 它要改的是控制面的 box 生命周期默认值（`box-lifecycle.constants.ts:8`），而 PR-A 整块落在 `src/boxlite/`、`apps/` 零改动（§6.1「PR-A 无进无出」）——把一个 `apps/` 的默认值塞进来，就毁掉了「可独立合并、独立回滚」这条立 PR 的理由。机制依据一个字没变：守卫 B 是**路径级**的，停止的 box 的 `disk.qcow2` 照样钉住它的基盘，所以 `autoDelete` 仍然封顶 D1 与 D2-min 的有效回收率 |
| **W10** | （未提及）`read_backing_chain` 返回值的语义 | **严格版留住 stat 不到的路径，宽松版把它过滤掉** —— 宽松版对调用方的输出与改动前逐字节一致 | W7 要区分「链走完了」和「链断了」，而 `exists()` 为 false 既可能是真的没有、也可能是权限或 I/O 错误；要报 `complete: false`，那条路径就必须留在**严格版**的集合里，否则调用方拿到一个既不完整又少一项的集合。但**宽松版不能跟着变**：它的调用方是去**用**这些路径的 —— jailer 把每一条都交给 bwrap 的严格 `--ro-bind`（`jailer/sandbox/bwrap.rs:121`；仓库另有 `ro_bind_if_exists` 专门给可选源用），所以报一条不存在的路径会把「基盘坏了的 box」变成「连沙箱都进不去的 box」。一句话：**删东西的那一侧要知道自己瞎了，用东西的那一侧只要能用的路径。**钉在 `the_lenient_chain_leaves_out_a_backing_file_that_cannot_be_statd`；两侧验证的失败信号是 `a path bwrap would refuse to bind must not be reported as a backing file` |
| **W11** | （未提及）`load_from_local` 补写 index 行的副作用 | **它同时改了镜像列表的输出**：本地 OCI bundle 从此出现在 `rt.images().list()` 里 | `ImageManager::list`（`images/manager.rs:130`）读的就是 `image_index`（`store.rs:293` → `index.list_all()`），所以「补一行让盘保持可达」必然连带「这个镜像进列表」——两者是同一行数据。这是 PR-A **唯一一处用户可见的行为变化**，A10 的「逐字节不变」据此收窄；四份 SDK README 已写明 |
| **W12** | 淘汰只有日志，没有计数器；V9 的裁决是「阈值/上限只经 env，不碰四份 SDK 镜像」 | **加两个 `RuntimeMetrics` 计数器**：`image_disks_evicted_total`（只数淘汰，回收垃圾不算）、`image_disk_bytes_reclaimed_total`（两趟共用，记 `blocks()*512` 实占）。**这条明确破了 A13** | 只有日志就只能靠人去 grep 文件；要告警必须有单调计数器。V9 管的是**配置入口**（`BoxliteOptions` 仍然一个字段不加，A14 成立），计数器是**只读输出**、只增不改，语义上与 PR-B 给 `ImageObject` 加两个访问器同类。代价是**一个只读计数器要镜像七处**：四个 SDK（`boxlite.h` 由 cbindgen 重生成）、两处 REST DTO（`rest/types.rs`、`cli/src/commands/serve/types.rs`）、Box API schema 与它的参考服务端（`openapi/box.openapi.yaml`、`openapi/reference-server/server.py`），外加 `docs/reference/nodejs/README.md` 的字段表。`apps/` 仍是零改动——runner 直接透传 Go SDK 的结构体（`apps/runner/pkg/boxlite/client.go:546`）。A13 据此改写 |
| **W13** | 「core 的 `tracing` 没接到 journald」列为「后续」 | **本期确认不做，理由改了**：原打算在 `register_to_tracing` 里按 systemd 的 `JOURNAL_STREAM` 多挂一路 stdout，评估后**整块推迟到下一期单独一个 PR** | 事件一直都有，只是写到 `$BOXLITE_HOME/logs/boxlite.log`（`init_logging_for`，`lib.rs:90`），而 unit 只收 stdout（`StandardOutput=journal`）——运维在 `journalctl` 里看不到。两条路都不干净：**(a) 库侧默认开**（按 `JOURNAL_STREAM`）一次二进制滚动升级就对所有在跑的机器生效，但核心 info 级有 297 处、其中 74 处在 create/start/boot 路径上，会灌进**每一个** systemd 下的嵌入式调用方的 journal（`try_init` 只让自带 subscriber 的宿主免疫），还会撞 journald 的 `RateLimitBurst` 把宿主自己的日志挤掉；**(b) 默认关、runner 显式开**要改两份 unit（`apps/runner/packaging/systemd/boxlite-runner.service` ＋ `apps/infra/stack/runners.ts:512` 的 user-data heredoc），而 `apps/infra/runner/update.ts` **只换二进制、明确不动 unit**（「leaving the unit untouched」），所以那行 `Environment=` 只在**实例被替换**时才到达云上 runner —— 现存机器的 `journalctl` 仍然是空的。下一期的正确形状大概是「stdout 只放 warn 及以上」＋ 把淘汰那条提到 `warn`，但那需要单独定级、单独验证。**另有一跳同期缺失**：`RuntimeMetrics` 的两个新计数器到不了控制面——`apps/runner/pkg/boxlite/client.go:547` 的 `Metrics()` 唯一调用方是 `:541` 的丢弃式探活，`internal/metrics/collector.go` 只采 CPU／内存／磁盘／box 数，不读核心指标。所以「能告警」目前只对嵌入式与 `boxlite serve` 成立 |

### 0.4 相对本文 v1 被取消的东西

| v1 的交付物 | v2/v3 | 原因 |
|------------|----|------|
| `POST /images/registers` ＋ 50 秒长轮询 ＋ `ImageBuildWaiter` | **删** | N1 |
| `apps/image-builder` 服务 ＋ 独立 task role ＋ infra 一项 | **删** | N1；builder 到 S3 才出现，且只做构建 |
| `image_build` 表 ＋ 部分唯一索引幂等 ＋ `progressAt` 心跳 ＋ `ImageBuildReaper` ＋ `POST /internal/image-builds/{claim,progress,finish}` ＋ builder token 分支 | **删** | N1；这套机器随 builder 回到 S3（那里有真正长跑的工作正当化它） |
| 平台 OCI registry ＋ `PlatformRegistryClient` ＋ `systemSourceRegistry` 承重 ＋ `PLATFORM_REGISTRY_*` 三元组 | **删** | 推迟到 S3 |
| `organization.image_storage_limit_gib` | **换成 `image_count_limit`** | N7 |
| `DELETE` 同步删平台 manifest | **删** | N8 |
| `importing` / `ready` / `failed` 三态词汇 | **删** | N2：目录只在成功后写，`image_version.state` 保持 `ready`/`deleted` 两值 |
| `write:images` 权限 | **删** | N11 |
| `images.register()` Python 方法 | **删** | 五个方法变四个 |
| v1 的 §0.3 修订 3/4/5/6/7/8 | **作废** | 它们都在描述 register 链路 |
| **`CREATE_BOX` 载荷的 `imageRevalidate` 字段** | **删**（v3） | V1：改成派活点现算 |

**新增到 v2/v3 的**：`ImageAdmission`（N3）、digest 回报链路（N4）、tag 重新解析（N5、V1）、
下载上限（N6，实现期拆成两层，见 §0.3.4 W1）、`BoxDto.progress`（N12）、D2-min（N13）、`autoDelete` 定稿（V4）。

### 0.5 上游已经定过、本文照办的决策

不重复论证，只登记：镜像**不**决定 box 的 cpu/mem/disk（常量成契约）；**不**新增
`BoxState.PREPARING_IMAGE`（所以 `progress` 是独立字段，不是新状态）；**不**给 runner
加镜像 API；**不**加镜像类 `JobType`；**不**把队列放到 Redis 上；一次性用法
（`boxes.create(image="python")` → box 内装东西 → 删 box）必须保留、不产生目录记录。

### 0.6 SDK 面：两个 "images" 不是一回事

镜像这条线的 SDK 面分成两个命名空间，**跨期不变**，文档里必须分开写：

| 命名空间 | 是什么 | 后端 | 何时出现 |
|---|---|---|---|
| `rt.images()` | **本机镜像缓存**（`pull` / `list`） | 只在嵌入式后端可用 | 今天已有 |
| `boxlite.cloud` 的 `c.images` | **云端目录**（`list` / `get` / `delete` / `usage`） | REST | **S1 首次出现** |

**一个必须写进用户文档的陷阱**：`Boxlite.rest(...).images()` **抛 `Unsupported`**——
`runtime/core.rs:442-448` 的 `"Image operations not supported over REST API"`。
**四期都不改这一点。**

跨期约定：`boxlite.cloud` 这个 import 路径**跨期不变**（S3 换成生成客户端时只替换内部
实现）；裸名异步、`Sync…` 前缀阻塞（与 `sdks/python/boxlite/sync_api/` 一致）；
**零第三方运行时依赖**（`sdks/python/pyproject.toml:10` 的 `dependencies = []`）在
S1/S2 是硬约束；**SDK 绝不自己拼造任何 registry 地址**——解析始终在 API 侧。
**Node / Go / C 在 S1 不需要任何新 API**：把"任意镜像"传给 `BoxOptions.image` 就是换一个
字符串，四个 SDK 今天都支持。

---

## 1. 架构图与变化对比

### 1.1 现状（`4d806970`）

```text
[ 客户端 ]  Python / Node / Go / C SDK（REST）· Dashboard · boxlite CLI
   │  POST /v1/{prefix}/boxes   { image: "python" | curated 全 ref }
   ▼
[ apps/api —— 控制面 ]
   BoxliteBoxController.createBox              boxlite-rest/boxlite-box.controller.ts:112
     └─ BoxService.create                      box/services/box.service.ts:187
          ├─ assertSupportedImage(image)       box/constants/curated-images.constant.ts:93
          │    env 白名单 · 不读库 · undefined → 第一个条目（base）
          ├─ requiresFreshBox(dto, org)        box/utils/warm-pool-eligibility.util.ts:23
          ├─ redis.exists('warm-pool:skip:'+image)          box.service.ts:235
          ├─ warmPoolService.fetchWarmPoolBox(…)            box.service.ts:237
          └─ **只落一行 box**（desiredState=STARTED），**不派活**
   BoxStartAction（对账循环，稍后跑）  box/managers/box-actions/box-start.action.ts:59
     └─ runnerAdapter.createBox(box, metadata)                             :79
          └─ 载荷**逐字段从 box 行读**  runner-adapter/runnerAdapter.v2.ts:120-152
             └─ jobService.createJob(CREATE_BOX, runner, BOX, box.id, payload)  :153
   systemSourceRegistry                        config/configuration.ts
     └─ 配置齐了，**无人读**
   │
   │  Job 派活：Redis brpop 唤醒（仅提示）+ 条件 UPDATE 认领
   ▼
[ Runner 机队 —— EC2 c8i.2xlarge × N，root 卷 100 GB（infra/stack/settings.ts:14-19）]
   apps/runner  Client.Create
     └─ runtime.GetOrCreate(ctx, boxDto.Image, opts...)     pkg/boxlite/client.go:314
          凭证 = **runtime 级静态**
                buildImageRegistries(insecure, ghcr)         client.go:132-152
                ＋ NewClient 事后追加 docker.io               client.go:165-173
   [ 内嵌 boxlite core —— 同一个 core 也被 Python/Node/Go/C SDK 打包 ]
     ├─ ImageManager.pull                                   images/manager.rs:117
     │    ├─ 快路径：按 **ref 字符串**查缓存，网络调用之前   images/store.rs:172-179
     │    ├─ 未列表的 host 一律匿名                          images/store.rs:1061-1072
     │    ├─ images/layers/ + images/extracted/   按**层 digest**去重
     │    └─ 宿主 SQLite image_index(reference PK)           db/schema.rs:70-79
     ├─ ImageDiskManager.get_or_create                      images/image_disk.rs:78
     │    └─ images/disk-images/{layer串digest}-r{512MiB}.ext4  **无任何回收器**
     ├─ Qcow2Helper.create_cow_child_disk                   container_rootfs.rs:234
     │    └─ box disk.qcow2（backing 直指上一行）→ microVM
     └─ 回收：仅 recover_boxes() 末尾各跑一次                rt_impl.rs:1513、:1520

[ 外部 ]      ghcr.io —— curated 镜像的**权威副本在别人家**（我们在租）
[ 持久状态 ]  Postgres  box · job · warm_pool · volume · runner · organization
              Redis     TypeORM 缓存（ignoreErrors，app.module.ts:99-103）· 限流桶 · 锁 · pubsub
              S3        storage bucket —— 今天只有 volume 用
              宿主      SQLite image_index + ~/.boxlite/images/*（**派生、可丢弃**）
```

**关键观察**：拉任意公开镜像的能力**已经在树里**。挡住它的只有 `box.service.ts:209`。

**两条贯穿性事实（决定 D1 与 N5 的形状）**：

1. **宿主侧的 GC 今天全部只在启动时跑一次。** `recover_boxes()` 只从运行时构造处调用一次
   （`rt_impl.rs:225` → `:370`），两个清扫都挂在它末尾——guest rootfs 的 `gc`（`:1513`）和
   base 文件的 `gc_orphans`（`:1520`）。runner 上的 boxlite 进程长驻，启动一次可能几周不
   重启，所以"照抄 `gc_orphans` 的形状"只够抄它的**判据**，**触发点必须新加**。
2. **pull 的快路径按 ref 字符串查缓存，且从不重新校验。** 见 N5。tag 是可变指针，所以
   这不只是性能问题，而是**缓存正确性问题**。

### 1.2 S1 之后

**组件（新增的都标了 ←）**

```text
[ 客户端 ]
   boxlite.cloud（← **新**，仅标准库，两个面，四个方法）
   Dashboard /dashboard/images（← **新页面**）
   现有 Python / Node / Go / C SDK 与 CLI（**签名不变**）

[ apps/api ]
   ImageModule（← **新**，照 Volume 模块形状）
     ├─ ImageController      GET    /images · /images/usage · /images/:idOrRef
     │                       DELETE /images/:idOrRef
     │                       **路由声明顺序**：/images/usage 必须在 /images/:idOrRef 之前
     ├─ ImageCatalogService  目录读写 · 跨 org 隔离 · 删除守卫（409）
     └─ ImageUsageService    数量与已知字节的求和 vs organization.image_count_limit
   ImageAdmission（← **新**，替换 assertSupportedImage）
     ├─ curated 选择符直通（env，不读库）
     ├─ registry host 允许表（拒 link-local / 私有网段 / 生产环境的 localhost）
     ├─ ref 语法校验（'..'、非法字符、超长）——在任何 URL 拼接与 DB 写之前
     ├─ per-org 镜像数量上限
     └─ per-org 并发冷拉上限（Redis 计数器，默认 3；429 走 retryAfterSeconds）
   ImageResolver（← **新**，box 创建路径上的唯一解析入口，**每次现算、不缓存**）
   ImageRegistrar（← **新**，在 box 报到 STARTED 时把回报的 digest 落成目录行）
   runnerAdapter.createBox（← **改**：载荷多一个由 box.image 现算的 imageRevalidate）

[ Runner 机队 ]
   apps/runner        CREATE_BOX 载荷多一个 imageRevalidate 布尔（← 约 15 LOC）
                      box 状态回报多带 imageDigest / imageSizeBytes（← 约 20 LOC）
   内嵌 boxlite core  + ImageObject::manifest_digest() / total_layer_size()（← N4/V5）
                      + BoxOptions.image_revalidate（#[serde(skip)]）绕过 ref 字符串快路径（← N5）
                      + 下载上限：manifest 总量 ＋ 写入侧流式（← N6、§0.3.4 W1）
                      + ImageDiskManager::gc_unreachable（← **D1**，§2.4）
                      + ImageDiskManager::evict_cold_if_low_on_space（← **D2-min**，§2.4）
                      + load_from_local 补写 image_index 行（← C6）
                      解压 / 建盘 / COW 流水线 **完全不变**

[ 外部来源 ]  docker.io / ghcr.io / quay.io / … —— runner **直连**（允许表内的 host）
[ 持久状态 ]  Postgres  + image · image_version · image_tag
                        + organization.image_count_limit
                        - organization.template_deactivation_timeout_minutes
              Redis     + 一个 per-org 并发冷拉计数器；**不加队列、不加 pubsub channel**
              宿主      + image_index.last_used_at 一列
              S3        S1 不用
```

**读路径 —— box 创建（隐式登记就在这条路径上）**

```text
SDK / Dashboard / CLI
   │  POST /v1/{prefix}/boxes { image: "docker.io/acme/app:1.2" | "python" }
   ▼
apps/api  BoxService.create
   ├─ ImageAdmission.assert(org, selector)      ← **新增一跳**，替代裸 assertSupportedImage
   │    curated → 直通；其余 → host 允许表 + 语法 + 数量上限 + 并发上限
   ├─ ImageResolver.resolve(org, selector)      ← **新增一跳**
   │    ├─ 情形 1  curated（env，**不读库、不计配额**）→ 原 ghcr.io ref 直通
   │    ├─ 情形 2  <repo>@sha256:…  → 目录命中则用它；未命中直接透传（本来就钉死了）
   │    ├─ 情形 3  <repo>:<tag>     → 目录命中 → digest 钉死 ref；未命中 → 透传
   │    ├─ 情形 4  裸 <repo>        → 按 tag 'latest' 走情形 3
   │    └─ 出口断言：目录命中的输出**永远**是 `@sha256:` 形式（§8 R8）
   ├─ requiresFreshBox(dto, org, resolved)      ← **加镜像维度**
   │    org 镜像 ⇒ true ⇒ 既不查 warm pool、也不写 warm-pool:skip 负缓存
   └─ **落 box 行**（box.image = 解析后的 ref），**不派活**
   ▼
apps/api  BoxStartAction（对账循环）→ runnerAdapter.createBox(box, metadata)
   └─ 载荷 = 逐字段读 box 行
        ＋ imageRevalidate = !isCurated(box.image) && !isDigestPinned(box.image)  ← **现算**
   ▼
Runner  runtime.GetOrCreate(ctx, boxDto.Image, WithImageRevalidate(…))
   └─ boxlite core  pull（image_revalidate=true 时绕过 ref 字符串快路径 → 重新解析 tag）
                    → layers / extracted → disk-images/*.ext4 → disk.qcow2 → microVM
   │  PUT /boxes/:id/state { state: STARTED, imageDigest, imageSizeBytes }
   ▼
apps/api  ImageRegistrar.onBoxStarted
   └─ 单事务：upsert image → INSERT image_version ON CONFLICT DO NOTHING
              → upsert image_tag → touch lastUsedAt
      **只在成功时写**（N2）。失败留在 box 的 ERROR + errorReason 上
```

**回收路径 —— D1 与 D2-min**：见 §2.4。

### 1.3 变化对比

| 维度 | 现状 | S1 之后 | 变化性质 |
|------|------|---------|---------|
| 镜像可选集 | curated 三个（+ env 追加），全局共享 | curated **不变** + **允许表内任意公开镜像** | 放开 |
| 镜像字节权威副本 | ghcr.io（租用） | 不变——**S1 不拥有任何镜像字节** | 无 |
| 准入位置 | `assertSupportedImage`，env 精确匹配 | `ImageAdmission`：curated 精确匹配 + 其余按 host 允许表与配额 | 换门，不是拆门 |
| 解析位置 | 同上，不读库 | `ImageResolver`：情形 1 与今天**逐字节一致**；情形 2–4 查库 | 新增一跳 |
| 到达 runner 的 ref | curated 的 tag 钉死 ref | curated 不变；org 镜像**首次是 tag（带重解析开关）、其后永远 `@sha256:`** | 部分收紧（§8 R8） |
| `CREATE_BOX` 载荷 | 逐字段来自 box 行 | **＋ 一个由 `box.image` 现算的布尔**，不来自 create 请求 | 极小新增（V1） |
| 目录写入 | 无目录 | box 报到 STARTED 时由回报的 digest 写入；**失败不写行** | 新增 |
| 进程数 | api · runner · proxy · dashboard | **不变** | 无新增进程 |
| 派活机制 | `job` 表行 + Redis brpop 唤醒 | **完全不变** | 无 |
| Redis 职责 | 缓存 · 限流 · 锁 · pubsub · 写缓冲 | **+ 一个 per-org 并发冷拉计数器**；不加队列、不加 channel | 极小新增 |
| warm pool | 任何 `warm_pool` 行都能被任何 org 认领 | 只放 curated；org 镜像**永不**进池、也不查池 | 收紧（租户隔离） |
| 配额 | 只有 per-box 上限 | **+ per-org 镜像数量上限 + per-org 并发冷拉上限** | 新增闸门 |
| runner 磁盘回收 | `disk-images/` **无任何回收器**，宿主 GC 只在启动时跑 | **+ D1 + D2-min** + 三个触发点 | 新增；D1 收垃圾、D2-min 保不失败（§8 R1） |
| runner 剩余空间感知 | **零**（`statvfs` 家族零命中） | **建盘前一次 `statvfs`** | 新增能力 |
| runner 出网 | 只连 ghcr.io / docker.io / INSECURE_REGISTRIES | **允许表内的任意 registry host** | 放开（§8 R2） |
| 层下载 | 事后校验，`size <= 0` 跳过 | **流式上限** | 收紧 |
| 嵌入式库 API | — | `BoxOptions` 加一个 `#[serde(skip)]` 布尔；其余签名不变 | 极小 |
| box 生命周期默认 | `autoStop` 900 s，`autoDelete` 0（禁用） | **本期定稿**（§6.0 B6） | 决策 |

---

## 2. Call graph 与变化对比

约定：`函数 / 文件:行 · LOC · 注解`。LOC 为判断值。`←` 标注新增或改动。
**标识符约定**（全文一致）：`I<n>` = 子 issue（§6.1），`PR-<X>` = PR（§6.1），
`P<n>` = 性能变化点（§5），`N/C/V<n>` = 修订条目（§0.3），`B<n>` = day-0 决策（§6.0），
`F<n>` = 功能点（§4），`R<n>` = 风险（§8）。

### 2.1 读路径 — box 创建（现状）

```text
POST /v1/{prefix}/boxes { image: "python" }
└─ BoxliteBoxController.createBox            boxlite-rest/boxlite-box.controller.ts:112 · 13
   ├─ BoxService.create                      box/services/box.service.ts:187 · ~130
   │  ├─ getValidatedOrDefaultRegion                                       :191
   │  ├─ 资源默认值（常量，TODO 待成契约）    box.service.ts:86-92 / :197-203
   │  ├─ assertWithinPerBoxLimits(cpu,mem,disk,org)  box/services/per-box-limits.ts
   │  ├─ assertSupportedImage(dto.image)      box/constants/curated-images.constant.ts:93 · 13
   │  │  └─ supportedImages()                                              :80 · 6   env，无 DB
   │  ├─ requiresFreshBox(dto, org)           box/utils/warm-pool-eligibility.util.ts:23 · 27
   │  ├─ redis.exists('warm-pool:skip:'+image)  box.service.ts:235               负缓存读
   │  ├─ BoxWarmPoolService.fetchWarmPoolBox  box/services/box-warm-pool.service.ts:67 · ~70
   │  │  ├─ warmPoolRepository.findOne(…)                                  :69-84   字段清单 ①（有 gpu）
   │  │  ├─ boxRepository.createQueryBuilder(…)                            :93-112  字段清单 ②（**无 gpu**）
   │  │  └─ redis.set('warm-pool:skip:'+image, 60s)                        :132     负缓存写
   │  └─ **落 box 行，不派活**
   └─ BoxStateWaiter.waitForStarted(id, org, 30)  boxlite-box.controller.ts:122

对账循环（稍后，与上面不同一次请求）
└─ BoxStartAction.handleRunnerBoxUnknownStateOnDesiredStateStart  box-start.action.ts:59 · 25
   └─ runnerAdapter.createBox(box, metadata)                               :79
      └─ RunnerAdapterV2.createBox            runner-adapter/runnerAdapter.v2.ts:116 · 40
         ├─ payload = { id, image: box.image, osUser, cpuQuota, …, secrets }  :120-152
         └─ jobService.createJob(null, CREATE_BOX, runner.id, BOX, box.id, payload)  :153

Runner（Go）
└─ Client.Create                             apps/runner/pkg/boxlite/client.go
   └─ runtime.GetOrCreate(ctx, boxDto.Image, opts...)                      :314
      凭证 = buildImageRegistries(insecure, ghcr…)                         :132 · 21
             ＋ NewClient 追加 docker.io                                    :165-173

boxlite core（Rust，嵌入 runner）
└─ ImageManager.pull(ref)                    src/boxlite/src/images/manager.rs:117
   └─ ImageStore.pull                        src/boxlite/src/images/store.rs:155
      ├─ try_load_cached(inner, ref_str)                  :172-179  **按 ref 字符串，网络之前**
      ├─ pull_from_registry → registry_auth_for(host)     :1061-1072 未列表 → Anonymous
      ├─ stage_layer_download(digest, size)               storage.rs:282
      │  └─ commit(): size 事后校验，size<=0 跳过          storage.rs:603 / :619  ← N6 的缺口
      └─ update_index                                     :621 · 15
└─ ImageDiskManager.get_or_create(image)     src/boxlite/src/images/image_disk.rs:78 · 11
   ├─ digest = image.compute_image_digest()   images/object.rs:284-292  **层 digest 串的 sha256**
   ├─ find(digest)                                                          :91 · 5
   │  └─ disk_path(digest) = "{digest去冒号}-r{reserve}.ext4"                :170 · 5
   └─ build_and_install → install (rename)                                  :98 / :131
└─ Qcow2Helper.create_cow_child_disk         litebox/init/tasks/container_rootfs.rs:234
```

### 2.2 读路径 — box 创建（S1 之后）

```text
POST /v1/{prefix}/boxes { image: "docker.io/acme/app:1.2" }
└─ BoxliteBoxController.createBox            boxlite-rest/boxlite-box.controller.ts:112   不变
   ├─ BoxService.create                      box/services/box.service.ts:187
   │  ├─ assertWithinPerBoxLimits(…)                                             不变
   │  ├─ ImageAdmission.assert(org, dto.image)  box/services/image-admission.service.ts · ~80 ←新增
   │  │  ├─ isCuratedSelector(sel) → 直通（不读库、不计任何闸门）
   │  │  ├─ parseRef(sel) → { host, repository, tag?, digest? }   语法校验在此
   │  │  ├─ host ∈ IMAGE_REGISTRY_ALLOWLIST，且非 link-local / 私有网段
   │  │  ├─ countDistinctImages(org) < organization.image_count_limit
   │  │  └─ redis.incr('image:coldpull:'+orgId) ≤ 上限（默认 3，TTL 自愈）
   │  │        超限 → 抛带 retryAfterSeconds 的 429（all-exceptions.filter.ts:74-78 写头）
   │  ├─ ImageResolver.resolve(org, dto.image)  box/services/image-resolver.service.ts · ~90 ←新增
   │  │  ├─ 情形 1  curated → assertSupportedImage(sel)      ←**不读库、不计闸门**
   │  │  │           undefined 仍返回 curated 默认（保住今天每个调用方）
   │  │  ├─ 情形 2  <repo>@sha256:… → findVersionByDigest；未命中直接透传
   │  │  ├─ 情形 3  <repo>:<tag>    → findVersionByTag（1 次 join 点查）；未命中 → 透传
   │  │  ├─ 情形 4  裸 <repo>       → 按 'latest' 走情形 3
   │  │  └─ 出口断言 assertPinnedOnCatalogHit(resolved)                ←承重（§8 R8）
   │  ├─ ResolvedImage { ref, isOrgOwned, imageId? }                          ←新类型
   │  ├─ requiresFreshBox(dto, org, resolved)  box/utils/warm-pool-eligibility.util.ts · +6 ←改签名
   │  │  └─ resolved.isOrgOwned ⇒ true      ← 在 box.service.ts:235 **之前**短路（C9）
   │  ├─ （org 镜像：redis.exists / fetchWarmPoolBox 两处**都不执行**）
   │  └─ **落 box 行**（box.image = resolved.ref）                             不变
   └─ BoxStateWaiter.waitForStarted(id, org, 30)                              不变
      └─ 超时返回的 BoxDto 带 progress{phase:'preparing_image', retryAfterMs}  ←新增（N12）

对账循环
└─ BoxStartAction …                                            box-start.action.ts:59   不变
   └─ RunnerAdapterV2.createBox                       runnerAdapter.v2.ts:116 · +8  ←改
      ├─ payload = { …逐字段读 box… }                                   :120-152  不变
      ├─ payload.imageRevalidate = imageNeedsRevalidate(box.image)             ←**新增（V1）**
      │    = !isCuratedSelector(box.image) && !box.image.includes('@sha256:')
      │      · curated 判定 = 对 supportedImages() **精确匹配**（env，零 DB）
      │      · 纯函数、无状态、CREATE_BOX 重放时自动重算
      └─ jobService.createJob(…, payload)                                     不变

Runner（Go）
└─ runtime.GetOrCreate(ctx, boxDto.Image,
                       boxlite.WithImageRevalidate(boxDto.ImageRevalidate))  client.go:314 ←改
   └─ 成功后取回解析出的 manifest digest 与层大小之和                          ←新（N4/V5）
      └─ PUT /boxes/:id/state { state, imageDigest, imageSizeBytes }          ←新

boxlite core（Rust）
└─ ImageObject::manifest_digest() / total_layer_size()             images/object.rs ←新（V5）
└─ ImageStore.pull                                                store.rs:155
   ├─ if !image_revalidate { try_load_cached(ref_str) }            :172-179 ←加条件（N5）
   ├─ stage_layer_download → 写入侧流式上限                        storage.rs:505 ←新（N6）
   └─ update_index                                                 不变
└─ ImageDiskManager.get_or_create → Qcow2Helper…                   见 §2.4

被拒的形状（一个单测各钉一条）：
  · 目录命中却输出了带 tag 的 ref        → 拒
  · curated 创建触碰了任何 image 行       → 拒
  · curated 的 box 被算出 imageRevalidate=true → 拒（会给 ghcr.io 加一次往返）
  · warm_pool.image 是一个 org 镜像 ref   → 拒（生产侧）
  · 允许表外的 host / link-local 地址      → 400，不是 500
```

**唯一新增的 DB 往返只落在 org 镜像上。** curated 路径在 `ImageAdmission`、
`ImageResolver` 与派活点的 `imageNeedsRevalidate` 里都排第一、都不读库，所以
"一次性用法"与今天逐字节一致。

### 2.3 登记回报路径（全新）

```text
Runner（Go）  box 起来之后
└─ boxSync / Client.Create 的收尾
   └─ PUT /v1/{prefix}/boxes/:id/state
        { state: "started", imageDigest: "sha256:…", imageSizeBytes: 123456789 }
   ▲   载体是既有的 UpdateBoxStateDto（apps/api/src/box/dto/update-box-state.dto.ts:11-35）
   │   它今天已有 state / errorReason / recoverable 三个字段
   ▼
apps/api  BoxService.updateState → ImageRegistrar.onBoxStarted(box, digest, size)
   ├─ 若 box.image 是 curated → **直接返回**（curated 不进目录）
   ├─ parseRef(box.image) → { host, repository, tag }
   └─ 单事务：
      ├─ upsert image(organizationId, name = host/repository)
      │     ON CONFLICT (organizationId, name) WHERE deletedAt IS NULL DO UPDATE lastUsedAt
      ├─ INSERT image_version(imageId, digest, sizeBytes, sourceKind='pull',
      │                       sourceSpec={sourceRef: box.image}, storageRef=<repo>@<digest>)
      │     ON CONFLICT (imageId, digest) DO NOTHING          ←并发同 ref 由 DB 兜住（N2）
      └─ upsert image_tag(imageId, name = tag, versionId)
            ON CONFLICT (imageId, name) DO NOTHING            ←S1 不移动 tag，所以只在缺失时写

失败路径（拉取失败 / 镜像不存在 / 超上限）
└─ PUT /boxes/:id/state { state: "error", errorReason: "..." }
   └─ **不写任何目录行**（N2）。errorReason 的既有示例就是 'Failed to pull artifact image'
```

**两个 digest 不是同一个，这条必须在代码与测试里显式区分**：

| | 值 | 谁用 | 依据 |
|---|---|---|---|
| **OCI manifest digest** | 上游 manifest 的内容哈希 | `image_version.digest`、送回 runner 的钉死 ref | `manager.rs:34`，经 V5 的新访问器暴露 |
| **整镜像 digest** | `sha256(concat(层 digest))` | **只**作宿主 `disk-images/` 的缓存键 | `object.rs:284-292`，`image_disk.rs:79` |

**为什么 `image_tag` 用 `DO NOTHING` 而不是 `DO UPDATE`。** S1 不做 tag 移动，
所以一旦 `app:latest` 指向了 digest D，它就停在 D——这是 N9 描述的行为，
逃生口是 `DELETE` 后再用一次。用 `DO UPDATE` 会让 tag 在用户无感知的情况下漂移，
而 box 的 `image` 已经钉死，两者不一致比停住更糟。

### 2.4 回收路径 — D1 与 D2-min

```text
现状（宿主回收器全部只在**启动时**跑一次）
└─ RuntimeImpl::new                             runtime/rt_impl.rs:225
   └─ recover_boxes()                                       :370 → :1276
      ├─ guest_rootfs_mgr.gc(boxes_dir)         rootfs/guest.rs:564   （调用点 :1513）
      └─ base_disk_mgr.gc_orphans(boxes_dir)    disk/base_disk.rs:199 （调用点 :1520）
         守卫：① 无 base_disk 行  ② 无 backing 引用（:128、:246）
               ③ mtime 年龄 ≥ ORPHAN_GRACE 300s（:86、:238-243）  ④ 只碰 ext4/qcow2（:227）
               ⑤ DB 出错读作"有主"（:249+）
   images/{layers,extracted,disk-images}         ← **没有任何回收器**
   剩余空间                                       ← **从不检查**（statvfs 家族零命中）

S1 之后
└─ ImageDiskManager::gc_unreachable(&live_disk_names, &referenced)
     src/boxlite/src/images/image_disk.rs · ~70                                    ←新（D1）
   ├─ 守卫 A  文件名 ∉ live_disk_names                                          （C5）
   │            live_disk_names = { disk_path(sha256(concat(row.layers)))
   │                                | row ∈ image_index.list_all() }
   │            依据：compute_image_digest() 就是 sha256(层 digest 串)
   │                  images/object.rs:284-292；而 index 存的正是同一个**有序**列表
   │                  images/store.rs:627（`manifest.layers.iter().map(|l| l.digest)`）
   │            DB 出错 → 整趟放弃，绝不读作"全都不可达"
   ├─ 守卫 B  路径 ∉ base_disk_mgr.referenced_backing_paths(boxes_dir)
   │            disk/base_disk.rs:128 —— **已经覆盖 disk-images/**：box 的
   │            disk.qcow2 backing 直指它（container_rootfs.rs:234）
   │            且该函数走**整条** backing 链（:141）、路径不做目录过滤
   ├─ 守卫 C  mtime 年龄 ≥ ORPHAN_GRACE（300s）——install 先 rename 后可见
   └─ 守卫 D  只碰 `.ext4`，且只在自己的 cache_dir 里
   触发点（**必须新加**，只抄判据等于什么都不回收）
   ├─ recover_boxes() 末尾，紧邻 :1513 / :1520
   ├─ get_or_create() 建新盘之前                 images/image_disk.rs:78
   └─ 周期任务（默认 6 小时，**首趟立即**；两趟都跑，见 §0.3.4 W5）
   配套改动
   ├─ ImageManager::load_from_local 补写 image_index 行   images/manager.rs:185   ←C6
   └─ cache_dir 在 new() 里 canonicalize（与 base_disk.rs:92 同理），
      否则守卫 B 的路径比较会假阴性
```

`referenced_backing_paths` 已经覆盖 `disk-images/`，所以 S1 **不需要**扩它的扫描范围。

**D1 只收垃圾，所以 S1 还要 D2-min（N13）压在同一个钩子点上**：

```text
get_or_create(image)                              images/image_disk.rs:78
├─ find(digest) 命中 → touch image_index.last_used_at → 返回          ←新（N13）
└─ 未命中，建盘之前：
   ├─ gc_unreachable(...)                          ←D1：删**不可达**文件，代价为零
   └─ evict_cold_if_low_on_space(...)              ←D2-min：删**热缓存条目**，有代价
        ├─ statvfs(cache_dir) —— 运行时新增能力，读取失败 → 整趟放弃
        ├─ 使用率**低于**触发阈值（默认 85%）→ 一块都不动
        └─ **达到**即按 last_used_at 从最久未用开始删，到低水位（默认 70%）即停
           跳过：有 box 压着的、本次正在装的、落地不足 300 s 的（§0.3.4 W6）
             · 复用 D1 守卫 B：活 box 的 backing 盘绝不动（含**停止的** box）
             · 只删 disk-images/，layers/ 与 extracted/ 不动 → 重建不走网络
```

两者的分工要写清：**D1 保证"垃圾不积累"（代价为零），D2-min 保证"满了不失败"
（有代价，所以阈值保守）**。真正把触发频率压下去的是 HRW 亲和（S2），把重建时间压到
一次顺序下载的是预建盘缓存（S3，N14）。残余风险与容量算术见 §8 R1。

**一个必须一起想清楚的耦合（V4）**：`autoDelete` 默认禁用意味着停止的 box 的
`disk.qcow2` 长期留在 runner 上，而守卫 B 是**路径级**的——它不区分 box 是运行中还是
停止。所以**每一个没被删掉的停止 box 都在钉住一块基盘**，D1 与 D2-min 都碰不了。
这不是回收器的 bug，是生命周期默认值的后果，因此 §6.0 B6 必须在本期定。

---

## 3. Data schema 与变化对比

### 3.1 新增表（Postgres，控制面）

命名遵循本仓约定：`box` / `volume` 族的列名是 camelCase（`CustomNamingStrategy` 继承
`DefaultNamingStrategy`、保留属性名，见 `common/utils/naming-strategy.util.ts:9`），而
`organization` 的配额列用显式 snake_case `name:`（见 `organization.entity.ts:31-56`）。
新表跟前者，`organization` 新列跟后者。

```sql
CREATE TYPE "image_version_state_enum" AS ENUM ('ready', 'deleted');
CREATE TYPE "image_source_kind_enum"   AS ENUM ('pull');          -- S3 加 'build'

CREATE TABLE "image" (
  "id"             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "organizationId" uuid         NOT NULL,      -- 无 NULL 行：curated 留在 env（C2）
  "name"           varchar(255) NOT NULL,      -- 上游仓库路径，如 docker.io/library/python（N10）
  "createdAt"      timestamptz  NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz  NOT NULL DEFAULT now(),
  "lastUsedAt"     timestamptz  NULL,
  "deletedAt"      timestamptz  NULL
);
-- 部分唯一索引，不用表级 @Unique（C4）：软删过的名字可以复用
CREATE UNIQUE INDEX "image_org_name_active_unique"
  ON "image" ("organizationId", "name") WHERE "deletedAt" IS NULL;
CREATE INDEX "image_org_lastused_index" ON "image" ("organizationId", "lastUsedAt");

CREATE TABLE "image_version" (
  "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "imageId"    uuid NOT NULL REFERENCES "image"("id") ON DELETE CASCADE,
  "digest"     varchar(71) NOT NULL,           -- 'sha256:' + 64 hex，**OCI manifest digest**
  "sizeBytes"  bigint      NOT NULL,           -- 由 runner 回报（N4）：层 size 之和
  "state"      "image_version_state_enum" NOT NULL DEFAULT 'ready',
  "sourceKind" "image_source_kind_enum"   NOT NULL,
  "sourceSpec" jsonb       NOT NULL,           -- {sourceRef} —— 用户当初写的那个 ref
  "storageRef" text        NOT NULL,           -- 从哪拉：S1 = 上游 <repo>@<digest>
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "image_version_image_digest_unique" UNIQUE ("imageId", "digest")  -- C3 + N2
);
CREATE INDEX "image_version_image_state_index" ON "image_version" ("imageId", "state");

CREATE TABLE "image_tag" (
  "id"        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "imageId"   uuid NOT NULL REFERENCES "image"("id") ON DELETE CASCADE,
  "name"      varchar(128) NOT NULL,
  "versionId" uuid NOT NULL REFERENCES "image_version"("id"),  -- RESTRICT：有 tag 不许删 version
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "image_tag_image_name_unique" UNIQUE ("imageId", "name")
);
```

**`image_version.digest` 是 OCI manifest digest，不是 `compute_image_digest()`**（§2.3 的表）。

**`storageRef` 的语义是"从哪拉"，跨期只换取值不换结构**（分期文档 I4）：S1 填上游的
digest 钉死 ref，S2/S3 换成 `gateway/<org>/…@sha256:…`，表不动。

**没有 `image_build` 表**（N1 / §0.4）。它随 builder 回到 S3。

### 3.2 改动既有表与 DTO

```sql
-- 新增：per-org 镜像**数量**闸门（N7）。字节闸门随平台存储回到 S3
ALTER TABLE "organization"
  ADD COLUMN "image_count_limit" integer NOT NULL DEFAULT 20;

-- 删除：被删子系统的死残留
ALTER TABLE "organization" DROP COLUMN "template_deactivation_timeout_minutes";
```

删列**连带两处代码**，不改会编译失败：`organization.entity.ts:141-145`（列定义）与
`organization/dto/organization.dto.ts:93`、`:175`（DTO 字段与投影）。

DTO 层（不是表）：

| 位置 | 改动 |
|------|------|
| `apps/api/src/box/dto/update-box-state.dto.ts:11-35` | `+ imageDigest?: string`、`+ imageSizeBytes?: number`，两者都 `@IsOptional()`。这是 digest 回报的载体（N4） |
| `CREATE_BOX` job 载荷（`runnerAdapter.v2.ts:120-152`） | `+ imageRevalidate: boolean`，**由 `box.image` 现算**（V1）。**不来自 create 请求，也不落 `box` 表** |
| `BoxDto` | `+ progress?: { phase: 'preparing_image'; retryAfterMs: number }`（N12） |

**`box` 表不动。** `box.image` 已经存着解析后的 ref，`box_image_idx`
（`box.entity.ts:40`）已经给"哪些 box 在用这个镜像"这条删除守卫查询建好了索引。

### 3.3 与上游 §1 草案的差异

| 项 | 上游 §1 草案 | 本文 | 为什么 |
|---|-------------|------|-------|
| `image_build` | S1 表结构里列出 | **不建**，随 builder 到 S3 | N1 |
| `image.state` | `createdAt, lastUsedAt`，未定删除语义 | `deletedAt` ＋ 部分唯一索引 | C4 |
| `image.name` | 用户起的短名 | 上游仓库路径，`varchar(255)` | N10 |
| curated 行 | `organizationId = null` 的 image 行 | **不存在**，`GET /images` 做 union | C2 |
| `image_version.digest` | org 内唯一 | `UNIQUE(imageId, digest)` | C3 |
| `image_version.state` | `ready \| inactive \| deleted` | `ready \| deleted` | inactive/rehydrate 在 S3 |
| `image_version.sourceKind` | `build \| register` | `pull`（S3 加 `build`） | register 不存在了 |
| `image_tag_event` | S1 表结构里列出 | **S2 才建** | S1 没有 tag 移动 |
| `registry_credential` | S1 表结构里列出 | **S2 才建** | S1 只支持公开镜像 |
| org 配额列 | `image_storage_limit_gib` | `image_count_limit` | N7 |
| `image_version_inactive_after_days` | 决策 3 要新增 | **不加** | 判据是引用式的，不是时间式的 |

### 3.4 宿主 SQLite：**加一列，语义不变**

`~/.boxlite/db/boxlite.db` 的表都不新增也不删除，`image_index(reference PK,
manifest_digest, config_digest, layers, cached_at, complete)`（`db/schema.rs:70-79`）**加一列**：

```sql
ALTER TABLE image_index ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;  -- N13
```

**为什么不能用 mtime 代替它**：基盘是只读的 backing 文件，读不改 mtime，所以 mtime-LRU
退化成"按创建顺序 FIFO"——会优先淘汰**创建最早**的盘，而那往往是所有人共享的 curated
基础镜像。`get_or_create`（`image_disk.rs:78-88`）命中时更新这一列，它本来就是钩子点。

S1 另外改两处**读写时机**：

- C6：`load_from_local`（`manager.rs:185`）也走已有的 `upsert`（`db/images.rs:79`）写一行
- N5：`pull` 的快路径在 `image_revalidate` 为真时**不查**这张表

这张表仍然只回答一个问题——*这个 ref 的层在这块盘上是否已完整解压*——而这条事实只在
那台机器上成立，不得集中化。

### 3.5 权威副本与派生数据（S1 定稿）

| 存储 | 存什么 | 权威 |
|------|-------|------|
| Postgres | image / image_version / image_tag，数量闸门 | **是**（目录元数据） |
| 上游 registry（docker.io / ghcr.io / …） | org 镜像的层与 manifest 字节 | **是**（**在别人家**） |
| ghcr.io | curated 镜像字节（我们在租） | 是（外部） |
| 宿主 SQLite ＋ `~/.boxlite/images/*` | 每机器缓存索引与层、基盘 | **否**（派生、可丢弃） |
| 平台 OCI registry | **S1 不存在** | — |
| S3 storage bucket | S1 不用 | — |

**三样东西不是缓存，误当缓存回收就是数据丢失**：`bases/`（装用户快照）、每 box 的
qcow2（唯一副本，不是派生数据）、S3 起的平台存储（权威）。回收器扩展范围每次变动都要
对着这三样重新过一遍。

**S1 不拥有任何镜像字节。** 这条决定了 `DELETE` 的语义（N8）、耐久性的缺失（§8 R4），
以及"耐久性是 S3 的属性"这个跨期结论。

---

## 4. 新增功能点

| # | 功能 | 对应旅程 | 用户可见形态 | 实现落点 |
|---|------|---------|-------------|---------|
| F1 | **用任意公开镜像创建 box** | Day 3 | `POST /boxes { image: "docker.io/acme/app:1.2" }`，无需任何前置调用 | `ImageAdmission` ＋ `ImageResolver` |
| F2 | **用过即入目录** | Day 3 | 首个 box 起来后镜像自动出现在列表里 | `ImageRegistrar`（§2.3） |
| F3 | 按 digest / tag / 裸名创建 | Day 3 | `<repo>@sha256:…` / `<repo>:<tag>` / 裸 `<repo>`（按 latest） | `ImageResolver` 情形 2–4 |
| F4 | 镜像列表（跨 org 不可见） | Day 5 | `GET /images`；控制台表格 NAME / TAGS / VERSIONS / SIZE / LAST USED | `ImageCatalogService.list` ＋ curated union |
| F5 | 镜像详情 | Day 5 | `GET /images/:idOrRef` → versions（digest、sizeBytes、sourceRef）、tags、history（S1 恒为 `[]`） | `ImageCatalogService.get` |
| F6 | 删除镜像 | Day 5 | `DELETE /images/:idOrRef` → 204。语义是**从目录移除**；有 box 在用则 **409** | 删除守卫照抄 `volume.service.ts:109-150` |
| F7 | 用量与闸门 | Day 20 前置 | `GET /images/usage` → `{count, limit, knownBytes}`；超限 `IMAGE_LIMIT_EXCEEDED` | `ImageUsageService` |
| F8 | **准入拒绝有可读理由** | — | 允许表外的 host、非法 ref、超数量上限各有明确 400；超并发上限 429 带 `Retry-After` | `ImageAdmission` |
| F9 | **首次拉取的进度提示** | Day 15 上移 | `BoxDto.progress = { phase:'preparing_image', retryAfterMs }`，SDK 据此重试 | 由 API 派生（§5 P5） |
| F10 | 极小 Python 云客户端 | Day 3/5 | `boxlite.cloud`：`images.list/get/delete/usage`，两个面，**零第三方依赖** | `sdks/python/boxlite/cloud/` |
| F11 | 权限粒度 | — | API key 可只授 `read:images`；`delete:images` 分开 | 权限枚举 ＋ **两个**分组文件（N15） |
| F12 | 创建框改读 API | Day 5 | `CreateBoxDialog` 列出 curated ＋ 本 org 镜像，并允许直接输入任意 ref | 删掉 `CreateBoxDialog.tsx:30-34` 的硬编码三项 |
| F13 | **org 镜像永不进 warm pool** | 安全 | 无可见 UI；org 镜像的 create 永远新建 | `requiresFreshBox` ＋ `createForWarmPool` 双侧强制 |
| F14 | **D1 回收不可达基盘** | 运维 | 无可见 UI；`disk-images/` 不再只增不减 | `gc_unreachable` ＋ 三个触发点 |
| F15 | **层下载有上限** | 安全 | 恶意 registry 无法用 `size: 0` 写满 runner 盘 | `storage.rs` 写入侧上限 |
| F16 | `/api/images` 指标 | 运维 | PostHog 上的目录事件，替换被删的 `/api/templates` | `metrics.interceptor.ts:131`、`:197`、`:413` |
| F17 | **D2-min：满盘不再等于建不出 box** | 运维 | 无可见 UI；空间压力下淘汰最久未用的基盘，box 创建变慢而不是失败 | `evict_cold_if_low_on_space` ＋ `last_used_at`（N13） |
| F18 | **`autoDelete` 有一个想清楚了的默认值** | 运维 ＋ 成本 | 若改默认：闲置 box 到点自毁，盘随之释放 | `box-lifecycle.constants.ts:8`（V4、§6.0 B6） |

**保住的旧行为（不是新功能，但必须逐条钉住）**：curated 短名与全 ref 直通、
`undefined` 仍解析到 curated 默认、一次性用法不产生目录记录、`RootfsSpec` 与嵌入式 SDK
签名不变、REST 后端 `images()` 仍 `Unsupported`（`core.rs:442-448`）。

---

## 5. 新增性能变化点

| # | 变化 | 量级 | 依据 | 缓解 / 判据 |
|---|------|------|------|------------|
| P1 | box 创建路径 +2 跳（`ImageAdmission` ＋ `ImageResolver`） | curated：**+0 次 DB 往返**；org 镜像：1 次数量 count ＋ 1 次 Redis incr ＋ 1 次索引点查 | 两个组件都把 curated 排在第一位且不读库（`curated-images.constant.ts:80-86`）；情形 2/3 命中 `image_version_image_digest_unique` / `image_tag_image_name_unique` | 验收要求 curated 路径**逐字节一致**；org 路径 p99 增量 < 3 ms。数量 count 要走 `image_org_lastused_index` 或单独计数列 |
| P2 | **首次使用某镜像 = 完整冷拉，落在 box 创建路径上** | 冷 ≈ 23 s（小镜像）到分钟级（GB 级镜像）vs 热 ≈ 1.3 s | `get_or_create` 用整镜像 digest 为键（`image_disk.rs:78-79`），且放置是"可用性前 10 台里随机挑"（`runner.service.ts:308`、`:788`） | **这是 v2 相对 v1 最大的性能变化**：v1 把这次等待放在 register 里，v2 放在第一个 box 上。缓解是 F9 的 `progress`；根治是 D2＋HRW（S2）。**每个 version 仍要在候选池每台 runner 上各付一次** |
| P3 | 首次拉取额外一次 manifest 解析（N5） | 一次 registry manifest GET，通常 < 200 ms，且只发生在 ref 未钉死时 | `imageRevalidate` 在派活点由 `box.image` 现算（V1） | **不得**对所有 tag ref 一律重解析——那会给 curated 每次创建加一次 ghcr.io 往返，打破 §7.3 基线。判定必须把 curated 排除在外 |
| P4 | org 镜像的 create 永远不走 warm pool | 这些请求从"可能秒级认领"退回完整冷创建 | C8/C9，租户隔离硬要求 | 刻意的。文档与控制台文案要说明 |
| P5 | `BoxDto.progress` 是**派生**的，不是测量的 | 零额外查询：由 `box.state ∈ {UNKNOWN, CREATING}` ＋ 该 image 是否已有 ready version 推出 | 上游决策"不新增 `BoxState.PREPARING_IMAGE`"仍然照办（§0.5） | 已知局限：区分不了"正在拉"与"正在启动"。真正的相位需要 runner 侧再加一条回报，S1 不做 |
| P6 | 新增 Postgres 写入 | 每个成功的**首次**box：1 事务 3 条写（image upsert / version insert / tag upsert）。重复使用同一镜像只有一次 `lastUsedAt` UPDATE | `ON CONFLICT DO NOTHING` 让重复路径几乎无写 | `lastUsedAt` 异步更新，不在关键路径 |
| P7 | Redis 新增一个 per-org 计数器 | `image:coldpull:{orgId}`，incr ＋ TTL 自愈 | 决策"不把队列放到 Redis 上"仍然照办——这是计数器不是队列 | 单节点 `cluster:false`（`foundation.ts:51`）已承载缓存/限流/锁/扇出，本项增量极小 |
| P8 | **不新增**：cron 扫描、builder 轮询、pubsub channel、长轮询连接占用 | v1 的 P4–P9 全部消失 | §0.4 | —— |
| P9 | 下载上限的开销 | 每写一块比较一次累计字节（未知大小的 blob 多一次 `AtomicU64::fetch_update`），与既有的 sha256 流式计算同一层；manifest 总量是每次 pull 一次 `i64` 求和 | 照 `extractor.rs:714-722` 的 `OnceLock` ＋ env 覆盖形状 | 可忽略 |
| P10 | **D1 的删除代价** | 只删**不可达**文件，所以正常运行期不改变任何命中率 | 守卫 A 是"文件名当前 manager 生成不出来"，这些文件 `find()` 本来就命中不了（`image_disk.rs:91-95`） | 与 D2 本质不同：D2 删的是**热缓存条目**，代价是下一个 box 付一次重建；D1 代价为零。这条差别决定了 D1 可以无条件跑、D2 必须由容量压力驱动 |
| P11 | D1 扫描本身的开销 | 一次 `read_dir(disk-images)` ＋ 一次 `image_index.list_all()`（`db/images.rs:135`）＋ 一次 backing 链扫描 | 条目数按 org 镜像数增长；`referenced_backing_paths` 已在启动路径上跑（`rt_impl.rs:1520`） | 建盘前触发点要有节流（同一进程内最小间隔），否则密集创建会重复扫 |
| P12 | Python 客户端阻塞模型 | `SyncCloudClient` 用 `urllib.request`；`CloudClient` = 它上面的 `asyncio.to_thread` | 目录四个方法都是短请求，**没有 v1 那个 50 秒窗口** | 反方向（sync→async）不需要 `greenlet`，所以 `dependencies = []` 保得住 |
| P13 | **D2-min 的淘汰代价**：被淘汰镜像的下一次创建从热路径退回一次本地重建 | 重建 ≈ **4 遍未压缩内容的小文件密集 I/O**——`prepare_copy_based` 是真实字节拷贝（`rootfs/builder.rs:84-140`，`CopyMode::Content` 在 `:124`）读写各一遍，`mke2fs -d`（`image_disk.rs:117-121`）再读一遍写一遍 | 与 D1 本质不同（见 P10） | 阈值默认 85%/70%，只在真的接近满时触发；淘汰只删 `disk-images/`、保留 `layers/` 与 `extracted/`，所以重建**不走网络**。彻底降低触发频率靠 HRW（S2），把时间成本压到一次顺序下载靠预建盘缓存（S3，N14） |
| P14 | **`statvfs` 是运行时新增的能力** | 每次建盘前一次系统调用 | `available_space`/`statvfs`/`free_space`/`disk_usage`/`fs2::` 在 `src/boxlite/src` **零命中**——今天没有任何空间检查 | 可忽略。但要注意它是新增依赖面：读取失败必须**整趟放弃**，不得读作"空间不足" |
| P15 | 建盘的**瞬时峰值躲不开** | merged 树 ＋ 暂存 ext4 同时落在同一个卷上 | merged 树在 `tempfile::tempdir_in(self.temp_dir)`（`image_disk.rs:100`），而 `layout.rs:225-262` 的 `validate_same_filesystem` **拒绝** `temp/` `bases/` `disk-images/` 跨文件系统启动 | 不能用"把 tmp 挪走"绕开。给镜像缓存单独一个卷要连着迁三个目录——那是 S4 的工作 |
| P16 | **缓存命中多一次 `last_used_at` 记录** | 实测 **113 µs**（500 条索引行），一条主键 `UPDATE` | 走 `ImageObject::reference()` ＋ `image_index` 主键，与行数无关。**先前的写法是全表扫 ＋ 每行一次 SHA-256，实测 23 ms**，且会给没人用过的 tag 盖时间戳；共享由读侧的 `coldest_first` 取最新值处理 | 可忽略，且不随缓存规模增长。§7.3 第一行的 curated 时延基线据此仍然持平 |
| P17 | **缓存未命中多两趟回收** | 实测 **1.9 ms**（500 条索引行）：一次 `statvfs` ＋ 一次缓存目录 `read_dir` ＋ 每个 box 一次 backing 链走查 | 只在未命中时跑，紧接着是数秒的建盘（P2） | 可忽略。D1 那半有 300 s 节流，淘汰那半刻意不节流——它回答的是"我马上要建的这块盘有地方放吗" |

**没有变化的性能面（要在验收里作为回归基线钉住）**：guest 最小 rootfs、Jailer、
gvproxy、`allow_net` 钉定、preview 的 rejection-only 缓存、层与解压层的跨镜像去重、
每 box COW 盘的大小计算。一个自定义镜像只改变**容器 rootfs 盘的来源 digest**。

---

## 6. 实现步骤和计划

### 6.0 第 0 天必须先落定的六件事（不做会返工）

| # | 待定项 | 怎么定 | 影响谁 |
|---|-------|-------|-------|
| B1 | **manifest digest 从 core 的哪个访问器出来** | **已定（V5）**：给 `ImageObject` 加 `pub fn manifest_digest(&self) -> &str`（读 `manager.rs:34` 的字段）与 `pub fn total_layer_size(&self) -> i64`（`manifest.layers[].size` 求和）。**注意 `compute_image_digest()` 不是它**（`object.rs:284-292` 是层 digest 串的哈希，而且是宿主盘缓存键） | I6 整条链路；`image_version.digest` 的语义 |
| B2 | **`IMAGE_REGISTRY_ALLOWLIST` 的初始取值** | 建议 `docker.io, ghcr.io, quay.io, gcr.io, public.ecr.aws`，本地栈追加 `127.0.0.1:25000` | `ImageAdmission`；e2e 能否跑 |
| B3 | **`image_count_limit` 与并发冷拉上限的默认值** | 建议 20 与 3 | §5 P1、§5 P7、§8 R1 |
| B4 | **`image_revalidate` 挂在 `BoxOptions` 还是独立参数** | 它**不是**秘密，所以 `BoxOptions` ＋ `#[serde(skip)]` 够用（`BoxOptions` 是落盘的 box 配置，`litebox/config.rs:19-21`、`:40`；容器上已有 `#[serde(default)]`（`options.rs:318`），skip 后回落 `false`——重启不重解析，正是想要的）。S2 的凭证**不能**这么做——那必须是独立的非序列化参数 | I6；S2 的接口形状 |
| B5 | **D2-min 的阈值默认值** | **已定：85% 触发、降到 70% 停**（70 而非 75 的理由见 §0.3.4 W4——75 是控制面的投放惩罚线）；不设独立开关，`HIGH=100` 即关闭 | §5 P13、§8 R1、§0.3.4 W4 |
| B6 | **`autoDelete` 的默认值** | 今天 `AUTO_DELETE_DISABLED = 0`（`box-lifecycle.constants.ts:8`），DB 默认也是 0，`autoStop` 默认 900 秒**只停不删**。而停止的 box 的 qcow2 会钉住它的基盘（§2.4 末），所以这条直接决定 D1/D2-min 的有效回收率。三个选项：① 维持 0（则运维手册必须写明人工清理）；② 给一个保守的非零默认（如 7 天）；③ 只对 org 镜像的 box 给非零默认。**必须选一个并写进文档** | §2.4、§8 R1、F18 |

顺手两件事：

1. **核实 runner root 卷的文件系统类型**（`stat -f -c %T /`）。它是 S4（reflink）的前置，现在花 10 秒，比 S4 排期时花两天强。
2. **给冷路径做一次分段测量**：把"冷 ≈ 23 秒"拆成网络下载 / gzip 解压 / 层拷贝成 merged 树 / `mke2fs -d` 四段。这个数字在树里**从没被量过**，而 N14 的收益估算（预建盘缓存快一个数量级）完全建立在"CPU 与本地 I/O 占大头"这个假设上。同时记一条 `du -sh ~/.boxlite/images/*` 的分项基线（layers / extracted / disk-images），S4 要用它对比。

### 6.1 PR 与子 issue 拆分

两级。**PR 是交付单元**——合并即交付一块能当场演示的能力；**子 issue 是验收单元**——每个
都有自己能独立验收的内容，一个 PR 关掉一到若干个。**3 个 PR、14 个子 issue。**

| PR | 能力（合并后能演示什么） | 含子 issue | 估时 | 硬前置 |
|----|------------------------|-----------|------|--------|
| **PR-A · 共享 runner 的容量与安全底线** | 在一台机器上：`disk-images/` 会被回收（今天只增不减）；盘快满时建盘不再 ENOSPC，而是淘汰最久未用的基盘后继续；一个声明 `size: 0` 的恶意 registry 写不满盘 | I7、I12、I13 | 4 d | 无 |
| **PR-B · 任意公开镜像可以起 box** | `POST /boxes {image:"docker.io/library/alpine:3.20"}` → box 起来；第二次创建送的是 digest 钉死的 ref；允许表外 host 与 link-local → 400；`image` 表出现一行、拉取失败则不出现；curated 创建与今天逐字节一致；org 镜像永不进 warm pool | I1–I6 | 11.5 d | **PR-A**（**发布门**，非构建依赖，见下） |
| **PR-C · 镜像目录可见、可管、可编程** | 控制台 Images 页（列表 / 详情 / 用量条 / 删除）；`boxlite.cloud` 四个方法 × 两个面；首次拉取时 `BoxDto.progress` 报"正在准备镜像"；创建框可自由输入任意 ref | I8–I11、I14 | 9.5 d | PR-B |

合计约 **25 人日**。

**PR 之间不是零依赖——三条边，逐条列出。** 依赖图是 DAG（无环），所以上表的顺序就是
唯一可行的合并顺序。

```text
PR-A ──（发布门，无构建依赖）──► PR-B ──（构建依赖：I8/I9/I14 → I6）──► PR-C
```

| 边 | 类型 | 由哪些子 issue 造成 | 后果 |
|---|---|---|---|
| PR-B 需要 PR-A | **发布门，不是构建依赖** | **一条都没有**——PR-B 的任何子 issue 都不引用 PR-A 的符号 | 两者可以**完全并行开发、各自跑通各自的测试**；约束只落在**合并与上线顺序**上：PR-A 不先在 runner 上生效，PR-B 就把"无界镜像种类堆在共享盘上"这条打开了（N13、§8 R1） |
| PR-C 需要 PR-B | **构建依赖** | I8→I6、I9→I6、I14→I6 | 目录里没有行，`GET /images` 就没有东西可返回、`progress` 就没有派生依据、e2e 就没有可断言的对象。**这条绕不开**——"目录可见"按定义晚于"目录里有东西" |
| PR-A | **无进无出** | — | 整块在 `src/boxlite/`，不引用也不被引用，可独立合并、独立回滚 |

**为什么 PR-A 必须先于 PR-B 合并，而不是"同期发"就行。** PR-B 是各 org 第一次能往共享
runner 上塞任意镜像的那一刻。在那之前 `disk-images/` 没有任何回收器、运行时没有任何剩余
空间检查（`statvfs` 家族零命中）、下载侧没有上限。PR-A 的三项**都不是优化**：D1 保证
"垃圾不积累"（代价为零）、D2-min 保证"满了不失败"（有代价，所以阈值保守）、下载上限保证
"一次恶意拉取写不满盘"。它整块落在 `src/boxlite/`，与 `apps/` 零共享符号，所以它能
**先合、先跑一段时间、也能独立回滚**——这正是把它单独立成一个 PR 的理由。

**PR-B 的验收面是 API、job 载荷与 e2e，没有 UI。** 这是刻意的：PR-B 里 I4 是纯接缝重构，
验收标准是"curated 路径逐字节一致"，把 UI diff 压进同一个 PR 会让这条断言的评审被淹没。
UI 到 PR-C 才补上，而在这中间用户已经能通过 REST 与 SDK 用上这个能力。

**一句实话**：PR-B 11.5 人日、PR-C 9.5 人日，都超出一次能审好的体量。落地方式是
**stacked**——每个子 issue 一个提交、按下面明细里的硬依赖顺序摞在一条特性分支上，评审
按子 issue 逐个进行；PR 只做一次面向 main 的合并，和一次面向上表那一行的验收演示。

#### 每个 PR 的交付内容

三段固定写法：**用户拿到什么 / 系统里多出什么 / 明确不在本 PR**。第三段和前两段一样重要——
它是"这个 PR 到此为止"的边界，也是评审时拒绝夹带的依据。验收标准见 §7.5。

**PR-A · 共享 runner 的容量与安全底线**（I7、I12、I13 · 4 d）

- **用户拿到**：几乎什么都没有。这是一块**运维与安全**能力，**除本地 OCI bundle 从此出现在镜像列表里（W11，`load_from_local` 补 index 行的必然连带）之外，用户可见行为逐字节不变**——这条本身就是它的验收判据之一（§7.5 A10）。
- **系统里多出**：`ImageDiskManager::gc_unreachable`（四道守卫 ＋ 三个触发点 ＋ 建盘前节流）；`evict_cold_if_low_on_space`（`statvfs` ＋ 按 `last_used_at` 淘汰到低水位，建盘前与周期任务两个触发点，见 §0.3.4 W5）；`storage.rs` 写入侧流式上限；`image_index.last_used_at` 一列；`load_from_local` 补写 index 行；**五个** env 覆盖点（阈值与上限**不进 `BoxliteOptions`**，见下一条与 V9、§0.3.4 W2）。
- **嵌入式库调用方会观察到**：`disk-images/` 不再只增不减；建盘前多一次 `statvfs`；`load_from_local` 过的镜像出现在 `list()` 里（W11）；五个新的 env 覆盖点。**没有任何签名变化。**
- **明确不在本 PR**：目录三张表、REST、控制台、`ImageAdmission`/`ImageResolver`——它们在 PR-B/C。
- **SDK 交付面：四个嵌入式 SDK 零签名变化，但 `RuntimeMetrics` 上只增两个只读计数器**（W12——这条是对 A13 的有意破例，四份镜像都要改）。它们打包的是同一个 core，所以**库调用方还会观察到行为变化**（`disk-images/` 不再只增不减、建盘前多一次 `statvfs`、`load_from_local` 过的镜像进 `list()`）。五个阈值/上限**只经 env 覆盖**、**不加 `BoxliteOptions` 字段**（V9）——四个 SDK 各自手工镜像核心选项结构（`PyBoxOptions` `sdks/python/src/options.rs:536`、`JsOptions` `sdks/node/src/options.rs:61`、`sdks/go/options.go` 的 25 个 `WithXxx`、`sdks/c/include/boxlite.h`），加一个字段就是四份镜像各改一遍。
- **SDK 文档改动**：四个 README 新增 **Disk & Image Cache** 一节，写明回收与淘汰规则、五个 env 覆盖点、两个新计数器、以及日志落在哪里。Python README 顺带修正了 `RuntimeMetrics` 字段清单——它原先列的四个名字在代码里都不存在。

**PR-B · 任意公开镜像可以起 box**（I1–I6 · 11.5 d）

- **用户拿到**：`POST /boxes { image: "<允许表内的任意公开 ref>" }` 直接可用，**无需任何前置调用**。这是本期的核心能力。
- **系统里多出**：`image` / `image_version` / `image_tag` 三张表 ＋ `organization.image_count_limit`；`ImageAdmission`、`ImageResolver`、`ImageRegistrar`；digest 回报链路（Rust 访问器 → Go 回报 → `UpdateBoxStateDto` → 目录 upsert）；派活点现算的 `imageRevalidate`；warm pool 收窄到 curated（五份字段清单收成一个共用谓词）。
- **同时清掉**：20 处 `TODO(image-rewrite)` ＋ `organization.template_deactivation_timeout_minutes`（连带 `organization.dto.ts:93`、`:175`）＋ `*:templates` 在两个分组文件里隐藏。
- **明确不在本 PR**：**没有任何目录的读接口**。镜像确实进了 `image` 表，但用户此刻只能通过起 box 观察到效果，目录行要靠 DB 查询或 e2e 断言——**列表、详情、删除、用量、`progress`、Python 客户端、控制台全在 PR-C**。这是刻意的取舍，理由见 §6.1 的"PR-B 的验收面是 API、job 载荷与 e2e，没有 UI"。
- **SDK 交付面（嵌入式，四语言共享的 core）**：`ImageObject` 新增 `manifest_digest()` 与 `total_layer_size()` 两个**只读访问器**——`ImageObject` 是 `ImageManager::pull` 的返回类型，所以这是**只增不改**的公开 API。四个 SDK 的现有签名一律不变，`rt.images()` 的 `pull`/`list` 不变，REST 后端仍抛 `Unsupported`（`core.rs:442-448`）。
- **`BoxOptions.image_revalidate` 只在 Go 侧镜像**（`WithImageRevalidate(...)`，runner 要用）；**Python / Node / C 不镜像**。理由同 V9：把一个运行时内部开关镜像四遍等于四份漂移源，而它对嵌入式用户没有意义——他们的 ref 由自己给，不存在"目录命中与否"这个概念。它在 Rust 侧是 `#[serde(skip)]`，所以落盘的 box 配置里不出现、重启回落 `false`。
- **`boxlite.cloud` 在本 PR 还不存在。** 用户此刻只能用 curl 或任意 HTTP 客户端打 REST。**Node / Go / C 零改动**——把任意 ref 传给 `BoxOptions.image` 就是换一个字符串，今天四个 SDK 都支持。

**PR-C · 镜像目录可见、可管、可编程**（I8–I11、I14 · 9.5 d）

- **用户拿到**：控制台 Images 页（列表 / 详情 / 用量条 / 删除）；`boxlite.cloud` 的 `images.list/get/delete/usage` 四个方法 × 同步与异步两个面；首次拉取时 `BoxDto.progress` 报"正在准备镜像"；创建框改读 API 并允许自由输入任意 ref。
- **系统里多出**：`GET /images`（curated union）、`GET /images/usage`、`GET /images/:idOrRef`、`DELETE /images/:idOrRef`（软删 ＋ 在用守卫 409）；`read:images` / `delete:images` 与**两个**权限分组文件的同步；`/api/images` 指标；`apps/e2e/cases/test_images_catalog.py`。
- **明确不在本 PR**：tag 移动与 History、私有 registry 凭证、云端构建——分别在 S2 与 S3。
- **SDK 交付面（本期最重的一块，也是 `boxlite.cloud` 这个命名空间的首次出现）**：
  - `sdks/python/boxlite/cloud/`：`SyncCloudClient` / `CloudClient` 两个面；`images.list / get / delete / usage` 四个方法；错误类型 `ImageNotFound` / `ImageLimitExceeded`；基于 `urllib.request` ＋ `asyncio.to_thread`，**零第三方运行时依赖**（守住 `sdks/python/pyproject.toml:10` 的 `dependencies = []`）。
  - **import 路径 `boxlite.cloud` 是本 PR 立下的跨期契约**：S3 换成生成客户端时只替换内部实现，S1/S2 时期用户写好的代码**一行不改**。
  - **文档必须把两个 "images" 分开写**（§0.6）：`rt.images()` = **本机**镜像缓存（`pull`/`list`），只在嵌入式后端可用、REST 后端抛 `Unsupported`；`c.images` = **云端**目录。同一个词两个语义，不分开写必然误用。
  - **`BoxDto.progress` 出现在 REST 响应里，但 S1 不要求任何 SDK 解析它**：`Boxlite.rest(...).create` 的行为不变（它本来就在等 STARTED），文档写明轮询者可以据 `retryAfterMs` 重试。
  - **Node / Go / C：零改动。** 云端管理面是否跟进留到 S3 定。

#### 子 issue 明细

依赖只写**硬**依赖（不满足就编译不过或测不了）。估时是判断。

| # | PR | 子 issue 标题（也是它的 Conventional Commit 标题） | 内容 | 硬依赖 | 估时 |
|---|:--:|------------------------------------------------|------|--------|------|
| I1 | B | `chore(api): retire image and template subsystem residue` | 20 处删除（webhook 载荷与 handler、`openapi-webhooks.ts`、runner 选择两处、`organization.service.ts`、`app.service.ts`、`/api/templates` 指标三处（`metrics.interceptor.ts:131`、`:197`、`:413`）、dashboard 六处残留、`infra-local/README.md`）；`*:templates` 从两个权限分组文件里隐藏（`OrganizationPermissionsGroups.ts:15-18` 的 "Images" 组今天指的就是 templates） | — | 1.5 d |
| I2 | B | `feat(api): add the image catalog schema` | §3.1 三张表 ＋ §3.2 两处列变更（**含 `organization.dto.ts:93`、`:175`**）；entities / DTO；一个 pre-deploy 迁移 ＋ 迁移测试 | I1（同一个迁移文件删 `template_deactivation_timeout_minutes`） | 1.5 d |
| I3 | B | `feat(api): gate box images by an admission policy` | `ImageAdmission`；`image-ref.util.ts`（解析、语法校验、host 允许表、link-local 拒绝、`isCuratedSelector`、`isDigestPinned`）；替换 `box.service.ts:209`；429 复用 `retryAfterSeconds`（V3） | I2 | 2 d |
| I4 | B | `feat(api): resolve box images through an image resolver` | `ImageResolver` 四路解析 ＋ `ResolvedImage` 类型 ＋ 出口断言；`box.service.ts:86-92` / `:197-203` 的常量成契约、删 TODO | I3 | 1.5 d |
| I5 | B | `fix(api): keep the warm pool curated-only` | `requiresFreshBox` 加镜像维度（**改签名**）；`createForWarmPool`（`box.service.ts:164`）拒绝 org 镜像；**五份**字段清单（`box-warm-pool.service.ts:69-84`、`:93-112`、`:151-167`、`:193-205`、`:211-227`）收成一个共用谓词，顺带修 `gpu` 漂移与 `gpuType` 缺失 | I4 | 2 d |
| I6 | B | `feat(core): report the resolved image digest and revalidate tags` | **跨 3 语言。** Rust：`ImageObject::manifest_digest()` / `total_layer_size()`（B1）；`BoxOptions.image_revalidate`（B4）在为真时绕过 `store.rs:172-179` 的快路径。Go：`WithImageRevalidate`、读 job 载荷新字段、状态回报带 digest/size。API：`runnerAdapter.v2.ts` 现算 `imageRevalidate`（V1）＋ `UpdateBoxStateDto` 两个可选字段 ＋ `ImageRegistrar.onBoxStarted` 单事务 upsert | I4 | 3 d |
| I7 | A | `fix(core): bound compressed layer downloads` | **两层**（§0.3.4 W1）：manifest 声明总量 > 20 GiB 在拉第一层之前就拒（`store.rs`）；写入侧流式上限钩在 `bytes_written` 累加处，声明 > 0 用声明值、未知则用整次 pull 共享的余额（`storage.rs`），照 `extractor.rs:704-722` 的 `OnceLock` ＋ env 覆盖形状；超限即中止并删暂存文件 | —（与 apps 线并行） | 0.5 d |
| I8 | C | `feat(api): expose the image catalog` | `GET /images`（curated union）、`GET /images/usage`、`GET /images/:idOrRef`、`DELETE /images/:idOrRef`（软删 ＋ 在用守卫 **409**）；**路由声明顺序**：`usage` 在 `:idOrRef` 之前；权限枚举 `read/delete:images` ＋ **两个**分组文件同步（N15）；`/api/images` 指标 | I6 | 2 d |
| I9 | C | `feat(api): report image preparation progress on box create` | `BoxDto.progress` 派生逻辑 ＋ `retryAfterMs` 常量 ＋ OpenAPI；`BoxStateWaiter` 超时返回带 progress 的 DTO | I6 | 1.5 d |
| I10 | C | `feat(python): add a minimal boxlite.cloud catalog client` | `sdks/python/boxlite/cloud/{__init__,_transport,images,errors}.py`；四个方法 × 两个面；status 优先的错误映射；**零第三方依赖**；客户端单测 ＋ 导入测试 | I8（端点定稿） | 1.5 d |
| I11 | C | `feat(dashboard): add the images page` | `pages/Images.tsx` ＋ 详情页 ＋ 用量条；`RoutePath.IMAGES` 从 `HIDDEN_DASHBOARD_ROUTES`（`App.tsx:55-56`）移出、删 `:221-223` 的重定向映射里那一项、侧边栏放在 Volumes 旁；`CreateBoxDialog.tsx:30-34` 改读 API 并允许自由输入 ref | I8 | 3 d |
| I12 | A | `fix(core): reclaim unreachable image disk cache entries` | `ImageDiskManager::gc_unreachable` 四道守卫 ＋ 三个触发点；`cache_dir` canonicalize；`load_from_local` 补写 index 行；**阈值/开关只经 env 覆盖、不加 `BoxliteOptions` 字段**（V9）；Rust 单测 | —（与 apps 线并行） | 2.5 d |
| I13 | A | `fix(core): evict cold image disks under space pressure` | **D2-min**：`statvfs` 剩余空间检查（**运行时今天没有任何空间检查**）＋ `image_index.last_used_at` ＋ 建盘前按最久未用淘汰到低水位；复用 I12 的"活 box backing 盘不动"守卫；默认阈值 85% 触发、降到 70% 停（`HIGH=100` 即关闭）；另加 6 小时周期触发与装盘窗口守卫（§0.3.4 W4–W6） | I12（复用它的守卫 B） | 1 d |
| I14 | C | `test(e2e): boot a box from an arbitrary public image` | `apps/e2e/cases/test_images_catalog.py`，经 `boxlite.cloud` 同步面驱动；本地 registry（`infra-local/compose/config.py:95`，端口 25000）充当外部公开来源；准入允许表本地放开 | I6, I10, I11 | 1.5 d |

合计约 **25 人日**，与按 PR 汇总的一致。

> **对早先口头估计的更正**：先前说过"12 个 PR 掉到 7 个"，那是按旧的细粒度口径数的。
> 现在的口径是 **3 个 PR（交付单元）/ 14 个子 issue（验收单元）/ 约 25 人日**。
> **真正的收益不在人日，在复杂度**：不新增进程、不新增部署单元、不新增 registry 依赖、
> 不新增 IAM 边界、不引入"删元数据不删字节"这一整类 bug。v3 还顺手省掉了一处跨组件
> 状态传递（V1）。

两人并行，落在 **3 周**：

```text
PR-A（整期并行，全在 src/boxlite/；两个起点互不依赖）
     I7  ────────────────┐
     I12 ──► I13 ────────┴─►   合并即可演示：回收、淘汰、下载上限
                               ╎
                               ╎ 发布门（准入条件）：PR-A 先合，但**不阻塞 PR-B 的开发**
                               ▼
PR-B（第 1 周）
     I1 ──► I2 ──► I3 ──► I4 ──┬─► I5        合并即可演示：任意公开镜像起 box
                               └─► I6
                                    │ 构建依赖：I8、I9、I14 都要 I6 落成的目录行
                                    ▼
PR-C（第 2–3 周）
     I9                                      （只依赖 I6，与下面整条并行）
     I8 ──┬─► I10 ──┐
          └─► I11 ──┴─► I14                  合并即可演示：控制台 + SDK 全通

关键路径  I1→I2→I3→I4→I6→I8→I11→I14  ≈ 16 d
```

**为什么 I1 必须是 PR-B 的第一个。** 20 处删除很便宜，但不做会让 S2–S4 每一期都继承一个
半残子系统；而它和 I2 共用同一个迁移文件，所以顺序是机制决定的，不是偏好。

**为什么 I3 与 I4 在同一个 PR 里仍要分成两个子 issue。** I3 是**放开准入**（行为变化，
安全相关）；I4 是**接缝重构**（验收标准是 curated 路径逐字节一致）。混成一个提交会让
"逐字节一致"这条断言的评审失去意义——这正是子 issue 存在的理由：**PR 按能力交付，
提交按可评审的最小行为变化切。**

**为什么 I6 是关键路径上最重的一个。** 它同时改 Rust、Go 和 TypeScript，而且是 digest
钉死这条承重结构的实现。它不能再拆——拆了就会出现"回报了 digest 但没人写目录"或
"写了目录但 digest 是层哈希"的中间态。

### 6.2 完成定义

**子 issue（验收单元）——五条，逐个满足**

1. `make lint` 与该包的最小测试目标通过（不是整棵树）
2. 新增/改动的分支有对应单测；行为变化类子 issue 走两侧验证（§7.4）
3. 提交信息用它自己那条 Conventional Commit 标题（`CONTRIBUTING.md` 对提交只要求这个）；before/after 端到端调用图是 **PR 描述**的强制项，不是每条提交的
4. 迁移类子 issue 额外要有迁移测试与 `down()`
5. 越出 `apps/` 的子 issue（I6 的 Rust/Go 部分、I7、I12、I13）写明**库调用方会观察到什么变化**

**PR（交付单元）——再加四条**

6. 它包含的每个子 issue 都已满足上面五条
7. §6.1 那一行的"能演示什么"**当着评审跑一遍**，把输出贴进 PR 描述
8. PR 描述汇总列出它关掉的子 issue，并带一张覆盖整块能力的 before/after 调用图
9. §7.3 里与本 PR 相关的回归基线行有实测数字，不是"应该没变"

### 6.3 可选项

| # | 项 | 内容 | 为什么值得在这一期做 | 估时 |
|---|----|------|--------------------|------|
| O1 | `fix(api): let a deleted volume's name be reused` | 把 `volume.entity.ts:11` 的 `@Unique(['organizationId','name'])` 换成部分唯一索引，放进 I2 那个迁移 | **同一失败类**（C4）：`volume.service.ts:109-150` 只检查状态就放行重名，DB 约束却拒绝——软删过的名字复用会 500。I2 本来就要写迁移。只放宽、不收紧，无回滚风险 | 0.5 d |
| O2 | `feat(api): pin image affinity when selecting a runner` | 恢复 `runner.service.ts:791-792` 被删掉的镜像亲和（HRW） | pull-through 下随机选 runner 意味着每台缓存每个镜像。**但上游要求 HRW 与积极淘汰同期发**，所以本期只做会让淘汰缺位。建议整体留在 S2 | — |

O1 需要评审拍板（它改的是 Volume 的行为，不在本期请求范围内）。**不做也不阻塞 S1**——
`image` 表从第一天就是部分索引，不会继承这个 bug。

---

## 7. 测试和验收计划

### 7.1 单元测试（按子 issue）

**I2 — 迁移**
- `up()` 建三张表、两处列变更；`down()` 逆向
- 断言部分唯一索引的 `WHERE "deletedAt" IS NULL` 字面出现（C4 的回归基线）
- 断言 `image.name` 是 `varchar(255)`（N10）
- 断言 `organization.dto.ts` 不再引用 `templateDeactivationTimeoutMinutes`（否则 I1 只做了一半）

**I3 — 准入与 ref 工具**
- host 允许表：表内通过；表外 400 且消息列出允许的 host
- **link-local / 私有网段拒绝**：`169.254.169.254`、`127.0.0.1`（生产 profile）、`10.0.0.0/8`、`[::1]` 各一条
- ref 语法：`../`、空、超长、非法字符、`@sha256:` 短 digest 在**任何** URL 拼接与 DB 写之前被拒
- 数量上限：达到 `image_count_limit` 时新镜像 400，**已在目录里的镜像仍可创建**
- 并发上限：超出时 429 **且响应带 `Retry-After` 头**（走 `retryAfterSeconds`，V3）
- curated 选择符**不经过**上述任何一条（用 spy 断言零 Redis、零 DB 调用）
- `isCuratedSelector` / `isDigestPinned` 各一组表驱动用例——它们是 V1 的判定基础

**I4 — resolver**
- curated 短名与全 ref 直通，且 `undefined` 仍解析到 curated 默认
- **curated 解析不产生任何 DB 查询**（mock repository 断言零调用）——"一次性用法"的机械保证
- `<repo>@sha256:…` / `<repo>:<tag>` / 裸 `<repo>`（latest 存在与不存在）四路
- **目录命中 ⇒ 输出必为 `@sha256:`**；反过来必须失败
- 目录未命中 ⇒ 输出为原 ref（不编造 digest）
- 保留 `curated-images.constant.spec.ts` 作为回归基线，不改

**I5 — 租户隔离**
- org 镜像被 `createForWarmPool` 拒绝，错误消息含那行 `warm_pool` 的 id
- org 镜像的创建**从不调用** `fetchWarmPoolBox`，**也不读写** `warm-pool:skip:` 键（C9）
- **"五份字段清单一旦不再一致就失败"**：从共用谓词导出字段集合，逐一比对五处查询的 where 键；`gpu` 漂移与 `gpuType` 缺失作为回归基线；顺带断言 `warm_pool_find_idx`（`warm-pool.entity.ts:11`）覆盖同一组字段
- `requiresFreshBox` 的既有三组维度不回归：网络策略、容器进程（`runAsUser` / `workingDir` / `entrypoint` / `cmd`）、`secrets`

**I6 — digest 回报与重解析**
- Rust：`image_revalidate = true` 时**不查** `try_load_cached`；为 false 时查（用一个假 registry 计数请求次数）
- Rust：`manifest_digest()` **等于 manifest digest**，而**不等于** `compute_image_digest()`——写成显式的不等断言，否则 B1 选错访问器不会被发现
- Rust：`BoxOptions` 序列化后**不含** `image_revalidate` 键，且 `from_str("{}")` 回落 `false`（B4 / V6）
- **API：`imageNeedsRevalidate(box.image)` 的四象限**——curated tag ref ⇒ false；curated 全 ref ⇒ false；org tag ref ⇒ true；org digest ref ⇒ false。这是 V1 的回归基线，也是 I3 那条"curated 不加往返"的机械保证
- Go：job 载荷的 `imageRevalidate` 透传到 create 选项；状态回报带上 digest 与 size
- API：`onBoxStarted` 幂等——同一个 (imageId, digest) 调两次只有一行
- API：**curated 的 box 报到 STARTED 时不产生任何 image 行**
- API：`state=error` 时**不产生任何 image 行**（N2 的回归基线）
- API：并发两个 box 用同一个新 ref → 一行 version（由 `ON CONFLICT` 兜住，不靠时序）
- API：`image_tag` 用 `DO NOTHING`——同名 tag 第二次报到不同 digest 时 tag **不移动**（N9）

**I7 — 下载上限**（两层，§0.3.4 W1）
- manifest 声明总量超限 → **拉任何层之前**就拒，`ResourceExhausted` 且消息点名 `BOXLITE_MAX_IMAGE_DOWNLOAD_SIZE`
- 声明未知（`size <= 0`）的层**不计入**该总量 —— 它们由流式那条余额管，两条闸门不许互相代劳
- 声明总量**恰好等于**上限 → 放行（拒的是"超过"）
- `expected_size <= 0` 且流耗尽整次 pull 的余额 → 中止、暂存文件被删、返回 `ResourceExhausted`
- 那条余额是**整次 pull 共享**的：第二个未知大小的 blob 只拿得到剩余额度
- `expected_size > 0` 且流超过它 → 同上，**不等到 `commit()` 才发现**
- **声明值不被 clamp**：一个远大于未知余额的声明值仍然按声明值放行（否则会误伤诚实的大层）
- 正常镜像不受影响
- env 覆盖的回落规则生效（`parse_override`：缺失/不可解析都回落默认值）

**I8 — 目录与用量**
- `GET /images` 跨 org 不可见；curated 出现在结果里且标记为不可删
- **路由顺序**：`GET /images/usage` 不被 `:idOrRef` 吞掉（一条显式测试）
- `:idOrRef` 同时接受 uuid 与 URL 编码的 ref（含斜杠）
- `DELETE`：有未销毁的 box 在用 → **409** 并列出 box id；无则软删 ＋ 名字可复用
- 幂等：删两次，第二次 404（客户端当成功）
- 用量 = 目录中 `deletedAt IS NULL` 的 image 计数；`knownBytes` 是 ready version 的 `sizeBytes` 求和，端点文档写明**版本间共享的层是刻意重复计数的**

**I9 — progress**
- 新镜像的 box 在 CREATING 期间带 `progress.phase = 'preparing_image'`
- 已有 ready version 的镜像**不带** progress
- box 到 STARTED 后 progress 消失
- `retryAfterMs` 引用具名常量，不是字面量

**I10 — Python 客户端（对着 stub transport）**
- 四个方法各一条 happy path，两个面各跑一遍
- **错误映射：status 优先、`code` 只做细化，绝不凭空合成。** 必须包含**无 `code`** 的 4xx 与 5xx。凭空造 code 正是 Rust 侧刚修掉的 bug（`src/boxlite/src/rest/types.rs:31-44`）
- 错误 body 是**扁平**形状 `{path,timestamp,statusCode,error,message,code?}`（`filters/all-exceptions.filter.ts:84-91`）
- **断言不发 `X-BoxLite-Organization-ID`**：org 由 key 自带（`auth/api-key.strategy.ts:130`）
- 非法名字（含 `../`）在发请求前就被拒
- **导入测试**：`boxlite` 装完之后仍然没有任何第三方运行时依赖（守住 `pyproject.toml:10` 的 `dependencies = []`）

**I12 — D1（Rust）**
- 守卫 A：reserve 常量变更后的旧文件被删；digest 无 index 行的被删；**digest 有 index 行且 reserve 匹配的绝不被删**
- 守卫 A 的重建路径：`live_disk_names` 由 `sha256(concat(row.layers))` 算出，与 `compute_image_digest()` **逐字符相等**（一条直接对照的测试）
- 守卫 B：一个活着的 box 的 `disk.qcow2` backing 指向的盘绝不被删（含**停止的** box）
- 守卫 C：新于 `ORPHAN_GRACE`（300 s）的文件被跳过
- 守卫 D：`.qcow2`、无扩展名、子目录一律不碰；**DB 出错 → 整趟放弃**
- `load_from_local` 之后 index 有行，且该盘不再被 D1 判成垃圾（C6 的回归基线）
- 三个触发点各有一条测试；建盘前触发点的节流生效

**I13 — D2-min（Rust）**
- 使用率低于触发阈值 ⇒ **一块都不淘汰**（默认配置下等于关闭）
- 达到触发阈值 ⇒ 按 `last_used_at` 从最久未用开始淘汰，**到低水位即停**（不是清空）
- **活着的 box 所 backing 的盘绝不被淘汰**，即使它是最久未用的（含**停止的** box——它的 qcow2 还在）；这条复用 I12 的守卫 B
- **`last_used_at` 在 `get_or_create` 命中时被更新**——写成"命中后该值前进"的断言，否则退化成 FIFO 不会被发现
- **一条显式的反 mtime 测试**：构造"创建最早但刚被用过"和"创建最晚但很久没用"两块盘，断言被淘汰的是后者。这是 N13 的回归基线
- 淘汰只删 `disk-images/`，**`layers/` 与 `extracted/` 不动**——重建不走网络
- `statvfs` 读取失败 ⇒ **整趟放弃**，绝不读作"空间不足"而清缓存
- 淘汰后紧接着的建盘成功（只是慢），不是失败
- **装盘窗口**：刚 rename 进缓存（< 300 s）且还没有 overlay 的盘，不被并发的淘汰取走；本次正在装的 digest 同样跳过（§0.3.4 W6）
- **周期触发跑的是两趟**（D1 ＋ 淘汰），首趟立即——这是"盘满了拿不到投放"的机器唯一的自愈通路（§0.3.4 W5）

### 7.2 e2e（`apps/e2e/cases/test_images_catalog.py`）

本地栈：Postgres ＋ Redis ＋ MinIO ＋ registry(25000) ＋ registry-ui，共 12 个组件，
无需 AWS 账号。`INSECURE_REGISTRIES=127.0.0.1:25000` 今天就已经配给本地 runner
（`infra-local/compose/native.py:247`），所以本地 registry 可以直接充当**外部公开来源**，
runner 侧零改动——只需把它加进准入允许表（B2）。

**必须由那个 Python 客户端驱动**（同步面），让客户端由同一次运行覆盖。

1. 用 `crane`/`skopeo` 把一个小镜像（alpine，实占约 25 MiB）推进本地 registry
2. `POST /boxes { image: "127.0.0.1:25000/acme/app:v1" }` → box 起来
3. `c.images.list()` 里出现 `127.0.0.1:25000/acme/app`；`c.images.get(...)` 的 version 有 digest 与 sizeBytes；`c.images.usage()` 的 count 增加
4. **断言第二次创建送的是 digest 钉死的 ref，且载荷的 `imageRevalidate` 为 `false`**（读 job 载荷）
5. **tag 重解析**：把 registry 上的 `:v1` 指向一个新镜像，再建一个 box → 因为目录已命中，**送的仍是旧 digest**（N9 的行为，不是 bug）；`c.images.delete(...)` 之后再建 → `imageRevalidate` 回到 `true`，拉到新 digest
6. `c.images.delete(...)` → 204；有 box 在用时 → **409**
7. **准入**：允许表外的 host → 400；`169.254.169.254/x:v1` → 400；超数量上限 → 400
8. **失败不入目录**：用一个不存在的 tag 建 box → box 进 ERROR 且 `c.images.list()` 不多出行
9. 异步面把 3–6 重跑一遍（`await`）
10. **curated 回归**：`POST /boxes { image: "python" }` 与今天逐字节一致，不产生任何 `image` 行，且载荷的 `imageRevalidate` 为 `false`

### 7.3 回归基线

| 基线 | 怎么量 |
|------|-------|
| curated box 创建时延 | S1 前后各跑 20 次 `POST /boxes {image:"python"}`，比 p50/p99；curated 路径不新增 DB 往返也不新增 registry 往返（I3/I6），所以要求持平 |
| curated 创建不触碰目录 | 单测（零 repository 调用）＋ e2e 第 10 条 ＋ I6 的"curated 报到不产生 image 行" |
| 嵌入式 SDK 签名 | Python/Node/Go/C 的现有测试全绿；`BoxOptions` 新字段是 `#[serde(skip)]` 的可选布尔，不改任何现有签名 |
| `disk-images/` 实占 | `du -sh`（**不是** `stat`——这些是稀疏文件）。记一条 S1 基线数字，供 S4 对比 |
| 容量算术复核 | 按 `du -sh ~/.boxlite/images/*` 的分项数字复核"约 500 块基盘 / 25 个 org"（§8 R1） |
| 冷路径分段 | 网络下载 / gzip 解压 / 层拷贝成 merged 树 / `mke2fs -d` 四段各一个数字（§6.0 顺手第 2 件） |
| warm pool 命中率 | curated 请求的命中率不下降（org 镜像本来就不进池） |
| 正常镜像不受下载上限影响 | 拉 `python:3.12-slim` 成功，且未触发 `ResourceExhausted` |

### 7.4 两侧验证（行为变化类 PR 必做）

按 `AGENTS.md` 的顺序，每条都**手动跑两遍**并记录观察到的失败信号。**「观察到」一栏是
实际跑出来的文本**——`AGENTS.md` 要求的是观察值而不是预期值，两者不一致时以观察值为准；
留空的行表示尚未跑过，不得据此声称该测试守住了缺陷。

| 子 issue | 复现测试 | 步骤 1（production 全部回退，只留测试）预期失败信号 | 观察到 |
|----|---------|------------------------------------------------|--------|
| I5 | org 镜像的创建不读写 `warm-pool:skip:` | 回退后 `redis.exists` 被调用 → 断言失败 |
| I5 | 五份字段清单一致性 | 回退共用谓词后，因 `gpu` 漂移而失败 |
| I6 | `image_revalidate=true` 时不命中 ref 字符串缓存 | 回退后假 registry 的请求计数为 0 → 断言"至少一次 manifest 请求"失败 |
| I6 | **curated 的 box 不被判成需要重解析** | 回退 `imageNeedsRevalidate` 里的 curated 分支后，curated 创建多出一次 registry 往返 → 断言"零额外请求"失败 |
| I6 | `state=error` 不写目录行 | 回退 `onBoxStarted` 的成功判定后，出现一行 version → 断言"零行"失败 |
| I7 | 声明未知的层被上限中止 | 回退上限后，暂存文件写到超出预算 → 断言"越界那次写入被拒"失败（用注入的小额度让测试跑得快） |
| I12 | reserve 常量变更后旧盘被回收 | 回退 `gc_unreachable` 后旧盘仍在 → 断言 `!path.exists()` 失败 |
| I12 | `load_from_local` 的盘不被误删 | 回退 index 补写后该盘被删 → 断言 `path.exists()` 失败 |
| I13 | 空间不足时建盘仍然成功 | 回退 D2-min 后，把可用空间压到阈值以下再建盘 → `create_ext4_from_dir` 报 ENOSPC → 断言"建盘成功"失败 |
| I13 | 淘汰的是最久未用而非创建最早 | 回退 `last_used_at`、改回 mtime 后，被淘汰的是"创建最早但刚用过"那块 → 断言失败（N13 的回归基线） |

**实现期补做的七条**（都跑过两遍，观察值逐字记录）：

| 子 issue | 复现测试 | 观察到的失败信号 |
|----|---------|----------------|
| I12 | `an_unreadable_directory_entry_reports_incomplete`（逐条目 `read_dir` 错误被 `flatten()` 丢掉） | `an entry that could not be read leaves the answer unknown, not smaller`（`base_disk.rs`） |
| I13 | `a_high_watermark_of_100_turns_eviction_off`（`HIGH=100` 并未关闭淘汰） | `a full volume must not evict when the operator disabled eviction` |
| I13 | `the_low_watermark_always_leaves_room_to_evict_into`（低水位钳到高水位 ⇒ 第一个候选就退出） | `assertion left == right failed … left: 85, right: 84` |
| I12 | `the_lenient_chain_leaves_out_a_backing_file_that_cannot_be_statd`（宽松版返回 stat 不到的路径 ⇒ bwrap 严格 `--ro-bind` 起不来） | `a path bwrap would refuse to bind must not be reported as a backing file` |
| I12 | `a_backing_path_is_recorded_canonical_even_when_given_through_a_symlink`（W8：qcow2 头里的 backing 路径必须是规范路径，守卫 B 的集合比较依赖它） | `left: ".../linked/base.ext4"` vs `right: ".../real/base.ext4"` |
| I7 | `the_unsized_allowance_is_charged_once_per_byte_that_lands`（额度按提交的字节扣、不按落盘的字节扣 ⇒ `Pending` 与短写各重复扣一次） | `100 bytes fit inside a 1000-byte allowance: … "write of 30 bytes would exceed this download's byte budget"` |
| I13 | `a_cache_hit_records_the_use`（`record_use` 用原样 ref、行按归一化 ref 存 ⇒ `touch` 匹配 0 行、静默） | `a cache hit must move last_used_at forward` |

**一条明确没有测试守住的**（按上面的约定，不得据此声称已守住）：

| 行为 | 状态 | 为什么 |
|------|------|--------|
| **重建路径也要记一次 use** | **未测** | `get_or_create` 的命中分支与重建分支现在汇合到同一个 `record_use` 调用点，所以结构上两条都记；但**把它改回只在命中分支记，全套 60 个相关单测依然全绿** —— 也就是说这条只靠代码形状保证，没有测试。原因是重建分支要走成功需要真实层 ＋ `mke2fs`，本地 bundle 测试夹具是刻意让构建失败的。补上的是互补性质那一半（`a_failed_build_records_no_use`：没交出盘就不记）。**要真正钉住它需要一个能成功建盘的夹具，归属与 A8 的 tmpfs 用例同一条** |

I4 是纯接缝重构（验收标准是"逐字节一致"），没有可复现的缺陷，因此不适用两侧验证；
它的保证来自"curated 解析零 DB 调用"与出口断言两条单测。

### 7.5 验收

**按 PR 分组**——每个 PR 合并前把自己这张表跑完，不欠账到下一个 PR。"证据"一栏指向本文
其它小节，不重复展开。**判为不通过**那几条是一票否决：出现任意一条即退回，不做权衡。

#### PR-A · 共享 runner 的容量与安全底线

| # | 验收判据 | 证据 |
|---|---------|------|
| A1 | reserve 常量变更后的旧盘被回收，而 digest 有 index 行**且 reserve 匹配**的一块不删 | §7.1 I12 守卫 A ＋ §7.4 I12 第 1 行 |
| A2 | 活着**与停止的** box 的 backing 盘绝不被删、也绝不被淘汰 | §7.1 I12 守卫 B、I13 第 3 条 |
| A3 | 三个触发点各生效一次；建盘前那个的节流生效 | §7.1 I12 末两条 |
| A4 | DB 或 `statvfs` 读取失败 ⇒ **整趟放弃**，绝不读作"全都不可达"或"空间不足" | §7.1 I12 守卫 D、I13 倒数第 2 条 |
| A5 | 使用率低于触发阈值 ⇒ 一块都不淘汰；达到 ⇒ 按 `last_used_at` 淘汰**到低水位即停**（不是清空）；装盘窗口内的盘（本次正在装的、落地 < 300 s 的）不被并发的淘汰取走 | §7.1 I13 前两条、§0.3.4 W6 |
| A6 | **淘汰的是最久未用而非创建最早**（构造"创建最早但刚用过"与"创建最晚但很久没用"两块盘） | §7.1 I13 的反 mtime 测试 ＋ §7.4 I13 第 2 行 |
| A7 | 淘汰只删 `disk-images/`，`layers/` 与 `extracted/` 一个不动（重建不走网络） | §7.1 I13 |
| A8 | 淘汰后紧接着的建盘**成功**（只是慢），不是失败 | **自动化只到「建盘前真的腾出了空间」**：`the_build_path_evicts_cold_disks_to_make_room` 走真实入口 `reclaim_before_build`，验最冷的被腾、活 box 压着的不动、本次正在装的不动。**「`mke2fs` 随后成功」这一段没有自动化测试**——它需要一个真的满卷，实测用 32 MiB tmpfs 跑的：`usage 89% → 写入 ENOSPC(code 28) → 淘汰 1 块 → usage 38% → 同一写入 ok`。要把这段纳入 CI 需要一个特权的 tmpfs 集成用例，未排期 |
| A9 | 声明未知且流超限 ⇒ 中止、删暂存、`ResourceExhausted`，**不等到 `commit()`** | §7.1 I7 ＋ §7.4 I7 |
| A9b | 未知大小的余额是**整次 pull 共享**；声明值**不被 clamp** | §7.1 I7 |
| A9c | manifest 声明总量超限 ⇒ **拉任何层之前**就拒；未知大小的层不计入总量；恰好等于上限放行 | §7.1 I7 |
| A10 | **除 W11 那一处（本地 bundle 进镜像列表）外，用户可见行为逐字节不变**：四语言嵌入式 SDK 现有测试全绿，无签名变化 | §7.3 第 3 行、§0.3.4 W11 |
| A11 | 正常镜像不受上限影响：拉 `python:3.12-slim` 成功且未触发 `ResourceExhausted` | §7.3 末行 |
| A12 | 记下 `du -sh ~/.boxlite/images/*` 的分项基线（layers / extracted / disk-images），S4 要用同一条 | §7.3 |
| A13 | **四份 SDK 的选项镜像一个字没改**：`PyBoxOptions`（`sdks/python/src/options.rs:536`）、`JsOptions`/`JsBoxOptions`（`sdks/node/src/options.rs:61`、`:170`）、`sdks/go/options.go`。**指标镜像是有意破例**（W12）：四份 `RuntimeMetrics` ＋ 两处 REST DTO 各加两个只读计数器，`boxlite.h` 由 cbindgen 重新生成 | diff 审查 ＋ §7.3 第 3 行、§0.3.4 W12 |
| A14 | **五个**阈值/上限**只经 env 覆盖**，`BoxliteOptions` 上不出现任何新字段（V9、§0.3.4 W2）；env 覆盖的回落规则有测试 | §7.1 I7、I12、I13 |
| A15 | 四个 SDK README 的"磁盘与缓存"一节已写明回收行为与**五个** env 覆盖点 | 文档审阅 |
| A16 | **两个计数器数的是对的**：`image_disks_evicted_total` 只在淘汰时前进（回收垃圾不算，两者对一台机器的含义相反）；`image_disk_bytes_reclaimed_total` 两趟共用，且记**实占**（`blocks()*512`，不是 `len()`——盘是稀疏的） | 单测 `both_passes_report_what_they_freed_to_the_runtime_metrics`；镜像面 diff 审查（W12 列出的七处） |

**判为不通过**：任何一次活的或停止的 box 的 backing 盘被回收或淘汰；`statvfs` 失败时清了
缓存；淘汰信号退化成 mtime；`load_from_local` 的盘被误删；`layers/` 或 `extracted/` 被删。

#### PR-B · 任意公开镜像可以起 box

| # | 验收判据 | 证据 |
|---|---------|------|
| B1 | `POST /boxes {image:"docker.io/library/alpine:3.20"}` → box 起来，**无任何前置调用** | 演示脚本第 1 步 ＋ e2e 第 2 条 |
| B2 | 第二次创建送到 runner 的是 digest 钉死的 ref，且载荷 `imageRevalidate=false` | e2e 第 4 条读 job 载荷 ＋ §7.1 I4 出口断言 |
| B3 | **只在拉取成功后写目录行**：`state=error` 不写；并发两个 box 用同一新 ref 只得一行 version | §7.1 I6 ＋ e2e 第 8 条 |
| B4 | 回报的 digest **等于 manifest digest 且不等于 `compute_image_digest()`**（显式不等断言） | §7.1 I6 |
| B5 | **curated 逐字节一致**：零 DB、零 Redis、**零额外 registry 往返**，p50/p99 持平 | §7.3 前两行 ＋ §7.1 I4 ＋ §7.4 I6 第 2 行 |
| B6 | `imageNeedsRevalidate` 四象限全对（curated tag / curated 全 ref / org tag / org digest） | §7.1 I6 ＋ §7.4 I6 第 2 行 |
| B7 | 允许表外 host、`169.254.169.254`、`10.0.0.0/8`、`[::1]`、`../`、超长 ref、超数量上限 ⇒ 明确 4xx；超并发上限 ⇒ 429 **带 `Retry-After` 头** | §7.1 I3 ＋ e2e 第 7 条 |
| B8 | 达到数量上限时新镜像 400，而**已在目录里的镜像仍可创建** | §7.1 I3 |
| B9 | org 镜像**永不进也永不查** warm pool，且**不读写** `warm-pool:skip:` 键 | §7.1 I5 ＋ §7.4 I5 第 1 行 |
| B10 | 五份 warm pool 字段清单一致（顺带修掉 `gpu` 漂移与 `gpuType` 缺失） | §7.1 I5 ＋ §7.4 I5 第 2 行 |
| B11 | 一次性用法不受影响：`image="python"` 起 box → 不产生任何 `image` 行 | e2e 第 10 条 |
| B12 | 20 处删除一次做完：`grep -rn 'TODO(image-rewrite)' apps --exclude-dir=dist` 归零 | §7.5 判据表末行 |
| B13 | 迁移可回滚：`down()` 有测试；部分唯一索引的 `WHERE "deletedAt" IS NULL` 字面存在 | §7.1 I2 |
| B14 | `ImageObject::manifest_digest()` / `total_layer_size()` 是**只增不改**的公开访问器；四个 SDK 现有签名不变、现有测试全绿 | §7.1 I6 ＋ §7.3 第 3 行 |
| B15 | `BoxOptions.image_revalidate` **只在 Go 侧镜像**（`WithImageRevalidate`）；`PyBoxOptions` / `JsBoxOptions` / cbindgen 头**都不镜像**它 | diff 审查 |
| B16 | `BoxOptions` 序列化后**不含** `image_revalidate` 键，`from_str("{}")` 回落 `false`——重启不重解析 tag | §7.1 I6 |

**判为不通过**：curated 路径多出任何一次 DB / Redis / registry 往返；目录命中却输出了带 tag
的 ref；拉取失败却写了目录行；org 镜像走到了 warm pool 或那个 Redis 负缓存；`TODO` 没归零。

#### PR-C · 镜像目录可见、可管、可编程

| # | 验收判据 | 证据 |
|---|---------|------|
| C1 | Images 页四件事都能做：列表、详情、用量条、删除 | 演示脚本第 2–6 步 |
| C2 | **路由顺序**：`GET /images/usage` 不被 `:idOrRef` 吞掉（显式测试）；`:idOrRef` 同时接受 uuid 与含斜杠的 URL 编码 ref | §7.1 I8 |
| C3 | `DELETE` 有未销毁的 box 在用 ⇒ **409** 并列出 box id；否则软删且名字可复用；删两次第二次 404 | §7.1 I8 |
| C4 | 跨 org 不可见 | 演示脚本第 7 步 ＋ §7.1 I8 |
| C5 | `progress`：CREATING 期间带 `phase='preparing_image'`；已有 ready version 不带；到 STARTED 消失；`retryAfterMs` 引用具名常量 | §7.1 I9 |
| C6 | Python 四方法 × 两个面全绿；**错误映射 status 优先、`code` 只做细化、绝不凭空合成**，含无 `code` 的 4xx 与 5xx | §7.1 I10 |
| C7 | 断言**不发** `X-BoxLite-Organization-ID`（org 由 key 自带） | §7.1 I10 |
| C8 | **零第三方运行时依赖**（导入测试守住 `pyproject.toml:10`） | §7.1 I10 |
| C9 | 权限：`read/delete:images` 生效，且**两个**分组文件都改了——"Images" 组不再指 templates，API key 那份新增 Images 组 | §7.1 I8 |
| C10 | e2e 十条全绿，含 curated 回归与"`DELETE` 后再用一次拉到新 digest"这条 re-pin 逃生口 | §7.2 |
| C11 | 文案已写明 `DELETE` 是"从目录移除"而不是"删除字节"，以及 tag 钉死后的逃生口 | 端点文档 ＋ 控制台文案审阅（§8 R9） |
| C12 | import 路径就是 **`boxlite.cloud`**（S3 换生成客户端时不变），且 `SyncCloudClient` 与 `CloudClient` 方法集**逐个对齐** | §7.1 I10 |
| C13 | 文档把 `rt.images()`（本机缓存，REST 后端抛 `Unsupported`）与 `c.images`（云端目录）**分开写**，并给出各自的可用后端 | SDK 文档审阅（§0.6） |
| C14 | **Node / Go / C 三个 SDK 的 diff 为空**，现有测试全绿 | diff 审查 |

**判为不通过**：`/images/usage` 被路由吞掉；`DELETE` 返回 400 而不是 409；引入任何第三方
运行时依赖；只改了一个权限分组文件；Python 客户端凭空合成 `code`。

**演示脚本（控制台）**
1. 创建 box 时在镜像框里直接填 `docker.io/library/alpine:3.20` → box 起来（首次较慢，界面显示"正在准备镜像"）
2. Images 页出现一行：NAME / TAGS / VERSIONS / SIZE / LAST USED
3. 详情页看到那个 version 的 digest、size，以及它来自哪个上游 ref
4. 顶部用量条显示 `count / limit`
5. 再建一个同镜像的 box → 明显更快（基盘已在该 runner 上）
6. 删除该镜像 → 列表消失，用量条回落；有 box 在用时给出明确拒绝
7. 用另一个 org 的 key 调 `GET /images` → 看不到它
8. 填一个允许表外的 host → 明确的 400，不是 500

**演示脚本（Python，同步面与异步面各一遍）**

```python
from boxlite import Boxlite, BoxOptions, BoxliteRestOptions                       # 起 box 仍走既有 SDK
from boxlite.cloud import SyncCloudClient, ImageNotFound

c = SyncCloudClient(api_key="blk_live_…")         # 也可从 BOXLITE_API_KEY / BOXLITE_API_URL 读

# 1. 直接用任意公开镜像建 box —— 没有任何前置的注册调用
rt = Boxlite.rest(BoxliteRestOptions.from_env())
box = rt.create(BoxOptions(image="docker.io/acme/whisper:1.2"))
#    首次使用某镜像会慢（完整冷拉在这条路径上）。BoxDto.progress 让调用方知道在等什么：
#      {"phase": "preparing_image", "retryAfterMs": …}

# 2. 它已经进了目录 —— 用过即入，不需要注册
for row in c.images.list():
    print(row["name"], row["tags"], row["lastUsedAt"])

detail = c.images.get("docker.io/acme/whisper")   # 也接受 image id
for version in detail["versions"]:
    print(version["digest"], version["sizeBytes"], version["sourceSpec"]["sourceRef"])
print(detail["history"])                          # S1 恒为 []，S2 才有数据

usage = c.images.usage()
print(usage["count"], "/", usage["limit"])        # S1 是**数量**闸门，不是字节

# 3. 删除 = 从目录移除；下次再用同一个 ref 会重新拉回来
#    它同时是 S1 唯一的 re-pin 逃生口：digest 钉死后 tag 无法前进，删了再用一次即可
try:
    c.images.delete("docker.io/acme/whisper")
except ImageNotFound:
    pass                                          # 对调用方来说 delete 是幂等的
```

镜像名由**服务端**解析——SDK 绝不自己拼造任何 registry 地址。
注意 `rt.images()`（本机缓存）与 `c.images`（云端目录）是两回事，且前者在 REST 后端
上抛 `Unsupported`（§0.6）。

**验收判据表**

| 判据 | 怎么证明 |
|------|---------|
| 无需任何前置调用即可用任意公开镜像建 box | 演示脚本第 1 步 ＋ e2e 第 2 条 |
| 用过的镜像自动进目录，失败的不进 | e2e 第 3、8 条 ＋ I6 单测 |
| 第二次起送到 runner 的**永远**是 digest 钉死的 ref | e2e 第 4 条读 job 载荷 ＋ I4 出口断言单测 |
| 首次拉取会重新解析 tag，不吃陈旧的 ref 字符串缓存 | I6 的两侧验证 |
| **curated 的 box 创建与今天逐字节一致**（含不多一次 registry 往返） | §7.3 前两行 ＋ I6 的四象限测试与两侧验证 |
| 准入门挡得住允许表外 host 与 link-local | e2e 第 7 条 ＋ I3 单测 |
| 恶意 registry 无法用 `size: 0` 写满 runner 盘 | I7 的两侧验证 |
| 跨 org 不可见 | 控制台第 7 条 ＋ 单测 |
| org 镜像永不进 warm pool | 四条租户测试（§7.1 I5） |
| `boxlite` 仍然零第三方运行时依赖 | 导入测试 |
| `disk-images/` 不再只增不减 | I12 的守卫 A 测试 ＋ `du` 基线 |
| 满盘时 box 创建变慢而不是失败 | I13 的两侧验证 |
| `autoDelete` 默认值已定并写进文档 | §6.0 B6 的决策记录 |
| 20 处删除一次做完 | `grep -rn 'TODO(image-rewrite)' apps --exclude-dir=dist` 归零——20 处删掉，第 21 处（`box.service.ts:197` 的镜像解析）被 `ImageResolver` 的实现替换 |

---

## 8. 风险与未验证前置项

| # | 风险 | 严重度 | 防护 / 残余风险 |
|---|------|:------:|----------------|
| R1 | **runner 的镜像缓存增长由租户驱动，而 pull-through 让它比上游方案更快。** D1 只收**不可达**文件（C7）——一块半年没用但 index 行还在的盘，D1 永远不碰 | **高** | 五层防护，逐层说清挡什么：① `image_count_limit`（默认 20）挡单 org 的镜像**种类**数，**不挡跨 org 总量**；② per-org 并发冷拉上限（默认 3）挡瞬时峰值叠加，不挡稳态增长；③ **D2-min（N13）挡"满了"**——建盘前空间检查 ＋ 按 `last_used_at` 淘汰，把"box 创建失败"换成"box 创建慢一点"；④ **`autoDelete` 默认值（B6）决定有多少盘被停止的 box 钉住**——D1 与 D2-min 都碰不了它们；⑤ `currentDiskUsagePercentage`（`runner.service.ts:420`）做成告警项。**容量算术**：100 GB root 卷（`settings.ts:14-19`）留 30% 给 box qcow2 与系统 ≈ 70 GB，按实测上界 141 MiB/块 ≈ **500 块基盘**；随机调度下每台 runner 最终缓存每个镜像，`image_count_limit=20` 时 **25 个活跃 org 就能填满一台**。**残余风险**：D2-min 只保证不失败、不保证不抖——真正把 25 这个数字抬上去的是 **HRW 亲和（S2）**，它让一个镜像落在 1–2 台而不是所有台。在那之前，磁盘惩罚是**单向**的（`:915-919` 指数惩罚、`:281-285` 完全排除），运维手册要写明人工处置步骤 |
| R1b | **`currentDiskUsagePercentage` 是 fail-open 的** | 中 | `runner.service.ts:420` 是 `metrics.currentDiskUsagePercentage \|\| 0`——runner 不上报时静默变 0，也就是"盘是空的"。要靠这个字段告警，先得把"没上报"与"真的 0%"分开（用 `?? null` ＋ 告警侧把 null 当未知处理） |
| R1c | **D2-min 淘汰错了对象会变成性能事故** | 中（若发生） | 若用 mtime 做信号，会优先淘汰创建最早的盘——那往往是共享度最高的 curated 基础镜像，命中率断崖下跌。防护是 N13 的 `last_used_at` ＋ §7.1 I13 那条显式的反 mtime 测试 |
| R2 | **攻击者可选的 egress 从 box runner 出去。** 租户能让 runner 向它挑的 host 发 HTTPS 请求 | **高** | 防护：host 允许表（B2）＋ 拒绝 link-local 与私有网段 ＋ IMDSv2 ＋ 禁止重定向到私有地址。**残余风险**：允许表内的 registry 仍可把 blob 请求 302 到任意地址——重定向目标必须复用同一套地址检查。**S2 的网关正面解掉这一整类**，届时 runner 只连网关 |
| R3 | **恶意 registry 用 `size: 0` 写满共享 runner 的盘** | 高 | I7 的**两层**上限（§0.3.4 W1）：声明未知的 blob 共用整次 pull 的余额（默认 256 MiB），所以 N 层都声明 `size: 0` 也乘不上去；声明诚实的超大 manifest 由总量闸门（默认 20 GiB）在拉第一层之前拒掉。`LayerInfo.size` 的注释（`manager.rs:46-48`）与 `storage.rs` 原来那条"`expected_size > 0` 才比"的事后校验一起构成了这个洞。两个数字都可 env 覆盖 |
| R4 | **上游可用性与可变性耦合** | 中 | 用户删了 upstream tag、或 docker.io 挂了 → 新 box 起不来；已有基盘的 box 不受影响。这是 S1 明确接受的代价（§3.5），耐久性到 S3 才有。表现必须是可理解的 `errorReason`，不是裸 500 |
| R5 | **Docker Hub 凭证是全 fleet 共享的** | 中 | `config.go:63-64` 是一个 envconfig，一个租户的拉取循环烧的是所有人的配额。防护：per-org 并发冷拉上限（B3）。**归宿是 S2 的网关**，那里能做 per-org 限流 |
| R6 | **digest 回报丢失** → 拉取成功但目录里没行 | 中 | 后果是下一次创建又走一次"未命中"路径（重新解析 ＋ 重新回报），不会错，只是慢。回报是幂等 upsert，重放安全。**不做补偿任务**——那又会引入一个需要陈旧判定的组件 |
| R7 | **首次拉取时到达 runner 的是 tag 而不是 digest** | 中 | 这是 pull-through 的固有形状：digest 要拉了才知道。防护是 N5 的重新解析 ＋ 第二次起必然钉死。**残余风险**：同一时刻两个 box 用同一个刚变过的 tag，可能落到两个不同 digest，其中一个被登记。可接受——两者都是那一刻上游真实提供的字节 |
| R8 | **透传路径被误用**：目录命中却输出了未钉死的 ref | **高** | `image_index` 主键是 ref 字符串且**从不重新校验**（`db/schema.rs:70-79`、`store.rs:172-179`），所以一台缓存过 `name:stable` 的宿主会永远提供旧版本。防护：resolver 出口断言 ＋ 两条单测（命中必钉死、未命中不编造）。这是承重结构，不是洁癖 |
| R9 | **`latest` 永远前进不了**（N9） | 中 | S1 的逃生口是 `DELETE` 后再用一次；S2 的 tag 移动把它变成一等操作。**必须写进端点文档与控制台文案**，否则用户会以为是 bug |
| R10 | D1 误删热缓存条目 | 高（若发生） | 四道守卫 ＋ C6；DB 出错整趟放弃；两侧验证覆盖"`load_from_local` 的盘不被误删" |
| R11 | 20 处删除只做了一半 | 中 | 全部落在 I1 一个子 issue 里；验收判据是 `grep` 归零。注意 `apps/dist/` 下有构建产物副本，统计时必须 `--exclude-dir=dist` |
| R12 | **`image.name` 是用户可控字符串**，会进 URL 与路由参数 | 中 | 语法校验在 `ImageAdmission` 里、在任何 URL 拼接与 DB 写之前（I3）；`:idOrRef` 只接受 uuid 或 URL 编码 ref；DB 侧用参数化查询。测试覆盖 `../`、编码绕过、超长 |
| R13 | **`imageRevalidate` 判定漏掉 curated** | **高** | 判定在派活点，而 curated 的 ref 是 env 驱动的（`curated-images.constant.ts:35-54`），默认恰好是 `ghcr.io/boxlite-ai/…` 但**不保证**。判定必须是"对 `supportedImages()` 精确匹配"，**绝不能按 host 判断**。漏了它，curated 的每次创建都多一次 ghcr.io 往返，直接打破 §7.3 的第一条基线，而这个回归**不会报错、只会变慢**。防护：I6 的四象限测试 ＋ 一条两侧验证 |

**明确的未验证项**（不阻塞开工）：runner root 卷的文件系统类型（S4 前置，§6.0 建议在
本期顺手验）；宿主侧 discard/TRIM 是否真的生效；允许表内各 registry 的 blob 重定向
目标分布（R2 的缓解要覆盖它）。

---

## 9. 索引

> 未标注 = 本版重读过；**✗** = 沿用早前读数、本版未重读。

| 主题 | 路径 |
|------|------|
| 分期与阶段边界 | `custom-oci-images-staging.zh-CN.md`（不在本仓库） |
| S1–S4 issue 拆分 | [Notion: Issue 清单（S1–S4）](https://app.notion.com/p/3d68d8d971798181b56fde0962110267) |
| S2 详细设计 | [Notion: S2 详细设计与执行计划](https://app.notion.com/p/3d68d8d9717981fa8e21dec153337dd1) |
| 上游方案 / issue 拆分 | `custom-oci-images.md`、`custom-oci-images.zh-CN.md`、`custom-oci-images-issues.md`（均不在本仓库） |
| curated 门（被 `ImageAdmission` 替换） | `apps/api/src/box/constants/curated-images.constant.ts:35-54`、`:80-86`、`:93-105` |
| box 创建（**只落行、不派活**） | `apps/api/src/box/services/box.service.ts:164`、`:187`、`:209`、`:235`、`:86-92`、`:197-203` |
| **派活点（`imageRevalidate` 现算处）** | `apps/api/src/box/managers/box-actions/box-start.action.ts:59-83`；`apps/api/src/box/runner-adapter/runnerAdapter.v2.ts:116`、`:120-152`、`:153` |
| box 状态回报（digest 的载体） | `apps/api/src/box/dto/update-box-state.dto.ts:11-35`（示例文案在 `:24`） |
| `box.image` 索引（删除守卫用） | `apps/api/src/box/entities/box.entity.ts:40` |
| box 生命周期默认值（B6） | `apps/api/src/box/constants/box-lifecycle.constants.ts:6-9`；`apps/api/src/migrations/pre-deploy/1784250000000-add-box-lifecycle-seconds-migration.ts:13`；`boxlite-rest/mappers/box-to-box.mapper.ts:31` |
| warm pool 五份字段清单 | `apps/api/src/box/services/box-warm-pool.service.ts:69-84`、`:93-112`、`:151-167`、`:193-205`、`:211-227`；负缓存写 `:132` |
| warm pool 实体与索引（`gpuType` 五份皆缺） | `apps/api/src/box/entities/warm-pool.entity.ts:11`、`:38` |
| warm pool 资格判定 | `apps/api/src/box/utils/warm-pool-eligibility.util.ts:23` |
| `POST /boxes` 服务端等待 | `apps/api/src/boxlite-rest/boxlite-box.controller.ts:112`、`:122`；`box/services/box-state-waiter.service.ts:18` |
| Volume 删除守卫（镜像删除照抄形状，**409**） | `apps/api/src/box/services/volume.service.ts:109-150`（`:148` 抛 `ConflictException`） |
| Volume 的表级 `@Unique`（C4 的反面样本） | `apps/api/src/box/entities/volume.entity.ts:11` |
| 扁平错误 body ＋ **`Retry-After` 机制** | `apps/api/src/filters/all-exceptions.filter.ts:59-92`（`:68` join、`:74-78` Retry-After、`:84-91` body）；`common/utils/rate-limit-headers.util.ts:25-36` |
| ValidationPipe（无 `disableErrorMessages`） | `apps/api/src/main.ts:89-92` |
| API key 携带 org / runner key 分支 | `apps/api/src/auth/api-key.strategy.ts:130`、`:140-149` |
| org 级限流计数器 | `apps/api/src/common/guards/authenticated-rate-limit.guard.ts:40-50` |
| 权限枚举（头部注释只提一个分组文件） | `apps/api/src/organization/enums/organization-resource-permission.enum.ts:8`、`:10-39` |
| 权限分组**两个**文件 | `apps/dashboard/src/constants/OrganizationPermissionsGroups.ts:9-34`（Images 组在 `:15-18`，指向 templates）、`CreateApiKeyPermissionsGroups.ts:9-14`（**只有 Boxes**） |
| 指标白名单投影的正确形状 | `apps/api/src/interceptors/metrics.interceptor.ts:131`、`:134`、`:197`、`:413`、`:415-422` |
| 命名策略（列名 camelCase） | `apps/api/src/common/utils/naming-strategy.util.ts:9` |
| org 配额列（snake_case）＋ 待删列 | `apps/api/src/organization/entities/organization.entity.ts:31-56`、`:141-145`；`organization/dto/organization.dto.ts:93`、`:175` |
| TypeORM Redis 缓存 | `apps/api/src/app.module.ts:99-103` |
| 被隐藏的 Images 路由 | `apps/dashboard/src/App.tsx:55-56`、`:221-223`；`enums/RoutePath.ts:24` |
| 硬编码的镜像下拉框 | `apps/dashboard/src/components/Box/CreateBoxDialog.tsx:30-34` |
| runner registry 凭证与 create | `apps/runner/pkg/boxlite/client.go:112-122`、`:128-130`、`:132-152`、`:163`、`:165-173`、`:314`；`cmd/runner/config/config.go:63-64` |
| runner 放置（前 10 台里随机）、磁盘惩罚、亲和残留 | `apps/api/src/box/services/runner.service.ts:277-285`、`:308`、`:420`、`:778`、`:788`、`:791-792`、`:915-919` |
| runner 实例与卷 | `apps/infra/stack/settings.ts:14-19` |
| Redis 单节点 | `apps/infra/stack/foundation.ts:51` |
| 本地 registry / 12 个组件 | `apps/infra-local/compose/config.py:95`、`services.py:168-169`、`native.py:247` |
| pull 快路径按 ref 字符串查缓存 | `src/boxlite/src/images/store.rs:155`、`:172-179`（调用点 `:176`） |
| 匿名认证默认值 / Basic 通道 | `src/boxlite/src/images/store.rs:1061-1072`、`:1068` |
| `docker.io` 归一化（S2 用得上） | `src/boxlite/src/images/store.rs:1172-1189` |
| 层下载与事后大小校验 | `src/boxlite/src/images/storage.rs:282`、`:505`、`:603`、`:619` |
| 层 size 可以是 0 的字段注释 | `src/boxlite/src/images/manager.rs:42-49` |
| 解压放大上限（下载侧照抄的形状） | `src/boxlite/src/images/archive/extractor.rs:704-722` |
| **manifest 声明总量闸门（实现期新增）** | `src/boxlite/src/images/store.rs:61`（`assert_declared_size_fits`）、`:667`（`pull_from_registry` 的插入点） |
| **写入侧流式上限（实现期新增）** | `src/boxlite/src/images/storage.rs:507`（`UnsizedBlobBudget`）、`:566`（`DownloadBudget`）、`:675`（`poll_write`）、`:781`（`budget_error`） |
| **manifest digest 在哪（V5）** | `src/boxlite/src/images/manager.rs:32-40`、`:122-126`、`:158` |
| 整镜像 digest（**不是** manifest digest） | `src/boxlite/src/images/object.rs:284-292` |
| 基盘缓存（整镜像键、无 GC、瞬时峰值） | `src/boxlite/src/images/image_disk.rs:78-88`、`:91-95`、`:98-125`、`:100`、`:117-121`、`:131`、`:170-174` |
| headroom 常量（C5 的触发条件） | `src/boxlite/src/runtime/rt_impl.rs:215`、`:342` |
| 宿主缓存索引表 | `src/boxlite/src/db/schema.rs:70-79`；`src/boxlite/src/db/images.rs:79`、`:135` |
| index 只在网络 pull 路径被写（层列表有序） | `src/boxlite/src/images/store.rs:621-635`（`:627`）；`manager.rs:117`、`:185-201` |
| 已验证的回收器形状 | `src/boxlite/src/disk/base_disk.rs:86`、`:92`、`:128-141`、`:199-250`、`:337` |
| 启动回收调用点 | `src/boxlite/src/runtime/rt_impl.rs:225`、`:370`、`:1276`、`:1513`、`:1520` |
| guest rootfs 回收 | `src/boxlite/src/rootfs/guest.rs:564` |
| COW 子盘 backing 指向 disk-images | `src/boxlite/src/litebox/init/tasks/container_rootfs.rs:234` |
| 本地重建的真实代价 | `src/boxlite/src/rootfs/builder.rs:84-140`（`:124` `CopyMode::Content`）；`images/image_disk.rs:117-121` |
| 三目录同卷校验（S4 前置） | `src/boxlite/src/runtime/layout.rs:225-262`；目录常量 `:99-100`、`:153`、`:172`、`:187` |
| per-create 载体与 create 签名 | `src/boxlite/src/runtime/options.rs:319`；`runtime/core.rs:291-300` |
| **`BoxOptions` 是落盘的 box 配置（V6）** | `src/boxlite/src/litebox/config.rs:19-21`、`:40`；`src/boxlite/src/db/schema.rs:27-32`；`runtime/options.rs:317-319` |
| runtime 级 registry 凭证与屏蔽 Debug | `src/boxlite/src/runtime/options.rs:51`、`:136-160`、`:297-313` |
| REST 后端 `images()` 抛 `Unsupported` | `src/boxlite/src/runtime/core.rs:442-448` |
| Rust 侧错误映射（status 优先） | `src/boxlite/src/rest/types.rs:31-44` |
| 预建盘缓存的接缝（S3） | `src/boxlite/src/images/blob_source.rs:30-36` |
| Python SDK 零依赖与既有面 | `sdks/python/pyproject.toml:10`；`boxlite/sync_api/_images.py:31`、`:34`；`sync_api/_boxlite.py:258`；`boxlite/credential.py:18` |
| e2e 用例目录形状 | `apps/e2e/cases/`（`test_*.py`，`conftest.py`） |
| ✗ per-box 上限 | `apps/api/src/box/services/per-box-limits.ts` |
| ✗ job 派活模式（S3 会照抄） | `apps/api/src/box/services/job.service.ts` |
| ✗ runner 侧对象存储客户端（S3 取回预建盘） | `apps/runner/pkg/storage/` |
